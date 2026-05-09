import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'
import { resolveProfileViewer } from '@/lib/profileVisibility'

const PAGE = 30
const SEARCH_MIN = 2

// Shared handler for /api/users/[id]/followers and /following.
// ?mutual=mutual|non   filter on the reverse edge
// ?q=<query>           name substring (case-insensitive, min 2 chars)
// ?cursor=<userId>     pagination (descending user id)
//
// Logged-in only — anonymous viewers see profile basics + counts on /u/<id>
// but enumerating someone's social graph requires an account. Per-IP rate
// limit caps abuse; bursts well above normal browsing to allow real use.
export async function listProfilePeople(
  req: NextRequest,
  params: Promise<{ id: string }>,
  direction: 'followers' | 'following',
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const viewerId = Number(session.user.id)

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = await checkRate(`rl:profile-people:${ip}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { id } = await params
  const profileId = Number(id)
  if (!Number.isInteger(profileId) || profileId < 1) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  const gate = await resolveProfileViewer(profileId, viewerId)
  if (gate.status === 'gone') return NextResponse.json({ error: 'not found' }, { status: 404 })

  const url = req.nextUrl
  const mutual = url.searchParams.get('mutual')
  const q = (url.searchParams.get('q') || '').trim().slice(0, 64)
  if (q && q.length < SEARCH_MIN) return NextResponse.json({ users: [], nextCursor: null })
  const cursor = url.searchParams.get('cursor')
  const cursorId = cursor && Number.isInteger(Number(cursor)) ? Number(cursor) : null

  // For followers: rows where f.following_id = profileId; the "other" is f.follower_id.
  // For following: rows where f.follower_id  = profileId; the "other" is f.following_id.
  const otherCol = direction === 'followers' ? Prisma.sql`f.follower_id` : Prisma.sql`f.following_id`
  const fixedCol = direction === 'followers' ? Prisma.sql`f.following_id` : Prisma.sql`f.follower_id`

  // Mutual filter — the reverse edge of (profile, other) must (or must not) exist.
  const reverseFollower = direction === 'followers' ? Prisma.sql`${profileId}` : otherCol
  const reverseFollowing = direction === 'followers' ? otherCol : Prisma.sql`${profileId}`
  const mutualClause = mutual === 'mutual'
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM follows fr WHERE fr.follower_id = ${reverseFollower} AND fr.following_id = ${reverseFollowing})`
    : mutual === 'non'
    ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM follows fr WHERE fr.follower_id = ${reverseFollower} AND fr.following_id = ${reverseFollowing})`
    : Prisma.empty

  // Substring match — escape ILIKE wildcards so a literal `%`/`_` in `q`
  // doesn't act as a wildcard, then wrap in `%…%` for substring semantics.
  const qEscaped = q.replace(/[\\%_]/g, '\\$&')
  const qClause = q ? Prisma.sql`AND u.name ILIKE ${'%' + qEscaped + '%'}` : Prisma.empty
  const cursorClause = cursorId ? Prisma.sql`AND u.id < ${cursorId}` : Prisma.empty

  const rows = await prisma.$queryRaw<{ id: number; name: string; xp: number }[]>`
    SELECT u.id, u.name, u.xp
    FROM follows f
    JOIN users u ON u.id = ${otherCol}
    WHERE ${fixedCol} = ${profileId}
      ${mutualClause}
      ${qClause}
      ${cursorClause}
    ORDER BY u.id DESC
    LIMIT ${PAGE + 1}
  `

  const slice = rows.slice(0, PAGE)
  const nextCursor = rows.length > PAGE ? String(slice[slice.length - 1].id) : null
  const sliceIds = slice.map(r => r.id)

  // Viewer→listed-user follow state, for per-row Follow button.
  const myFollowing = viewerId && sliceIds.length
    ? new Set(
        (await prisma.follow.findMany({
          where: { followerId: viewerId, followingId: { in: sliceIds } },
          select: { followingId: true },
        })).map(f => f.followingId)
      )
    : new Set<number>()

  // Profile→listed-user follow state — only meaningful on the followers tab,
  // where it powers the "Follows you" label (someone follows the profile but
  // the profile doesn't follow them back).
  const profileFollows = direction === 'followers' && sliceIds.length
    ? new Set(
        (await prisma.follow.findMany({
          where: { followerId: profileId, followingId: { in: sliceIds } },
          select: { followingId: true },
        })).map(f => f.followingId)
      )
    : null

  return NextResponse.json({
    users: slice.map(r => ({
      id: r.id,
      name: r.name,
      xp: r.xp,
      isFollowing: myFollowing.has(r.id),
      profileFollowsThem: profileFollows ? profileFollows.has(r.id) : null,
    })),
    nextCursor,
  })
}
