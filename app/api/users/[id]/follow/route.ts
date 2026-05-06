import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const { id } = await params
  const followingId = Number(id)
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

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const followerId = Number(session.user.id)
  const followingId = Number((await params).id)
  await prisma.follow.deleteMany({ where: { followerId, followingId } })
  return NextResponse.json({ following: false })
}
