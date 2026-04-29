import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { ALL_BADGES, BADGE_MAP } from '@/lib/badges'
import { ensureBadgesSeedOnce, checkAndAwardBadges } from '@/lib/badgeService'

// GET — return all badges with earned status + XP
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  await ensureBadgesSeedOnce()

  const [earned, users] = await Promise.all([
    prisma.$queryRaw<{badge_id:string; earned_at:Date; seen:boolean}[]>`
      SELECT badge_id, earned_at, seen FROM user_badges WHERE user_id=${userId} ORDER BY earned_at DESC`,
    prisma.$queryRaw<[{xp:number}]>`SELECT xp FROM users WHERE id=${userId}`,
  ])

  const earnedMap = Object.fromEntries(earned.map(e => [e.badge_id, e]))
  const xp = Number(users[0]?.xp || 0)

  return NextResponse.json({
    badges: ALL_BADGES.map(b => ({
      ...b,
      earned: !!earnedMap[b.id],
      earned_at: earnedMap[b.id]?.earned_at || null,
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
  await prisma.$executeRaw`UPDATE user_badges SET seen=true WHERE user_id=${Number(session.user.id)}`
  return NextResponse.json({ ok: true })
}
