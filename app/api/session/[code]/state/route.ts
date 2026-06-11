import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { type SessionMeta } from '@/lib/session'
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

  // Session-existence check before participant check. 404 on a deleted /
  // never-existed session lets the client distinguish "go home" from "your
  // token is bad, retry join" (401 + x-vr-auth: invalid).
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })

  const session = await resolveUser(req)
  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const caller = p.identity

  const meta = JSON.parse(raw) as SessionMeta
  const identities = await redis.hGetAll(k.identities(c))

  const [metaR, winesR, ratingsR] = await Promise.allSettled([
    buildMetaView(c, meta, caller, viewerUserIdFrom(session), identities),
    buildWinesView(c, meta, caller, identities),
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
