import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { ALL_BADGES } from '@/lib/badges'
import { checkRate } from '@/lib/rateLimit'
import { resolveProfileViewer } from '@/lib/profileVisibility'

// Public list of a user's earned badges, with the full ALL_BADGES catalog so
// the UI can render earned + locked side-by-side. Logged-in only — same rule
// as /followers and /following: anonymous viewers see counts on the profile,
// detailed enumeration requires an account.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const viewerId = Number(session.user.id)

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile-badges:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { id } = await params
  const profileId = Number(id)
  if (!Number.isInteger(profileId) || profileId < 1) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  const gate = await resolveProfileViewer(profileId, viewerId)
  if (gate.status === 'gone') return NextResponse.json({ error: 'not found' }, { status: 404 })

  const earned = await prisma.userBadge.findMany({
    where: { userId: profileId },
    select: { badgeId: true, earnedAt: true },
    orderBy: { earnedAt: 'desc' },
  })
  const earnedMap = Object.fromEntries(earned.map(e => [e.badgeId, e]))

  return NextResponse.json({
    badges: ALL_BADGES.map(b => ({
      ...b,
      earned: !!earnedMap[b.id],
      earned_at: earnedMap[b.id]?.earnedAt || null,
    })),
  })
}
