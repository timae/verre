import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can rename this session' }, { status: 403 })
  }

  const name = String(body.name || '').trim().slice(0, 80)
  meta.name = name
  // KEEPTTL — don't downgrade a pro session's 72h/1w/unlimited lifespan
  // to 48h on a rename.
  await redis.set(k.meta(c), JSON.stringify(meta), { KEEPTTL: true })
  await touchWithMeta(c)
  // updateMany so a soft-deleted code (NULL) misses cleanly — `update`
  // would throw if the unique target doesn't exist.
  try { await prisma.session.updateMany({ where: { code: c, deletedAt: null }, data: { name: name || null } }) } catch {}
  return NextResponse.json({ ok: true, name })
}
