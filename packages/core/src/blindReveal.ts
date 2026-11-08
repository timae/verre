// When a blind moment's unrevealed wines become visible OUTSIDE the moment —
// in feeds and profiles (owner ruling Q5 (b), 2026-11-08; redis-rehydration
// release B). The live moment itself never auto-reveals: only the host's
// reveal un-redacts there. The rule is the moment's RECORD dates — never
// whether a cache still holds it:
//
//   over ⇔ now > dateTo, else dateFrom + 48 h, else (legacy rows) createdAt + 48 h
//
// The copy below states the rule on every blind-tasting setup surface (web +
// mobile, create + settings) — one string so the four can't drift from each
// other or from the rule.

export const MOMENT_DEFAULT_SPAN_MS = 48 * 60 * 60 * 1000

export const BLIND_FEED_REVEAL_NOTE =
  'Feeds and profiles show the names once the moment ends (or 48 h after the start), unless revealed sooner.'

export function momentIsOver(
  dates: { dateFrom: Date | null; dateTo: Date | null; createdAt: Date | null },
  now = Date.now(),
): boolean {
  const end = dates.dateTo ? dates.dateTo.getTime()
    : dates.dateFrom ? dates.dateFrom.getTime() + MOMENT_DEFAULT_SPAN_MS
    : dates.createdAt ? dates.createdAt.getTime() + MOMENT_DEFAULT_SPAN_MS
    : null
  return end !== null && now > end
}
