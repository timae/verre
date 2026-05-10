import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const checkinId = parsePathId((await params).id)
  if (checkinId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const rl = await checkRate(`rl:like:${userId}:1h`, 120, 3600)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many likes.' }, { status: 429 })

  await prisma.checkinLike.upsert({
    where: { userId_checkinId: { userId, checkinId } },
    create: { userId, checkinId },
    update: {},
  })
  const count = await prisma.checkinLike.count({ where: { checkinId } })
  return NextResponse.json({ liked: true, count })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const checkinId = parsePathId((await params).id)
  if (checkinId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  await prisma.checkinLike.deleteMany({ where: { userId, checkinId } })
  const count = await prisma.checkinLike.count({ where: { checkinId } })
  return NextResponse.json({ liked: false, count })
}
