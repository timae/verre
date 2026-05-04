import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const { id } = await params

  const rl = await checkRate(`rl:like:${userId}:1h`, 120, 3600)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many likes.' }, { status: 429 })

  await prisma.checkinLike.upsert({
    where: { userId_checkinId: { userId, checkinId: Number(id) } },
    create: { userId, checkinId: Number(id) },
    update: {},
  })
  const count = await prisma.checkinLike.count({ where: { checkinId: Number(id) } })
  return NextResponse.json({ liked: true, count })
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const { id } = await params
  await prisma.checkinLike.deleteMany({ where: { userId, checkinId: Number(id) } })
  const count = await prisma.checkinLike.count({ where: { checkinId: Number(id) } })
  return NextResponse.json({ liked: false, count })
}
