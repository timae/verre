import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate } from '@/lib/rateLimit'
import { canUseCatalog } from '@/lib/catalogGate'
import { CatalogValidationError } from '@/lib/catalogWrite'
import { mintEntries } from '@/lib/catalogAddFlow'

// POST /api/catalog/entries — mint catalog entries for the add-a-wine flow.
//
// This is the CREATE half of RFC § Add-a-wine flow; the SEARCH half is
// /api/catalog/search. The five branches in the RFC are not five endpoints —
// they are five shapes of this one request, distinguished by which ids the
// caller already has. Modelling them explicitly (rather than as one
// "upsert-ish" call) is the point: it is what makes it impossible to mint a
// duplicate at the wrong grain.
//
//   1. existing producer → existing product → existing vintage
//        …no request at all. The client already has every id; it links
//        directly. Listed here so the absence is deliberate, not an omission.
//   2. existing product, missing vintage    { productId, year|null }
//   3. existing producer, missing product   { producerId, product: {…}, year? }
//   4. nothing matches                      { producer: {…}, product: {…}, year? }
//   5. collaboration                        …either 3 or 4, plus collaboratorIds
//
// 🔒 Branch 2's `year: null` means the NON-VINTAGE row, never "unknown year".
// A caller who does not know the year OMITS `year` entirely and links at
// product grain (vintageId null) — that is what keeps NV rows clean. The two
// are different requests and must stay distinguishable, so `null` and absent
// are read differently below. This is the single easiest thing to get wrong in
// this endpoint.
//
// Everything minted here is `provisional` and immediately usable. It enters the
// phase-3 review queue, where the SAME fuzzy matcher surfaces likely duplicates
// for a curator to confirm, merge, or reject. Nobody is blocked from adding;
// nothing auto-collapses.

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // 🔒 404 while the release switch is off — see lib/catalogGate.ts.
  if (!(await canUseCatalog(userId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Catalog rows are permanent identity: one ID for life, never re-minted, and
  // a junk entry can only be cleaned up by a curator (phase 3) — so creation is
  // capped harder than search. Mirrors the /api/checkins content-spam budget.
  const rl = await checkRate(`rl:catalog-create:u:${userId}:1h`, 60, 3600)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  try {
    const result = await mintEntries(body, userId)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }
}

