// Multi-taster compare aggregation — structure-wheel proposal §7 / design 02d.
// Pure + platform-neutral (core's purity rule). Computed CLIENT-side per the
// 2026-07-02 ruling: the people-selector recomputes live over the selected
// subset, and every taster's ratings already arrive via GET /:code/state — so
// the canonical semantics live once here, and there is NO server aggregate.
//
// Zero rule (Simon, 2026-07-02, refined 2026-07-06): an EXPLICIT stored 0 counts
// (today's input writes every axis of the wine's style, unfilled ones as 0 — the
// server fills on write). But an axis KEY that is ABSENT from a rating's stored
// flavours is a "never asked" — it must NOT count as 0. The live trigger is a
// style change: a wine rated as still-wine (8 axes, no `bubbles`) later flipped
// to `spark` (9 axes) would otherwise read every prior taster as bubbles=0 on an
// axis they never saw. So engagement is tracked PER AXIS via raw key-presence:
// an axis's min/max/avg + its own denominator count only ratings whose raw map
// HAS that key. `n` is the count of ratings engaged with ANY structure (the
// `{}`-gate below, which already excludes pre-structure legacy rows); per-axis
// counts can be ≤ n when a style grew after some ratings.

import { resolveAxes, fillFlavourZeros } from './structureAxes'
import { snapScore } from './scoringInput'

export type AxisAggregate = {
  k: string
  l: string
  min: number
  max: number
  avg: number
  /** Ratings that were actually asked about this axis (raw key present). Can be
   *  < the impression's engaged `n` when the wine's style grew after some
   *  ratings (e.g. bubbles on a since-flipped-to-spark wine). 0 = no rating
   *  carried it → the axis is a neutral placeholder, not a real 0. */
  n: number
}

export type FlavourAggregate = {
  /** Aggregated axes in registry order; empty when no taster has flavour data. */
  axes: AxisAggregate[]
  /** Engaged-taster count (non-empty flavours after normalization). */
  n: number
}

export function aggregateFlavourAxes(
  flavorMaps: ReadonlyArray<Record<string, number> | null | undefined>,
  category: string | null | undefined,
  style: string | null | undefined,
): FlavourAggregate {
  // Engaged = ratings with ANY structure data. The `{}` gate (fillFlavourZeros
  // returns {} when no resolved axis is positive) already excludes pre-structure
  // legacy rows. We keep the RAW map alongside so per-axis presence can be read
  // from the un-filled data (fillFlavourZeros would stamp absent keys as 0 and
  // erase the "never asked" signal).
  const engaged: { raw: Record<string, number>; filled: Record<string, number> }[] = []
  for (const m of flavorMaps) {
    const filled = fillFlavourZeros(m, category, style)
    if (Object.keys(filled).length > 0) engaged.push({ raw: m ?? {}, filled })
  }
  if (engaged.length === 0) return { axes: [], n: 0 }
  const axes = resolveAxes(category, style).map((a) => {
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let count = 0
    for (const { raw, filled } of engaged) {
      // Only count ratings that were ACTUALLY asked about this axis (raw key
      // present). An absent key = "never asked" (e.g. a pre-`spark` rating on a
      // wine since flipped to spark) → excluded from this axis entirely, NOT 0.
      // An explicit stored 0 (key present) counts.
      if (!Object.prototype.hasOwnProperty.call(raw, a.k)) continue
      const v = filled[a.k] ?? 0
      if (v < min) min = v
      if (v > max) max = v
      sum += v
      count += 1
    }
    // No engaged rating carried this axis (e.g. a spark wine where every rating
    // predates the bubbles axis) → a neutral empty axis, not a 0-floored one.
    if (count === 0) return { k: a.k, l: a.l, min: 0, max: 0, avg: 0, n: 0 }
    return { k: a.k, l: a.l, min, max, avg: sum / count, n: count }
  })
  return { axes, n: engaged.length }
}

