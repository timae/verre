import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, lifespanTTL, scanKeys } from '@/lib/redis'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { applySessionFields } from '@/lib/sessionFields'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can change session settings' }, { status: 403 })
  }

  const isPro = !!(session?.user as { pro?: boolean })?.pro

  // Detail fields (name/address/dates/timezone/description/link/hideLineup)
  // apply via the helper shared with POST /api/session — validators (scrub,
  // cleanUrl scheme guard, length caps) live in lib/sessionFields.ts.
  const fieldError = applySessionFields(meta, body)
  if (fieldError) return NextResponse.json({ error: fieldError }, { status: 400 })

  // Pro-gated settings (blind, lifespan): a non-pro caller may submit
  // the current value (no-op, e.g. a cohost saving unrelated edits with
  // the full settings payload) but cannot change it in either direction.
  // Symmetric gate — both enabling and disabling require pro. Per-wine
  // reveal-all already covers the "show everything in a blind session"
  // case without needing to flip the meta.blind flag, so disabling is
  // not a workflow the non-pro caller actually needs.
  if (body.blind !== undefined) {
    const newBlind = !!body.blind
    if (newBlind !== meta.blind && !isPro) {
      return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
    }
    meta.blind = newBlind
    // Disabling blind also clears blindForEveryone. Otherwise the host could
    // disable blind, re-enable it later, and find themselves blinded again
    // because the stale flag persisted — a UX surprise. Keep blindForEveryone's
    // scope strictly within an active blind session.
    if (!newBlind) meta.blindForEveryone = false
  }
  // "Blind for all" — composes on top of meta.blind. NOT pro-gated
  // (running a blind tasting is fine for free hosts who happen to flip
  // an existing pro-blind session; only flipping a session TO blind needs
  // pro, which is gated above). Silently no-ops when meta.blind is false
  // — there's no rendered effect, so accept the value but it doesn't do
  // anything until blind is true.
  if (body.blindForEveryone !== undefined)        meta.blindForEveryone             = !!body.blindForEveryone

  // "Show who brought each impression" (Moment Setup). PRO-gated, symmetric
  // like blind: a change in EITHER direction requires pro. DEFAULT ON, so the
  // effective current value treats an absent flag as true. A non-pro caller
  // (host OR free cohost) can't flip it in either direction — they're locked at
  // whatever the host set, which may be OFF (a pro host hid it, a free cohost
  // now views it), so this is not a "can't hide it" gate but a "can't change
  // it" gate. A pure gate before any write, so a 403 orphans nothing.
  if (body.showProvenance !== undefined) {
    const newShow = !!body.showProvenance
    const curShow = meta.showProvenance !== false
    if (newShow !== curShow && !isPro) {
      // Direction-neutral: the gate blocks ANY change by a non-pro (hiding OR
      // re-showing an already-hidden moment), so a "hiding requires pro"
      // message misreads on the unhide attempt.
      return NextResponse.json({ error: 'changing impression attribution requires a pro account' }, { status: 403 })
    }
    meta.showProvenance = newShow
  }

  if (body.lifespan !== undefined) {
    // Same allow-list as create — without it a pro caller could persist a
    // junk string that lifespanTTL silently maps to 48h while meta records
    // the junk.
    if (typeof body.lifespan !== 'string' || !['48h', '72h', '1w', 'unlimited'].includes(body.lifespan)) {
      return NextResponse.json({ error: 'unsupported lifespan' }, { status: 400 })
    }
    if (body.lifespan !== meta.lifespan && !isPro) {
      return NextResponse.json({ error: 'extended lifespan requires a pro account' }, { status: 403 })
    }
    meta.lifespan = body.lifespan
  }

  // Cover photo LAST among the gates: every rejection path above is pure
  // (no side effects), so a 403 on blind/lifespan can't orphan an already-
  // uploaded cover. Data URL = replace, explicit null = remove. The prior
  // bytes are reclaimed only AFTER the meta + Postgres mirror writes
  // succeed (capture/commit/reclaim-after, root CLAUDE.md). Logged-in
  // hosts only — an anon-hosted session has no Postgres row, so its TTL
  // expiry would orphan the S3 bytes with no deletion path.
  let priorCoverUrl: string | null = null
  let coverChanged = false
  if (body.coverPhoto !== undefined) {
    if (!session?.user) {
      // Identity resolved (participant+host above) but the caller class
      // lacks the capability — permission-denied, not auth-invalid.
      return NextResponse.json({ error: 'sign in to change the cover photo' }, { status: 403 })
    }
    priorCoverUrl = meta.coverPhotoUrl || null
    if (body.coverPhoto === null) {
      meta.coverPhotoUrl = undefined
      coverChanged = !!priorCoverUrl
    } else {
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
      const newUrl = await uploadImage(`sessions/${c}_${Date.now()}`, body.coverPhoto).catch(() => '')
      if (!newUrl) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
      meta.coverPhotoUrl = newUrl
      coverChanged = priorCoverUrl !== newUrl
    }
  }

  const ttl = lifespanTTL(meta.lifespan)
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: ttl })
  // Re-applying the full TTL here is intended: a settings save may change
  // the lifespan, and re-stamping all keys keeps the session's expiry
  // coherent.
  const keys = await scanKeys(`s:${c}:*`)
  if (keys.length > 0) {
    const tx = redis.multi()
    for (const key of keys) tx.expire(key, ttl)
    await tx.exec()
  }

  let mirrorOk = true
  try {
    // Soft-deleted sessions have `code = NULL` (§8 contract), so the
    // updateMany below naturally targets only live rows. Explicit filter
    // documents intent and survives any future change to the scrub set.
    await prisma.session.updateMany({
      where: { code: c, deletedAt: null },
      data: {
        name:        meta.name        || null,
        blind:       !!meta.blind,
        blindForEveryone: !!meta.blindForEveryone,
        address:     meta.address     || null,
        dateFrom:    meta.dateFrom    ? new Date(meta.dateFrom) : null,
        dateTo:      meta.dateTo      ? new Date(meta.dateTo)   : null,
        timezone:    meta.timezone    || null,
        description: meta.description || null,
        link:        meta.link        || null,
        coverPhotoUrl: meta.coverPhotoUrl || null,
      },
    })
  } catch (err) {
    // Non-fatal: Redis is the live-session source of truth, so the live
    // /session/<code> surface is unaffected. The PG mirror repairs on the next
    // SUCCESSFUL settings PATCH — NOT on a visit/rate archive touch, whose
    // pgUpsertSession update path rewrites only `name`, never these columns.
    // A cover change is the case that bites: /api/me/sessions reads
    // cover_photo_url from Postgres, so a failed mirror means PG still holds
    // the PRIOR url. Surface it, and (below) DON'T reclaim the prior bytes —
    // deleting them would leave Moments home serving a dead image. The new
    // bytes stay addressable and are reclaimed on the next successful change.
    mirrorOk = false
    console.error('[session] cover/settings PG mirror failed', { code: c, coverChanged, err })
  }

  // Reclaim the replaced/removed cover bytes only once the mirror committed —
  // otherwise the prior url is still the live Postgres value. Fire-and-forget;
  // a transient S3 error must not fail the settings save.
  if (coverChanged && priorCoverUrl && mirrorOk) reclaimImage(priorCoverUrl).catch(() => {})

  return NextResponse.json({ ok: true, meta })
}
