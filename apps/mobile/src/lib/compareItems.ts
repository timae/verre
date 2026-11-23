import { consensusFromRatings, fillFlavourZeros, groupScoreAverage, type ConsensusKey } from '@verre/core';
// Relative (not '@/'): the root unit test imports this module directly.
import { hasResolvableAroma } from '../components/moments/aromaCompareView';

// Compare's pure half (moved from components/moments/CompareBody.tsx, Moment
// Visibility step-2 plan T13): the cards over the SELECTION and their sorts.
// Unit-tested from the repo root (scripts/tests/look-in-compare-units.ts), so
// the types are STRUCTURAL (the app's WireWine / RatingsView fit): importing
// the API types there would pull React Native's typings into the web build.
//
// The look-in's seams, which the moment's own Compare never passes:
//   - `groupStats` (bottle id → the server's average + count over EVERYONE
//     counted, hidden people included): with nobody deselected the card's ★,
//     Highest / Lowest and Most ratings read it (R4), and a bottle that only
//     hidden people rated still gets a card (`hiddenOnly`: ★ and its count, no
//     rows; it does not expand, recheck r1). Once someone is deselected, the
//     selection's numbers, as inside a moment. Agreement (the spread sorts, the
//     consensus word) is always over the people the phone has.
//   - `hasAromas` on a rating (the look-in's light first read): counts as
//     comparable input before its aromas arrive (review r1).

export type CmpWine = { id: string; colour: string | null; sparkling: boolean; _blind?: boolean };
export type CmpRating = {
  score: number;
  flavors: Record<string, number>;
  aromas?: { a: string; m: string | null; p?: boolean }[];
  hasAromas?: true;
};
export type CmpRatings<R extends CmpRating = CmpRating> = Record<string, { displayName: string; ratings: Record<string, R> }>;
export type CmpRoster = { participants: readonly { id: string }[] } | null;
export type GroupStats = ReadonlyMap<string, { avg: number | null; count: number }>;

export type Rater<R extends CmpRating = CmpRating> = {
  id: string;
  displayName: string;
  rating: R;
  /** fillFlavourZeros-normalized flavours; {} ⟺ no flavour engagement. */
  filled: Record<string, number>;
  personIndex: number;
};

export type CmpItem<W extends CmpWine = CmpWine, R extends CmpRating = CmpRating> = {
  wine: W;
  index: number;
  /** SELECTED raters of this impression (the rail's hidden set already applied). */
  raters: Rater<R>[];
  scored: Rater<R>[];
  avg: number | null;
  /** How many ratings the card stands for: the selection's raters, or the server's count (`groupStats`). */
  count: number;
  /** Score span (max−min) across scored raters; null under 2 scores. Feeds the agreement sorts. */
  spread: number | null;
  consensus: ConsensusKey | null;
  /** Only people the viewer can't see rated it (`groupStats`, nobody deselected). */
  hiddenOnly?: true;
};

// Roster position drives person colours + rail order: participants first, then
// any raters no longer in the roster (kicked/tombstoned) in rating-map order.
export function rosterIndexOf(ratings: CmpRatings<CmpRating> | null, meta: CmpRoster): Map<string, number> {
  const rosterIndex = new Map<string, number>();
  (meta?.participants ?? []).forEach((p, i) => rosterIndex.set(p.id, i));
  let overflow = rosterIndex.size;
  for (const id of Object.keys(ratings ?? {})) {
    if (!rosterIndex.has(id)) rosterIndex.set(id, overflow++);
  }
  return rosterIndex;
}

// Items over the SELECTION: hidden raters are dropped before anything is
// computed, so avg/consensus/rows/charts/ranking all follow the rail.
export function buildItems<W extends CmpWine, R extends CmpRating>(
  wines: W[] | null,
  ratings: CmpRatings<R> | null,
  meta: CmpRoster,
  hidden: ReadonlySet<string>,
  groupStats?: GroupStats,
): CmpItem<W, R>[] {
  if (!wines || !ratings) return [];
  const rosterIndex = rosterIndexOf(ratings, meta);
  // Sorted by roster position: Object.entries follows the server's Redis SCAN
  // order, which is NOT stable across polls — unsorted, radar layering, axis
  // rows, and tied score rows would flicker between refreshes.
  const raterBuckets = Object.entries(ratings)
    .filter(([id]) => !hidden.has(id))
    .map(([id, bucket]) => ({ id, ...bucket }))
    .sort((a, b) => rosterIndex.get(a.id)! - rosterIndex.get(b.id)!);
  // The server's numbers stand only while nobody is deselected (R4).
  const everyone = groupStats && hidden.size === 0 ? groupStats : undefined;

  const items = wines
    .map((wine, index): CmpItem<W, R> => {
      const raters: Rater<R>[] = raterBuckets
        .filter((b) => b.ratings[wine.id])
        .map((b) => ({
          id: b.id,
          displayName: b.displayName,
          rating: b.ratings[wine.id],
          filled: fillFlavourZeros(b.ratings[wine.id].flavors, 'wine', wine),
          personIndex: rosterIndex.get(b.id)!,
        }))
        // Compare renders score, structure, OR aromas — an aroma-only rating is
        // real compare input (the Aroma-agreement strip needs it); only a
        // notes-only (or stale cleared) rating has none of the three and would
        // make a dead-end card ("No structure detail" + "No scores yet").
        .filter((r) =>
          (r.rating.score || 0) > 0
          || Object.keys(r.filled).length > 0
          || hasResolvableAroma(r.rating.aromas)
          || r.rating.hasAromas === true);
      const scores = raters.map((r) => r.rating.score || 0);
      const scoredScores = scores.filter((v) => v > 0);
      const stats = everyone?.get(wine.id);
      return {
        wine,
        index,
        raters,
        scored: raters.filter((r) => (r.rating.score || 0) > 0).sort((a, b) => b.rating.score - a.rating.score),
        avg: stats ? stats.avg : groupScoreAverage(scores),
        count: stats ? stats.count : raters.length,
        spread: scoredScores.length >= 2 ? Math.max(...scoredScores) - Math.min(...scoredScores) : null,
        consensus: consensusFromRatings(raters.map((r) => ({ score: r.rating.score || 0, flavors: r.rating.flavors })), 'wine', wine),
        ...(raters.length === 0 && (stats?.count ?? 0) > 0 ? { hiddenOnly: true as const } : {}),
      };
    })
    .filter((it) => it.raters.length > 0 || it.hiddenOnly);
  // Line-up order (Simon's ruling 2026-07-03, supersedes the score-ranked
  // list) — the default; the toolbar's sort menu reorders in CompareBody.
  return items;
}

export type CompareSort = 'lineup' | 'top' | 'bottom' | 'agree' | 'split' | 'most';
// Sentinels (not Infinity — Infinity−Infinity is NaN and breaks sort): items
// missing the sort signal (no score avg / <2 scores for a spread) go LAST in
// every mode, line-up order as the universal tiebreak.
export const SORT_FNS: Record<CompareSort, (a: CmpItem, b: CmpItem) => number> = {
  lineup: (a, b) => a.index - b.index,
  top: (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.index - b.index,
  bottom: (a, b) => (a.avg ?? 999) - (b.avg ?? 999) || a.index - b.index,
  agree: (a, b) => (a.spread ?? 999) - (b.spread ?? 999) || a.index - b.index,
  split: (a, b) => (b.spread ?? -1) - (a.spread ?? -1) || a.index - b.index,
  most: (a, b) => b.count - a.count || a.index - b.index,
};
