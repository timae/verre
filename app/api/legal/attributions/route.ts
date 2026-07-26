import { NextResponse } from 'next/server'
import { getAttributions } from '@/lib/attributions'

// Corpus-level legal attributions for the wine catalog.
//
// 🔒 DELIBERATELY UNAUTHENTICATED. This is the native app's source for a
// LEGAL surface — the entries must render for a signed-out user, on first
// launch, before any account exists. Gating it behind auth would make the
// attributions unreachable for exactly the callers most likely to open an
// "About" screen.
//
// No rate limit: the handler reads a process-cached constant, touches neither
// Postgres nor Redis, and exposes no user-scoped data. There is nothing here
// to brute-force and no per-caller cost to bound. (Contrast /api/catalog/search,
// which is capped because it runs a trigram scan.)
//
// The web page renders the same entries server-side via getAttributions() and
// does NOT call this route — see app/legal/attributions/page.tsx.

export async function GET() {
  const entries = getAttributions()
  return NextResponse.json(
    {
      entries,
      // Lets the native app tell a live response from its bundled fallback and
      // date what it is showing. 🔒 This is a SERVE time, not a data-retrieval
      // or licence-access date — do not render it as either.
      servedAt: new Date().toISOString(),
    },
    {
      headers: {
        // Deploy-time config: cacheable, but revalidate often enough that an
        // ops change to the entries reaches clients the same day. A licence
        // change must not sit behind a week-long CDN cache.
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    },
  )
}
