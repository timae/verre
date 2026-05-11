// Visibility gating is the caller's responsibility — call
// `resolveProfileViewer` first and reject on `gate.status === 'gone'`
// before invoking this loader.

import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { getProfileFlavor, type FlavorBlock } from '@/lib/profileFlavor'
import { decimalToNumber } from '@/lib/decimal'

export type LoadedCheckin = {
  id: number
  wineName: string
  producer: string | null
  vintage: string | null
  grape: string | null
  type: string | null
  score: number | null
  flavors: unknown
  notes: string | null
  imageUrl: string | null
  venueName: string | null
  city: string | null
  country: string | null
  createdAt: Date
  likeCount: number
  liked: boolean
  tags: { id: number; name: string }[]
}

export type LoadedProfile = {
  id: number
  name: string
  xp: number
  imageUrl: string | null
  level: ReturnType<typeof getLevel>
  stats: {
    ratings: number
    sessions: number
    badges: number
    checkins: number
    followers: number
    following: number
  }
  flavor: FlavorBlock | { avgScore: FlavorBlock['avgScore']; fiveStar: FlavorBlock['fiveStar']; keys: FlavorBlock['keys'] }
  isFollowing: boolean
  recentCheckins: LoadedCheckin[]
}

interface Args {
  userId: number
  viewerId: number | null
  isFollowing: boolean
}

