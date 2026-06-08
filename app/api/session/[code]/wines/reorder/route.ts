import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, mutateWines, isMutateReject, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import { normalizeCode } from '@verre/core'
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

  const orderedIds: string[] = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : []

  // Reorder is a pure permutation of the CURRENT list, so the validity
  // checks (length + id-set match) run inside the transform against the
  // watched value — a wine added/removed by a concurrent request would
  // otherwise pass a stale check and then clobber that change.
  const out = await mutateWines(c, (wines) => {
    if (orderedIds.length !== wines.length) return { reject: 'orderedIds length mismatch' }
    const byId = new Map(wines.map(w => [w.id, w]))
    if (orderedIds.some(id => !byId.has(id)) || new Set(orderedIds).size !== wines.length) {
      return { reject: 'invalid orderedIds' }
    }
    return orderedIds.map(id => byId.get(id)!)
  })
  if (isMutateReject(out)) return NextResponse.json({ error: out.reject }, { status: 400 })
  await touchWithMeta(c)
  // Same wire shape as the wines GET — strip `addedByIdentityId` and
  // synthesize `isMine`. Without this, the reorder response would leak
  // provenance the GET pipeline carefully keeps server-internal.
  // Identities + kicked-user fallback ensure `addedByDisplayName` resolves
  // to the same value the polling GET would produce.
  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup(out, identities)
  return NextResponse.json(
    out.map(w => wineToWire(w, identity.id, identities, userNameLookup)),
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
