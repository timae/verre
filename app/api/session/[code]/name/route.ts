import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
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
  const session = await resolveUser(req)
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

  // A moment name is REQUIRED (Simon, 2026-07-06) — this rename path is a 4th
  // name-write surface beside create + the settings PATCH; it must enforce the
  // same invariant or a host could blank the name here.
  const name = String(body.name || '').trim().slice(0, 80)
  if (!name) return NextResponse.json({ error: 'Please name your moment.' }, { status: 400 })
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
