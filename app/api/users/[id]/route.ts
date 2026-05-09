import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'
import { resolveProfileViewer } from '@/lib/profileVisibility'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const { id } = await params
  const userId = Number(id)
  if (!Number.isInteger(userId) || userId < 1) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

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
    isFollowing,
    recentCheckins,
  })
}
