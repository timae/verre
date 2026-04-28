import { NextRequest, NextResponse } from 'next/server'
import { redis, k, TTL } from '@/lib/redis'
import { touch } from '@/lib/session'

export async function POST(req: NextRequest) {
  const { code, userName } = await req.json()
  if (!code || !userName) return NextResponse.json({ error: 'code and userName required' }, { status: 400 })

  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  await redis.sAdd(k.users(c), userName)
  await touch(c)

  return NextResponse.json({ ...JSON.parse(raw), code: c })
}
