// What a tap on a moment opens (Moment Visibility step-2 plan § 4.3, T7):
// member first, one rule for every entry point (the feed card, a post's place
// line, someone's Moments list). A known membership (the viewer's own
// ['my-sessions'] row carries the code) opens the moment itself; a moment id
// alone opens the look-in, whose first read answers `{ member: true }` for a
// member whose row is past the loaded page (and the look-in then replaces itself
// with the moment); neither is inert. Pure, unit-tested from the repo root
// (scripts/tests/look-in-units.ts § 1).
export type MomentEntry = { kind: 'moment'; code: string } | { kind: 'look'; momentId: string } | { kind: 'inert' };

export function momentEntry(known: { code?: string | null; momentId?: string | null }): MomentEntry {
  if (known.code) return { kind: 'moment', code: known.code };
  if (known.momentId) return { kind: 'look', momentId: known.momentId };
  return { kind: 'inert' };
}

// Someone's Moments list row key (step-2 plan § 4.3): a shared row keys on its
// code (as before), an open row on its moment id, prefixed so the two can never
// collide; the list's dedupe and keyExtractor follow it.
export function momentRowKey(row: { code?: string; momentId?: string }): string {
  return row.code ? row.code : `m:${row.momentId ?? ''}`;
}
