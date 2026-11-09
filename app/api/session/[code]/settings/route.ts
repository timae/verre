import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { k } from '@/lib/redis'
import { isHostByIdentity, sessionSettingsColumns, expireSessionKeys, type SessionMeta } from '@/lib/session'
import { applySessionFields } from '@/lib/sessionFields'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { withSessionMutation, admitted, refuse, ContractRefused } from '@/lib/sessionMutation'
import { readRecordRoles, metaFromRecord, readLiveRow } from '@/lib/sessionRecord'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'

// Inlined S3 reclaim — same workaround as app/api/me/avatar/route.ts (a
// third lib/s3.ts export gets dropped by webpack). Reclaims the PRIOR cover
// bytes after a replace/remove commits.
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

// The settings body applied to `base` — pure, run twice: once on the cached
// meta for an early answer (before the cover upload, so a rejection can't orphan
// S3 bytes), and again UNDER THE LOCKS on the record's current settings, where
// it decides. Throws refuse(…) on a rejectable payload.
//
// Pro-gated settings (blind, lifespan, showProvenance): a non-pro caller may
// submit the current value (a cohost saving unrelated edits with the full
// payload) but cannot change it in either direction (symmetric gate). Disabling
// blind clears blindForEveryone (a stale flag must not resurrect on re-enable);
// blindForEveryone itself is not pro-gated (only flipping a session TO blind
// is). showProvenance defaults ON (absent = true).
function applySettings(base: SessionMeta, body: Record<string, unknown>, isPro: boolean): SessionMeta {
  const meta: SessionMeta = { ...base }
  const fieldError = applySessionFields(meta, body)
  if (fieldError) throw refuse(400, fieldError)
  if (body.blind !== undefined) {
    const newBlind = !!body.blind
    if (newBlind !== !!base.blind && !isPro) throw refuse(403, 'blind tastings require a pro account')
    meta.blind = newBlind
    if (!newBlind) meta.blindForEveryone = false
  }
  if (body.blindForEveryone !== undefined) meta.blindForEveryone = !!body.blindForEveryone
  if (body.showProvenance !== undefined) {
    const newShow = !!body.showProvenance
    if (newShow !== (base.showProvenance !== false) && !isPro) {
      throw refuse(403, 'changing impression attribution requires a pro account')
    }
    meta.showProvenance = newShow
  }
  if (body.lifespan !== undefined) {
    // Vestigial: no client sends `lifespan` any more (logged-in creates and
    // promotions are 'unlimited', and a guest moment's 48h is not editable).
    // Kept unchanged for API stability. Allow-list: a junk string would map to
    // 48h silently.
    if (typeof body.lifespan !== 'string' || !['48h', '72h', '1w', 'unlimited'].includes(body.lifespan)) {
      throw refuse(400, 'unsupported lifespan')
    }
    if (body.lifespan !== base.lifespan && !isPro) throw refuse(403, 'extended lifespan requires a pro account')
    meta.lifespan = body.lifespan
  }
  return meta
}

