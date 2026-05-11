import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { checkRate } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'
import { blockPairIds } from '@/lib/userBlock'

// Discovery lookup — finds users by display-name substring so they can
// be followed/tagged. Display names are presentation-only (see CLAUDE.md
// Auth section); this lookup never participates in identification or
// authorization.
//
// Auth required: anonymous callers get 401. Otherwise this endpoint would
// be an open enumeration channel.
//
// Display-name + id are always returned for matching users — those are
// always-public per the visibility model. Activity-level fields (xp,
// badge count) are only included when the viewer's tier qualifies them
// to see the profile content. Tier-denied viewers see name+id+isFollowing
// only — enough to render a follow button against, no content leak.

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'auth required' }, { status: 401 })
  }
  const viewerId = Number(session.user.id)

  // Now that auth is required, key the limiter on the caller — IP-keyed
  // would bucket a shared-NAT office to the same 30/min.
  const rl = await checkRate(`rl:search:u:${viewerId}:1m`, 30, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  // Cache-Control on every return path. Search is viewer-dependent
  // (block-pair filter, isFollowing, tier-gate decisions vary by viewer).
  // Empty responses share the same posture so a CDN can't cache them
  // cross-viewer.
  const noStore = { 'Cache-Control': 'private, no-store' }
  if (q.length < 2) return NextResponse.json([], { headers: noStore })

  // Substring search; the pg_trgm GIN index on users.name (added in the
  // privacy-tiers migration) makes this scale.
  const candidates = await prisma.user.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    select: { id: true, name: true, xp: true, _count: { select: { earnedBadges: true } } },
    take: 10,
    orderBy: { name: 'asc' },
  })

  if (candidates.length === 0) return NextResponse.json([], { headers: noStore })

  const candidateIds = candidates.map(c => c.id)
  const [visMap, viewerMap, myFollowing, blockPairs] = await Promise.all([
    batchLoadVisibilities(candidateIds),
    resolveProfileViewerBulk(candidateIds, viewerId),
    prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: candidateIds } },
      select: { followingId: true },
    }),
    blockPairIds(viewerId),
  ])
  const followingSet = new Set(myFollowing.map(f => f.followingId))
  const fofCandidates = candidateIds.filter(id => visMap.get(id)?.fofEnabled === true)
  const fofSet = fofCandidates.length > 0
    ? await viewerFofAuthorSet(viewerId, fofCandidates)
    : new Set<number>()

  // Block-pair candidates are dropped entirely (no stub). Both directions
  // — anyone the viewer blocked AND anyone who blocked the viewer.
  // Locked design: no surface in search reveals block-pair existence.
  const visibleCandidates = candidates.filter(c =>
    !blockPairs.blockedByMe.has(c.id) && !blockPairs.blockingMe.has(c.id)
  )
  if (visibleCandidates.length === 0) return NextResponse.json([], { headers: noStore })

  const result = visibleCandidates.map(c => {
    const isFollowing = followingSet.has(c.id)
    if (c.id === viewerId) {
      // Self always sees full content for self.
      return { id: c.id, name: c.name, xp: c.xp, badgeCount: c._count.earnedBadges, isFollowing }
    }
    const settings = visMap.get(c.id)
    if (!settings) {
      return { id: c.id, name: c.name, gated: true, isFollowing }
    }
    const base = viewerMap.get(c.id) ?? { id: viewerId, followsProfile: false, profileFollowsViewer: false }
    const v = {
      id: base.id ?? viewerId,
      followsProfile: base.followsProfile,
      profileFollowsViewer: base.profileFollowsViewer,
      isFofOfProfile: settings.fofEnabled ? fofSet.has(c.id) : undefined,
    }
    const canSee = canViewProfile(settings.visibility, v, settings.fofEnabled)
    if (canSee) {
      return { id: c.id, name: c.name, xp: c.xp, badgeCount: c._count.earnedBadges, isFollowing }
    }
    // Tier-denied: stub shape — name only, no activity-level data.
    return { id: c.id, name: c.name, gated: true, isFollowing }
  })

  return NextResponse.json(result, { headers: noStore })
}
