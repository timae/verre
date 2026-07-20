import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, mutateWines, isMutateReject, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can reveal wines' }, { status: 403 })
  }

  const revealedAt = new Date()
  const out = await mutateWines(c, (wines) => {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return { reject: 'wine not found' }
    const next = wines.slice()
    next[idx] = { ...next[idx], revealedAt: revealedAt.toISOString() }
    return next
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
  const revealedWine = out.find(w => w.id === wineId)!
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

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can hide wines' }, { status: 403 })
  }

  const out = await mutateWines(c, (wines) => {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return { reject: 'wine not found' }
    const next = wines.slice()
    const updated = { ...next[idx] }
    delete (updated as Partial<typeof updated>).revealedAt
    next[idx] = updated
    return next
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 404 })
  const hiddenWine = out.find(w => w.id === wineId)!
  await touchWithMeta(c)

  // Mirror the un-reveal to Postgres — same rationale as the POST path.
  try {
    await prisma.wine.updateMany({ where: { id: wineId }, data: { revealedAt: null } })
  } catch (err) {
    console.error('un-reveal pg update error:', err)
  }

  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup([hiddenWine], identities)
  return NextResponse.json(
    { ok: true, wine: wineToWire(hiddenWine, identity.id, identities, userNameLookup, meta.showProvenance !== false) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