// Score-side (02d accordion row). Overall score 0 = "not rated" (score-system
// invariant) — it never enters the group average or the consensus spread; a
// flavours-only taster still aggregates above (engagement is per-signal).

export type ConsensusKey = 'harmony' | 'mostly' | 'mixed' | 'divide'

// "Typical gap" between tasters: 2 × mean absolute deviation from the group
// mean. Equals the plain range for two values; for larger groups a single
// outlier dampens instead of dominating (range would let one contrarian in a
// group of nine scream "polarizing").
function typicalGap(values: ReadonlyArray<number>): number {
  const n = values.length
  if (n < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / n
  const mad = values.reduce((a, b) => a + Math.abs(b - mean), 0) / n
  return 2 * mad
}

/**
 * Consensus teaser over the selection — a blended disagreement score
 * (Simon's 2026-07-02 refinement; supersedes the score-range-only rule):
 *
 *   dScore  = typicalGap(rated scores) / 5          (score 0 never counts)
 *   dStruct = mean per-axis typicalGap(normalized intensities) / 5
 *             (over axes with ≥2 tasters who were ASKED that axis — a
 *             never-asked axis, e.g. bubbles on a since-flipped-to-spark wine,
 *             is skipped, not counted as a 0-gap; score-0 flavour-only tasters
 *             DO contribute)
 *   D       = 0.6·dScore + 0.4·dStruct   (dScore alone without structure)
 *
 *   D ≤ 0.10 harmony · ≤ 0.25 mostly agreed · ≤ 0.45 mixed · else polarizing
 *
 * In two-rater score-only terms: harmony up to a 0.5 gap, mostly to 1.25,
 * mixed to 2.25, polarizing beyond. Fewer than two rated scores → null — a
 * consensus is a group signal (no single-rater substitute, ruled 2026-07-02).
 */
export function consensusFromRatings(
  ratings: ReadonlyArray<{ score: number; flavors: Record<string, number> | null | undefined }>,
  category: string | null | undefined,
  style: string | null | undefined,
): ConsensusKey | null {
  const rated = ratings.map((r) => r.score).filter((s) => s > 0)
  if (rated.length < 2) return null
  const dScore = typicalGap(rated) / 5
  // Keep each engaged rating's RAW map beside its filled one, so per-axis
  // disagreement counts only raters actually asked about that axis (raw key
  // present) — a never-asked axis (e.g. bubbles on a since-flipped-to-spark
  // wine) must not inject a spurious 0 into the gap, same rule as the aggregate.
  const engaged = ratings
    .map((r) => ({ raw: r.flavors ?? {}, filled: fillFlavourZeros(r.flavors, category, style) }))
    .filter((e) => Object.keys(e.filled).length > 0)
  let d = dScore
  if (engaged.length >= 2) {
    const axes = resolveAxes(category, style)
    // Per axis: gap over only the raters who carried it; an axis with <2 such
    // raters has no defined disagreement and is skipped (mean over the axes
    // that DO have ≥2). If no axis qualifies, structure adds nothing (dScore).
    let gapSum = 0
    let axisCount = 0
    for (const a of axes) {
      const vals = engaged
        .filter((e) => Object.prototype.hasOwnProperty.call(e.raw, a.k))
        .map((e) => e.filled[a.k] ?? 0)
      if (vals.length < 2) continue
      gapSum += typicalGap(vals)
      axisCount += 1
    }
    if (axisCount > 0) d = 0.6 * dScore + 0.4 * (gapSum / axisCount / 5)
  }
  return d <= 0.1 ? 'harmony' : d <= 0.25 ? 'mostly' : d <= 0.45 ? 'mixed' : 'divide'
}

/** Group score average over rated (>0) scores, snapped to the 0.25 grid; null when nobody rated. */
export function groupScoreAverage(scores: ReadonlyArray<number>): number | null {
  const rated = scores.filter((s) => s > 0)
  if (rated.length === 0) return null
  return snapScore(rated.reduce((a, b) => a + b, 0) / rated.length)
}
