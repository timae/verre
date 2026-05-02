import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, requireParticipant } from '@/lib/identity'
import { isHostByIdentity, type SessionMeta } from '@/lib/session'

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const session = await auth()
  const caller = await requireParticipant(c, req, session)
  if (!caller) return NextResponse.json({ error: 'not a participant' }, { status: 401 })

  // Participants come from the identities map (id-keyed, the authoritative
  // source). The legacy `users` set is no longer written to.
  const idsByName = await redis.hGetAll(k.identities(c))
  const participants = Object.entries(idsByName).map(([id, displayName]) => ({ id, displayName }))
  const ttlSeconds = await redis.ttl(k.meta(c))
  return NextResponse.json({ ...JSON.parse(raw), code: c, participants, ttlSeconds })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName, targetId: targetIdFromBody, targetUser, action } = await req.json()

  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw) as SessionMeta

  // Authorize the caller as the *current host* — strictly. Co-hosts can do
  // wine and settings work via isHostByIdentity, but role assignment is
  // intentionally host-only to avoid privilege-escalation chains (cohost A
  // promoting cohost B, etc.). Match against hostIdentityId (id-first),
  // hostUserId (logged-in legacy), or display name (anon-host legacy).
  const callerIdentity = await resolveIdentity(c, req, session, userName ?? null)
  const callerIsHost = !!callerIdentity && (
    (meta.hostIdentityId && callerIdentity.id === meta.hostIdentityId) ||
    (meta.hostUserId && callerIdentity.id === `u:${meta.hostUserId}`) ||
    (!meta.hostIdentityId && !meta.hostUserId && callerIdentity.displayName === meta.host)
  )
  if (!callerIsHost) {
    return NextResponse.json({ error: 'only the host can assign roles' }, { status: 403 })
  }

  // Resolve the target by id (preferred) or by name (legacy fallback for
  // older clients). Using the id avoids ambiguity when two participants
  // share a display name. Both code paths produce a `{targetId, targetName}`
  // pair anchored to the identities map — the trust source.
  const idsByName = await redis.hGetAll(k.identities(c))
  let targetId: string | null = null
  let targetName: string = ''
  if (typeof targetIdFromBody === 'string' && targetIdFromBody) {
    const registered = idsByName[targetIdFromBody]
    if (registered) {
      targetId = targetIdFromBody
      targetName = registered
    }
  }
  if (!targetId && typeof targetUser === 'string' && targetUser) {
    const found = Object.entries(idsByName).find(([, name]) => name === targetUser)
    if (found) {
      targetId = found[0]
      targetName = found[1]
    } else {
      // Target not in identities — fall back to using the raw name for the
      // legacy display-name lists. Loses the id-keyed guarantees, but keeps
      // older flows working until all clients send targetId.
      targetName = targetUser
    }
  }
  if (!targetName) {
    return NextResponse.json({ error: 'targetId or targetUser required' }, { status: 400 })
  }

  const coHosts: string[] = meta.coHosts || []
  const coHostIds: string[] = meta.coHostIds || []

  if (action === 'add-cohost') {
    if (!coHosts.includes(targetName)) coHosts.push(targetName)
    if (targetId && !coHostIds.includes(targetId)) coHostIds.push(targetId)
  } else if (action === 'remove-cohost') {
    const ix = coHosts.indexOf(targetName); if (ix !== -1) coHosts.splice(ix, 1)
    if (targetId) {
      const idx = coHostIds.indexOf(targetId); if (idx !== -1) coHostIds.splice(idx, 1)
    }
  } else if (action === 'transfer-host') {
    // Old host becomes co-host. The new host's identity-id is the trust
    // anchor; hostUserId stays for logged-in compatibility, host (display
    // name) is just a label.
    meta.host = targetName
    meta.hostUserId = targetId?.startsWith('u:') ? Number(targetId.slice(2)) : null
    meta.hostIdentityId = targetId || undefined
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
