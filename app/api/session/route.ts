import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touch } from '@/lib/redis'
import { genCode, pgUpsertSession } from '@/lib/session'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const session = await auth()
  const { hostName, sessionName } = await req.json()
  if (!hostName) return NextResponse.json({ error: 'hostName required' }, { status: 400 })

  let code: string
  for (let i = 0; i < 10; i++) {
    code = genCode()
    if (!(await redis.exists(k.meta(code!)))) break
  }
  code = code!

  const meta = {
    host: hostName,
    name: sessionName ? String(sessionName).trim().slice(0, 80) : '',
    createdAt: Date.now(),
    hostUserId: session?.user?.id ? Number(session.user.id) : null,
  }

  await redis.set(k.meta(code), JSON.stringify(meta), { EX: TTL })
  await redis.set(k.wines(code), '[]', { EX: TTL })
  await redis.sAdd(k.users(code), hostName)
  await redis.expire(k.users(code), TTL)

  if (session?.user) {
    try {
      await prisma.session.create({
        data: {
          code,
          hostUserId: Number(session.user.id),
          hostName,
          name: meta.name || null,
          createdAt: new Date(meta.createdAt),
        },
      })
    } catch {}
  }

  return NextResponse.json({ code, name: meta.name, host: hostName })
}
