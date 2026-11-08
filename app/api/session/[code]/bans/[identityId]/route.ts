import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveUser } from '@/lib/resolveUser'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveIdentity, isValidIdentityId } from '@/lib/identity'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { removeBan, acquireBanLock, releaseBanLock } from '@/lib/sessionBan'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string; identityId: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// DELETE /api/session/<code>/bans/<identityId> — lift a ban. Idempotent.
// Authorization: host or cohost. Either can unban any target, including
// users banned by a different moderator (no per-row "banned by whom"
// attribution — once a ban is lifted, it's lifted).
//
// Lifts the bans-Set entry only. The user's data is already gone
// (deleted at ban time); unbanning doesn't restore it.
//
// Shares the 60/10min rate-limit budget with POST.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code, identityId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }
  // URL-decode the identity-id (path segment, may contain "%3A" for ":")
  const targetId = decodeURIComponent(identityId)
  if (!isValidIdentityId(targetId)) {
    return NextResponse.json({ error: 'invalid identityId' }, { status: 400, headers: noStore })
  }

  const rl = await checkRate(`rl:sessban:${identity.id}:10m`, 60, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many ban actions. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Record first, then the cache (redis-rehydration § 4.2): the durable ban
  // row goes, then the Redis SREM. A Postgres failure answers 500 with the
  // user still banned in both stores (retryable); an SREM that never runs after
  // the commit leaves a Redis entry that only DENIES — the cache erring closed.
  // Under the ban lock, like ban and promotion: promotion copies the Redis
  // bans set into session_bans while holding it, so an unban cannot delete
  // "no row yet", SREM, and then have promotion commit its older snapshot.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json({ error: 'another moderation action is in progress' }, { status: 409, headers: noStore })
  }
  try {
    try {
      await prisma.$executeRaw`DELETE FROM session_bans WHERE session_code = ${c} AND identity_id = ${targetId}`
    } catch (err) {
      console.error('[unban] session_bans delete failed', { code: c, err })
      return NextResponse.json({ error: 'could not lift the ban, try again' }, { status: 500, headers: noStore })
    }
    await removeBan(c, targetId)
  } finally {
    await releaseBanLock(c)
  }
  return NextResponse.json({ ok: true }, { headers: noStore })
}
