import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { verifyPassword } from '@/lib/verifyPassword'
import { revokeAllSessions } from '@/lib/identityStore'

// GET — list the caller's active per-device sessions ("Connected devices").
// Self-only by construction: WHERE userId = $me. Viewer-dependent, so the
// response is Cache-Control: private, no-store per app/api/CLAUDE.md.
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const currentSessionId = session.user.userSessionId

  const rl = await checkRate(`rl:devices:user:${userId}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter), 'Cache-Control': 'private, no-store' } },
    )
  }

  const rows = await prisma.userSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, deviceLabel: true, geoLabel: true, createdAt: true, lastSeenAt: true },
  })

  const devices = rows.map(r => ({
    id: r.id,
    deviceLabel: r.deviceLabel,
    geoLabel: r.geoLabel,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    isCurrent: r.id === currentSessionId,
  }))

  return NextResponse.json(
    { devices },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

// DELETE (no id) — "Sign out of all other devices." One password re-auth, one
// UPDATE. Keeps the caller's own current session alive. Separate, lower limit
// (10/h) than per-id DELETE because this is a single panic-button action, not
// list-clicking. Password comes from the body; userSessionId comes ONLY from
// the signed JWT (never body/header).
export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  // A valid session always carries a userSessionId (the auth gate strips any
  // token without one). The type is still optional, so guard the boundary.
  const currentSessionId = session.user.userSessionId
  if (!currentSessionId) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const rl = await checkRate(`rl:devices-all:user:${userId}:1h`, 10, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

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

  // Revoke everything except the current session, through revokeAllSessions
  // (the chokepoint — the only code allowed to write user_sessions.revokedAt in
  // bulk; CI-enforced; step 5 adds the Better Auth fan-out here). currentSessionId
  // is always present: a valid session always carries a userSessionId (the auth
  // gate strips any token without one), so there is no undefined-current case.
  const revokedCount = await revokeAllSessions(userId, currentSessionId, 'revoke_all')
  return NextResponse.json({ revoked: revokedCount })
}
