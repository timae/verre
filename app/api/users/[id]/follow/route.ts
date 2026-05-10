import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ id: string }> }

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

  await prisma.follow.upsert({
    where: { followerId_followingId: { followerId, followingId } },
    create: { followerId, followingId },
    update: {},
  })
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
