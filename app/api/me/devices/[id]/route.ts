import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { parsePathUuid } from '@/lib/parsePathId'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { verifyPassword } from '@/lib/verifyPassword'
import { revokeOneSession } from '@/lib/identityStore'

type Ctx = { params: Promise<{ id: string }> }

// DELETE /api/me/devices/[id] — revoke one device.
//
// Revoking your OWN current session needs no password (it's just logging
// yourself out). Revoking a DIFFERENT device requires password re-auth, same
// shape as /api/me/account — prevents a cookie-thief from locking the real
// owner out before they notice. targetId always comes from the path; userId +
// currentSessionId come from the signed JWT, never the body.
//
// 404 on missing-or-wrong-owner (not 403): uuid keys already block enumeration,
// and 404 leaks nothing about which session ids exist for other users. Matches
// the leak-prevention posture in app/api/CLAUDE.md.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const currentSessionId = session.user.userSessionId
  const targetId = parsePathUuid((await params).id)
  if (!targetId) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const rl = await checkRate(`rl:devices:user:${userId}:1h`, 30, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Cross-device revoke requires password re-auth. Revoking the caller's own
  // current session is frictionless (just a logout).
  if (targetId !== currentSessionId) {
    const body = await req.json().catch(() => ({}))
    const password = typeof body?.password === 'string' ? body.password : ''
    const check = await verifyPassword(userId, password)
    if (!check.ok && check.reason === 'rate-limited') {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${formatWait(check.retryAfter)}.`, retryAfter: check.retryAfter },
        { status: 429, headers: { 'Retry-After': String(check.retryAfter) } },
      )
    }
    if (!check.ok) return NextResponse.json({ error: 'password incorrect' }, { status: 403 })
  }

  // Idempotent, owner-scoped revoke through revokeOneSession (the chokepoint).
  // The userId scoping is what makes 404-on-wrong-owner work: a target uuid
  // belonging to another user matches zero rows → count 0 → 404,
  // indistinguishable from "no such uuid".
  const revokedCount = await revokeOneSession(userId, targetId, 'manual')
  if (revokedCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ revoked: true })
}
