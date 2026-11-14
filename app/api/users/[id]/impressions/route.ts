import { NextRequest, NextResponse } from 'next/server'
import { scrub } from '@/lib/textSafe'
import { loadImpressions } from '@/lib/profileLists'
import { parseImpressionSort } from '@/lib/impressionsCursor'
import { NO_STORE, openProfileList } from '@/lib/profileListRoute'

// GET /api/users/:id/impressions — someone's (or your own) impressions: every
// rating, through the post gate (lists plan D3 / D10). ?sort=newest (default,
// by when they had it: the post's time) | oldest | highest | lowest (their
// score, unrated last; anything else reads as newest; the cursor binds the
// sort, lib/impressionsCursor.ts). Filters: q, from / to (ISO instants), category,
// min / max (quarter steps in 0.25..5, min ≤ max), common=1 (someone else's:
// only the ones you both had). Blind rows (lib/outsideView.ts) show no
// identity; hidden line-ups are left out.
const SCORE = (v: string | null): number | null | 'bad' => {
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0.25 && n <= 5 && Number.isInteger(n * 4) ? n : 'bad'
}
const instant = (v: string | null) => {
  const ms = v ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? new Date(ms) : null
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const opened = await openProfileList(req, params)
  if (opened instanceof NextResponse) return opened
  const sp = req.nextUrl.searchParams
  const min = SCORE(sp.get('min'))
  const max = SCORE(sp.get('max'))
  if (min === 'bad' || max === 'bad' || (min !== null && max !== null && min > max)) {
    return NextResponse.json({ error: 'invalid score range' }, { status: 400, headers: NO_STORE })
  }
  const category = (scrub(sp.get('category')) ?? '').trim().slice(0, 32) || null
  const body = await loadImpressions(opened.ownerId, opened.gate, {
    q: (scrub(sp.get('q')) ?? '').trim().slice(0, 64),
    from: instant(sp.get('from')),
    to: instant(sp.get('to')),
    category: category === 'any' ? null : category,
    min, max,
    common: sp.get('common') === '1',
    sort: parseImpressionSort(sp.get('sort')),
    cursor: sp.get('cursor'),
  })
  return NextResponse.json(body, { headers: NO_STORE })
}
