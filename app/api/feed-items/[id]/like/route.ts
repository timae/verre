import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'
import { viewerCanSeeAuthor } from '@/lib/profileVisibility'

type Ctx = { params: Promise<{ id: string }> }

// Block-pair-adjusted like count for one feed_item. Match the global
// rule applied in feed + profileLoad: a like by user X on a feed_item
// by author Y is invisible to ALL viewers once X↔Y has a block in
// either direction. Returning the unadjusted count would let the
// like client display a number that disagrees with the feed/profile
// render of the same post.
async function blockAdjustedLikeCount(feedItemId: number, authorId: number): Promise<number> {
  const total = await prisma.feedItemLike.count({ where: { feedItemId } })
  const hidden = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT fl.user_id)::bigint AS n
    FROM feed_item_likes fl
    JOIN user_blocks b
      ON (b.blocker_id = fl.user_id AND b.blocked_id = ${authorId}::integer)
      OR (b.blocker_id = ${authorId}::integer AND b.blocked_id = fl.user_id)
    WHERE fl.feed_item_id = ${feedItemId}::integer
  `
  return Math.max(0, total - Number(hidden[0]?.n ?? 0))
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const feedItemId = parsePathId((await params).id)
  if (feedItemId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  // Visibility gate runs BEFORE rate-limit increment so an attacker
  // hammering hidden ids can't drain the legitimate user's 120/h budget.
  // Returns 404 for non-permitted access so the like endpoint doesn't
  // leak existence of a feed_item the viewer's tier excludes them from
  // seeing.
  const target = await prisma.feedItem.findUnique({
    where: { id: feedItemId },
    select: { userId: true },
  })
  if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await viewerCanSeeAuthor(userId, target.userId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const rl = await checkRate(`rl:like:${userId}:1h`, 120, 3600)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many likes.' }, { status: 429 })

  await prisma.feedItemLike.upsert({
    where: { userId_feedItemId: { userId, feedItemId } },
    create: { userId, feedItemId },
    update: {},
  })
  const count = await blockAdjustedLikeCount(feedItemId, target.userId)
  return NextResponse.json({ liked: true, count })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const feedItemId = parsePathId((await params).id)
  if (feedItemId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  // Same gate as POST. Counts are public to anyone who can see the
  // feed_item, but a viewer who can't see it shouldn't be able to
  // confirm it exists / read its like count via DELETE either.
  // Returns 404 (matching POST) so the endpoint shape doesn't leak the
  // existence of tier-hidden rows.
  const target = await prisma.feedItem.findUnique({
    where: { id: feedItemId },
    select: { userId: true },
  })
  if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await viewerCanSeeAuthor(userId, target.userId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  await prisma.feedItemLike.deleteMany({ where: { userId, feedItemId } })
  const count = await blockAdjustedLikeCount(feedItemId, target.userId)
  return NextResponse.json({ liked: false, count })
}
