import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { normalizeCode } from '@verre/core'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { canUseCatalog } from '@/lib/catalogGate'
import { answerCatalogSearch } from '@/lib/catalogSearchAnswer'
import { openSessionFor } from '@/lib/sessionRoute'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { isHostByIdentity, isProvider } from '@/lib/session'

// GET /api/session/<code>/catalog/search — the catalogue search from INSIDE a
// moment (catalogue model change § 2, ruled 2026-11-18; review r1 B2).
//
// Guests may pick an existing entry but never create one, and picking needs a
// search, which the global route answers only to a signed-in caller (no open
// enumeration channel). So a guest who hosts or brings bottles searches here:
// the same queries and the same answer (lib/catalogSearchAnswer.ts, producer /
// product / vintages), for a caller who may add bottles to THIS moment.
//
// Order, each before the next: 🔒 the entrance gate (`openSessionFor`: a wrong
// code pays the wrong-code budget like every moment route, the § 20 b route
// sweep holds this route to it), the participant gate, the wine POST's power
// test (host, cohost, provider; 403 otherwise), the kill switch (404, as the
// global route), then the budget: per USER when signed in (`rl:catalog-search`,
// the global route's key: the two don't stack), per ADDRESS for a guest
// (`getClientIp`: a guest identity is re-minted on every join, the
// `catalogLinkRateKey` reasoning), 60 a minute to start (one venue's guests
// share an address, but only hosts and bringers search; app/api/rate-limits.md).
// Effect, accepted by ruling: anyone who creates a guest moment can search the
// catalogue at that rate (it is open; this only widens who may search it).

type Ctx = { params: Promise<{ code: string }> }

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const identity = p.identity
  if (!isHostByIdentity(opened.meta, identity) && !isProvider(opened.meta, identity)) {
    return NextResponse.json({ error: 'only the host or a provider can add wines' }, { status: 403 })
  }
  const userId = session?.user ? Number(session.user.id) : null
  if (!(await canUseCatalog(userId))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const rl = userId !== null
    ? await checkRate(`rl:catalog-search:u:${userId}:1m`, 30, 60)
    : await checkRate(`rl:catalog-search:ip:${getClientIp(req)}:1m`, GUEST_SEARCHES_PER_MINUTE, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  return answerCatalogSearch(req.nextUrl.searchParams)
}

const GUEST_SEARCHES_PER_MINUTE = 60
