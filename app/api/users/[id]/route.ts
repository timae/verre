import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { parsePathId } from '@/lib/parsePathId'
import { checkRate } from '@/lib/rateLimit'
import { loadProfile } from '@/lib/profileLoad'
import { isMuted } from '@/lib/userMute'
import { prisma } from '@/lib/prisma'

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

  // Blocker-side stripped view: viewer blocked this profile. Render the
  // name (so they recognise who they blocked) but nothing else — no
  // imageUrl, no XP, no check-ins, no isFollowing affordance. Only an
  // unblock button surfaces on the frontend via the `blocked: true`
  // discriminator. Cache-Control private so a CDN can't serve another
  // viewer the same response.
  if (gate.status === 'blocked-by-me') {
    return NextResponse.json(
      { id: userId, name: gate.name, blocked: true },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  // Tier-gated: shell payload only. Display name + id + isFollowing —
  // never the avatar, XP, badges, check-ins, or social-graph data. The
  // shell tells the viewer "this user exists, here's the follow button"
  // without leaking content.
  if (gate.status === 'shell') {
    const isFollowing = viewerId
      ? !!(await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: userId } },
          select: { followerId: true },
        }))
      : false
    return NextResponse.json(
      { id: userId, name: gate.name, gated: true, isFollowing },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  const profile = await loadProfile({ userId, viewerId, isFollowing: gate.viewer.followsProfile })
  if (!profile) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // viewerMutes is included only in the full payload (not the shell).
  // Per product decision: the mute button only appears on the full
  // profile view, where the viewer has chosen to look at content.
  const viewerMutes = viewerId !== null && viewerId !== userId
    ? await isMuted(viewerId, userId)
    : false
  // Response varies by viewer (viewerMutes, isFollowing, viewer-dependent
  // counts after block-pair adjustment). Force `private, no-store` so a
  // CDN can't serve one viewer's payload to another.
  return NextResponse.json(
    { ...profile, viewerMutes },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
