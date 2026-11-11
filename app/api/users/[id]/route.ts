import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { resolveProfileViewer } from '@/lib/profileVisibility'
import { parsePathId } from '@/lib/parsePathId'
import { checkRate } from '@/lib/rateLimit'
import { loadProfile } from '@/lib/profileLoad'
import { loadProfileHeaderExtras } from '@/lib/profileHeader'
import { isMuted } from '@/lib/userMute'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Every return path carries `private, no-store`. The 200/404 split is
  // viewer-dependent (gate state), so a shared cache must never serve
  // one viewer's response to another.
  const noStore = { 'Cache-Control': 'private, no-store' }
  const session = await resolveUser(req)
  const { id } = await params
  const userId = parsePathId(id)
  if (userId === null) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400, headers: noStore })
  }

  // Public, anonymous-readable. Rate-limited per-IP to prevent
  // enumeration + DB-load amplification.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: noStore })

  const viewerId = session?.user ? Number(session.user.id) : null
  const gate = await resolveProfileViewer(userId, viewerId)
  if (gate.status === 'gone') return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: noStore },
  )

  // Blocker-side stripped view: viewer blocked this profile. Render the
  // name (so they recognise who they blocked) but nothing else — no
  // imageUrl, no XP, no check-ins, no isFollowing affordance. Only an
  // unblock button surfaces on the frontend via the `blocked: true`
  // discriminator. Cache-Control private so a CDN can't serve another
  // viewer the same response.
  if (gate.status === 'blocked-by-me') {
    return NextResponse.json(
      { id: userId, name: gate.name, blocked: true },
      { headers: noStore },
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
      { headers: noStore },
    )
  }

  // `?view=header` (the native app): no recent posts — the app reads them
  // from `/api/feed?user=`. The default (web) payload is unchanged.
  const headerView = req.nextUrl.searchParams.get('view') === 'header'
  const profile = await loadProfile({ userId, gate, recent: !headerView })
  if (!profile) return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: noStore },
  )
  // viewerMutes is included only in the full payload (not the shell).
  // Per product decision: the mute button only appears on the full
  // profile view, where the viewer has chosen to look at content.
  const [viewerMutes, extras] = await Promise.all([
    viewerId !== null && viewerId !== userId ? isMuted(viewerId, userId) : Promise.resolve(false),
    // Additive app-header fields (friendsCount, inCommon, tiles,
    // checkinsAudience) — full payload only, never the shell or blocked
    // views. The web ignores them. 🔒 `gate` itself is never serialized
    // (it carries the owner's settings).
    loadProfileHeaderExtras(userId, gate, profile.stats.checkins ?? 0),
  ])
  const { recentCheckins, recentSessionPosts, ...head } = profile
  // Response varies by viewer (viewerMutes, isFollowing, followsYou,
  // inCommon, viewer-dependent counts after block-pair adjustment). Force
  // `private, no-store` so a CDN can't serve one viewer's payload to another.
  return NextResponse.json(
    {
      ...head,
      ...(headerView ? {} : { recentCheckins, recentSessionPosts }),
      viewerMutes,
      // The profile owner follows the viewer (drives "Follow Back").
      followsYou: gate.viewer.profileFollowsViewer,
      ...extras,
    },
    { headers: noStore },
  )
}
