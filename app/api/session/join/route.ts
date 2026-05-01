import { NextRequest, NextResponse } from 'next/server'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { touch } from '@/lib/session'
import { validateDisplayName } from '@/lib/displayName'

export async function POST(req: NextRequest) {
  const { code, userName: rawUserName } = await req.json()
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  let userName: string
  try { userName = validateDisplayName(rawUserName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  await redis.sAdd(k.users(c), userName)
  await touchWithMeta(c)

  return NextResponse.json({ ...JSON.parse(raw), code: c })
}
