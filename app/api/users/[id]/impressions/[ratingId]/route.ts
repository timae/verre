import { NextRequest, NextResponse } from 'next/server'
import { loadImpression } from '@/lib/profileLists'
import { parsePathId } from '@/lib/parsePathId'
import { NO_STORE, openProfileList } from '@/lib/profileListRoute'

// GET /api/users/:id/impressions/:ratingId (Moment Visibility step 3, § 4.5):
// ONE impression for its page, the row the Impressions list would show this
// viewer plus the rating itself (lib/profileLists.ts `loadImpression`). The
// list's own preamble (the profile gate, `rl:profile-lists` per user and per
// address, shared with the three lists), then the post gate. 🔒 Every miss is
// the same 404: a malformed or out-of-range id, another owner's rating, a
// hidden line-up, an unknown id, posts hidden from the viewer.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; ratingId: string }> }) {
  const p = await params
  const opened = await openProfileList(req, Promise.resolve({ id: p.id }))
  if (opened instanceof NextResponse) return opened
  const ratingId = parsePathId(p.ratingId)
  const body = ratingId === null ? null : await loadImpression(opened.ownerId, opened.gate, ratingId)
  if (!body) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json(body, { headers: NO_STORE })
}
