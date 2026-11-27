import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate } from '@/lib/rateLimit'
import { canUseCatalog } from '@/lib/catalogGate'
import { answerCatalogSearch } from '@/lib/catalogSearchAnswer'

// Add-time catalog search — the SEARCH-FIRST half of RFC § Add-a-wine flow.
// The query kinds and the answer live in lib/catalogSearchAnswer.ts, shared
// with the moment's own search (GET /api/session/<code>/catalog/search, for
// guests who host or bring bottles).
//
// Auth required. Anonymous callers get 401 rather than an open enumeration
// channel over the whole catalog, matching /api/users/search. Note this is
// about ENUMERATION VOLUME, not secrecy — the catalog itself is deliberately
// open (RFC ruling 3). A guest searches only inside a moment they may add
// bottles to.

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // 🔒 404, not 403 — see lib/catalogGate.ts. While the kill switch is on,
  // this endpoint must look like it does not exist (staff still pass).
  if (!(await canUseCatalog(userId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // A trigram scan over the whole catalog is the expensive query in this
  // feature, so it is capped like /api/users/search. Caller-keyed, not
  // IP-keyed: IP would bucket a shared-NAT office into one budget. 🔒 The SAME
  // key as the moment's search for a signed-in caller, so the two don't stack.
  const rl = await checkRate(`rl:catalog-search:u:${userId}:1m`, 30, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  return answerCatalogSearch(req.nextUrl.searchParams)
}
