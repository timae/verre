import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, isProviderById, getSessionMeta, getWines, addWineToSession, pgUpsertSession, pgUpsertWine, wineToWire, buildKickedUserNameLookup } from '@/lib/session'
import type { WineMeta, WireWine } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

// Produce a redacted WireWine directly — wines that hit this path are by
// definition not the caller's own (the provider-bypass at the call site
// filters those out), so isMine is always false. Returning WireWine
// straight skips a second pass through `wineToWire`.
function redactWine(wine: WineMeta, index: number): WireWine {
  const { addedByIdentityId: _provenance, addedByDisplayName: _snapshot, ...rest } = wine
  return {
    ...rest,
    name: `Wine ${index + 1}`,
    producer: '',
    vintage: '',
    grape: '',
    type: 'red',   // keep as red for FL purposes but will show mystery icon
    image: '',
    imageUrl: '',
    // Metadata fields that would leak wine identity to a blind taster —
    // strip alongside name/producer/vintage/grape. Country/region/
    // vinification narrow the wine geographically; description/purchaseUrl
    // can name it outright. `addedByDisplayName` is stripped too: a
    // blind taster knowing "Alice brought this one" partially identifies
    // the wine via Alice's known preferences.
    description: '',
    region: '',
    country: '',
    vinification: '',
    purchaseUrl: '',
    isMine: false,
    addedByDisplayName: null,
    addedByUserId: null,
    _blind: true,
  }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

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

  const wines = await getWines(c)
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const isUserHost = isHostByIdentity(meta, identity)

  // Lineup hidden until X minutes before start
  if (meta.hideLineup && meta.dateFrom && !isUserHost) {
    const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60 * 1000
    if (Date.now() < revealAt) return NextResponse.json([])
  }

  // Hybrid resolution for `addedByDisplayName`: live identities map →
  // users.name fallback for kicked logged-in adders → snapshot on the
  // wine itself → null. Fetch once per request and thread through.
  const identities = await redis.hGetAll(k.identities(c))
  const userNameLookup = await buildKickedUserNameLookup(wines, identities)

  if (meta.blind && !isUserHost) {
    // Per-wine redaction: a wine is shown un-redacted if it's revealed
    // OR if the caller is the provider who added it (providers see
    // their own wines un-redacted while still being blind to other
    // tasters' contributions). Pre-feature wines have NULL
    // `addedByIdentityId` and never match the provider exception —
    // they redact like any other wine the caller didn't add.
    return NextResponse.json(
      wines.map((w, i) => {
        const ownsThisWine = !!w.addedByIdentityId && w.addedByIdentityId === identity.id
        const showFull = w.revealedAt || ownsThisWine
        return showFull ? wineToWire(w, identity.id, identities, userNameLookup) : redactWine(w, i)
      }),
      // Response varies per viewer (provider sees own un-redacted; the
      // isMine flag is per-caller). Force private, no-store so no
      // intermediary cache can serve one viewer's payload to another.
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  return NextResponse.json(
    wines.map(w => wineToWire(w, identity.id, identities, userNameLookup)),
    // Non-blind path: isMine still varies per viewer, so same cache
    // posture applies.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await auth()
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

  const wines = await getWines(c)
  // Pass the adder's identity so the wine record carries provenance
  // (used by ban-with-delete-wines to identify which wines to orphan).
  // Snapshot the adder's current display name from the live identities
  // map so it survives a future kick/ban. Lookup happens here (not in
  // addWineToSession) because the helper is shared with the PATCH
  // route where snapshot freezing means we never re-resolve.
  const identities = await redis.hGetAll(k.identities(c))
  const adderDisplayName = identities[identity.id] || identity.displayName
  const result = await addWineToSession(c, body, undefined, identity.id, adderDisplayName)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines.push(result)
  // Optional one-shot insert position (1-indexed). Out-of-range silently
  // falls through to "append at end" — frontend validates the range.
  // Host-only: the standalone reorder endpoint is host-only, and we don't
  // want providers driving a partial reorder via the POST back door
  // (they're documented as unable to reorder wines). Ignored for
  // non-host callers — appends at end.
  if (isHostByIdentity(meta, identity)) {
    const pos = Number(body.position)
    if (Number.isInteger(pos) && pos >= 1 && pos < wines.length) {
      const inserted = wines.pop()!
      wines.splice(pos - 1, 0, inserted)
    }
  }
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
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
