import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate } from '@/lib/rateLimit'
import { canUseCatalog } from '@/lib/catalogGate'
import { searchProducers, searchProducts } from '@/lib/catalogSearch'

// Add-time catalog search — the SEARCH-FIRST half of RFC § Add-a-wine flow.
//
// GET /api/catalog/search?kind=producer&q=…
// GET /api/catalog/search?kind=product&q=…&producerId=…
//
// Returns SUGGESTIONS for a human to choose from. 🔒 Nothing about a result
// here links anything: the caller picks explicitly, or creates a new entry.
// The match is never a find-or-create hook (the invariant everything hangs on).
//
// Auth required. Anonymous callers get 401 rather than an open enumeration
// channel over the whole catalog, matching /api/users/search. Note this is
// about ENUMERATION VOLUME, not secrecy — the catalog itself is deliberately
// open (RFC ruling 3), and catalog records are uniformly presented with no
// status, createdAt, or adder identity exposed. 🔒 That uniformity is what
// ruling 3 is contingent on: do not add a "recently added" filter or a
// provisional badge to this response without re-deriving that decision.

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // 🔒 404, not 403 — see lib/catalogGate.ts. While the switch is off this
  // endpoint must look like it does not exist.
  if (!(await canUseCatalog(userId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // A trigram scan over the whole catalog is the expensive query in this
  // feature, so it is capped like /api/users/search. Caller-keyed, not
  // IP-keyed: IP would bucket a shared-NAT office into one budget.
  const rl = await checkRate(`rl:catalog-search:u:${userId}:1m`, 30, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const params = req.nextUrl.searchParams
  const kind = params.get('kind')
  const q = params.get('q') ?? ''
  const producerId = params.get('producerId') || undefined

  if (kind === 'producer') {
    const results = await searchProducers(q)
    return NextResponse.json({ results }, { headers: NO_STORE })
  }
  if (kind === 'product') {
    // 🔒 `producerId` IS REQUIRED ON THE PUBLIC PRODUCT PATH, and this is a
    // capacity decision as much as a UX one.
    //
    // The add-flow is documented as search-first and PRODUCER-FIRST (RFC
    // § Add-a-wine flow: branches 2–4 all begin from a chosen producer), so a
    // global product-name search is not a step the flow actually needs — and
    // generic product names ("Réserve", "Brut") collide constantly across
    // producers, so an unscoped result list is mostly noise even when it is
    // fast.
    //
    // Measured at 500k rows, this is the difference between a working feature
    // and an outage: unscoped product search ran ~1.15 s median / 1.23 s p95,
    // while the SAME search scoped by producer ran ~15 ms p95 and stayed flat
    // from 60k to 500k. Under 50 concurrent unscoped requests, 31 failed
    // outright on pool exhaustion. Requiring the scope REMOVES the expensive
    // query shape rather than optimising it.
    //
    // The unscoped path still exists in `searchProducts` for the phase-3
    // review queue (staff-gated, low volume, and legitimately global — a
    // curator hunting duplicates has no producer to scope by).
    if (!producerId) {
      return NextResponse.json(
        { error: 'producerId is required — choose a producer first' },
        { status: 400, headers: NO_STORE },
      )
    }
    const results = await searchProducts(q, { producerId })
    return NextResponse.json({ results }, { headers: NO_STORE })
  }
  return NextResponse.json({ error: 'kind must be producer or product' }, { status: 400 })
}

// The body doesn't vary by viewer today, but it is gated per-caller (the staff
// bypass means a staff caller can reach it while the public cannot), so a
// shared cache could serve a staff-visible response to a gated one.
const NO_STORE = { 'Cache-Control': 'private, no-store' }
