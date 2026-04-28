import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const keys = await redis.keys(`s:${c}:r:*`)
  const result: Record<string, Record<string, unknown>> = {}
  for (const key of keys) {
    const parts = key.split(':')
    const user = parts[3]
    const wineId = parts[4]
    const val = await redis.get(key)
    if (!result[user]) result[user] = {}
    if (val) result[user][wineId] = JSON.parse(val)
  }
  return NextResponse.json(result)
}
