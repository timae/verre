import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, lifespanTTL } from '@/lib/redis'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()
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

  if (body.name !== undefined)        meta.name        = String(body.name        || '').trim().slice(0, 80)
  if (body.address !== undefined)     meta.address     = String(body.address     || '').trim().slice(0, 255)
  if (body.dateFrom !== undefined)    meta.dateFrom    = body.dateFrom    || null
  if (body.dateTo !== undefined)      meta.dateTo      = body.dateTo      || null
  if (body.timezone !== undefined)    meta.timezone    = String(body.timezone    || '').trim().slice(0, 64)
  if (body.description !== undefined) meta.description = String(body.description || '').trim().slice(0, 1000)
  if (body.link !== undefined)               meta.link                    = String(body.link || '').trim().slice(0, 512)
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
  if (body.hideLineup !== undefined)         meta.hideLineup              = !!body.hideLineup
  if (body.hideLineupMinutesBefore !== undefined) meta.hideLineupMinutesBefore = Number(body.hideLineupMinutesBefore) || 0
  // "Blind for all" — composes on top of meta.blind. NOT pro-gated
  // (running a blind tasting is fine for free hosts who happen to flip
  // an existing pro-blind session; only flipping a session TO blind needs
  // pro, which is gated above). Silently no-ops when meta.blind is false
  // — there's no rendered effect, so accept the value but it doesn't do
  // anything until blind is true.
  if (body.blindForEveryone !== undefined)        meta.blindForEveryone             = !!body.blindForEveryone

  if (body.lifespan !== undefined) {
    if (body.lifespan !== meta.lifespan && !isPro) {
      return NextResponse.json({ error: 'extended lifespan requires a pro account' }, { status: 403 })
    }
    meta.lifespan = body.lifespan
  }

  const ttl = lifespanTTL(meta.lifespan)
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: ttl })
  const keys = await redis.keys(`s:${c}:*`)
  for (const key of keys) await redis.expire(key, ttl)

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
      },
    })
  } catch {}

  return NextResponse.json({ ok: true, meta })
}
