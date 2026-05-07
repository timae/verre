// Pure geometry helpers for radial flavour wheels — used by both the
// read-only PolarChart and the interactive FlavorWheel.
//
// All functions are pure and deterministic. No DOM, no React. Testable in
// isolation if a test framework is added later.
//
// Coordinate system: SVG with origin at top-left. The wheel's center is at
// (cx, cy). Angles are measured clockwise from the positive x-axis (SVG
// convention) — but slot 0 starts at -π/2 so the first wedge sits at the
// 12 o'clock position.

export interface WheelDims {
  cx: number
  cy: number
  rInner: number
  rOuter: number
  rLabel: number
  n: number
}

// Compute the angular range of a slot. Returns [a0, a1] in radians, where
// a0 < a1 and slot 0 starts at -π/2 (12 o'clock).
export function slotAngles(i: number, n: number): [number, number] {
  const span = (Math.PI * 2) / n
  const a0 = i * span - Math.PI / 2
  const a1 = (i + 1) * span - Math.PI / 2
  return [a0, a1]
}

// Build an SVG path for an annular wedge from rInner to rOuter spanning
// the angular range [a0, a1].
export function arcPath(cx: number, cy: number, rInner: number, rOuter: number, a0: number, a1: number): string {
  const p = (a: number, r: number): [number, number] => [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [x0o, y0o] = p(a0, rOuter)
  const [x1o, y1o] = p(a1, rOuter)
  const [x1i, y1i] = p(a1, rInner)
  const [x0i, y0i] = p(a0, rInner)
  return `M ${x0o.toFixed(2)} ${y0o.toFixed(2)} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)} L ${x1i.toFixed(2)} ${y1i.toFixed(2)} A ${rInner} ${rInner} 0 ${large} 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)} Z`
}

// Label anchor position for a slot. Returns the point at the slot's
// angular midpoint, a text-anchor hint that keeps long labels from
// drifting over the wheel, and the raw sin of the midpoint angle —
// callers use sin to decide vertical anchoring of multi-line labels
// (top-half labels anchor by their bottom edge, bottom-half by their
// top, side labels center).
export function labelPosition(cx: number, cy: number, rLabel: number, i: number, n: number): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; sin: number } {
  const [a0, a1] = slotAngles(i, n)
  const am = (a0 + a1) / 2
  const cos = Math.cos(am)
  const sin = Math.sin(am)
  const x = cx + cos * rLabel
  const y = cy + sin * rLabel
  const anchor: 'start' | 'middle' | 'end' = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle'
  return { x, y, anchor, sin }
}

// Hit-test: which wedge does (x, y) belong to, and how far is it from
// center? Returns null if the point is in either dead zone:
//   - inside the inner hub (dist < rInner): central "drag out" area;
//     a pointer-down here must NOT lock a wedge.
//   - outside the outer rim (dist > rOuter + OUTER_EPSILON): the SVG's
//     viewBox extends past the wheel for label space (vpad), and a
//     click in that empty area shouldn't silently set the angularly
//     nearest wedge to MAX. The small epsilon tolerates pointer events
//     that round just past rOuter mid-drag.
//
// Once a wedge IS locked, drag motion that passes back through rInner is
// fine — that's the drag-to-clear path, handled by the caller.
const OUTER_EPSILON = 8
export function wedgeFromXY(cx: number, cy: number, x: number, y: number, n: number, rInner: number, rOuter?: number): { idx: number; dist: number } | null {
  const dx = x - cx
  const dy = y - cy
  const dist = Math.hypot(dx, dy)
  if (dist < rInner) return null
  if (rOuter !== undefined && dist > rOuter + OUTER_EPSILON) return null
  // Math.atan2 returns [-π, π]. Add π/2 so slot 0 is at 12 o'clock, then
  // normalise to [0, 2π).
  let a = Math.atan2(dy, dx) + Math.PI / 2
  if (a < 0) a += Math.PI * 2
  if (a >= Math.PI * 2) a -= Math.PI * 2
  // Floor-clamp guards the seam: at the exact 2π boundary, floor() can
  // return n, which would index out of bounds.
  const idx = Math.min(n - 1, Math.floor((a / (Math.PI * 2)) * n))
  return { idx, dist }
}

// Level distribution along the wedge's radial extent.
//
// Linear bands (each level = 1/MAX of the depth) make a level-1 rating
// almost invisible — a thin sliver near the hub that's hard to
// distinguish from level 0. We therefore use a non-linear distribution:
// level 1 takes 1.5 "units" of depth, levels 2..5 each take 0.875 units
// (total = 5 units, normalized to fill the band from rInner to rOuter).
//
// LEVEL_FRACS[k] is the cumulative fraction of the band depth at which
// level k's outer edge sits. So:
//   - levelToFillRadius(k) = rInner + LEVEL_FRACS[k] * (rOuter - rInner)
//   - levelFromDist returns the largest k whose breakpoint exceeds t.
//
// Both functions read from the same table so they stay exact inverses
// regardless of how the distribution is tuned. The number of levels
// (MAX_LEVEL = LEVEL_FRACS.length - 1) is derived, not parameterized —
// changing the level count means rewriting the table by hand.
const LEVEL_FRACS = [0.0, 0.30, 0.475, 0.65, 0.825, 1.0]
export const MAX_LEVEL = LEVEL_FRACS.length - 1  // = 5

// Breakpoints between consecutive levels. LEVEL_BREAKPOINTS[k] is the
// upper edge of level k's commit zone — i.e. level k commits when
// `t < LEVEL_BREAKPOINTS[k]` AND no earlier breakpoint matched.
const LEVEL_BREAKPOINTS = (() => {
  const bp: number[] = []
  for (let k = 1; k <= MAX_LEVEL; k++) {
    bp.push((LEVEL_FRACS[k - 1] + LEVEL_FRACS[k]) / 2)
  }
  return bp
})()

// Convert a radial distance to an integer level [0, MAX_LEVEL].
//
// Edge bands: dist < rInner returns 0 (the drag-to-clear path). Dist
// >= rOuter saturates at MAX_LEVEL (so the very tip of the wedge always
// reaches max). Between rInner and rOuter, t is mapped to the nearest
// level via the LEVEL_BREAKPOINTS table.
//
// MUST be the exact inverse of levelToFillRadius. Both read from
// LEVEL_FRACS — never edit one without updating the other.
export function levelFromDist(dist: number, rInner: number, rOuter: number): number {
  if (dist < rInner) return 0
  const t = (dist - rInner) / (rOuter - rInner)
  if (t >= 1) return MAX_LEVEL
  for (let k = 0; k < LEVEL_BREAKPOINTS.length; k++) {
    if (t < LEVEL_BREAKPOINTS[k]) return k
  }
  return MAX_LEVEL
}

// Inverse of levelFromDist for display: where does the outer edge of a
// filled wedge sit for a given level?
//
// MUST be the exact inverse of levelFromDist. Both read from
// LEVEL_FRACS — never edit one without updating the other.
export function levelToFillRadius(level: number, rInner: number, rOuter: number): number {
  if (level <= 0) return rInner
  if (level >= MAX_LEVEL) return rOuter
  return rInner + LEVEL_FRACS[level] * (rOuter - rInner)
}