// 🔒 D1 (release-B plan § 9) — the cache may DENY before COMMIT, never grant.
// The meta written INSIDE the transaction keeps every field of `prev` but takes
// the TIGHTER of prev/next for each visibility flag: blind, blindForEveryone and
// hideLineup OR'd, showProvenance AND'd, and — when the lineup is hidden in
// either — whichever (dateFrom, hideLineupMinutesBefore) pair yields the LATER
// reveal instant. A crash after COMMIT and before the projection then leaves a
// cache that hides at least as much as the record, never less (with
// commit-then-project only, tasters would see wine identities the record hides).
function tightened(prev: SessionMeta, next: SessionMeta): SessionMeta {
  const out: SessionMeta = {
    ...prev,
    blind: !!prev.blind || !!next.blind,
    blindForEveryone: !!prev.blindForEveryone || !!next.blindForEveryone,
    hideLineup: !!prev.hideLineup || !!next.hideLineup,
    showProvenance: prev.showProvenance !== false && next.showProvenance !== false,
  }
  const revealAt = (m: SessionMeta) => m.hideLineup && m.dateFrom ? Date.parse(m.dateFrom) - (m.hideLineupMinutesBefore || 0) * 60_000 : -Infinity
  if (revealAt(next) > revealAt(prev)) {
    out.dateFrom = next.dateFrom
    out.hideLineupMinutesBefore = next.hideLineupMinutesBefore
  }
  return out
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const op = await openAsParticipant(c, req, session, 'identity required')
  if (op instanceof NextResponse) return op
  const { meta: cached, identity } = op
  if (!isHostByIdentity(cached, identity)) {
    return NextResponse.json({ error: 'only the host can change session settings' }, { status: 403 })
  }
  const isPro = !!(session?.user as { pro?: boolean })?.pro
  try { applySettings(cached, body, isPro) }
  catch (err) { if (err instanceof ContractRefused) return err.response; throw err }

  // Cover photo LAST among the gates: every rejection above is pure. Data URL =
  // replace, explicit null = remove. Logged-in callers only — an anon-hosted
  // session has no Postgres row, so its expiry would orphan the bytes. Uploaded
  // OUTSIDE the locks; the prior bytes are reclaimed only after COMMIT (and the
  // new bytes if the save fails) — capture/commit/reclaim-after.
  let newCoverUrl: string | null | undefined
  if (body.coverPhoto !== undefined) {
    if (!session?.user) return NextResponse.json({ error: 'sign in to change the cover photo' }, { status: 403 })
    if (body.coverPhoto === null) newCoverUrl = null
    else {
      if (typeof body.coverPhoto !== 'string' || body.coverPhoto.length > MAX_IMAGE_DATA_URL_BYTES) {
        return NextResponse.json({ error: 'image too large' }, { status: 400 })
      }
      // Charged only on an actual upload, not on no-op settings saves.
      const rl = await checkRate(`rl:cover:user:${session.user.id}:1h`, 10, 3600)
      if (!rl.allowed) {
        return NextResponse.json(
          { error: `Too many cover uploads. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
          { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
        )
      }
      newCoverUrl = await uploadImage(`sessions/${c}_${Date.now()}`, body.coverPhoto).catch(() => '')
      if (!newCoverUrl) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
    }
  }

  // Inside the session mutation contract: the power from the caller's fresh
  // grant; the body re-applied to the RECORD's current settings (a Postgres-
  // backed session — meta is a projection of the record, D4) or to the cached
  // meta (a Redis-only session, where meta is the data). Postgres first, the
  // tightened meta before COMMIT (D1), the record's meta as the projection
  // after it, plus a fenced EXPIRE of every key when the lifespan changed.
  let prior: string | null = null
  let result: SessionMeta
  try {
    result = await withSessionMutation(c, { label: 'settings', redisLock: { waitMs: 3000 }, caller: identity }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!isHostByIdentity(ctx.meta!, caller)) throw refuse(403, 'only the host can change session settings')
      const base = ctx.row ? metaFromRecord(ctx.row, await readRecordRoles(tx, c), ctx.meta) : ctx.meta!
      const next = applySettings(base, body, isPro)
      prior = base.coverPhotoUrl || null
      if (newCoverUrl !== undefined) next.coverPhotoUrl = newCoverUrl || undefined
      if (ctx.row) {
        await tx.session.update({ where: { id: ctx.row.id }, data: sessionSettingsColumns(next) })
        await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(tightened(ctx.meta!, next)), { XX: true, KEEPTTL: true }) })
        return metaFromRecord((await readLiveRow(tx, c))!, await readRecordRoles(tx, c), ctx.meta)
      }
      await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(next), { XX: true, KEEPTTL: true }) })
      if (next.lifespan !== base.lifespan) await expireSessionKeys(ctx.fence!, c, next.lifespan)
      return next
    }, async (ctx, next) => {
      if (!ctx.row) return
      await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(next), { XX: true, KEEPTTL: true }) })
      if (next.lifespan !== ctx.meta!.lifespan) await expireSessionKeys(ctx.fence!, c, next.lifespan)
    })
  } catch (err) {
    if (newCoverUrl) reclaimImage(newCoverUrl).catch(() => {})
    return contractFailure(err, c, { label: 'settings' })
  }
  if (newCoverUrl !== undefined && prior && prior !== newCoverUrl) reclaimImage(prior).catch(() => {})
  return NextResponse.json({ ok: true, meta: result })
}
