import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, bumpLastSeen, unhideCarousel } from '@/lib/redis'
import { getSessionMeta, pgUpsertSession } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { userIdentityId, recordIdentity, authRemoved } from '@/lib/identity'
import { disambiguateDisplayName } from '@/lib/displayName.server'
import { isSameOrigin } from '@/lib/csrf'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
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

  // Ban / kick gate. Without this, a banned-or-kicked user opening the
  // session URL would have SessionShell call /visit on mount and we'd
  // re-add them to identities — effectively undoing the moderation. The
  // 401+X-Vr-Auth: removed response triggers sessionFetch to redirect
  // to /join/<C>?removed=1 where RemovedView takes over.
  if (await redis.sIsMember(k.bans(c), id)) {
    return authRemoved('removed from session')
  }
  if (await redis.sIsMember(k.kicked(c), id)) {
    return authRemoved('removed from session')
  }
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

  // Persist the role at join time. The strict-host check is by id; cohosts
  // get a distinct 'co_host' role so future archival audits can reconstruct
  // who had what permissions. Don't reuse isHostByIdentity here — it lumps
  // hosts and cohosts together, which would mislabel cohosts as host.
  const isStrictHost = (meta.hostIdentityId && meta.hostIdentityId === id)
    || (meta.hostUserId && userIdentityId(meta.hostUserId) === id)
  const isCohost = !!meta.coHostIds?.includes(id)
  const role: 'host' | 'co_host' | 'taster' = isStrictHost ? 'host' : isCohost ? 'co_host' : 'taster'

  try {
    await pgUpsertSession(c, meta)
    const userId = Number(session.user.id)
    // Pin this session as "Just visited" on the user's Moments home, and
    // un-hide it if they'd dismissed it from the carousel (re-engagement
    // brings the card back to the highlights).
    await bumpLastSeen(c, userId)
    await unhideCarousel(userId, c)
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
