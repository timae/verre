import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, isProviderById, getSessionMeta, getWines, addWineToSession, pgUpsertWine, wineToWire } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
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

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Hosts (including cohosts) can edit any wine. Providers can edit
  // only the wines they themselves added — matched via the wine's
  // `addedByIdentityId`. Wines from before the provider feature have
  // NULL provenance and aren't editable by providers.
  const isHost = isHostByIdentity(meta, identity)
  const isOwnAsProvider = isProviderById(meta, identity.id) && wines[idx].addedByIdentityId === identity.id
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can edit it' }, { status: 403 })
  }

  const result = await addWineToSession(c, body, wines[idx])
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines[idx] = result
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  if (session?.user) {
    try { await pgUpsertWine(c, result) } catch {}
  }

  // Same wire shape as GET so a client storing this response back into
  // its wines cache doesn't see a different shape than the polling GET
  // would produce.
  return NextResponse.json(wineToWire(result, identity.id))
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

  const wines = await getWines(c)
  const targetWine = wines.find(w => w.id === wineId)
  if (!targetWine) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Same provider/host rules as PATCH.
  const isHost = isHostByIdentity(meta, identity)
  const isOwnAsProvider = isProviderById(meta, identity.id) && targetWine.addedByIdentityId === identity.id
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can delete it' }, { status: 403 })
  }

  const updated = wines.filter(w => w.id !== wineId)
  await redis.set(k.wines(c), JSON.stringify(updated), { KEEPTTL: true })
  const ratingKeys = await redis.keys(`s:${c}:r:*:${wineId}`)
  for (const rk of ratingKeys) await redis.del(rk)
  deleteImage(wineId).catch(() => {})
  await touchWithMeta(c)

  try { await prisma.wine.delete({ where: { id: wineId } }) } catch {}

  return NextResponse.json({ ok: true })
}
