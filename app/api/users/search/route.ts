import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { viewableProfiles } from '@/lib/profileVisibility'
import { blockScrub, friendsInCommon, momentsTogether } from '@/lib/peopleSql'

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
// badge count, photo, friends in common) are only included when the
// viewer's tier qualifies them to see the profile content. Tier-denied
// viewers see name + id + the viewer's own edges (isFollowing, followsViewer,
// momentsTogether) — enough to render a follow button against, no content
// leak.

export async function GET(req: NextRequest) {
  // Cache-Control on every return path. Search is viewer-dependent
  // (block-pair filter, isFollowing, tier-gate decisions vary by viewer).
  // Empty and refused responses share the same posture so a CDN can't cache
  // them cross-viewer.
  const noStore = { 'Cache-Control': 'private, no-store' }
  const session = await resolveUser(req)
  if (!session?.user) {
    return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  }
  const viewerId = Number(session.user.id)

  // Now that auth is required, key the limiter on the caller — IP-keyed
  // would bucket a shared-NAT office to the same 30/min.
  const rl = await checkRate(`rl:search:u:${viewerId}:1m`, 30, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: noStore })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json([], { headers: noStore })

  // Substring search; the pg_trgm GIN index on users.name (added in the
  // privacy-tiers migration) makes this scale. Block pairs (either direction,
  // anyone the viewer blocked AND anyone who blocked the viewer) are dropped
  // in SQL BEFORE the limit, so ten results stay ten (locked design: no
  // surface in search reveals block-pair existence). You never find yourself
  // (Add Friends has nothing to offer on your own row), also before the limit.
  // ILIKE wildcards in `q` are escaped (lib/profilePeople.ts).
  const like = '%' + q.slice(0, 64).replace(/[\\%_]/g, '\\$&') + '%'
  const candidates = await prisma.$queryRaw<{ id: number; name: string; xp: number; image_url: string | null; badge_count: number }[]>`
    SELECT u.id, u.name, u.xp, u.image_url,
      (SELECT COUNT(*) FROM user_badges ub WHERE ub.user_id = u.id)::int AS badge_count
    FROM users u
    WHERE u.name ILIKE ${like}
      AND u.id <> ${viewerId}
      AND ${blockScrub(viewerId, viewerId, Prisma.raw('u.id'))}
    ORDER BY u.name ASC, u.id ASC
    LIMIT 10
  `
  if (candidates.length === 0) return NextResponse.json([], { headers: noStore })

  // Activity-level fields, the photo and friends in common follow each
  // person's own visibility (viewableProfiles: tier + circle);
  // `followsViewer` + `momentsTogether` are the viewer's own edges.
  const ids = candidates.map(c => c.id)
  const [{ admitted, viewers }, together] = await Promise.all([
    viewableProfiles(viewerId, ids),
    momentsTogether(viewerId, ids),
  ])
  const inCommon = await friendsInCommon(viewerId, ids.filter(i => admitted.has(i)))

  const result = candidates.map(c => {
    const v = viewers.get(c.id)
    const rel = {
      isFollowing: v?.followsProfile ?? false,
      followsViewer: v?.profileFollowsViewer ?? false,
      momentsTogether: together.get(c.id) ?? 0,
    }
    if (admitted.has(c.id)) {
      return { id: c.id, name: c.name, xp: c.xp, badgeCount: c.badge_count, imageUrl: c.image_url, ...rel, friendsInCommon: inCommon.get(c.id) ?? 0 }
    }
    // Tier-denied: stub shape — name only, no activity-level data.
    return { id: c.id, name: c.name, gated: true, imageUrl: null, ...rel, friendsInCommon: null }
  })

  return NextResponse.json(result, { headers: noStore })
}
