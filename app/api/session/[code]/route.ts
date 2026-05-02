import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { resolveIdentity } from '@/lib/identity'
import { isHostByIdentity, type SessionMeta } from '@/lib/session'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const users = await redis.sMembers(k.users(c))
  const ttlSeconds = await redis.ttl(k.meta(c))
  return NextResponse.json({ ...JSON.parse(raw), code: c, users, ttlSeconds })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName, targetUser, action } = await req.json()

  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw) as SessionMeta

  // Authorize the caller as the current host (id-first, name fallback).
  const callerIdentity = await resolveIdentity(c, req, session, userName ?? null)
  const callerIsHost = !!callerIdentity && (
    (meta.hostUserId && callerIdentity.id === `u:${meta.hostUserId}`) ||
    (!meta.hostUserId && callerIdentity.displayName === meta.host)
  )
  if (!callerIsHost) {
    return NextResponse.json({ error: 'only the host can assign roles' }, { status: 403 })
  }

  // Resolve the target user's identity from the session's identities map so
  // we can mutate coHostIds (the trust anchor) alongside the legacy coHosts
  // display-name list.
  const idsByName = await redis.hGetAll(k.identities(c))
  const targetId = Object.entries(idsByName).find(([, name]) => name === targetUser)?.[0] || null

  const coHosts: string[] = meta.coHosts || []
  const coHostIds: string[] = meta.coHostIds || []

  if (action === 'add-cohost') {
    if (!coHosts.includes(targetUser)) coHosts.push(targetUser)
    if (targetId && !coHostIds.includes(targetId)) coHostIds.push(targetId)
  } else if (action === 'remove-cohost') {
    const ix = coHosts.indexOf(targetUser); if (ix !== -1) coHosts.splice(ix, 1)
    if (targetId) {
      const idx = coHostIds.indexOf(targetId); if (idx !== -1) coHostIds.splice(idx, 1)
    }
  } else if (action === 'transfer-host') {
    // Old host becomes co-host. New host: by display name (legacy) and id
    // (when known). The previous host's display name comes from the resolved
    // identity, not the request body, so dropping userName from the body is
    // safe.
    meta.host = targetUser
    meta.hostUserId = targetId?.startsWith('u:') ? Number(targetId.slice(2)) : null
    meta.coHosts = callerIdentity ? [callerIdentity.displayName] : []
    meta.coHostIds = callerIdentity ? [callerIdentity.id] : []
  }

  if (action !== 'transfer-host') {
    meta.coHosts = coHosts
    meta.coHostIds = coHostIds
  }

  // Mirror the role into Postgres for any logged-in target user. Hosts get
  // 'host', co-hosts 'co_host', everyone else 'taster' (default at row create).
  if (targetId?.startsWith('u:')) {
    const targetUserId = Number(targetId.slice(2))
    let role: 'host' | 'co_host' | 'taster' = 'taster'
    if (action === 'transfer-host') role = 'host'
    else if (action === 'add-cohost') role = 'co_host'
    else if (action === 'remove-cohost') role = 'taster'
    try {
      await prisma.sessionMember.update({
        where: { userId_sessionCode: { userId: targetUserId, sessionCode: c } },
        data: { role },
      })
    } catch { /* member may not exist yet; visit upsert will create with default */ }
  }
  // If we just demoted the previous host on transfer, downgrade them too.
  if (action === 'transfer-host' && callerIdentity?.id.startsWith('u:')) {
    const prevHostUserId = Number(callerIdentity.id.slice(2))
    try {
      await prisma.sessionMember.update({
        where: { userId_sessionCode: { userId: prevHostUserId, sessionCode: c } },
        data: { role: 'co_host' },
      })
    } catch {}
  }

  await redis.set(k.meta(c), JSON.stringify(meta), { EX: 48 * 3600 })
  return NextResponse.json({ ok: true, meta })
}
