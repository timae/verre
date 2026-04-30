import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { code, wineId } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName } = await req.json()
  if (!userName) return NextResponse.json({ error: 'userName required' }, { status: 400 })

  // When authenticated, the userName must match the auth session.
  if (session?.user && userName !== session.user.name) {
    return NextResponse.json({ error: 'userName does not match authenticated user' }, { status: 403 })
  }

  await redis.del(k.rating(c, userName, wineId))
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
