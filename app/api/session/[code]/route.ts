import { NextRequest, NextResponse } from 'next/server'
import { redis, k } from '@/lib/redis'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const users = await redis.sMembers(k.users(c))
  return NextResponse.json({ ...JSON.parse(raw), code: c, users })
}
