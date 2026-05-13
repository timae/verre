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
  const fontSize = size === 'detail' ? 28 : 21
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, lineHeight: 1, color: 'var(--accent)', fontWeight: 800 }}>
      {/* Explicit text-font stack forces Chromium/Brave to use a system
          text font instead of falling back to a color-emoji font for ★.
          Same fontSize then renders at the same visual size across
          Firefox + Chromium. The list intentionally excludes emoji
          fonts so the picker can never land on one. */}
      <span style={{ fontSize, lineHeight: 1, fontFamily: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif' }}>★</span>
      <span style={{ fontSize, lineHeight: 1 }}>{formatScore(value)}</span>
    </span>
  )
}
