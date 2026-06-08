// Score-as-text formatter. Always shows at least one decimal (`4` →
// `4.0`, signaling that quarter precision is supported); strips
// trailing zeros beyond the first decimal so `.50` → `.5` but `.25`
// and `.75` stay full. Returns '' for non-finite input so callers
// don't end up with `★ NaN` on the wire if a guard upstream slips.
export function formatScore(v: number): string {
  if (!Number.isFinite(v)) return ''
  if (Number.isInteger(v)) return v.toFixed(1)
  const s = v.toFixed(2)
  return s.endsWith('0') ? s.slice(0, -1) : s
}
