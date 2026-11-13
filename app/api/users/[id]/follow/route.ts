import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { parsePublicIdParam, userIdForPublicId } from '@/lib/publicIds'
import { isSameOrigin } from '@/lib/csrf'
import { viewerBlocksAuthor, authorBlocksViewer } from '@/lib/userBlock'

type Ctx = { params: Promise<{ id: string }> }

// Follow is intentionally NOT gated by profile visibility — sending a
// follow is the path to seeing a stricter-tier user later, so blocking
// it here would be circular. The endpoint returns a uniform success
// shape whether or not the target exists / accepts (an unknown public id
// answers the same 200 after the limiter; a target deleted mid-request trips
// the FK and gets the same 200), but the timing channel still leaks existence (a real user's
// upsert takes a different shape than a non-existent target's failed
// insert). At 10k users this defense is theatre — narrowing the leak
// further would require always running the same SQL shape regardless
// of branch, which isn't worth the complexity.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const { id } = await params
  const publicId = parsePublicIdParam(id)
  if (publicId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  const followingId = await userIdForPublicId(publicId)
  if (followerId === followingId) return NextResponse.json({ error: 'cannot follow yourself' }, { status: 400 })

  const rl = await checkRate(`rl:follow:${followerId}:1h`, 60, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many follows. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })
  // 🔒 An unknown public id: the limiter is charged and the answer is the
  // same 200 a blocked-me target gets (public-user-ids § 4).
  if (followingId === null) return NextResponse.json({ following: true })

  // Block check — scenario 12a vs 12b:
  //   12a: viewer blocked target → reject with explicit message (the
  //        viewer knows they blocked, no leak).
  //   12b: target blocked viewer → uniform 200 silent no-op. Matches
  //        the non-existent-target shape so the blocked side can't
  //        infer the block via response code.
  // Both checks run in parallel — they're independent queries. Priority
  // on conflict: 12b wins (silent 200) so the blocker-side reject
  // doesn't surface when there's a reverse-direction block to mask.
  const [blockedByAuthor, viewerBlocked] = await Promise.all([
    authorBlocksViewer(followerId, followingId),
    viewerBlocksAuthor(followerId, followingId),
  ])
  if (blockedByAuthor) {
    return NextResponse.json({ following: true })
  }
  if (viewerBlocked) {
    return NextResponse.json({ error: 'you blocked this user' }, { status: 400 })
  }

  // Catch FK violation (target user doesn't exist) and surface the same
  // {following: true} shape a real target produces. Without this, the
  // route would 500 on a non-existent id, giving a clean existence
  // oracle (200 = exists, 500 = doesn't). At 10k users this defense is
  // partial — query timing still differs measurably between branches —
  // but the response code/body channel is closed.
  try {
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId } },
      create: { followerId, followingId },
      update: {},
    })
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'P2003') throw err
  }
  return NextResponse.json({ following: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const publicId = parsePublicIdParam((await params).id)
  if (publicId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  const followingId = await userIdForPublicId(publicId)
  if (followingId !== null) await prisma.follow.deleteMany({ where: { followerId, followingId } })
  return NextResponse.json({ following: false })
}
