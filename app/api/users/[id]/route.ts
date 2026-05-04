import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getLevel } from '@/lib/badges'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const { id } = await params
  const userId = Number(id)

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
  const isFollowing = session?.user
    ? !!(await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: Number(session.user.id), followingId: userId } },
      }))
    : false

  const recentCheckins = await prisma.checkin.findMany({
    where: { userId, isPublic: true },
    orderBy: { createdAt: 'desc' },
    take: 6,
    include: { _count: { select: { likes: true } } },
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
