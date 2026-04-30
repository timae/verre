import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const schema = z.object({
  name:     z.string().min(1).max(64),
  email:    z.string().email(),
  password: z.string().min(8),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 })

  const { name, email, password } = parsed.data
  try {
    const hash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: { name: name.trim(), email: email.toLowerCase(), passwordHash: hash },
      select: { id: true, name: true, email: true, role: true, pro: true },
    })
    return NextResponse.json({ user })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: 'email already registered' }, { status: 409 })
    }
    return NextResponse.json({ error: 'registration failed' }, { status: 500 })
  }
}
