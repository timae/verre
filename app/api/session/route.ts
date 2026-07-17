import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, lifespanTTL } from '@/lib/redis'
import { genCode, type SessionMeta } from '@/lib/session'
import { applySessionFields } from '@/lib/sessionFields'
import { prisma } from '@/lib/prisma'
import { validateDisplayName } from '@verre/core'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
  userIdentityId,
} from '@/lib/identity'

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
  // Stored urls carry the PUBLIC prefix (S3_PUBLIC_ENDPOINT, when split
  // from the SDK endpoint — see lib/s3.ts); pre-split rows carry the
  // internal one. Accept either so both generations stay reclaimable.
  const pub = process.env.S3_PUBLIC_ENDPOINT || ENDPOINT
  const prefix = [`${pub}/${BUCKET}/`, `${ENDPOINT}/${BUCKET}/`].find((p) => url.startsWith(p))
  if (!prefix) return
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

  // Lifespan beyond 48h requires pro ON WEB. Native callers are exempt and
  // default to 'unlimited' — app-created moments are durable (amends the
  // freemium split; see root CLAUDE.md). `authSource` is set by which
  // credential VALIDATED in resolveUser (Better Auth cookie), never by a
  // client-controlled header. Caveat (root CLAUDE.md): a BA session is
  // self-issuable from any client until App Attest lands — accepted.
  // Reject loudly rather than silently downgrading — a non-pro web caller
  // asking for 72h is making an explicit choice we shouldn't honor and
  // shouldn't quietly substitute.
  const isNative = session?.authSource === 'native'
  if (lifespan !== undefined && lifespan !== null && (typeof lifespan !== 'string' || !['48h', '72h', '1w', 'unlimited'].includes(lifespan))) {
    return NextResponse.json({ error: 'unsupported lifespan' }, { status: 400 })
  }
  if (lifespan && lifespan !== '48h' && !isPro && !isNative) {
    return NextResponse.json({ error: 'extended lifespan requires a pro account' }, { status: 403 })
  }
  const resolvedLifespan = typeof lifespan === 'string' && lifespan ? lifespan : isNative ? 'unlimited' : '48h'
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

  // Collision check on BOTH Redis and Postgres. Anonymous sessions only
  // touch Redis, but a Postgres row can survive a Redis TTL expiry — re-using
  // such a code would clobber the unique constraint at create time. Log the
  // retry count so namespace-exhaustion shows up in logs before it bites.
  //
  // Soft-deleted sessions have `code = NULL` per the §8 scrub, so the
  // `findUnique({where:{code:candidate}})` below naturally misses them and
  // their codes are freed for re-use. Intentional — the unique index permits
  // multiple NULLs (NULLs are distinct), and a tombstoned session has no
  // public surface that the recycled code would conflict with.
  let code: string | null = null
  let attempts = 0
  for (let i = 0; i < 10; i++) {
    attempts++
    const candidate = genCode()
    const [redisHit, pgHit] = await Promise.all([
      redis.exists(k.meta(candidate)),
      prisma.session.findUnique({ where: { code: candidate }, select: { id: true } }),
    ])
    if (!redisHit && !pgHit) {
      code = candidate
      break
    }
  }
  if (!code) {
    console.error(`[session] code generation failed after ${attempts} attempts`)
    return NextResponse.json({ error: 'could not allocate session code' }, { status: 500 })
  }
  if (attempts > 1) {
    console.warn(`[session] code allocated after ${attempts} attempts`)
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
    createdAt: Date.now(),
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
  // side-effect-free). The code keys the S3 object; timestamped so recycled
  // codes (soft-delete frees them) can't collide and replacement leaves
  // prior bytes addressable for reclaim. uploadImage carries the full
  // hardening (MIME allow-list, magic bytes, size cap, JPEG EXIF strip) —
  // '' means rejected.
  let coverPhotoUrl = ''
  if (typeof coverPhoto === 'string' && coverPhoto) {
    coverPhotoUrl = await uploadImage(`sessions/${code}_${Date.now()}`, coverPhoto).catch(() => '')
    if (!coverPhotoUrl) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
    meta.coverPhotoUrl = coverPhotoUrl
  }

  await redis.set(k.meta(code), JSON.stringify(meta), { EX: sessionTTL })
  await redis.set(k.wines(code), '[]', { EX: sessionTTL })

  // Register the host in the identities map so participant-gated reads
  // (wines, ratings, session meta) work right after create.
  await recordIdentity(code, {
    id: identityId,
    displayName: hostName,
    kind: session?.user?.id ? 'user' : 'anon',
  })
  if (anonToken) {
    await recordAnonToken(code, anonToken, identityId)
    await redis.expire(k.tokens(code), sessionTTL)
  }
  await redis.expire(k.identities(code), sessionTTL)

  if (session?.user) {
    try {
      await prisma.session.create({
        data: {
          code,
          hostUserId: Number(session.user.id),
          hostName,
          name: meta.name || null,
          blind: !!blind,
          createdAt: new Date(meta.createdAt),
          category,
          coverPhotoUrl: coverPhotoUrl || null,
          address: meta.address || null,
          dateFrom: meta.dateFrom ? new Date(meta.dateFrom) : null,
          dateTo: meta.dateTo ? new Date(meta.dateTo) : null,
          timezone: meta.timezone || null,
          description: meta.description || null,
          link: meta.link || null,
        },
      })
    } catch (err) {
      // Pre-create collision check ran above, so a P2002 here means a race —
      // log loudly and surface it. Tear down the Redis state we just wrote:
      // a logged-in session has no other archival path, so leaving the keys
      // would orphan a live session with NO Postgres row — and native's
      // 'unlimited' lifespan makes that a ~1-year orphan, not a 48h one. Cover
      // bytes are likewise NOT TTL'd, so reclaim them too. (No tokens key here
      // — anonToken is null on the logged-in path.) Cleanup is best-effort and
      // must not mask the original failure.
      console.error('[session] postgres create failed', err)
      await Promise.all([
        redis.del(k.meta(code)),
        redis.del(k.wines(code)),
        redis.del(k.identities(code)),
      ]).catch(() => {})
      if (coverPhotoUrl) reclaimImage(coverPhotoUrl).catch(() => {})
      return NextResponse.json({ error: 'could not archive session' }, { status: 500 })
    }
    // Best-effort counter bump. A failure here doesn't undo the session.
    try {
      await prisma.$executeRaw`
        UPDATE users SET lifetime_sessions_hosted = lifetime_sessions_hosted + 1
        WHERE id = ${Number(session.user.id)}`
    } catch (err) {
      console.warn('[session] lifetime counter bump failed', err)
    }
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