export async function loadProfile({ userId, viewerId, isFollowing }: Args): Promise<LoadedProfile | null> {
  // After dropping checkins.is_public, every check-in is governed by
  // the author's profile-visibility tier — there's no per-row public/
  // private flag anymore. The count below now matches the author's
  // total check-ins; callers route `gate.status === 'gone'` to 404 and
  // `'shell'` to ProfileShell, so only `'ok'` reaches this loader.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, xp: true, imageUrl: true,
      lifetimeRatings: true, lifetimeSessionsJoined: true,
      _count: { select: { earnedBadges: true, checkins: true, followers: true, following: true } },
    },
  })
  if (!user) return null

  // Block-pair counts: subtract any follower/following edge where the
  // other end is in a block-pair with the profile owner. Locked design:
  // counts drop globally on block (Instagram-style); same number shown
  // to every viewer.
  //
  // Implementation: first resolve the SET of block-pair partner ids
  // (deduplicated via Set so a mutual A↔B block — two user_blocks rows
  // for the same pair — only counts once). Then count intersecting
  // follow edges via a simple `IN (...)`. Earlier "joined count" shape
  // double-counted mutual block-pairs.
  const blockPartnerRows = await prisma.userBlock.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  })
  const blockPartnerIds = new Set<number>()
  for (const r of blockPartnerRows) {
    blockPartnerIds.add(r.blockerId === userId ? r.blockedId : r.blockerId)
  }
  const [followersBlockedCount, followingBlockedCount] = blockPartnerIds.size > 0
    ? await Promise.all([
        prisma.follow.count({ where: { followingId: userId, followerId: { in: [...blockPartnerIds] } } }),
        prisma.follow.count({ where: { followerId: userId, followingId: { in: [...blockPartnerIds] } } }),
      ])
    : [0, 0]
  const adjustedFollowers = Math.max(0, user._count.followers - followersBlockedCount)
  const adjustedFollowing = Math.max(0, user._count.following - followingBlockedCount)

  const flavorFull = await getProfileFlavor(userId)
  // For non-owners we redact `activeRatings` because that exact count
  // combined with the public `lifetimeRatings` would let any visitor
  // compute how many sessions the profile owner has deleted.
  const isOwner = viewerId !== null && viewerId === userId
  const flavor = isOwner
    ? flavorFull
    : { avgScore: flavorFull.avgScore, fiveStar: flavorFull.fiveStar, keys: flavorFull.keys }

  // Explicit select — never ship lat/lng on the public wire. No
  // per-row visibility filter; the upstream profile gate handled it.
  const recentCheckins = await prisma.checkin.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, wineName: true, producer: true, vintage: true, grape: true, type: true,
      score: true, flavors: true, notes: true, imageUrl: true,
      venueName: true, city: true, country: true, createdAt: true,
      _count: { select: { likes: true } },
      tags: { include: { user: { select: { id: true, name: true } } } },
    },
  })

  // Hydrate viewer's "liked" state in one batch lookup.
  const likedSet = viewerId
    ? new Set(
        (await prisma.checkinLike.findMany({
          where: { userId: viewerId, checkinId: { in: recentCheckins.map(c => c.id) } },
          select: { checkinId: true },
        })).map(l => l.checkinId),
      )
    : new Set<number>()

  // Block-pair like adjustment for the profile's own check-ins. Same
  // global symmetric rule as feed: a like by user X on a check-in by
  // user Y is invisible to every viewer once X↔Y has a block.
  //
  // COUNT(DISTINCT cl.user_id) protects against a mutual A↔B block
  // (two rows in user_blocks for the same pair) double-counting the
  // single like row.
  const profileCheckinIds = recentCheckins.map(c => c.id)
  const profileBlockHiddenLikes = new Map<number, number>()
  if (profileCheckinIds.length > 0) {
    const rows = await prisma.$queryRaw<{ checkin_id: number; n: bigint }[]>`
      SELECT cl.checkin_id AS checkin_id, COUNT(DISTINCT cl.user_id)::bigint AS n
      FROM checkin_likes cl
      JOIN user_blocks b
        ON (b.blocker_id = cl.user_id AND b.blocked_id = ${userId}::integer)
        OR (b.blocker_id = ${userId}::integer AND b.blocked_id = cl.user_id)
      WHERE cl.checkin_id = ANY(${profileCheckinIds}::int[])
      GROUP BY cl.checkin_id
    `
    for (const r of rows) profileBlockHiddenLikes.set(r.checkin_id, Number(r.n))
  }

  // Block-pair tag filter on the profile's own check-ins. Tag rendering
  // drops block-pair tags from every viewer's view of the profile.
  // The "other side" of each block-pair row (not the profile owner) is
  // the user id to filter out of the tag list.
  const tagUserIds = recentCheckins.flatMap(c => c.tags.map(t => t.user.id))
  const blockedTagUserIds = tagUserIds.length > 0
    ? new Set(
        (await prisma.userBlock.findMany({
          where: {
            OR: [
              { blockerId: userId, blockedId: { in: tagUserIds } },
              { blockedId: userId, blockerId: { in: tagUserIds } },
            ],
          },
          select: { blockerId: true, blockedId: true },
        })).map(b => b.blockerId === userId ? b.blockedId : b.blockerId)
      )
    : new Set<number>()

  return {
    id: user.id,
    name: user.name,
    xp: user.xp,
    imageUrl: user.imageUrl,
    level: getLevel(user.xp),
    stats: {
      ratings: user.lifetimeRatings,
      sessions: user.lifetimeSessionsJoined,
      badges: user._count.earnedBadges,
      checkins: user._count.checkins,
      followers: adjustedFollowers,
      following: adjustedFollowing,
    },
    flavor,
    isFollowing,
    recentCheckins: recentCheckins.map(c => ({
      id: c.id,
      wineName: c.wineName,
      producer: c.producer,
      vintage: c.vintage,
      grape: c.grape,
      type: c.type,
      score: decimalToNumber(c.score),
      flavors: c.flavors,
      notes: c.notes,
      imageUrl: c.imageUrl,
      venueName: c.venueName,
      city: c.city,
      country: c.country,
      createdAt: c.createdAt,
      likeCount: Math.max(0, c._count.likes - (profileBlockHiddenLikes.get(c.id) ?? 0)),
      liked: likedSet.has(c.id),
      tags: (c.tags ?? []).filter(t => !blockedTagUserIds.has(t.user.id)).map(t => t.user),
    })),
  }
}
