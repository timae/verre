import { NextRequest, NextResponse } from 'next/server'
import { redis, k, touchWithMeta } from '@/lib/redis'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { code, wineId } = await params
  const c = code.toUpperCase()
  const { userName } = await req.json()
  if (!userName) return NextResponse.json({ error: 'userName required' }, { status: 400 })
  await redis.del(k.rating(c, userName, wineId))
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
