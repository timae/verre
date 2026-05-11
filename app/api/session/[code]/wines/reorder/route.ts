import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines, wineToWire } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
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
    return NextResponse.json({ error: 'only the host can reorder wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const orderedIds: string[] = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : []
  if (orderedIds.length !== wines.length) {
    return NextResponse.json({ error: 'orderedIds length mismatch' }, { status: 400 })
  }

  const byId = new Map(wines.map(w => [w.id, w]))
  if (orderedIds.some(id => !byId.has(id)) || new Set(orderedIds).size !== wines.length) {
    return NextResponse.json({ error: 'invalid orderedIds' }, { status: 400 })
  }

  const reordered = orderedIds.map(id => byId.get(id)!)
  await redis.set(k.wines(c), JSON.stringify(reordered), { KEEPTTL: true })
  await touchWithMeta(c)
  // Same wire shape as the wines GET — strip `addedByIdentityId` and
  // synthesize `isMine`. Without this, the reorder response would leak
  // provenance the GET pipeline carefully keeps server-internal.
  return NextResponse.json(
    reordered.map(w => wineToWire(w, identity.id)),
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
