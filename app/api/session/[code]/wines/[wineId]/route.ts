import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta, scanKeys } from '@/lib/redis'
import { isHostByIdentity, isProviderById, getSessionMeta, getWines, mutateWines, isMutateReject, addWineToSession, pgUpsertWine, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { normalizeCode } from '@verre/core'
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

  // addWineToSession may do an S3 upload — a side effect that must run
  // OUTSIDE the WATCH/MULTI transform (the transform can run multiple
  // times on retry and must stay pure). Build the result here against the
  // wine we read, then atomically splice it in by id below.
  const result = await addWineToSession(c, body, wines[idx])
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  const out = await mutateWines(c, (current) => {
    const i = current.findIndex(w => w.id === wineId)
    if (i === -1) return { reject: 'wine not found' }
    const next = current.slice()
    next[i] = result
    return next
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
  await touchWithMeta(c)

  if (session?.user) {
    try { await pgUpsertWine(c, result) } catch {}
  }

  // Same wire shape as GET so a client storing this response back into
  // its wines cache doesn't see a different shape than the polling GET
  // would produce — including the kicked-user fallback for the adder
  // name, so an edit response and the next poll resolve to the same
  // `addedByDisplayName` value.
  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([result], identities)
  return NextResponse.json(wineToWire(result, identity.id, identities, userNameLookup))
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

  const out = await mutateWines(c, (current) => {
    if (!current.some(w => w.id === wineId)) return { reject: 'wine not found' }
    return current.filter(w => w.id !== wineId)
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
  const ratingKeys = await scanKeys(`s:${c}:r:*:${wineId}`)
  if (ratingKeys.length > 0) await redis.del(ratingKeys)
  deleteImage(wineId).catch(() => {})
  await touchWithMeta(c)

  try { await prisma.wine.delete({ where: { id: wineId } }) } catch {}

  return NextResponse.json({ ok: true })
}
