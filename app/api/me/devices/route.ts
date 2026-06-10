import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { verifyPassword } from '@/lib/verifyPassword'
import { revokeAllSessions } from '@/lib/identityStore'
import { bucketStart } from '@/lib/lastSeen'

// GET — list the caller's active per-device sessions ("Connected devices"),
// the UNION of both session stores (§5a): web rows from user_sessions (uuid
// ids) + native Better Auth rows from auth_sessions (`ba:<int>` ids, so the
// per-id DELETE can route the revoke to the right store). Self-only by
// construction: WHERE userId = $me. Viewer-dependent, so the response is
// Cache-Control: private, no-store per app/api/CLAUDE.md.
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

  // Reading auth_sessions rows via Prisma is fine — only WRITES must go through
  // Better Auth (the rows exist in both stores; the Redis copy mirrors these).
  const [rows, baRows] = await Promise.all([
    prisma.userSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, deviceLabel: true, geoLabel: true, createdAt: true, lastSeenAt: true },
    }),
    prisma.authSession.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, updatedAt: true },
    }),
  ])

  // BA rows: ipAddress/userAgent hold READY-MADE labels, not raw values — the
  // session.create.before hook in lib/betterAuth.ts derives them at write time
  // (same privacy posture as user_sessions: no raw IP/UA at rest in either
  // store). lastSeenAt maps to BA's updatedAt, which the session create/update
  // hooks now FLOOR to the 5-min bucket AT WRITE TIME (lib/lastSeen.ts) — same
  // at-rest precision as web user_sessions.lastSeenAt. We re-bucket here on the
  // way out too (belt: the at-rest value is already on an edge, but re-flooring
  // is cheap and keeps this surface correct even if a future BA write path bumps
  // updatedAt without the hook). isCurrent is always false for BA rows in step 5:
  // the panel is web-only and a web viewer's current session is by definition a
  // user_sessions row. (A native viewer would see no row flagged current —
  // revisit with the native UI.)
  const baDevices = baRows.map(r => ({
    id: `ba:${r.id}`,
    deviceLabel: r.userAgent || 'Unknown device',
    geoLabel: r.ipAddress || null,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: new Date(bucketStart(r.updatedAt.getTime())).toISOString(),
    isCurrent: false,
  }))

  const devices = [
    ...rows.map(r => ({
      id: r.id,
      deviceLabel: r.deviceLabel,
      geoLabel: r.geoLabel,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      isCurrent: r.id === currentSessionId,
    })),
    ...baDevices,
  ].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))

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
  // bulk; CI-enforced; it also fans out to ALL Better Auth sessions, both
  // stores). currentSessionId is always present for web callers: a valid web
  // session always carries a userSessionId (the auth gate strips any token
  // without one). A NATIVE caller has none and 401s above — native
  // "sign out everywhere" is a step-6+ surface.
  const revokedCount = await revokeAllSessions(userId, currentSessionId, 'revoke_all')
  return NextResponse.json({ revoked: revokedCount })
}
