import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { BADGE_MAP } from '@/lib/badges'
import { decimalToNumber } from '@/lib/decimal'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'
import { mutedUserIds } from '@/lib/userMute'
import { blockPairIds } from '@/lib/userBlock'

const PAGE = 20

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  // Defense-in-depth: the SQL below uses prisma.$queryRaw's tagged template
  // form which parameterizes ${userId}, so this is already safe. But TypeScript
  // can't prevent a future caller from sneaking a non-integer through (e.g. via
  // a header or refactor that bypasses Number()). Reject anything that isn't a
  // positive integer up front so the SQL only ever sees a sane value.
  if (!Number.isInteger(userId) || userId < 1) {
    return NextResponse.json({ error: 'invalid session' }, { status: 401 })
  }

  // cursor must parse as a finite Date; bad input → 400 not 500.
  const cursorParam = req.nextUrl.searchParams.get('cursor')
  let cursor: Date
  if (cursorParam) {
    const d = new Date(cursorParam)
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: 'invalid cursor' }, { status: 400 })
    cursor = d
  } else {
    cursor = new Date()
  }

  // My network: explicit follows + tasting buddies (shared sessions). The
  // ${userId} interpolations below are parameterized by Prisma's tagged
  // template handling, not concatenated into the SQL string.
  const network = await prisma.$queryRaw<{ user_id: number }[]>`
    SELECT DISTINCT user_id FROM (
      SELECT ${userId}::integer AS user_id
      UNION
      SELECT following_id AS user_id FROM follows WHERE follower_id = ${userId}
      UNION
      SELECT sm2.user_id
      FROM session_members sm1
      JOIN session_members sm2 ON sm2.session_code = sm1.session_code
      WHERE sm1.user_id = ${userId} AND sm2.user_id <> ${userId}
    ) n
  `
  const networkIds = network.map(r => r.user_id)
  if (!networkIds.length) return NextResponse.json({ items: [], nextCursor: null })

  // Visibility pre-filter: trim networkIds down to authors the viewer can
  // actually see per their profile-visibility tier. Done up front so the
  // cursor reflects visible count, not raw count — otherwise a page of 20
  // could collapse to a handful of rows after post-filtering.
  // Batched: one query for visibilities, one for follows-out, one for
  // follows-in, optionally one for FoF reachability. Cost is O(networkSize)
  // not O(rowsPerPage), and constant in number of roundtrips.
  //
  // Mute filter: applied in the same pass. The viewer's mute set is
  // independent of tier — a `public-internet` user the viewer muted
  // gets filtered out the same as a `public-mutual` user they aren't
  // allowed to see. Composed multiplicatively: both checks must pass.
  //
  // Block filter: composed in the same pass. Block-pair authors (either
  // direction — viewer blocked author OR author blocked viewer) are
  // dropped before the visibility tier even runs. Block is the strictest
  // primitive.
  const [visMap, viewerMap, muteSet, blockPairs] = await Promise.all([
    batchLoadVisibilities(networkIds),
    resolveProfileViewerBulk(networkIds, userId),
    mutedUserIds(userId),
    blockPairIds(userId),
  ])
  const fofCandidates = networkIds.filter(id => visMap.get(id)?.fofEnabled === true)
  const fofSet = fofCandidates.length > 0
    ? await viewerFofAuthorSet(userId, fofCandidates)
    : new Set<number>()
  const allowedNetworkIds = networkIds.filter(authorId => {
    // Self-visibility: viewer always sees their own content. (Self-mute
    // and self-block are both rejected at the API + DB level, so the
    // viewer can't appear in their own mute/block sets.)
    if (authorId === userId) return true
    if (blockPairs.blockedByMe.has(authorId) || blockPairs.blockingMe.has(authorId)) return false
    if (muteSet.has(authorId)) return false
    const settings = visMap.get(authorId)
    if (!settings) return false
    const base = viewerMap.get(authorId) ?? { id: userId, followsProfile: false, profileFollowsViewer: false }
    // Clone so we never mutate the shared map values; isFofOfProfile is
    // a per-call hint, not state to carry on the underlying ProfileViewer.
    const viewer = {
      id: base.id ?? userId,
      followsProfile: base.followsProfile,
      profileFollowsViewer: base.profileFollowsViewer,
      isFofOfProfile: settings.fofEnabled ? fofSet.has(authorId) : undefined,
    }
    return canViewProfile(settings.visibility, viewer, settings.fofEnabled)
  })
  if (!allowedNetworkIds.length) return NextResponse.json({ items: [], nextCursor: null })

  // Checkins
  const checkins = await prisma.checkin.findMany({
    where: { userId: { in: allowedNetworkIds }, createdAt: { lt: cursor } },
    include: {
      user: { select: { id: true, name: true, xp: true, imageUrl: true } },
      _count: { select: { likes: true } },
      tags: { include: { user: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: PAGE,
  })

  // Which of these checkins has the current user already liked?
  const myLikes = new Set(
    (await prisma.checkinLike.findMany({
      where: { userId, checkinId: { in: checkins.map(c => c.id) } },
      select: { checkinId: true },
    })).map(l => l.checkinId)
  )

  // Like-count adjustment for block-pair likes. Locked design: a like
  // by user X on a check-in by user Y is invisible to ALL viewers (not
  // just the block-pair members) once a block exists between X and Y.
  // Globally symmetric — every viewer sees the same adjusted count.
  //
  // One batched query fetches the like-rows on the page's check-ins
  // that involve a block-pair edge between liker and check-in author;
  // we subtract those from each check-in's _count.likes.
  //
  // COUNT(DISTINCT cl.user_id) protects against a mutual A↔B block
  // (two user_blocks rows for the same pair) double-counting the same
  // like row.
  const checkinIds = checkins.map(c => c.id)
  const blockAdjustedLikeCount = new Map<number, number>()
  if (checkinIds.length > 0) {
    const blockHiddenLikes = await prisma.$queryRaw<{ checkin_id: number; n: bigint }[]>`
      SELECT cl.checkin_id AS checkin_id, COUNT(DISTINCT cl.user_id)::bigint AS n
      FROM checkin_likes cl
      JOIN checkins c ON c.id = cl.checkin_id
      JOIN user_blocks b
        ON (b.blocker_id = cl.user_id AND b.blocked_id = c.user_id)
        OR (b.blocker_id = c.user_id AND b.blocked_id = cl.user_id)
      WHERE cl.checkin_id = ANY(${checkinIds}::int[])
      GROUP BY cl.checkin_id
    `
    for (const r of blockHiddenLikes) blockAdjustedLikeCount.set(r.checkin_id, Number(r.n))
  }

  // Set of viewer-follows-author — gates the "had a sip" button per row.
  const myFollowing = new Set(
    (await prisma.follow.findMany({
      where: { followerId: userId, followingId: { in: checkins.map(c => c.user.id) } },
      select: { followingId: true },
    })).map(f => f.followingId)
  )

  // Block-pair tag filter is GLOBAL: a tag of user X on a check-in by
  // author Y is invisible to ALL viewers (not just the viewer's
  // block-pair set) once X↔Y has a block in either direction. Locked
  // design — match the like-count rule.
  //
  // One batched query collects every (author, tag-user) pair from the
  // page that has a block-pair edge; we filter tags per check-in.
  const tagAuthorPairs = checkins.flatMap(c => c.tags.map(t => ({ authorId: c.user.id, tagUserId: t.user.id })))
  // hiddenAuthorTag is a Set of "authorId:tagUserId" strings — fast O(1) lookup at render.
  const hiddenAuthorTag = new Set<string>()
  if (tagAuthorPairs.length > 0) {
    const authorIds = [...new Set(tagAuthorPairs.map(p => p.authorId))]
    const tagUserIds = [...new Set(tagAuthorPairs.map(p => p.tagUserId))]
    const rows = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: { in: authorIds }, blockedId: { in: tagUserIds } },
          { blockerId: { in: tagUserIds }, blockedId: { in: authorIds } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    for (const r of rows) {
      // Add both orderings — we'll look up by (author, tagUser) regardless
      // of which side of the user_blocks row the author was on.
      hiddenAuthorTag.add(`${r.blockerId}:${r.blockedId}`)
      hiddenAuthorTag.add(`${r.blockedId}:${r.blockerId}`)
    }
  }

  // Badge unlocks (last 30 days). Same allowed-author filter — a badge
  // unlock is metadata about a user, so a `public-mutual` profile's badge
  // shouldn't show up in a non-mutual's feed.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const badges = await prisma.userBadge.findMany({
    where: { userId: { in: allowedNetworkIds }, earnedAt: { lt: cursor, gt: thirtyDaysAgo } },
    include: { user: { select: { id: true, name: true, imageUrl: true } } },
    orderBy: { earnedAt: 'desc' },
    take: PAGE,
  })

  // Merge and sort
  const feedItems = [
    ...checkins.map(c => ({
      type: 'checkin' as const,
      createdAt: c.createdAt,
      author: c.user,
      checkin: {
        id: c.id, wineName: c.wineName, producer: c.producer, vintage: c.vintage,
        grape: c.grape, type: c.type, score: decimalToNumber(c.score), notes: c.notes, imageUrl: c.imageUrl,
        venueName: c.venueName, city: c.city, country: c.country,
        flavors: c.flavors, likeCount: Math.max(0, c._count.likes - (blockAdjustedLikeCount.get(c.id) ?? 0)), createdAt: c.createdAt,
        // Tag filter: drop GLOBALLY block-pair tags. A tag of user X on
        // a check-in by author Y is invisible to all viewers (same rule
        // as the like-count subtraction). Hidden via the (author,
        // tag-user) lookup set computed above. Render-time only — the
        // tag row stays in DB.
        tags: c.tags?.filter(t => !hiddenAuthorTag.has(`${c.user.id}:${t.user.id}`)).map(t => t.user) ?? [],
        liked: myLikes.has(c.id),
        viewerFollowsAuthor: myFollowing.has(c.user.id),
      },
    })),
    ...badges.map(b => ({
      type: 'badge' as const,
      createdAt: b.earnedAt,
      author: b.user,
      badge: BADGE_MAP[b.badgeId] ?? { id: b.badgeId, name: b.badgeId, icon: '🏅', description: '', category: '', rarity: 'common', xp_reward: 0 },
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, PAGE)

  const nextCursor = feedItems.length === PAGE
    ? feedItems[feedItems.length - 1].createdAt.toISOString()
    : null

  // Response varies by viewer (myLikes, viewerFollowsAuthor, tag filter,
  // like-count adjustment all depend on the calling user). Force
  // private no-store so a CDN can't serve one viewer's feed to another.
  return NextResponse.json(
    { items: feedItems, nextCursor },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
