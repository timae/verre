import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { resolveIdentity, authInvalid } from '@/lib/identity'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  const { code, wineId } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName } = await req.json()

  const identity = await resolveIdentity(c, req, session, userName ?? null)
  if (!identity) return authInvalid()

  await redis.del(k.rating(c, identity.id, wineId))
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
