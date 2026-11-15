import { NextRequest, NextResponse } from 'next/server'
import { scrub } from '@/lib/textSafe'
import { loadCravings } from '@/lib/profileLists'
import { NO_STORE, openProfileList } from '@/lib/profileListRoute'

// GET /api/users/:id/cravings — someone's (or your own) cravings (lists plan
// D6 / D10), when their Show Cravings lets you. ?sort=recent (default) |
// score; 🔒 their scores (and so the score sort and the post link) only
// through the post gate: without it a score sort is served as recent. ?q, and
// a SEALED cursor (lib/cravingsCursor.ts: no save time on the wire). No moment,
// no who-from, no timestamps on someone else's rows.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const opened = await openProfileList(req, params)
  if (opened instanceof NextResponse) return opened
  const sp = req.nextUrl.searchParams
  const body = await loadCravings(opened.ownerId, opened.gate, {
    q: (scrub(sp.get('q')) ?? '').trim().slice(0, 64),
    sort: sp.get('sort') === 'score' ? 'score' : 'recent',
    cursor: sp.get('cursor'),
  })
  return NextResponse.json(body, { headers: NO_STORE })
}
