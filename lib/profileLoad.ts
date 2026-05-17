// Visibility gating is the caller's responsibility — call
// `resolveProfileViewer` first and reject on `gate.status === 'gone'`
// before invoking this loader.

import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { getProfileFlavor, type FlavorBlock } from '@/lib/profileFlavor'
import { decimalToNumber } from '@/lib/decimal'
import { loadSessionFeedWines, detectExpiredCodes, pairKey, type SessionFeedPair } from '@/lib/sessionFeedWines'
import type { SessionFeedWine } from '@/lib/feedTypes'

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

// Per-wine fan-out shape for a session feed_item on the profile.
// Mirror of the API's SessionFeedPayload, plus a `createdAt` field
// for chronological merging with standalone check-ins on the same surface.
export type LoadedSessionPost = {
  id: number              // feed_items.id
  sessionId: number | null
  sessionName: string | null  // null when deleted (scrubbed) or unnamed
  hostName: string | null     // null when deleted (scrubbed) or anon-host
  deleted: boolean
  blind: boolean
  wines: SessionFeedWine[]    // empty when deleted (collapse rule)
  createdAt: Date
  likeCount: number
  liked: boolean
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
  flavor: FlavorBlock | { hasActiveRatings: boolean; avgScore: FlavorBlock['avgScore']; fiveStar: FlavorBlock['fiveStar']; keys: FlavorBlock['keys'] }
  isFollowing: boolean
  recentCheckins: LoadedCheckin[]
  // Phase 2 addition: session feed_items, rendered as stubs. Phase 3 ships
  // SessionFeedCard; this array becomes its data source. Empty for users
  // who have no session feed_items.
  recentSessionPosts: LoadedSessionPost[]
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
      // _count.checkins is the legacy table count — kept until phase 4
      // drops the table. The user-facing "check-ins" stat is sourced
      // from feed_items kind='standalone' below (which the data migration
      // backfills to match the legacy count, and which new POSTs write
      // to from slice 3 onward).
      _count: { select: { earnedBadges: true, followers: true, following: true } },
    },
  })
  if (!user) return null

  // "Check-ins" tile counts EVERY tasting (per-wine), not per-post —
  // a session with 4 rated wines + 1 standalone = 5 check-ins.
  // Sourced directly from `ratings` so it stays correct today regardless
  // of the lifetime_ratings parity gap (today's session-rate bumps it,
  // standalone POST doesn't — captured in .local/future-work-rewire.md).
  // Cheap on Tim+Simon scale; revisit if the user grows a six-figure
  // rating history.
  const tastingCount = await prisma.rating.count({ where: { userId } })

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
    : { hasActiveRatings: flavorFull.hasActiveRatings, avgScore: flavorFull.avgScore, fiveStar: flavorFull.fiveStar, keys: flavorFull.keys }

  // Standalone feed_items — the post-rewire shape. Each has a rating + wine
  // + optional rating_image attached. The profile renders these as the
  // user's standalone check-ins, matching pre-rewire behaviour on the
  // surface.
  //
  // Never ship lat/lng on the public wire. No per-row visibility filter
  // here — the upstream profile gate handled it.
  const standaloneFeedItems = await prisma.feedItem.findMany({
    where: { userId, kind: 'standalone' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      venueName: true, city: true, country: true, createdAt: true,
      _count: { select: { likes: true } },
      tags: { include: { user: { select: { id: true, name: true } } } },
      rating: {
        select: {
          score: true, flavors: true, notes: true,
          wine: { select: { name: true, producer: true, vintage: true, grape: true, style: true, imageUrl: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { imageUrl: true } },
        },
      },
    },
  })

  // Session feed_items (kind='session'). Phase 3 ships per-wine fan-out:
  // the same SessionFeedCard the social feed renders. Soft-deleted sessions
  // collapse to deleted=true with wines=[] (§3 collapse rule).
  //
  // Take a wider window than 10 because the two arrays are merged
  // chronologically at the render layer (ProfileCheckins). Pulling 10 of
  // each guarantees the top-10 chronological mix is correctly resolved
  // for users with a strong skew either way; the renderer will slice as
  // appropriate. At Tim+Simon scale this is two cheap queries.
  const sessionFeedItems = await prisma.feedItem.findMany({
    where: { userId, kind: 'session' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, createdAt: true,
      _count: { select: { likes: true } },
      session: {
        select: {
          id: true, code: true, name: true, deletedAt: true, blind: true, blindForEveryone: true,
          hostName: true, hostUserId: true,
        },
      },
    },
  })

  // Per-wine bulk-load for the session feed_items, mirroring /api/feed.
  // Tombstoned + expired short-circuits — see SessionFeedPair comment.
  const expiredCodes = await detectExpiredCodes(
    sessionFeedItems
      .filter(f => f.session && !f.session.deletedAt && f.session.code)
      .map(f => f.session!.code!)
  )

  const sessionPairs: SessionFeedPair[] = sessionFeedItems.flatMap(f => {
    if (!f.session) return []
    return [{
      authorId: userId,
      sessionId: f.session.id,
      blind: !!f.session.blind,
      blindForEveryone: !!f.session.blindForEveryone,
      deleted: !!f.session.deletedAt,
      expired: f.session.code != null && expiredCodes.has(f.session.code),
      hostUserId: f.session.hostUserId ?? null,
    }]
  })
  const sessionWines = await loadSessionFeedWines(sessionPairs, viewerId)

  // Hydrate viewer's "liked" state across BOTH standalone and session
  // feed_items in one batch lookup.
  const allFeedItemIds = [
    ...standaloneFeedItems.map(f => f.id),
    ...sessionFeedItems.map(f => f.id),
  ]
  const likedSet = viewerId
    ? new Set(
        (await prisma.feedItemLike.findMany({
          where: { userId: viewerId, feedItemId: { in: allFeedItemIds } },
          select: { feedItemId: true },
        })).map(l => l.feedItemId),
      )
    : new Set<number>()

  // Block-pair like adjustment for the profile's own feed_items. Same
  // global symmetric rule as feed: a like by user X on a feed_item by
  // user Y is invisible to every viewer once X↔Y has a block.
  //
  // COUNT(DISTINCT fl.user_id) protects against a mutual A↔B block
  // (two rows in user_blocks for the same pair) double-counting the
  // single like row. Run across BOTH standalone and session ids — same
  // shape, single query.
  const profileBlockHiddenLikes = new Map<number, number>()
  if (allFeedItemIds.length > 0) {
    const rows = await prisma.$queryRaw<{ feed_item_id: number; n: bigint }[]>`
      SELECT fl.feed_item_id AS feed_item_id, COUNT(DISTINCT fl.user_id)::bigint AS n
      FROM feed_item_likes fl
      JOIN user_blocks b
        ON (b.blocker_id = fl.user_id AND b.blocked_id = ${userId}::integer)
        OR (b.blocker_id = ${userId}::integer AND b.blocked_id = fl.user_id)
      WHERE fl.feed_item_id = ANY(${allFeedItemIds}::int[])
      GROUP BY fl.feed_item_id
    `
    for (const r of rows) profileBlockHiddenLikes.set(r.feed_item_id, Number(r.n))
  }

  // Block-pair tag filter on the profile's own standalone feed_items.
  // Session feed_items don't have tags today (no taggedUserIds on
  // session-rate), so only standalone matters here. The "other side" of
  // each block-pair row (not the profile owner) is the user id to filter
  // out of the tag list.
  const tagUserIds = standaloneFeedItems.flatMap(f => f.tags.map(t => t.user.id))
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
      checkins: tastingCount,
      followers: adjustedFollowers,
      following: adjustedFollowing,
    },
    flavor,
    isFollowing,
    recentCheckins: standaloneFeedItems.flatMap<LoadedCheckin>(f => {
      // Defensive: a standalone feed_item with no rating is a schema
      // violation; drop rather than crash.
      if (!f.rating) return []
      const wine = f.rating.wine
      const ratingImage = f.rating.images[0]?.imageUrl ?? null
      return [{
        id: f.id,
        wineName: wine.name,
        producer: wine.producer,
        vintage: wine.vintage,
        grape: wine.grape,
        type: wine.style,
        score: decimalToNumber(f.rating.score),
        flavors: f.rating.flavors,
        notes: f.rating.notes,
        // Image priority: rating's own photo first, falling back to the
        // wine's canonical bottle shot (null for standalone wines today).
        imageUrl: ratingImage ?? wine.imageUrl,
        venueName: f.venueName,
        city: f.city,
        country: f.country,
        createdAt: f.createdAt,
        likeCount: Math.max(0, f._count.likes - (profileBlockHiddenLikes.get(f.id) ?? 0)),
        liked: likedSet.has(f.id),
        tags: (f.tags ?? []).filter(t => !blockedTagUserIds.has(t.user.id)).map(t => t.user),
      }]
    }),
    recentSessionPosts: sessionFeedItems.map<LoadedSessionPost>(f => {
      const deleted = !!f.session?.deletedAt
      const wines = !f.session
        ? []
        : (sessionWines.get(pairKey(userId, f.session.id)) ?? [])
      return {
        id: f.id,
        sessionId: f.session?.id ?? null,
        // §8 contract: when soft-deleted, the session's name + hostName
        // are scrubbed (NULL). Renderer collapses to "[deleted session]"
        // without a link or per-wine enumeration.
        sessionName: deleted ? null : (f.session?.name ?? null),
        hostName: deleted ? null : (f.session?.hostName ?? null),
        deleted,
        blind: !!f.session?.blind,
        wines,
        createdAt: f.createdAt,
        likeCount: Math.max(0, f._count.likes - (profileBlockHiddenLikes.get(f.id) ?? 0)),
        liked: likedSet.has(f.id),
      }
    }),
  }
}
