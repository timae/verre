import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, requireParticipant, authInvalid } from '@/lib/identity'
import { isHostByIdentity, type SessionMeta } from '@/lib/session'
import { TOMBSTONE_NAME } from '@/lib/accountDelete'

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const session = await auth()
  const caller = await requireParticipant(c, req, session)
  if (!caller) return authInvalid('not a participant')

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
  const { targetId: targetIdFromBody, targetUser, action } = await req.json()

  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw) as SessionMeta

  // Authorize the caller as the *current host* — strictly. Co-hosts can do
  // wine and settings work via isHostByIdentity, but role assignment is
  // intentionally host-only to avoid privilege-escalation chains (cohost A
  // promoting cohost B, etc.). Match against hostIdentityId, falling back
  // to hostUserId for sessions whose meta predates the identityId field.
  const callerIdentity = await resolveIdentity(c, req, session)
  if (!callerIdentity) return authInvalid()
  const callerIsHost = (
    (meta.hostIdentityId && callerIdentity.id === meta.hostIdentityId) ||
    (meta.hostUserId && callerIdentity.id === `u:${meta.hostUserId}`)
  )
  if (!callerIsHost) {
    return NextResponse.json({ error: 'only the host can assign roles' }, { status: 403 })
  }

  // Resolve the target by id (preferred) or by name. Both must resolve to
  // an identities-map entry — the trust source. targetName is only used to
  // populate meta.host on transfer-host (display label).
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
    }
  }
  if (!targetId || !targetName) {
    return NextResponse.json({ error: 'targetId or targetUser required' }, { status: 400 })
  }

  // Reject unknown actions loudly. Without this guard a typo (e.g.
  // "addCohost" instead of "add-cohost") falls through to the no-op
  // path and returns 200 with the unchanged meta — so the caller
  // thinks the change took effect when nothing happened.
  if (action !== 'add-cohost' && action !== 'remove-cohost' && action !== 'transfer-host') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  const coHostIds: string[] = meta.coHostIds || []

  if (action === 'add-cohost') {
    if (!coHostIds.includes(targetId)) coHostIds.push(targetId)
  } else if (action === 'remove-cohost') {
    const idx = coHostIds.indexOf(targetId); if (idx !== -1) coHostIds.splice(idx, 1)
  } else if (action === 'transfer-host') {
    // Old host becomes co-host. The new host's identity-id is the trust
    // anchor; hostUserId stays for logged-in compatibility, host (display
    // name) is just a label.
    meta.host = targetName
    meta.hostUserId = targetId.startsWith('u:') ? Number(targetId.slice(2)) : null
    meta.hostIdentityId = targetId
    meta.coHostIds = [callerIdentity.id]
  }

  if (action !== 'transfer-host') {
    meta.coHostIds = coHostIds
  }

  // Mirror the role into Postgres for any logged-in target user. Upsert (not
  // update) so a promotion that happens before the target's first /visit
  // still lands cleanly — without this, Prisma logs P2025 and the role
  // defaults to 'taster' until the target visits.
  if (targetId.startsWith('u:')) {
    const targetUserId = Number(targetId.slice(2))
    let role: 'host' | 'co_host' | 'taster' = 'taster'
    if (action === 'transfer-host') role = 'host'
    else if (action === 'add-cohost') role = 'co_host'
    else if (action === 'remove-cohost') role = 'taster'
    try {
      await prisma.sessionMember.upsert({
        where: { userId_sessionCode: { userId: targetUserId, sessionCode: c } },
        create: { userId: targetUserId, sessionCode: c, role },
        update: { role },
      })
    } catch (err) { console.error('cohost role mirror failed:', err) }
  }
  // If we just demoted the previous host on transfer, downgrade them too.
  if (action === 'transfer-host' && callerIdentity.id.startsWith('u:')) {
    const prevHostUserId = Number(callerIdentity.id.slice(2))
    try {
      await prisma.sessionMember.upsert({
        where: { userId_sessionCode: { userId: prevHostUserId, sessionCode: c } },
        create: { userId: prevHostUserId, sessionCode: c, role: 'co_host' },
        update: { role: 'co_host' },
      })
    } catch (err) { console.error('prev-host downgrade failed:', err) }
  }

  await redis.set(k.meta(c), JSON.stringify(meta), { EX: 48 * 3600 })
  return NextResponse.json({ ok: true, meta })
}

