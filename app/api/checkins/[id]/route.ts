import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const { id } = await params
  const checkin = await prisma.checkin.findUnique({ where: { id: Number(id) } })
  if (!checkin) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (checkin.userId !== Number(session.user.id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  await prisma.checkin.delete({ where: { id: Number(id) } })
  return NextResponse.json({ ok: true })
}
