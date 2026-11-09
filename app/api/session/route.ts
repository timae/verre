import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { k, lifespanTTL, scanKeys } from '@/lib/redis'
import { genCode, sessionMetaToColumns, type SessionMeta } from '@/lib/session'
import { withSessionMutation, ContractBusy, LockLost, type MutationCtx } from '@/lib/sessionMutation'
import { applySessionFields } from '@/lib/sessionFields'
import { validateDisplayName } from '@verre/core'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { newAnonIdentityId, newAnonToken, userIdentityId } from '@/lib/identity'

// Inlined S3 reclaim — same workaround as app/api/me/avatar/route.ts: a
// third export on lib/s3.ts gets dropped by webpack, so each route that
// needs delete-by-URL keeps its own copy. Used here only to clean up a
// just-uploaded cover when the Postgres create fails after the upload.
const ENDPOINT = process.env.S3_ENDPOINT
const BUCKET = process.env.S3_BUCKET
const s3 = ENDPOINT
  ? new S3Client({
      endpoint: ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!s3 || !BUCKET || !url || !ENDPOINT) return
  const prefix = `${ENDPOINT}/${BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] session cover reclaim failed:', { key, err })
  }
}

// Session category — v1 allow-list. The category is the future contract for
// what impressions can be added ('wine' → wines only) and the category
// vocabulary; widen this list when a second category gets real attribute
// sets + styles (category_styles seed).
const SESSION_CATEGORIES = new Set(['wine'])

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)

  // Rate limit session creation: 10 per 10 minutes per user (logged-in)
  // or per IP (anon). Generous enough for legitimate "hosting multiple
  // tastings tonight" use; tight enough to make session-code-space
  // exhaustion expensive.
  const rlKey = session?.user?.id
    ? `rl:create:user:${session.user.id}:10m`
    : `rl:create:ip:${getClientIp(req)}:10m`
  const rl = await checkRate(rlKey, 10, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many sessions created. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Public field is `hostDisplayName` — there's no concept of a "username"
  // in this codebase (see CLAUDE.md Auth section), only display names.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { hostDisplayName: rawHostName, sessionName, blind, lifespan, category: rawCategory, coverPhoto } = body as Record<string, unknown>

  let hostName: string
  try { hostName = validateDisplayName(rawHostName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const category = rawCategory === undefined || rawCategory === null ? 'wine' : rawCategory
  if (typeof category !== 'string' || !SESSION_CATEGORIES.has(category)) {
    return NextResponse.json({ error: 'unsupported category' }, { status: 400 })
  }

  // blind tasting requires a pro account
  const isPro = !!(session?.user as { pro?: boolean } | undefined)?.pro
  if (blind && !isPro) {
    return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
  }

  // Lifespan (root CLAUDE.md § Freemium split): a logged-in create — web or
  // native — is Postgres-backed, so it is reopenable forever and its lifespan
  // only sizes the cache TTL: always 'unlimited', and a `lifespan` in the body
  // is IGNORED (a web client from before the picker was removed keeps working).
  // An anonymous create is Redis-only, so its 48h is real: anything else is
  // refused loudly rather than silently substituted.
  if (!session?.user && lifespan !== undefined && lifespan !== null && lifespan !== '48h') {
    return NextResponse.json({ error: 'longer lifespans need an account' }, { status: 403 })
  }
  const resolvedLifespan = session?.user ? 'unlimited' : '48h'
  const sessionTTL = lifespanTTL(resolvedLifespan)

  // Cover photo is logged-in only: an anonymous session has no Postgres row,
  // so its Redis TTL expiry would orphan the S3 bytes with no deletion path.
  if (coverPhoto !== undefined && coverPhoto !== null) {
    if (!session?.user) {
      return NextResponse.json({ error: 'sign in to add a cover photo' }, { status: 401 })
    }
    if (typeof coverPhoto !== 'string' || coverPhoto.length > MAX_IMAGE_DATA_URL_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 400 })
    }
  }

  // Mint the host's identity id up front so it can be stamped into meta —
  // host checks then work purely by id, no display-name fallback needed.
  let anonToken: string | null = null
  let identityId: string
  if (session?.user?.id) {
    identityId = userIdentityId(session.user.id)
  } else {
    identityId = newAnonIdentityId()
    anonToken = newAnonToken()
  }

  const meta: SessionMeta = {
    host: hostName,
    name: '',
    createdAt: 0,
    hostUserId: session?.user?.id ? Number(session.user.id) : null,
    hostIdentityId: identityId,
    blind: !!blind,
    lifespan: resolvedLifespan,
    category,
    coHostIds: [] as string[],
    providerIds: [] as string[],
  }
  // Shared with the settings PATCH so the validators can't drift; also maps
  // the create body's `sessionName` onto the canonical meta.name. Runs
  // BEFORE the cover upload so a field rejection can't orphan S3 bytes.
  const fieldError = applySessionFields(meta, {
    name: sessionName,
    address: (body as Record<string, unknown>).address,
    dateFrom: (body as Record<string, unknown>).dateFrom,
    dateTo: (body as Record<string, unknown>).dateTo,
    timezone: (body as Record<string, unknown>).timezone,
    description: (body as Record<string, unknown>).description,
    link: (body as Record<string, unknown>).link,
    hideLineup: (body as Record<string, unknown>).hideLineup,
    hideLineupMinutesBefore: (body as Record<string, unknown>).hideLineupMinutesBefore,
  })
  if (fieldError) return NextResponse.json({ error: fieldError }, { status: 400 })

  // A moment REQUIRES a name and a start date (Simon, 2026-07-06 — applies to
  // every caller: web, native, anon). applySessionFields rejects an explicit
  // empty/clear, but a create that OMITS the field entirely (mobile sends
  // sessionName:undefined when blank; a caller may send no dateFrom) leaves
  // meta.name === '' / meta.dateFrom undefined — caught here. Before the cover
  // upload so a rejection can't orphan S3 bytes (same ordering as the fields).
  if (!meta.name || !meta.name.trim()) return NextResponse.json({ error: 'Please name your moment.' }, { status: 400 })
  if (!meta.dateFrom) return NextResponse.json({ error: 'Please set a start date.' }, { status: 400 })

  // Upload the cover last among the validations (every rejection above is
  // side-effect-free). Timestamped so recycled codes can't collide; keyed by a
  // random prefix here because the code is only claimed below. uploadImage
  // carries the full hardening — '' means rejected.
  let coverPhotoUrl = ''
  if (typeof coverPhoto === 'string' && coverPhoto) {
    coverPhotoUrl = await uploadImage(`sessions/new_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, coverPhoto).catch(() => '')
    if (!coverPhotoUrl) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
    meta.coverPhotoUrl = coverPhotoUrl
  }

  // 🔒 The code is CLAIMED INSIDE THE SESSION LOCKS (redis-rehydration release-B
  // plan § 3, r2-1): for each candidate, under its Redis lock (no wait — a held
  // lock means someone is working on that code: take another) and its advisory
  // lock, re-check that no live row and no meta exists. A create that checked
  // outside the locks could claim a code a paused promotion was about to commit.
  // Keys left by an ended Redis-only session (meta evicted) are orphans and are
  // removed first, so a fresh incarnation never inherits a stale roster, ban
  // set or lineup. Then — anonymous: the fenced NX writes are the change (meta
  // LAST, mechanism 1). Logged-in: the sessions row, the host's member row and
  // both lifetime counters (hosted + joined, once per create — the host's later
  // /visit finds the member row) commit in ONE transaction, and the keys are the
  // projection after COMMIT; a projection that never lands leaves a live row
  // whose next open rebuilds it (meta from the record).
  const userId = session?.user?.id ? Number(session.user.id) : null
  let code: string | null = null
  for (let attempt = 1; attempt <= 10 && !code; attempt++) {
    const candidate = genCode()
    try {
      code = await withSessionMutation(candidate, { label: 'create', redisLock: { waitMs: 0 }, readMeta: 'optional' }, async (tx, ctx) => {
        if (ctx.row || ctx.meta) return null
        meta.createdAt = Date.now()
        const stale = await scanKeys(`s:${candidate}:*`)
        if (stale.length) await ctx.fence!.exec(m => { m.del(stale) })
        if (userId === null) {
          await publish(ctx, candidate, meta, identityId, hostName, sessionTTL, anonToken)
          return candidate
        }
        await tx.session.create({ data: { code: candidate, ...sessionMetaToColumns(meta) } })
        await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${candidate}`
        await tx.$executeRaw`INSERT INTO session_members (user_id, session_code, role) VALUES (${userId}, ${candidate}, 'host')`
        await tx.$executeRaw`
          UPDATE users SET lifetime_sessions_hosted = lifetime_sessions_hosted + 1,
                           lifetime_sessions_joined = lifetime_sessions_joined + 1
           WHERE id = ${userId}`
        return candidate
      }, async (ctx, claimed) => {
        if (claimed && userId !== null) await publish(ctx, claimed, meta, identityId, hostName, sessionTTL, null)
      })
      if (!code) console.warn(`[session] code candidate taken (attempt ${attempt})`)
    } catch (err) {
      if (err instanceof ContractBusy || err instanceof LockLost) continue
      console.error('[session] create failed', err)
      if (coverPhotoUrl) reclaimImage(coverPhotoUrl).catch(() => {})
      return NextResponse.json({ error: 'could not create session' }, { status: 500 })
    }
  }
  if (!code) {
    console.error('[session] code generation failed after 10 attempts')
    if (coverPhotoUrl) reclaimImage(coverPhotoUrl).catch(() => {})
    return NextResponse.json({ error: 'could not allocate session code' }, { status: 500 })
  }

  return NextResponse.json({
    code,
    name: meta.name,
    host: hostName,
    id: identityId,
    displayName: hostName,
    blind: !!blind,
    lifespan: resolvedLifespan,
    category,
    ...(coverPhotoUrl ? { coverPhotoUrl } : {}),
    ...(anonToken ? { anonToken } : {}),
  })
}

// The new session's keys, fenced: wines NX, the host's roster entry (and the
// anonymous host's token), then meta NX LAST — the existence signal every
// reader keys on.
async function publish(ctx: MutationCtx, code: string, meta: SessionMeta, identityId: string, hostName: string, ttl: number, anonToken: string | null): Promise<void> {
  await ctx.fence!.exec(m => {
    m.set(k.wines(code), '[]', { NX: true, EX: ttl })
    m.hSet(k.identities(code), identityId, hostName)
    m.expire(k.identities(code), ttl)
    if (anonToken) { m.hSet(k.tokens(code), anonToken, identityId); m.expire(k.tokens(code), ttl) }
    m.set(k.meta(code), JSON.stringify(meta), { NX: true, EX: ttl })
  })
}
