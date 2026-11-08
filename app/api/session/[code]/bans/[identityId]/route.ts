import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveAuthorized, authUnavailable, isValidIdentityId } from '@/lib/identity'
import { isHostByIdentity } from '@/lib/session'
import { withSessionMutation, refuse } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'
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
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const session = await resolveUser(req)
  const identity = await resolveAuthorized(c, req, session, opened.meta)
  if (identity === 'unavailable') return authUnavailable()
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(opened.meta, identity)) {
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

  // Record first, then the cache (redis-rehydration § 4.2 / plan § 1.4), inside
  // the mutation contract: the durable ban row goes and COMMITs, then the SREM
  // is the projection — an SREM that never runs leaves a Redis entry that only
  // DENIES (the cache erring closed) until reconciliation. For an anonymous
  // target, and in a Redis-only session, Redis is the authority: the SREM is
  // the change itself, fenced, inside the transaction.
  try {
    await withSessionMutation(c, { label: 'unban', redisLock: { waitMs: 3000 }, caller: identity }, async (tx, ctx) => {
      if (ctx.callerStatus !== 'ok' || !isHostByIdentity(ctx.meta!, ctx.caller)) throw refuse(403, 'forbidden')
      if (ctx.row) await tx.$executeRaw`DELETE FROM session_bans WHERE session_code = ${c} AND identity_id = ${targetId}`
      if (!ctx.row || targetId.startsWith('a:')) await ctx.fence!.exec(m => { m.sRem(k.bans(c), targetId) })
    }, async (ctx) => {
      if (ctx.row && !targetId.startsWith('a:')) await ctx.fence!.exec(m => { m.sRem(k.bans(c), targetId) })
    })
  } catch (err) {
    return contractFailure(err, c, { busy: 409, label: 'unban' })
  }
  return NextResponse.json({ ok: true }, { headers: noStore })
}
