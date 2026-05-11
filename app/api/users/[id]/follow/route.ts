import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ id: string }> }

// Follow is intentionally NOT gated by profile visibility — sending a
// follow is the path to seeing a stricter-tier user later, so blocking
// it here would be circular. The endpoint returns a uniform success
// shape whether or not the target exists / accepts; if the target id
// references a missing user, the FK constraint trips and we surface
// a 400, but the timing channel still leaks existence (a real user's
// upsert takes a different shape than a non-existent target's failed
// insert). At 10k users this defense is theatre — narrowing the leak
// further would require always running the same SQL shape regardless
// of branch, which isn't worth the complexity.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const { id } = await params
  const followingId = parsePathId(id)
  if (followingId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  if (followerId === followingId) return NextResponse.json({ error: 'cannot follow yourself' }, { status: 400 })

  const rl = await checkRate(`rl:follow:${followerId}:1h`, 60, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many follows. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

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
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const followingId = parsePathId((await params).id)
  if (followingId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  await prisma.follow.deleteMany({ where: { followerId, followingId } })
  return NextResponse.json({ following: false })
}
