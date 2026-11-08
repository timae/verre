import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { openAsParticipant, hostLineupWrite } from '@/lib/sessionRoute'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  const { meta, identity } = op
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can reveal wines' }, { status: 403 })
  }

  // Mirrored to Postgres through the wine-list mirror (the feed-read path
  // queries wines.revealed_at when the cache has no copy) — every session with
  // a live row, anon-hosted included once promoted.
  const revealedAt = new Date()
  const out = await hostLineupWrite(c, identity, { label: 'reveal', forbidden: 'only the host can reveal wines' }, (wines) => {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return { reject: 'wine not found' }
    const next = wines.slice()
    next[idx] = { ...next[idx], revealedAt: revealedAt.toISOString() }
    return next
  })
  if (out instanceof NextResponse) return out
  const revealedWine = out.find(w => w.id === wineId)!
  await touchWithMeta(c)

  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([revealedWine], identities)
  return NextResponse.json(
    { ok: true, wine: wineToWire(revealedWine, identity.id, identities, userNameLookup, meta.showProvenance !== false) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  const { meta, identity } = op
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can hide wines' }, { status: 403 })
  }

  const out = await hostLineupWrite(c, identity, { label: 'hide', forbidden: 'only the host can hide wines' }, (wines) => {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return { reject: 'wine not found' }
    const next = wines.slice()
    const updated = { ...next[idx] }
    delete (updated as Partial<typeof updated>).revealedAt
    next[idx] = updated
    return next
  })
  if (out instanceof NextResponse) return out
  const hiddenWine = out.find(w => w.id === wineId)!
  await touchWithMeta(c)

  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([hiddenWine], identities)
  return NextResponse.json(
    { ok: true, wine: wineToWire(hiddenWine, identity.id, identities, userNameLookup, meta.showProvenance !== false) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
