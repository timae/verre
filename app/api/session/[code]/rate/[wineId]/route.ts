import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@/lib/sessionCode'
import { resolveIdentity, authInvalid } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  const identity = await resolveIdentity(c, req, session)
  if (!identity) return authInvalid()

  await redis.del(k.rating(c, identity.id, wineId))
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
