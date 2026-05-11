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
  // 'shell' = profile exists but viewer can't see content — followers/
  // following list is content, so 404 (same shape as the doesn't-exist
  // path so a tier-denied viewer can't distinguish).
  if (gate.status !== 'ok') return NextResponse.json({ error: 'not found' }, { status: 404 })

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

  // Block-pair filter: drop rows where the listed user has a block-pair
  // with the profile owner (either direction). Globally symmetric — the
  // same list is returned to any viewer, and the row-count matches the
  // adjusted follower/following stats in loadProfile.
  //
  // Done as a NOT EXISTS so block-pair size doesn't materialise into an
  // IN list (a power user with thousands of blocks would otherwise inject
  // a huge array here).
  const blockClause = Prisma.sql`AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE (b.blocker_id = ${profileId} AND b.blocked_id = ${otherCol})
       OR (b.blocker_id = ${otherCol} AND b.blocked_id = ${profileId})
  )`

  const rows = await prisma.$queryRaw<{ id: number; name: string; xp: number; image_url: string | null }[]>`
    SELECT u.id, u.name, u.xp, u.image_url
    FROM follows f
    JOIN users u ON u.id = ${otherCol}
    WHERE ${fixedCol} = ${profileId}
      ${mutualClause}
      ${qClause}
      ${cursorClause}
      ${blockClause}
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

  // Response varies by viewer (isFollowing per row). private no-store
  // so a CDN can't serve one viewer's list to another.
  return NextResponse.json(
    {
      users: slice.map(r => ({
        id: r.id,
        name: r.name,
        xp: r.xp,
        imageUrl: r.image_url,
        isFollowing: myFollowing.has(r.id),
        profileFollowsThem: profileFollows ? profileFollows.has(r.id) : null,
      })),
      nextCursor,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
