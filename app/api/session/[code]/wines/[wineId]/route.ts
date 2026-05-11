import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines, addWineToSession, pgUpsertWine } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { resolveIdentity, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { deleteImage } from '@/lib/s3'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
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
    return NextResponse.json({ error: 'only the host can edit wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const result = await addWineToSession(c, body, wines[idx])
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines[idx] = result
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  if (session?.user) {
    try { await pgUpsertWine(c, result) } catch {}
  }

  return NextResponse.json(result)
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can delete wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const updated = wines.filter(w => w.id !== wineId)
  await redis.set(k.wines(c), JSON.stringify(updated), { KEEPTTL: true })
  const ratingKeys = await redis.keys(`s:${c}:r:*:${wineId}`)
  for (const rk of ratingKeys) await redis.del(rk)
  deleteImage(wineId).catch(() => {})
  await touchWithMeta(c)

  try { await prisma.wine.delete({ where: { id: wineId } }) } catch {}

  return NextResponse.json({ ok: true })
}
