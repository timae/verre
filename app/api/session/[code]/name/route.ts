import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, authInvalid } from '@/lib/identity'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return authInvalid()
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can rename this session' }, { status: 403 })
  }

  const name = String(body.name || '').trim().slice(0, 80)
  meta.name = name
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: 48 * 3600 })
  await touchWithMeta(c)
  try { await prisma.session.update({ where: { code: c }, data: { name: name || null } }) } catch {}
  return NextResponse.json({ ok: true, name })
}