// DELETE permanently removes a session and most of its data. Host-only
// (co-hosts cannot delete — same restriction as cohost role assignment).
//
// Retention rule: per (user, wine) pair, if the user bookmarked the wine,
// keep their rating row (so the bookmark detail still shows their score,
// notes, flavors). Delete every other rating row for those wines. HoF
// entries follow the rating: deleted when the corresponding rating is
// deleted, kept otherwise.
//
// Wines themselves are kept (orphaned with session_id = NULL) so bookmarked
// wines remain reachable from /me/saved with image, name, etc. intact.
//
// Lifetime counters on users do NOT decrement — that's the whole point of
// the snapshot column design.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()

  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw) as SessionMeta

  const callerIdentity = await resolveIdentity(c, req, session)
  if (!callerIdentity) return authInvalid()
  const callerIsHost = (
    (meta.hostIdentityId && callerIdentity.id === meta.hostIdentityId) ||
    (meta.hostUserId && callerIdentity.id === `u:${meta.hostUserId}`)
  )
  // Cohosts inherit the right to delete a session whose host has tombstoned
  // their account (host fields tombstoned and hostIdentityId/hostUserId both
  // null). Without this, an orphaned active session would be undeletable.
  const hostIsGone = !meta.hostIdentityId && !meta.hostUserId && meta.host === TOMBSTONE_NAME
  const callerIsCohost = !!meta.coHostIds?.includes(callerIdentity.id)
  if (!callerIsHost && !(hostIsGone && callerIsCohost)) {
    return NextResponse.json({ error: 'only the host can delete this session' }, { status: 403 })
  }

  // Postgres cleanup wrapped in a transaction so any failure rolls back the
  // whole set — no half-deleted state where, say, ratings are gone but the
  // session row remains. If the transaction throws, we still wipe Redis
  // below so the user gets the "session is gone" experience client-side.
  try {
    await prisma.$transaction(async (tx) => {
      const sessionRow = await tx.session.findUnique({ where: { code: c } })
      if (!sessionRow) return
      const sessionId = sessionRow.id

      // 1. Delete ratings whose (user, wine) is NOT bookmarked. Anonymous
      //    ratings only live in Redis; this only touches logged-in raters.
      await tx.$executeRaw`
        DELETE FROM ratings r
        USING wines w
        WHERE r.wine_id = w.id
          AND w.session_id = ${sessionId}
          AND r.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bookmarks b
            WHERE b.user_id = r.user_id AND b.wine_id = r.wine_id
          )
      `

      // 2. Delete HoF entries that correspond to ratings we just deleted.
      //    HoF rows are denormalized (wineName + userId), so the rule is
      //    symmetric: keep HoF when the rater bookmarked, drop otherwise.
      await tx.$executeRaw`
        DELETE FROM hall_of_fame h
        WHERE h.session_code = ${c}
          AND h.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bookmarks b JOIN wines w ON w.id = b.wine_id
            WHERE w.session_id = ${sessionId}
              AND b.user_id = h.user_id
              AND w.name = h.wine_name
          )
      `

      // 3. Orphan the wines (sessionId NULL). Schema's onDelete: SetNull
      //    would do this automatically when we delete the session row,
      //    but doing it explicitly is clearer.
      await tx.$executeRaw`UPDATE wines SET session_id = NULL WHERE session_id = ${sessionId}`

      // 4. Delete session_members rows for this session.
      await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${c}`

      // 5. Delete the session row itself.
      await tx.$executeRaw`DELETE FROM sessions WHERE id = ${sessionId}`
    })
  } catch (err) {
    console.error('session delete (postgres) error:', err)
  }

  // Wipe Redis. After this, every endpoint serving this session returns 404.
  try {
    const keys = await redis.keys(`s:${c}:*`)
    if (keys.length > 0) await redis.del(keys)
  } catch (err) {
    console.error('session delete (redis) error:', err)
  }

  return NextResponse.json({ ok: true })
}
