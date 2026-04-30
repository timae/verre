import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, lifespanTTL, LIFESPAN } from '@/lib/redis'
import { genCode, pgUpsertSession } from '@/lib/session'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const session = await auth()
  const { hostName, sessionName, blind, lifespan } = await req.json()
  if (!hostName) return NextResponse.json({ error: 'hostName required' }, { status: 400 })

  // blind tasting requires a pro account
  if (blind && (!session?.user || !(session.user as { pro?: boolean }).pro)) {
    return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
  }

  let code: string
  for (let i = 0; i < 10; i++) {
    code = genCode()
    if (!(await redis.exists(k.meta(code!)))) break
  }
  code = code!

  // lifespan beyond 48h requires pro
  const isPro = !!(session?.user as { pro?: boolean } | undefined)?.pro
  const resolvedLifespan = (lifespan && lifespan !== '48h' && !isPro) ? '48h' : (lifespan || '48h')
  const sessionTTL = lifespanTTL(resolvedLifespan)

  const meta = {
    host: hostName,
    name: sessionName ? String(sessionName).trim().slice(0, 80) : '',
    createdAt: Date.now(),
    hostUserId: session?.user?.id ? Number(session.user.id) : null,
    blind: !!blind,
    lifespan: resolvedLifespan,
    coHosts: [] as string[],
  }

  await redis.set(k.meta(code), JSON.stringify(meta), { EX: sessionTTL })
  await redis.set(k.wines(code), '[]', { EX: sessionTTL })
  await redis.sAdd(k.users(code), hostName)
  await redis.expire(k.users(code), sessionTTL)

  if (session?.user) {
    try {
      await prisma.session.create({
        data: {
          code,
          hostUserId: Number(session.user.id),
          hostName,
          name: meta.name || null,
          blind: !!blind,
          createdAt: new Date(meta.createdAt),
        },
      })
    } catch {}
  }

  return NextResponse.json({ code, name: meta.name, host: hostName, blind: !!blind, lifespan: resolvedLifespan })
}
