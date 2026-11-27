import type { LookIn, LookInPerson } from './lookInWire';

// The look-in screens' small rules (Moment Visibility step-2 plan § 4.4–4.5,
// R15). Pure, unit-tested from the repo root (scripts/tests/look-in-compare-units.ts).

// A bottle's page: each NAMED person who gave it stars, in the room's order
// (R15: stars only; notes never reach a look-in). `more` = the ratings the
// average counts that the page can't show: `count` counts scores above 0 only
// (the server's tally), so it is compared with the named people's scored
// ratings, never with every named row (Codex r2: a named structure-only rating
// is a row but not in `count`).
export function bottleStars(look: Pick<LookIn, 'lineup' | 'people' | 'ratings'>, key: string): {
  rows: { person: LookInPerson; score: number }[];
  more: number;
} | null {
  const bottle = look.lineup.find((b) => b.key === key);
  if (!bottle) return null;
  const byKey = new Map(look.people.named.map((p, i) => [p.key, { p, i }]));
  const rows = look.ratings
    .filter((r) => r.bottle === key && (r.score ?? 0) > 0 && byKey.has(r.person))
    .map((r) => ({ person: byKey.get(r.person)!.p, score: r.score!, i: byKey.get(r.person)!.i }))
    .sort((a, b) => a.i - b.i)
    .map(({ person, score }) => ({ person, score }));
  return { rows, more: Math.max(0, bottle.count - rows.length) };
}

// The people foot: up to three named faces (the host first when named), "+N"
// for the named beyond three plus everyone not named.
export function footFaces(look: Pick<LookIn, 'moment' | 'people'>): { faces: LookInPerson[]; extra: number } {
  const hostKey = look.moment.host?.id ?? null;
  const ordered = [...look.people.named].sort((a, b) => (a.key === hostKey ? -1 : b.key === hostKey ? 1 : 0));
  const faces = ordered.slice(0, 3);
  return { faces, extra: ordered.length - faces.length + look.people.more };
}
