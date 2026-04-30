import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcrypt'

export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const { name, email, currentPassword, newPassword } = await req.json()
  const userId = Number(session.user.id)
  const updates: Record<string, unknown> = {}

  if (name !== undefined) {
    const n = String(name).trim().slice(0, 64)
    if (!n) return NextResponse.json({ error: 'name required' }, { status: 400 })
    updates.name = n
  }

  if (email !== undefined) {
    const e = String(email).trim().toLowerCase()
    if (!e.includes('@')) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    updates.email = e
  }

  if (newPassword !== undefined) {
    if (!currentPassword) return NextResponse.json({ error: 'current password required' }, { status: 400 })
    if (String(newPassword).length < 8) return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })
    const valid = await bcrypt.compare(String(currentPassword), user.passwordHash)
    if (!valid) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    updates.passwordHash = await bcrypt.hash(String(newPassword), 10)
  }

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true })

  try {
    await prisma.user.update({ where: { id: userId }, data: updates })
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'email already in use' }, { status: 409 })
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
