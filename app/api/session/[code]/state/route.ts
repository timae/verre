import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { openSessionFor, servedLineup } from '@/lib/sessionRoute'
import { normalizeCode } from '@verre/core'
import {
  buildMetaView,
  buildWinesView,
  buildRatingsView,
  viewerUserIdFrom,
} from '@/lib/sessionState'

// Aggregate session poll: { meta, wines, ratings } in one request, replacing
// the three 5s polls (meta / wines / ratings). Composes the SAME builders the
// standalone GETs call (lib/sessionState.ts) — never re-derives the
// security-sensitive transforms (block-pair arrays, avatar tier gate,
// blind/hideLineup redaction). docs/dev/proposals/mobile-app/02-realtime.md §2.
//
// Partial-failure isolation: collapsing three endpoints into one would
// otherwise turn one failing sub-view into a blank session. Each section
// builds independently; a failed section returns null and the client keeps
// its previous data for that section. All three failing → 500 (total
// failure is a server problem; let the client's retry/backoff handle it).
//
// The whole body is viewer-dependent (blind redaction + isMine keyed on the
// caller, viewerBlocksOut/In on the viewer): Cache-Control must stay
// `private, no-store` on every return path.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const noStore = { 'Cache-Control': 'private, no-store' }
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })

  // The entrance gate first (redis-rehydration § 5.3, leak-fixes F2): a cold
  // Postgres-backed moment is rebuilt here; 404 only when it is really gone
  // (the client then goes home), 503 + Retry-After while restoring, never a 404
  // for a live row; 429 to a non-member once the wrong-code budget is spent.
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  // The cached line-up when it is stamped with the record's revision, else the
  // record's (model change § 8a).
  const served = await servedLineup(c, opened, p.identity)
  if (served instanceof NextResponse) return served
  // The settings and the caller the line-up was read with (a refreshed
  // line-up comes with newer ones: lib/sessionRoute.ts servedLineup).
  const { wines, meta, identity: caller } = served

  const identities = await redis.hGetAll(k.identities(c))

  const [metaR, winesR, ratingsR] = await Promise.allSettled([
    buildMetaView(c, meta, caller, viewerUserIdFrom(session), identities),
    buildWinesView(c, meta, caller, identities, wines),
    buildRatingsView(c, identities, caller.id),
  ])
  for (const [name, r] of [['meta', metaR], ['wines', winesR], ['ratings', ratingsR]] as const) {
    if (r.status === 'rejected') console.error(`session state: ${name} section failed:`, r.reason)
  }
  if (metaR.status === 'rejected' && winesR.status === 'rejected' && ratingsR.status === 'rejected') {
    return NextResponse.json({ error: 'unavailable' }, { status: 500, headers: noStore })
  }

  return NextResponse.json(
    {
      meta: metaR.status === 'fulfilled' ? metaR.value : null,
      wines: winesR.status === 'fulfilled' ? winesR.value : null,
      ratings: ratingsR.status === 'fulfilled' ? ratingsR.value : null,
    },
    { headers: noStore },
  )
}
