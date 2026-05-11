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
      followers: user._count.followers,
      following: user._count.following,
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
      likeCount: c._count.likes,
      liked: likedSet.has(c.id),
      tags: c.tags?.map(t => t.user) ?? [],
    })),
  }
}
