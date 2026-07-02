// Multi-taster compare aggregation — structure-wheel proposal §7 / design 02d.
// Pure + platform-neutral (core's purity rule). Computed CLIENT-side per the
// 2026-07-02 ruling: the people-selector recomputes live over the selected
// subset, and every taster's ratings already arrive via GET /:code/state — so
// the canonical semantics live once here, and there is NO server aggregate.
//
// Zero rule (Simon, 2026-07-02 — per RATING, not per axis): a rating with ANY
// structure data counts on EVERY axis of the wine's resolved set — keys missing
// from an old sparse row normalize to explicit 0 via fillFlavourZeros ("all
// nones count as 0"). An empty/reset rating is no data: it contributes to no
// axis. `n` is therefore uniform across axes for a given impression+selection.

import { resolveAxes, fillFlavourZeros } from './structureAxes'
import { snapScore } from './scoringInput'

export type AxisAggregate = {
  k: string
  l: string
  min: number
  max: number
  avg: number
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
  const engaged: Record<string, number>[] = []
  for (const m of flavorMaps) {
    const filled = fillFlavourZeros(m, category, style)
    if (Object.keys(filled).length > 0) engaged.push(filled)
  }
  if (engaged.length === 0) return { axes: [], n: 0 }
  const axes = resolveAxes(category, style).map((a) => {
    let min = Infinity
    let max = -Infinity
    let sum = 0
    for (const f of engaged) {
      const v = f[a.k] ?? 0 // fillFlavourZeros guarantees presence; ?? is belt
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    return { k: a.k, l: a.l, min, max, avg: sum / engaged.length }
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
 *             (only when ≥2 tasters carry structure detail — score-0
 *             flavour-only tasters DO contribute here)
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
  const filled = ratings
    .map((r) => fillFlavourZeros(r.flavors, category, style))
    .filter((f) => Object.keys(f).length > 0)
  let d = dScore
  if (filled.length >= 2) {
    const axes = resolveAxes(category, style)
    const meanAxisGap =
      axes.reduce((sum, a) => sum + typicalGap(filled.map((f) => f[a.k] ?? 0)), 0) / axes.length
    d = 0.6 * dScore + 0.4 * (meanAxisGap / 5)
  }
  return d <= 0.1 ? 'harmony' : d <= 0.25 ? 'mostly' : d <= 0.45 ? 'mixed' : 'divide'
}

/** Group score average over rated (>0) scores, snapped to the 0.25 grid; null when nobody rated. */
export function groupScoreAverage(scores: ReadonlyArray<number>): number | null {
  const rated = scores.filter((s) => s > 0)
  if (rated.length === 0) return null
  return snapScore(rated.reduce((a, b) => a + b, 0) / rated.length)
}
