import { NextRequest, NextResponse } from 'next/server'
import { aromaFilterMatch, gateAromaSelections, resolveAxes, type AromaFilterMatch } from '@verre/core'
import { scrub } from '@/lib/textSafe'
import { loadImpressions } from '@/lib/profileLists'
import { parseImpressionSort } from '@/lib/impressionsCursor'
import { NO_STORE, openProfileList } from '@/lib/profileListRoute'

// GET /api/users/:id/impressions — someone's (or your own) impressions: every
// rating, through the post gate (lists plan D3 / D10). ?sort=newest (default,
// by when they had it: the post's time) | oldest | highest | lowest (their
// score, unrated last; anything else reads as newest; the cursor binds the
// sort, lib/impressionsCursor.ts). Filters: q, from / to (ISO instants), category,
// min / max (quarter steps in 0.25..5, min ≤ max), st (structure ranges), ar
// + armode (aroma picks; both below), common=1 (someone else's: only the ones
// you both had). Blind rows (lib/outsideView.ts) show no identity; hidden
// line-ups are left out.
const SCORE = (v: string | null): number | null | 'bad' => {
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0.25 && n <= 5 && Number.isInteger(n * 4) ? n : 'bad'
}
const instant = (v: string | null) => {
  const ms = v ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? new Date(ms) : null
}
// ?st=sweet:1-3,tannin:0-0 — structure ranges, whole 0..5, lo ≤ hi, each axis
// once, keys from the wine registry (Bubbles included: it only matches
// sparkling ratings).
const AXIS_KEYS = new Set(resolveAxes('wine', { sparkling: true }).map((a) => a.k))
const STRUCTURE = (v: string | null): { k: string; lo: number; hi: number }[] | 'bad' => {
  if (v === null || v === '') return []
  const out: { k: string; lo: number; hi: number }[] = []
  for (const part of v.split(',')) {
    const m = /^([a-z]+):([0-5])-([0-5])$/.exec(part)
    if (!m || !AXIS_KEYS.has(m[1]) || out.some((s) => s.k === m[1])) return 'bad'
    const lo = Number(m[2]), hi = Number(m[3])
    if (lo > hi) return 'bad'
    out.push({ k: m[1], lo, hi })
  }
  return out
}
// ?ar=[{"a":"fruity"},{"a":"apricot","m":"dried","p":true}] — aroma picks in
// the stored selection shape, through the write gate (canonical form, the 30
// cap), each read broad (core aromaFilterMatch). ?armode=any = any of them,
// else all.
const AROMAS = (v: string | null): AromaFilterMatch[] | 'bad' => {
  if (v === null || v === '') return []
  if (v.length > 4000) return 'bad'
  let raw: unknown
  try { raw = JSON.parse(v) } catch { return 'bad' }
  const gated = gateAromaSelections(raw)
  return gated.value ? gated.value.map(aromaFilterMatch) : 'bad'
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
  const structure = STRUCTURE(sp.get('st'))
  if (structure === 'bad') return NextResponse.json({ error: 'invalid structure filter' }, { status: 400, headers: NO_STORE })
  const aromas = AROMAS(sp.get('ar'))
  if (aromas === 'bad') return NextResponse.json({ error: 'invalid aroma filter' }, { status: 400, headers: NO_STORE })
  const category = (scrub(sp.get('category')) ?? '').trim().slice(0, 32) || null
  const body = await loadImpressions(opened.ownerId, opened.gate, {
    q: (scrub(sp.get('q')) ?? '').trim().slice(0, 64),
    from: instant(sp.get('from')),
    to: instant(sp.get('to')),
    category: category === 'any' ? null : category,
    min, max,
    structure,
    aromas,
    aromaMode: sp.get('armode') === 'any' ? 'any' : 'all',
    common: sp.get('common') === '1',
    sort: parseImpressionSort(sp.get('sort')),
    cursor: sp.get('cursor'),
  })
  return NextResponse.json(body, { headers: NO_STORE })
}
