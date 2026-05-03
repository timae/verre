import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { validateDisplayName } from '@/lib/displayName'
import { checkRate, getClientIp } from '@/lib/rateLimit'

const schema = z.object({
  name:     z.string(),
  email:    z.string().email(),
  password: z.string().min(8),
})

export async function POST(req: NextRequest) {
  // Rate limit: 100 registrations per minute per IP. Generous enough for
  // a busy event where many people sign up at once; tight enough to make
  // sustained signup spam expensive.
  const ip = getClientIp(req)
  const rl = await checkRate(`rl:register:ip:${ip}:1m`, 100, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many registration attempts. Try again later.', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 })

  let name: string
  try { name = validateDisplayName(parsed.data.name) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const { email, password } = parsed.data
  try {
    const hash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), passwordHash: hash },
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
