import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'
import { blockScrub, together } from '@/lib/peopleSql'
import { viewableProfiles } from '@/lib/profileVisibility'

// "People you tasted with" (the app's Add Friends sheet): people who share a
// started, live moment with the caller (the together predicate,
// lib/peopleSql.ts), newest shared moment first, then most moments together.
// Never the caller, people they already follow, block pairs (either way) or
// people they muted, all excluded in SQL BEFORE the limit. The photo follows
// each person's own visibility. 🔒 No moment code: a name and a date only.
const NO_STORE = { 'Cache-Control': 'private, no-store' }
const LIMIT = 8
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const viewerId = Number(session.user.id)
  const rl = await checkRate(`rl:tasted-with:user:${viewerId}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } },
    )
  }
  const rows = await prisma.$queryRaw<{ id: number; name: string; image_url: string | null; last_name: string | null; last_at: Date }[]>`
    SELECT t.other_id AS id, u.name, u.image_url,
      (array_agg(t.name ORDER BY t.at DESC, t.session_id DESC))[1] AS last_name,
      MAX(t.at) AS last_at
    FROM ${together(viewerId)} t
    JOIN users u ON u.id = t.other_id
    WHERE ${blockScrub(viewerId, viewerId, Prisma.raw('t.other_id'))}
      AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${viewerId} AND f.following_id = t.other_id)
      AND NOT EXISTS (SELECT 1 FROM user_mutes m WHERE m.muter_id = ${viewerId} AND m.muted_id = t.other_id)
    GROUP BY t.other_id, u.name, u.image_url
    ORDER BY MAX(t.at) DESC, COUNT(*) DESC, t.other_id DESC
    LIMIT ${LIMIT}
  `
  const { admitted, viewers } = await viewableProfiles(viewerId, rows.map(r => r.id))
  return NextResponse.json({
    people: rows.map(r => ({
      id: r.id,
      name: r.name,
      imageUrl: admitted.has(r.id) ? r.image_url : null,
      followsViewer: viewers.get(r.id)?.profileFollowsViewer ?? false,
      lastMoment: { name: r.last_name, at: r.last_at.toISOString() },
    })),
  }, { headers: NO_STORE })
}
