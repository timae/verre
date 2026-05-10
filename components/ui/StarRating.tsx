// Canonical score-display primitive. Renders the score as `★ 4.25`
// (single star glyph + number, no `/5` denominator).
//
// Display rule (locked at product spec):
//   - 0.25 increments, range 0..5
//   - Whole numbers always shown with one decimal: `4` → `4.0`
//   - Half steps trim trailing zero: `4.5` not `4.50`
//   - Quarter steps verbatim: `4.25`, `4.75`
//   - null, undefined, NaN, or ≤0 render nothing — empty state means
//     "not rated", not "rated as zero"
//
// Surfaces that need a full filled-star strip (rate-modal hero, etc.)
// will use a future StarStrip primitive; this is the read-side text+icon
// version used everywhere else.

import { formatScore } from '@/lib/formatScore'

interface Props {
  // 0..5 in 0.25 increments. null/undefined/NaN/<=0 render nothing.
  value: number | null | undefined
  size?: 'compact' | 'detail'
}

export function StarRating({ value, size = 'compact' }: Props) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  const fontSize = size === 'detail' ? 28 : 22
  // Star glyph rendered slightly larger than the number (≈1.1×) — it's
  // the anchor of the read; the number is the precision detail. The
  // ratio is proportional so any future size tier stays balanced.
  const starSize = Math.round(fontSize * 1.1)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, lineHeight: 1, color: 'var(--accent)', fontWeight: 800 }}>
      <span style={{ fontSize: starSize, lineHeight: 1 }}>★</span>
      <span style={{ fontSize, lineHeight: 1 }}>{formatScore(value)}</span>
    </span>
  )
}
