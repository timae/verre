import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { ALL_BADGES } from '@/lib/badges'
import { checkRate } from '@/lib/rateLimit'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { parsePathId } from '@/lib/parsePathId'

// Public list of a user's earned badges, with the full ALL_BADGES catalog so
// the UI can render earned + locked side-by-side. Logged-in only — same rule
// as /followers and /following: anonymous viewers see counts on the profile,
// detailed enumeration requires an account.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Every return path carries `private, no-store` — the 404 in particular
  // varies by viewer (tier-denied vs not-exists) and must not be cached
  // cross-viewer.
  const noStore = { 'Cache-Control': 'private, no-store' }
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const viewerId = Number(session.user.id)

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile-badges:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: noStore })

  const { id } = await params
  const profileId = parsePathId(id)
  if (profileId === null) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400, headers: noStore })
  }

  const gate = await resolveProfileViewer(profileId, viewerId)
  // Badges are gated content — only 'ok' qualifies; 'shell' and 'gone'
  // both surface as 404.
  if (gate.status !== 'ok') return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })

  const earned = await prisma.userBadge.findMany({
    where: { userId: profileId },
    select: { badgeId: true, earnedAt: true },
    orderBy: { earnedAt: 'desc' },
  })
  const earnedMap = Object.fromEntries(earned.map(e => [e.badgeId, e]))

  return NextResponse.json(
    {
      badges: ALL_BADGES.map(b => ({
        ...b,
        earned: !!earnedMap[b.id],
        earned_at: earnedMap[b.id]?.earnedAt || null,
      })),
    },
    { headers: noStore },
  )
}
