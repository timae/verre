import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { resolveIdentity, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
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

  wines[idx] = { ...wines[idx], revealedAt: new Date().toISOString() }
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  return NextResponse.json({ ok: true, wine: wines[idx] })
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

  return NextResponse.json({ ok: true, wine: wines[idx] })
}
