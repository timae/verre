import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, isProviderById, getSessionMeta, mutateWines, addWineToSession, pgUpsertSession, pgUpsertWine, wineToWire } from '@/lib/session'
import { buildWinesView } from '@/lib/sessionState'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  // Session-existence check first. If the session was deleted or never
  // existed, return 404 — distinct from 401 ("session exists but you're
  // not a participant"). The client uses this to decide whether to bounce
  // the participant home (404 = session gone, leave) vs to /join/<code>
  // (401 = token bad / not in session, try to join).
  if (!(await redis.exists(k.meta(c)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const identity = p.identity

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Wire-shape assembly (hideLineup gate, blind redaction branch,
  // wineToWire) lives in lib/sessionState.ts buildWinesView — shared with
  // /api/session/:code/state.
  const identities = await redis.hGetAll(k.identities(c))
  const wines = await buildWinesView(c, meta, identity, identities)
  return NextResponse.json(
    wines,
    // Response varies per viewer (blind redaction, the isMine flag). Force
    // private, no-store so no intermediary cache can serve one viewer's
    // payload to another.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  // Banned cohosts must not be able to write wines until they next poll
  // and bounce. participantOrBanned does the same check that GET uses.
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  // Hosts, cohosts, and providers can all add wines. Providers can only
  // edit/delete the wines they added (gated in the [wineId] route by
  // matching `addedByIdentityId` to the caller).
  if (!isHostByIdentity(meta, identity) && !isProviderById(meta, identity.id)) {
    return NextResponse.json({ error: 'only the host or a provider can add wines' }, { status: 403 })
  }

  // Pass the adder's identity so the wine record carries provenance
  // (used by ban-with-delete-wines to identify which wines to orphan).
  // Snapshot the adder's current display name from the live identities
  // map so it survives a future kick/ban. Lookup happens here (not in
  // addWineToSession) because the helper is shared with the PATCH
  // route where snapshot freezing means we never re-resolve.
  // addWineToSession may upload to S3 — a side effect, so it runs OUTSIDE
  // the WATCH/MULTI transform below (which must stay pure across retries).
  const identities = await redis.hGetAll(k.identities(c))
  const adderDisplayName = identities[identity.id] || identity.displayName
  const result = await addWineToSession(c, body, undefined, identity.id, adderDisplayName)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  // Optional one-shot insert position (1-indexed). Out-of-range silently
  // falls through to "append at end" — frontend validates the range.
  // Host-only: the standalone reorder endpoint is host-only, and we don't
  // want providers driving a partial reorder via the POST back door
  // (they're documented as unable to reorder wines). Ignored for
  // non-host callers — appends at end. Resolved against the CURRENT list
  // inside the transform so a concurrent add doesn't shift the position.
  const callerIsHost = isHostByIdentity(meta, identity)
  const pos = Number(body.position)
  await mutateWines(c, (current) => {
    const next = current.slice()
    next.push(result)
    if (callerIsHost && Number.isInteger(pos) && pos >= 1 && pos < next.length) {
      next.pop()
      next.splice(pos - 1, 0, result)
    }
    return next
  })
  await touchWithMeta(c)

  if (session?.user) {
    try {
      await pgUpsertSession(c, meta)
      await pgUpsertWine(c, result)
    } catch {}
  }

  // Same wire shape as GET — clients that store POST responses back
  // into their wines list shouldn't see a different shape than the
  // polling GET. The caller is the wine's adder, so isMine is always
  // true here (wineToWire computes it from the just-written provenance).
  // Pass identities so `addedByDisplayName` resolves to the live name;
  // userNameLookup is empty (the just-added wine's adder is in the map).
  return NextResponse.json(wineToWire(result, identity.id, identities))
}
