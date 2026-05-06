import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { BADGE_MAP } from '@/lib/badges'

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

  const cursorParam = req.nextUrl.searchParams.get('cursor')
  const cursor = cursorParam ? new Date(cursorParam) : new Date()

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

  // Checkins
  const checkins = await prisma.checkin.findMany({
    where: { userId: { in: networkIds }, isPublic: true, createdAt: { lt: cursor } },
    include: {
      user: { select: { id: true, name: true, xp: true } },
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

  // Badge unlocks (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const badges = await prisma.userBadge.findMany({
    where: { userId: { in: networkIds }, earnedAt: { lt: cursor, gt: thirtyDaysAgo } },
    include: { user: { select: { id: true, name: true } } },
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
        grape: c.grape, type: c.type, score: c.score, notes: c.notes, imageUrl: c.imageUrl,
        venueName: c.venueName, city: c.city, country: c.country,
        flavors: c.flavors, likeCount: c._count.likes, createdAt: c.createdAt,
        tags: c.tags?.map(t => t.user) ?? [], liked: myLikes.has(c.id),
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

  return NextResponse.json({ items: feedItems, nextCursor })
}
