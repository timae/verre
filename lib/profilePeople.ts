import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { checkRates, getClientIp } from '@/lib/rateLimit'
import { resolveProfileViewer, viewableProfiles } from '@/lib/profileVisibility'
import { parsePathId } from '@/lib/parsePathId'
import { blockScrub, friendsInCommon, momentsTogether } from '@/lib/peopleSql'

const PAGE = 30
const SEARCH_MIN = 2

// Shared handler for /api/users/[id]/followers and /following.
// ?mutual=mutual|non   filter on the reverse edge
// ?known=1             only people the VIEWER follows (someone else's list;
//                      ignored on your own): the app's "Only people you know"
// ?q=<query>           name substring (case-insensitive, min 2 chars)
// ?cursor=<userId>     pagination (descending user id)
//
// Logged-in only — anonymous viewers see profile basics + counts on /u/<id>
// but enumerating someone's social graph requires an account. Limited per
// user (60/min) with a per-IP backstop (300/min: accounts per address would
// otherwise multiply the budget), both charged after the 401.
//
// Per row (additive; the web reads the old fields): `imageUrl` + `xp` follow
// the LISTED person's own visibility (viewableProfiles: block, tier, circle;
// null when denied), `followsViewer`, `momentsTogether` (the together
// predicate, lib/peopleSql.ts) and `friendsInCommon` (only for admitted rows);
// the last two are null on your own row. The first page (no cursor, no q) of
// someone else's list carries `knownCount`.
export async function listProfilePeople(
  req: NextRequest,
  params: Promise<{ id: string }>,
  direction: 'followers' | 'following',
) {
  // Every return path carries `private, no-store` — the 404 branch in
  // particular varies by viewer (tier-denied vs not-exists), so a shared
  // cache must never serve one viewer's response to another.
  const noStore = { 'Cache-Control': 'private, no-store' }
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const viewerId = Number(session.user.id)

  const rl = await checkRates([
    { key: `rl:profile-people:u:${viewerId}:1m`, max: 60, windowSeconds: 60 },
    { key: `rl:profile-people:ip:${getClientIp(req)}:1m`, max: 300, windowSeconds: 60 },
  ])
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: noStore })

  const { id } = await params
  const profileId = parsePathId(id)
  if (profileId === null) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400, headers: noStore })
  }

  const gate = await resolveProfileViewer(profileId, viewerId)
  // 'shell' = profile exists but viewer can't see content — followers/
  // following list is content, so 404 (same shape as the doesn't-exist
  // path so a tier-denied viewer can't distinguish).
  if (gate.status !== 'ok') return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })

  const url = req.nextUrl
  const mutual = url.searchParams.get('mutual')
  const q = (url.searchParams.get('q') || '').trim().slice(0, 64)
  if (q && q.length < SEARCH_MIN) return NextResponse.json({ users: [], nextCursor: null }, { headers: noStore })
  const cursor = url.searchParams.get('cursor')
  const cursorId = cursor && Number.isInteger(Number(cursor)) ? Number(cursor) : null
  const own = profileId === viewerId
  const known = !own && url.searchParams.get('known') === '1'

  // For followers: rows where f.following_id = profileId; the "other" is f.follower_id.
  // For following: rows where f.follower_id  = profileId; the "other" is f.following_id.
  const otherCol = direction === 'followers' ? Prisma.sql`f.follower_id` : Prisma.sql`f.following_id`
  const fixedCol = direction === 'followers' ? Prisma.sql`f.following_id` : Prisma.sql`f.follower_id`

  // Mutual filter — the reverse edge of (profile, other) must (or must not) exist.
  const reverseFollower = direction === 'followers' ? Prisma.sql`${profileId}` : otherCol
  const reverseFollowing = direction === 'followers' ? otherCol : Prisma.sql`${profileId}`
  const mutualClause = mutual === 'mutual'
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM follows fr WHERE fr.follower_id = ${reverseFollower} AND fr.following_id = ${reverseFollowing})`
    : mutual === 'non'
    ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM follows fr WHERE fr.follower_id = ${reverseFollower} AND fr.following_id = ${reverseFollowing})`
    : Prisma.empty

  // Substring match — escape ILIKE wildcards so a literal `%`/`_` in `q`
  // doesn't act as a wildcard, then wrap in `%…%` for substring semantics.
  const qEscaped = q.replace(/[\\%_]/g, '\\$&')
  const qClause = q ? Prisma.sql`AND u.name ILIKE ${'%' + qEscaped + '%'}` : Prisma.empty
  const cursorClause = cursorId ? Prisma.sql`AND u.id < ${cursorId}` : Prisma.empty

  // Block pairs: no row with a block pair (either direction) between the
  // listed user and the profile owner OR the viewer, so the rows are
  // viewer-dependent; the tab COUNTS stay global (docs/dev/block.md). Every
  // viewer-relative count below uses the same scrub, so none can exceed its
  // rows. A NOT EXISTS (never an IN list): a power user's blocks don't
  // materialise into the query.
  const blockClause = Prisma.sql`AND ${blockScrub(profileId, viewerId, otherCol)}`
  const knownClause = Prisma.sql`AND EXISTS (SELECT 1 FROM follows fk WHERE fk.follower_id = ${viewerId} AND fk.following_id = ${otherCol})`

  const [rows, knownCount] = await Promise.all([
    prisma.$queryRaw<{ id: number; name: string; xp: number; image_url: string | null }[]>`
      SELECT u.id, u.name, u.xp, u.image_url
      FROM follows f
      JOIN users u ON u.id = ${otherCol}
      WHERE ${fixedCol} = ${profileId}
        ${mutualClause}
        ${known ? knownClause : Prisma.empty}
        ${qClause}
        ${cursorClause}
        ${blockClause}
      ORDER BY u.id DESC
      LIMIT ${PAGE + 1}
    `,
    // The same set as the rows' known filter, on the first page only.
    !own && !cursorId && !q
      ? prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM follows f
          WHERE ${fixedCol} = ${profileId}
            ${mutualClause}
            ${knownClause}
            ${blockClause}
        `.then(r => r[0]?.n ?? 0)
      : Promise.resolve(undefined),
  ])

  const slice = rows.slice(0, PAGE)
  const nextCursor = rows.length > PAGE ? String(slice[slice.length - 1].id) : null
  const sliceIds = slice.map(r => r.id)
  const others = sliceIds.filter(i => i !== viewerId)

  // The listed people's own gate (photo, XP, friends in common) + the
  // viewer's edges to them, the mute state (the web's row menu), the
  // profile's edge to them (the web's "Follows you", followers tab only) and
  // the moments together; friends in common only for the admitted rows.
  const [{ admitted, viewers }, myMutes, profileFollows, together] = await Promise.all([
    viewableProfiles(viewerId, sliceIds),
    sliceIds.length
      ? prisma.userMute.findMany({ where: { muterId: viewerId, mutedId: { in: sliceIds } }, select: { mutedId: true } })
          .then(r => new Set(r.map(m => m.mutedId)))
      : Promise.resolve(new Set<number>()),
    direction === 'followers' && sliceIds.length
      ? prisma.follow.findMany({ where: { followerId: profileId, followingId: { in: sliceIds } }, select: { followingId: true } })
          .then(r => new Set(r.map(f => f.followingId)))
      : Promise.resolve(null),
    momentsTogether(viewerId, others),
  ])
  const inCommon = await friendsInCommon(viewerId, others.filter(i => admitted.has(i)))

  // Response varies by viewer (rows, gated fields, lines). private no-store
  // so a CDN can't serve one viewer's list to another.
  return NextResponse.json(
    {
      users: slice.map(r => {
        const self = r.id === viewerId, sees = admitted.has(r.id), v = viewers.get(r.id)
        return {
          id: r.id,
          name: r.name,
          xp: sees ? r.xp : null,
          imageUrl: sees ? r.image_url : null,
          isFollowing: v?.followsProfile ?? false,
          viewerMutes: myMutes.has(r.id),
          profileFollowsThem: profileFollows ? profileFollows.has(r.id) : null,
          followsViewer: v?.profileFollowsViewer ?? false,
          momentsTogether: self ? null : together.get(r.id) ?? 0,
          friendsInCommon: self || !sees ? null : inCommon.get(r.id) ?? 0,
        }
      }),
      nextCursor,
      ...(knownCount === undefined ? {} : { knownCount }),
    },
    { headers: noStore },
  )
}
