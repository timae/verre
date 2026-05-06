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
// angular midpoint and a text-anchor hint that keeps long labels from
// drifting over the wheel.
export function labelPosition(cx: number, cy: number, rLabel: number, i: number, n: number): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  const [a0, a1] = slotAngles(i, n)
  const am = (a0 + a1) / 2
  const cos = Math.cos(am)
  const x = cx + cos * rLabel
  const y = cy + Math.sin(am) * rLabel
  const anchor: 'start' | 'middle' | 'end' = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle'
  return { x, y, anchor }
}

// Hit-test: which wedge does (x, y) belong to, and how far is it from
// center? Returns null if the point is inside the inner dead zone.
//
// The dead zone matters for the gesture model: an initial pointer-down
// at dist < rInner must NOT lock a wedge — it would land on the central
// hub (the "drag out" hint area) and silently zero whichever wedge the
// pointer happened to be over angularly.
//
// Once a wedge IS locked, drag motion that passes back through rInner is
// fine — that's the drag-to-clear path, handled by the caller.
export function wedgeFromXY(cx: number, cy: number, x: number, y: number, n: number, rInner: number): { idx: number; dist: number } | null {
  const dx = x - cx
  const dy = y - cy
  const dist = Math.hypot(dx, dy)
  if (dist < rInner) return null
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

// Convert a radial distance to an integer level [0, max].
//
// Uses Math.round so each integer level has its display radius at the
// exact center of its commit band. Level k displays at t = k/max and
// commits when t falls in [k - 0.5, k + 0.5] / max. This is the only
// scheme where levelFromDist and levelToFillRadius are exact inverses —
// any other rounding makes the wedge stop short of (or extend past) the
// guide ring at the committed level, which feels broken.
//
// Edge bands: dist < rInner returns 0 (the drag-to-clear path). Dist
// >= rOuter saturates at max (so the very tip of the wedge always
// reaches level max).
export function levelFromDist(dist: number, rInner: number, rOuter: number, max: number): number {
  if (dist < rInner) return 0
  const t = (dist - rInner) / (rOuter - rInner)
  if (t >= 1) return max
  return Math.max(0, Math.min(max, Math.round(t * max)))
}

// Inverse of levelFromDist for display: where does the outer edge of a
// filled wedge sit for a given level? Each level's display radius is at
// t = level/max, matching levelFromDist's band centers.
export function levelToFillRadius(level: number, rInner: number, rOuter: number, max: number): number {
  if (level <= 0) return rInner
  if (level >= max) return rOuter
  return rInner + (level / max) * (rOuter - rInner)
}
