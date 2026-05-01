import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { resolveIdentity } from '@/lib/identity'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { code, wineId } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName } = await req.json()

  const identity = await resolveIdentity(c, req, session, userName ?? null)
  if (!identity) return NextResponse.json({ error: 'identity required' }, { status: 401 })

  await redis.del(k.rating(c, identity.displayName, wineId))
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
