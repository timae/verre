import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { type SessionMeta, isHostByIdentity } from '@/lib/session'
import { acquireBanLock, releaseBanLock } from '@/lib/sessionBan'
import { normalizeCode } from '@/lib/sessionCode'
import { TOMBSTONE_NAME } from '@/lib/accountDelete'
import { isSameOrigin } from '@/lib/csrf'
import { blockPairIds } from '@/lib/userBlock'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'

// Inlined S3 reclaim — same pattern as app/api/checkins/[id]/route.ts and
// lib/session.ts. Adding a third named export to lib/s3.ts trips a Next 15.5 /
// webpack 5.98 bundling bug; keeping copies here until that's fixed upstream.
const _S3_ENDPOINT = process.env.S3_ENDPOINT
const _S3_BUCKET = process.env.S3_BUCKET
const _s3 = _S3_ENDPOINT
  ? new S3Client({
      endpoint: _S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!_s3 || !_S3_BUCKET || !url || !_S3_ENDPOINT) return
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await _s3.send(new DeleteObjectCommand({ Bucket: _S3_BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] reclaimImage failed:', { key, err })
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const session = await auth()
  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const caller = p.identity

  // Participants come from the identities map (id-keyed, the authoritative
  // source). The legacy `users` set is no longer written to.
  const idsByName = await redis.hGetAll(k.identities(c))
  // Logged-in participants — their numeric userIds drive both block
  // resolution (below) and the brought-by-avatar gate.
  const participantUserIds: number[] = []
  for (const id of Object.keys(idsByName)) {
    if (id.startsWith('u:')) {
      const n = Number(id.slice(2))
      if (Number.isInteger(n) && n > 0) participantUserIds.push(n)
    }
  }
  const ttlSeconds = await redis.ttl(k.meta(c))

  // Ban count: only sent to host/cohost callers (others have no UI for
  // it). Drives the conditional render of the BannedUsersSection on the
  // client — section appears the moment a ban exists, disappears when
  // the last unban happens. Polled via the existing 5s session GET
  // refetch, so cross-host ban events propagate without a dedicated
  // socket. Free for non-pro sessions (default 48h TTL); also works for
  // pro lifespans (72h/1w/unlimited) — the polling cadence is
  // client-side and independent of session TTL.
  const meta = JSON.parse(raw) as SessionMeta
  const isHost = isHostByIdentity(meta, caller)
  const banCount = isHost ? await redis.sCard(k.bans(c)) : 0

  // Viewer's block-pair set, scoped to identity-ids of participants in
  // this session. Sent to the client so the participants list and
  // Compare screen can apply the block render rules (anon-style for
  // blocker-as-host, 🚫 prefix for blocked-as-host, hide non-host
  // participants in either direction). Only logged-in viewers have a
  // block-pair set — anon viewers never appear in user_blocks.
  //
  // SECURITY: these arrays carry the viewer's block-pair list (scoped
  // to this session). They MUST NOT be logged, mirrored to analytics,
  // or stored in any shared cache. The Cache-Control header below
  // forces a private no-store on the whole response for this reason.
  const viewerUserId = session?.user
    ? (() => {
        const n = Number(session.user.id)
        return Number.isInteger(n) && n > 0 ? n : null
      })()
    : null

  const blockPairs = viewerUserId !== null ? await blockPairIds(viewerUserId) : null

  const viewerBlocksOut: string[] = []
  const viewerBlocksIn: string[] = []
  if (blockPairs) {
    // Translate user-ids to identity-ids; only logged-in participants
    // (u:<id>) participate in blocks. Filter to participants actually
    // in this session so the client's render filter doesn't have to.
    const participantUserIdSet = new Set(participantUserIds)
    for (const uid of blockPairs.blockedByMe) {
      if (participantUserIdSet.has(uid)) viewerBlocksOut.push(`u:${uid}`)
    }
    for (const uid of blockPairs.blockingMe) {
      if (participantUserIdSet.has(uid)) viewerBlocksIn.push(`u:${uid}`)
    }
  }

  // Brought-by avatar imageUrl resolution. We deliberately DO NOT extend
  // the "session participation > profile tier" exception that already
  // applies to display names + ratings: avatars are stronger identity
  // than a session-chosen display name, and a user's tier choice should
  // hold here. Block beats tier (handled first via blockPairs); tier
  // gates via the same batch composition used by /api/feed. Anon viewer
  // (viewerUserId === null) only sees `public-internet` avatars. Self
  // always sees their own. When the gate denies, imageUrl stays null and
  // the client falls back to the initial letter (same render as today).
  const imageUrlByUserId = new Map<number, string>()
  if (participantUserIds.length > 0) {
    const [visMap, viewerMap, users] = await Promise.all([
      batchLoadVisibilities(participantUserIds),
      resolveProfileViewerBulk(participantUserIds, viewerUserId),
      prisma.user.findMany({
        where: { id: { in: participantUserIds } },
        select: { id: true, imageUrl: true },
      }),
    ])
    const fofCandidates = participantUserIds.filter(id => visMap.get(id)?.fofEnabled === true)
    const fofSet = fofCandidates.length > 0 && viewerUserId !== null
      ? await viewerFofAuthorSet(viewerUserId, fofCandidates)
      : new Set<number>()
    const urlById = new Map<number, string>()
    for (const u of users) {
      if (u.imageUrl) urlById.set(u.id, u.imageUrl)
    }
    for (const profileId of participantUserIds) {
      const url = urlById.get(profileId)
      if (!url) continue
      // Self: always visible.
      if (viewerUserId !== null && profileId === viewerUserId) {
        imageUrlByUserId.set(profileId, url)
        continue
      }
      // Block beats tier — block-pair (either direction) drops the avatar.
      if (blockPairs && (blockPairs.blockedByMe.has(profileId) || blockPairs.blockingMe.has(profileId))) continue
      const settings = visMap.get(profileId)
      if (!settings) continue
      const base = viewerMap.get(profileId) ?? { id: viewerUserId, followsProfile: false, profileFollowsViewer: false }
      const viewer = {
        id: base.id ?? viewerUserId,
        followsProfile: base.followsProfile,
        profileFollowsViewer: base.profileFollowsViewer,
        isFofOfProfile: settings.fofEnabled ? fofSet.has(profileId) : undefined,
      }
      if (canViewProfile(settings.visibility, viewer, settings.fofEnabled)) {
        imageUrlByUserId.set(profileId, url)
      }
    }
  }

  const participants = Object.entries(idsByName).map(([id, displayName]) => {
    let imageUrl: string | null = null
    if (id.startsWith('u:')) {
      const n = Number(id.slice(2))
      if (Number.isInteger(n)) {
        const url = imageUrlByUserId.get(n)
        if (url) imageUrl = url
      }
    }
    return { id, displayName, imageUrl }
  })

  return NextResponse.json(
    {
      ...meta,
      code: c,
      participants,
      ttlSeconds,
      viewerBlocksOut,
      viewerBlocksIn,
      banCount,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { targetId: targetIdFromBody, action, role: roleFromBody } = body as Record<string, unknown>

  // Banned/kicked callers get the `removed` bounce header (same as the
  // polled GETs and wine routes) so their client reroutes to
  // /join/<C>?removed=1 instead of seeing a bare 403.
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const callerIdentity = pp.identity

  // Serialize meta read-modify-write against concurrent role mutations
  // and kick/ban operations (which also mutate coHostIds/providerIds via
  // sessionWipe). Without the lock two strict-host calls could each read
  // the same starting meta, derive divergent coHostIds/providerIds sets,
  // and the later write would silently clobber the earlier.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json(
      { error: 'busy, try again' },
      { status: 429, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '1' } },
    )
  }
  try {
    const raw = await redis.get(k.meta(c))
    if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const meta = JSON.parse(raw) as SessionMeta

    // Coarse moderator gate inside the lock — fresh meta is the
    // authoritative view of cohost membership. Closes the enumeration
    // oracle that would otherwise let a non-participant probe `targetId:
    // u:<n>` and distinguish session members (400 unknown-target) from
    // non-members (403). Action-specific strict-host gates run below.
    const strictHostNow = !!(
      (meta.hostIdentityId && callerIdentity.id === meta.hostIdentityId) ||
      (meta.hostUserId && callerIdentity.id === `u:${meta.hostUserId}`)
    )
    const cohostNow = !!meta.coHostIds?.includes(callerIdentity.id)
    if (!strictHostNow && !cohostNow) {
      return NextResponse.json({ error: 'only the host or a co-host can assign roles' }, { status: 403 })
    }

    // Action-specific strict-host pre-check BEFORE target resolution.
    // Closes an enumeration oracle a cohost could otherwise use to probe
    // `targetId: u:<n>` and tell from the response code (400
    // unknown-target vs 403 wrong-role) whether the user is in the
    // session: for actions that are strict-host-only regardless of the
    // target's identity, the answer must be 403 either way. Cohost
    // attempting to demote another cohost (touchesCohost on set-role
    // with newRole=taster|provider) still requires target resolution,
    // but the blast radius is contained — cohosts already see the
    // session identities map.
    if (action === 'set-role' && roleFromBody === 'co_host' && !strictHostNow) {
      return NextResponse.json({ error: 'only the host can assign or remove the co-host role' }, { status: 403 })
    }

    // Resolve the target by id — must be an identities-map entry, the
    // trust source. Display-name lookup (`targetUser`) was removed
    // because names are presentation-only per CLAUDE.md.
    const idsByName = await redis.hGetAll(k.identities(c))
    // Guard against prototype property names (`__proto__`, `constructor`,
    // `toString`) — without hasOwnProperty, those would resolve to
    // Object.prototype members (truthy), letting a host plant junk
    // identity-ids into coHostIds/providerIds via a crafted body.
    let targetId: string | null = null
    if (
      typeof targetIdFromBody === 'string' &&
      targetIdFromBody &&
      Object.hasOwn(idsByName, targetIdFromBody)
    ) {
      targetId = targetIdFromBody
    }
    if (!targetId) {
      return NextResponse.json({ error: 'targetId required' }, { status: 400 })
    }

    // Self-target rejected for all role mutations.
    if (targetId === callerIdentity.id) {
      return NextResponse.json({ error: 'cannot change your own role' }, { status: 400 })
    }
    // Strict host cannot be re-roled — would orphan the session. The
    // only path that moves the host slot is account-deletion (which
    // tombstones host fields and softens the strict-host check so
    // cohosts inherit delete rights via `lib/accountDelete.ts`).
    const targetIsStrictHost = (
      (meta.hostIdentityId && targetId === meta.hostIdentityId) ||
      (meta.hostUserId && targetId === `u:${meta.hostUserId}`)
    )

    // Only `set-role` is supported — `transfer-host` was removed
    // because no UI calls it and the host-handoff case is covered by
    // account-deletion's tombstone mechanism.
    if (action !== 'set-role') {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
    if (targetIsStrictHost) {
      return NextResponse.json({ error: 'cannot change the host\'s role' }, { status: 400 })
    }
    if (roleFromBody !== 'taster' && roleFromBody !== 'co_host' && roleFromBody !== 'provider') {
      return NextResponse.json({ error: 'role must be taster, co_host, or provider' }, { status: 400 })
    }
    const newRole = roleFromBody as 'taster' | 'co_host' | 'provider'
    const currentRole: 'taster' | 'co_host' | 'provider' =
      meta.coHostIds?.includes(targetId) ? 'co_host'
      : meta.providerIds?.includes(targetId) ? 'provider'
      : 'taster'
    if (currentRole === newRole) {
      return NextResponse.json(
        { ok: true, meta },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    // Locked transition rule: any role mutation that adds or removes the
    // cohost designation requires strict-host. Demoting a cohost to taster
    // or provider still requires target resolution (the residual leak:
    // bad-target → 400, real-cohost-target → 403 — accepted because
    // cohosts already see the identities map via the session GET).
    const touchesCohost = newRole === 'co_host' || currentRole === 'co_host'
    if (touchesCohost && !strictHostNow) {
      return NextResponse.json({ error: 'only the host can assign or remove the co-host role' }, { status: 403 })
    }

    // Apply role change to meta. coHostIds and providerIds are mutually
    // exclusive — strip from both first, then add to the destination
    // list (if any).
    meta.coHostIds = (meta.coHostIds ?? []).filter(id => id !== targetId)
    meta.providerIds = (meta.providerIds ?? []).filter(id => id !== targetId)
    if (newRole === 'co_host') meta.coHostIds.push(targetId)
    else if (newRole === 'provider') meta.providerIds.push(targetId)

    // Mirror to Postgres session_members.role for logged-in targets.
    if (targetId.startsWith('u:')) {
      const targetUserId = Number(targetId.slice(2))
      try {
        await prisma.sessionMember.upsert({
          where: { userId_sessionCode: { userId: targetUserId, sessionCode: c } },
          create: { userId: targetUserId, sessionCode: c, role: newRole },
          update: { role: newRole },
        })
      } catch (err) { console.error('set-role mirror failed:', err) }
    }

    // KEEPTTL preserves the session's existing TTL (which may be 72h / 1w /
    // unlimited for pro hosts). Hardcoding an EX value would silently
    // downgrade any longer lifespan on every role toggle.
    await redis.set(k.meta(c), JSON.stringify(meta), { KEEPTTL: true })
    return NextResponse.json(
      { ok: true, meta },
      // Response carries coHostIds/providerIds which vary per-session
      // and arrive in the meta envelope. Match the GET cache posture so
      // intermediaries don't ever serve a stale role-mutation result.
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } finally {
    await releaseBanLock(c)
  }
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
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw) as SessionMeta

  // Banned/kicked callers get the `removed` bounce header (same protocol
  // as the polled GETs and wine routes). Without this a banned host
  // (impossible today, but defense-in-depth) or a banned cohost trying
  // to delete the session would see a bare 403 instead of bouncing.
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const callerIdentity = pp.identity
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
  let reclaimUrls: string[] = []
  try {
    reclaimUrls = await prisma.$transaction(async (tx): Promise<string[]> => {
      const sessionRow = await tx.session.findUnique({ where: { code: c } })
      if (!sessionRow) return []
      const sessionId = sessionRow.id

      // Capture image URLs of wines nobody bookmarked. Bookmarked wines stay
      // reachable from /me/saved so we keep their image; orphans lose their
      // last reader the moment this session is gone, so the bytes can go.
      // Race window: a bookmark INSERT racing this tx (READ COMMITTED) could
      // land after this SELECT but before commit, leaving the bookmarker with
      // a wine row whose image we then reclaim. Narrow (single-user clicking
      // bookmark in the seconds during host delete) and acceptable.
      const orphanImages = await tx.$queryRaw<{ image_url: string }[]>`
        SELECT image_url FROM wines
        WHERE session_id = ${sessionId}
          AND image_url IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = wines.id)
      `

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

      return orphanImages.map(r => r.image_url).filter(Boolean)
    })
  } catch (err) {
    console.error('session delete (postgres) error:', err)
  }

  // Reclaim S3 objects fire-and-forget after commit. If the transaction rolled
  // back, reclaimUrls is [] so nothing happens. If S3 fails, the row is
  // already gone — orphan bytes for a future cleanup, never broken DB state.
  for (const url of reclaimUrls) reclaimImage(url)

  // Wipe Redis. After this, every endpoint serving this session returns 404.
  try {
    const keys = await redis.keys(`s:${c}:*`)
    if (keys.length > 0) await redis.del(keys)
  } catch (err) {
    console.error('session delete (redis) error:', err)
  }

  return NextResponse.json({ ok: true })
}
