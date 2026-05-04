import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { ALL_BADGES } from '@/lib/badges'
import { ensureBadgesSeedOnce, checkAndAwardBadges } from '@/lib/badgeService'

// GET — return all badges with earned status + XP
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  await ensureBadgesSeedOnce()

  const [earned, user] = await Promise.all([
    prisma.userBadge.findMany({
      where: { userId },
      select: { badgeId: true, earnedAt: true, seen: true },
      orderBy: { earnedAt: 'desc' },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { xp: true } }),
  ])

  const earnedMap = Object.fromEntries(earned.map(e => [e.badgeId, e]))
  const xp = user?.xp ?? 0

  return NextResponse.json({
    badges: ALL_BADGES.map(b => ({
      ...b,
      earned: !!earnedMap[b.id],
      earned_at: earnedMap[b.id]?.earnedAt || null,
      seen: earnedMap[b.id]?.seen ?? true,
    })),
    xp,
    unseenCount: earned.filter(e => !e.seen).length,
  })
}

// POST — manually trigger badge check (e.g. after joining a session)
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const { action } = await req.json().catch(() => ({ action: 'join' }))
  try {
    const result = await checkAndAwardBadges(Number(session.user.id), action)
    return NextResponse.json(result)
  } catch (err) {
    console.error('badge check error:', err)
    return NextResponse.json({ newBadges: [], xpGained: 0, totalXP: 0 })
  }
}

// PATCH — mark all unseen badges as seen
export async function PATCH() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  await prisma.userBadge.updateMany({
    where: { userId: Number(session.user.id), seen: false },
    data: { seen: true },
  })
  return NextResponse.json({ ok: true })
}
