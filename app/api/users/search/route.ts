import { NextRequest, NextResponse } from 'next/server'
import { checkRate } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'

// Public discovery lookup — finds users by display-name prefix so they can
// be followed/tagged. Display names are presentation-only (see CLAUDE.md
// Auth section); this lookup never participates in identification or
// authorization. Results carry user ids, and any subsequent action against
// a returned user resolves through resolveIdentity → id, not by name.
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:search:${ip}:1m`, 30, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json([])

  // Case-insensitive prefix search; NFKC normalised at write time
  const users = await prisma.user.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    select: { id: true, name: true, xp: true, _count: { select: { earnedBadges: true } } },
    take: 10,
    orderBy: { name: 'asc' },
  })

  return NextResponse.json(users)
}
