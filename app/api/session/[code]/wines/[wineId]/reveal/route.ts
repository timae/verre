import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
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
    return NextResponse.json({ error: 'only the host can reveal wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const revealedAt = new Date()
  wines[idx] = { ...wines[idx], revealedAt: revealedAt.toISOString() }
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  // Mirror the reveal to Postgres so the post-rewire feed-read path
  // (which queries wines.revealed_at directly) renders correctly after
  // Redis evicts the session. Silently no-ops for anon-host wines —
  // their Postgres row doesn't exist because pgUpsertWine only fires
  // for logged-in hosts. Captured in .local/future-work-rewire.md
  // ("Anon-host blind session reveal persistence").
  try {
    await prisma.wine.updateMany({ where: { id: wineId }, data: { revealedAt } })
  } catch (err) {
    console.error('reveal pg update error:', err)
  }

  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([wines[idx]], identities)
  return NextResponse.json(
    { ok: true, wine: wineToWire(wines[idx], identity.id, identities, userNameLookup) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
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
    return NextResponse.json({ error: 'only the host can hide wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const updated = { ...wines[idx] }
  delete (updated as Partial<typeof updated>).revealedAt
  wines[idx] = updated
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  // Mirror the un-reveal to Postgres — same rationale as the POST path.
  try {
    await prisma.wine.updateMany({ where: { id: wineId }, data: { revealedAt: null } })
  } catch (err) {
    console.error('un-reveal pg update error:', err)
  }

  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([wines[idx]], identities)
  return NextResponse.json(
    { ok: true, wine: wineToWire(wines[idx], identity.id, identities, userNameLookup) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
