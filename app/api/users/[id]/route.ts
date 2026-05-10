import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { getProfileFlavor } from '@/lib/profileFlavor'
import { parsePathId } from '@/lib/parsePathId'
import { checkRate } from '@/lib/rateLimit'
import { decimalToNumber } from '@/lib/decimal'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const { id } = await params
  const userId = parsePathId(id)
  if (userId === null) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  // Public, anonymous-readable, and runs an extra SQL aggregate over
  // `ratings`. Rate-limited per-IP to prevent enumeration + DB-load
  // amplification. Same shape as the sibling /badges endpoint.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const viewerId = session?.user ? Number(session.user.id) : null
  const gate = await resolveProfileViewer(userId, viewerId)
  if (gate.status === 'gone') return NextResponse.json({ error: 'not found' }, { status: 404 })
  const isFollowing = gate.viewer.followsProfile

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, xp: true,
      lifetimeRatings: true, lifetimeSessionsJoined: true,
      _count: { select: { earnedBadges: true, checkins: true, followers: true, following: true } },
    },
  })
  if (!user) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const level = getLevel(user.xp)

  // Live flavor-wheel aggregate. The tile in the UI uses lifetimeRatings
  // (monotonic); the wheel itself uses live `flavor.keys` (current
  // dataset). For non-owners we redact `activeRatings` because that
  // exact count combined with the public `lifetimeRatings` would let
  // any visitor compute how many sessions the profile owner has
  // deleted. The owner gets the full block to render the "based on N
  // of M" caption on their own profile.
  const isOwner = viewerId !== null && viewerId === userId
  const flavorFull = await getProfileFlavor(userId)
  const flavor = isOwner
    ? flavorFull
    : { avgScore: flavorFull.avgScore, fiveStar: flavorFull.fiveStar, keys: flavorFull.keys }

  // Explicit select — never ship lat/lng on the public wire (matches feed/profile-page payloads).
  const recentCheckins = await prisma.checkin.findMany({
    where: { userId, isPublic: true },
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: {
      id: true, wineName: true, producer: true, vintage: true, grape: true, type: true,
      score: true, flavors: true, notes: true, imageUrl: true,
      venueName: true, city: true, country: true, createdAt: true,
      _count: { select: { likes: true } },
    },
  })

  return NextResponse.json({
    id: user.id,
    name: user.name,
    xp: user.xp,
    level,
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
    // Coerce score Decimal → number on the wire so consumers don't get
    // `"5.00"` strings when they expect a JS number.
    recentCheckins: recentCheckins.map(c => ({ ...c, score: decimalToNumber(c.score) })),
  })
}
