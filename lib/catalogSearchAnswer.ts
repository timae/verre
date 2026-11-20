import { NextResponse } from 'next/server'
import { searchProducers, searchProducts, browseProducts } from '@/lib/catalogSearch'
import { productVintages } from '@/lib/catalogEntries'
import { denyCatalogRef } from '@/lib/catalogWrite'
import { scrub } from '@/lib/textSafe'

// A producer's wines listed with no query: one page; `more: true` when cut
// (the picker then says to type).
const BROWSE_PAGE = 20
const ID = /^[A-Za-z0-9_-]{1,21}$/

// The ONE answer of a catalogue search (GET /api/catalog/search and the
// moment's own, GET /api/session/<code>/catalog/search; spec § 2): the same
// queries, the same response shape, the same generic denials. Each route runs
// its own gates and budget first.
//
//   ?kind=producer&q=…
//   ?kind=product&q=…&producerId=…   (🔒 producerId REQUIRED: capacity, see below;
//                                      q under 3 characters = that producer's wines, A to Z)
//   ?kind=vintages&productId=…        (ids + years only, NV included)
//
// Returns SUGGESTIONS for a human to choose from. 🔒 Nothing about a result
// links anything: the caller picks explicitly, or creates a new entry. The
// match is never a find-or-create hook (the invariant everything hangs on).
// 🔒 Records are uniformly presented: no status, createdAt or adder identity
// (RFC ruling 3 is contingent on that; lib/catalogSearch.ts strips them).
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function answerCatalogSearch(params: URLSearchParams): Promise<NextResponse> {
  const kind = params.get('kind')
  // Scrubbed like every free text from a request (a NUL byte would 500 in
  // Postgres, review r3).
  const q = scrub(params.get('q') ?? '') ?? ''
  if (kind === 'producer') {
    return NextResponse.json({ results: await searchProducers(q) }, { headers: NO_STORE })
  }
  if (kind === 'product') {
    // 🔒 `producerId` IS REQUIRED ON THE PUBLIC PRODUCT PATH, and this is a
    // capacity decision as much as a UX one: the add flow is producer-first
    // (RFC § Add-a-wine flow), generic product names ("Réserve", "Brut")
    // collide across producers, and measured at 500k rows an unscoped product
    // search ran ~1.15 s median while the scoped one stayed ~15 ms p95 (31 of
    // 50 concurrent unscoped requests failed on pool exhaustion). Requiring the
    // scope REMOVES the expensive shape. The unscoped path stays in
    // `searchProducts` for the staff-only review queue.
    const producerId = params.get('producerId') || undefined
    // The id's shape before it reaches Postgres (review r4: a NUL byte 500'd).
    if (producerId && !ID.test(producerId)) return NextResponse.json({ results: [] }, { headers: NO_STORE })
    if (!producerId) {
      return NextResponse.json({ error: 'producerId is required. Choose a producer first.' }, { status: 400, headers: NO_STORE })
    }
    // Fewer than 3 characters (a trigram): that producer's wines, A to Z, so a
    // short name is still found by picking it.
    if (q.trim().length < 3) {
      const page = await browseProducts(producerId, { prefix: q, limit: BROWSE_PAGE + 1 })
      return NextResponse.json({ results: page.slice(0, BROWSE_PAGE), ...(page.length > BROWSE_PAGE ? { more: true } : {}) }, { headers: NO_STORE })
    }
    return NextResponse.json({ results: await searchProducts(q, { producerId }) }, { headers: NO_STORE })
  }
  if (kind === 'vintages') {
    // Picking an existing vintage needs a read path (spec § 2, Codex r1):
    // product search returns no vintages. ADDING a missing one is the add
    // flow's branch 2 (signed in only).
    const productId = params.get('productId') || ''
    const results = ID.test(productId) ? await productVintages(productId) : null
    if (!results) {
      denyCatalogRef(`vintage lookup of ${productId}`)
      return NextResponse.json({ error: 'invalid catalog reference' }, { status: 400, headers: NO_STORE })
    }
    return NextResponse.json({ results }, { headers: NO_STORE })
  }
  return NextResponse.json({ error: 'kind must be producer, product or vintages' }, { status: 400, headers: NO_STORE })
}
