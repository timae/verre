import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { getSessionMeta, pgUpsertSession, isHostByIdentity } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { userIdentityId, recordIdentity } from '@/lib/identity'
import { disambiguateDisplayName } from '@/lib/displayName'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  if (!session?.user) return NextResponse.json({ ok: true })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // Mirror logged-in user into the Redis participant set on first visit so
  // every entry path (rejoin link, direct URL, /api/session/join) reflects
  // participation. Idempotent across re-entries via the identities map: if
  // this user-id is already registered in this session, reuse the stored
  // displayName instead of name-matching against the users set (which is
  // lossy for display-name collisions).
  const id = userIdentityId(session.user.id)
  let displayName = session.user.name || ''
  if (displayName) {
    try {
      const registered = await redis.hGet(k.identities(c), id)
      if (registered) {
        displayName = registered
      } else {
        displayName = await disambiguateDisplayName(c, displayName)
        await recordIdentity(c, { id, displayName, kind: 'user' })
      }
      await touchWithMeta(c)
    } catch {}
  }

  // Persist the role at join time. Hosts get role='host' so future archival /
  // co-host audits can reconstruct who had what permissions in this session.
  const identity = { id, displayName, kind: 'user' as const }
  const role = isHostByIdentity(meta, identity) ? 'host' : 'taster'

  try {
    await pgUpsertSession(c, meta)
    const userId = Number(session.user.id)
    const existing = await prisma.sessionMember.findUnique({
      where: { userId_sessionCode: { userId, sessionCode: c } },
    })
    await prisma.sessionMember.upsert({
      where: { userId_sessionCode: { userId, sessionCode: c } },
      create: { userId, sessionCode: c, role },
      update: {},
    })
    // First-ever join of this session by this user → bump joined counter.
    if (!existing) {
      await prisma.$executeRaw`
        UPDATE users SET lifetime_sessions_joined = lifetime_sessions_joined + 1
        WHERE id = ${userId}`
    }
  } catch (err) {
    console.error('visit error:', err)
  }
  return NextResponse.json({ ok: true, id, displayName })
}
