import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { openSession, unavailable } from '@/lib/sessionRehydrate'
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

  // Session opened first (redis-rehydration § 5.3): a cold Postgres-backed
  // moment is rebuilt here; 404 only when it is really gone (the client then
  // goes home), 503 + Retry-After while restoring — never a 404 for a live row.
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const { meta, wines } = opened

  const session = await resolveUser(req)
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const caller = p.identity

  const identities = await redis.hGetAll(k.identities(c))

  const [metaR, winesR, ratingsR] = await Promise.allSettled([
    buildMetaView(c, meta, caller, viewerUserIdFrom(session), identities),
    buildWinesView(c, meta, caller, identities, wines),
    buildRatingsView(c, identities),
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
