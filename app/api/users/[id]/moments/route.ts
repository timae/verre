import { NextRequest, NextResponse } from 'next/server'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { blockPairIds } from '@/lib/userBlock'
import { clampLimit } from '@/lib/keyCursor'
import { facetsExpensive, parseMomentFacets } from '@/lib/momentFacets'
import { loadSharedMoments } from '@/lib/profileLists'
import { NO_STORE, openProfileList } from '@/lib/profileListRoute'

// GET /api/users/:id/moments — someone's moments, when their Show Moments lets
// you, newest first: the ones you share (with the code), and with Moment
// Visibility on the ones you may look into where they are named to you (open
// rows: `momentId`, no code; lib/profileLists.ts). The same filter params and
// meaning as /api/me/sessions (D14, lib/momentFacets.ts): q, from, to, roles
// (THEIR role), hosts, people, category; cursor + limit. On an open row a
// filter only matches people named to you. The first page carries
// `otherCount` (their other moments, unfiltered).
// 🔒 A moment you're not in (or were kicked from) never carries its code; one
// you can't look into is never a row or a name. Your own moments are read from
// /api/me/sessions.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const opened = await openProfileList(req, params)
  if (opened instanceof NextResponse) return opened
  const sp = req.nextUrl.searchParams
  const facets = parseMomentFacets(sp)
  // The search / per-friend EXISTS share the 30/min budget of your own moments
  // (the SAME key string as /api/me/sessions).
  if (facetsExpensive(facets)) {
    const rl = await checkRate(`rl:moments-search:u:${opened.viewerId}:1m`, 30, 60)
    if (!rl.allowed) {
      return NextResponse.json({ error: `Too many requests. Try again ${formatWait(rl.retryAfter)}.` }, { status: 429, headers: NO_STORE })
    }
  }
  const { blockedByMe, blockingMe } = await blockPairIds(opened.viewerId)
  const body = await loadSharedMoments(opened.ownerId, opened.gate, opened.viewerId, {
    facets,
    blockedUserIds: new Set([...blockedByMe, ...blockingMe]),
    cursor: sp.get('cursor'),
    limit: clampLimit(sp.get('limit'), 30, 50),
  })
  return NextResponse.json(body, { headers: NO_STORE })
}
