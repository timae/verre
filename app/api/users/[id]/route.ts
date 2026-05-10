import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { parsePathId } from '@/lib/parsePathId'
import { checkRate } from '@/lib/rateLimit'
import { loadProfile } from '@/lib/profileLoad'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const { id } = await params
  const userId = parsePathId(id)
  if (userId === null) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  // Public, anonymous-readable. Rate-limited per-IP to prevent
  // enumeration + DB-load amplification.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const viewerId = session?.user ? Number(session.user.id) : null
  const gate = await resolveProfileViewer(userId, viewerId)
  if (gate.status === 'gone') return NextResponse.json({ error: 'not found' }, { status: 404 })

  const profile = await loadProfile({ userId, viewerId, isFollowing: gate.viewer.followsProfile })
  if (!profile) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(profile)
}
