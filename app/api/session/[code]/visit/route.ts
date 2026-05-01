import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { getSessionMeta, pgUpsertSession, isHostByIdentity } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { userIdentityId } from '@/lib/identity'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  if (!session?.user) return NextResponse.json({ ok: true })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // Mirror logged-in user into the Redis participant set so any entry path
  // (rejoin link, direct URL) reflects participation, not just /api/session/join.
  if (session.user.name) {
    try {
      await redis.sAdd(k.users(c), session.user.name)
      await touchWithMeta(c)
    } catch {}
  }

  // Persist the role at join time. Hosts get role='host' so future archival /
  // co-host audits can reconstruct who had what permissions in this session.
  const identity = { id: userIdentityId(session.user.id), displayName: session.user.name, kind: 'user' as const }
  const role = isHostByIdentity(meta, identity) ? 'host' : 'taster'

  try {
    await pgUpsertSession(c, meta)
    await prisma.sessionMember.upsert({
      where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: c } },
      create: { userId: Number(session.user.id), sessionCode: c, role },
      update: {},
    })
  } catch (err) {
    console.error('visit error:', err)
  }
  return NextResponse.json({ ok: true })
}
