// Vero scoring geometry — the design-handoff flavour-wheel (coxcomb) and
// star-fill math as pure functions. Render layers (web SVG string, RN
// react-native-svg <Path>) consume the returned path data / coordinates;
// colours and labels are the caller's concern.

export const WHEEL_MAX = 5
export const HUB_FRACTION = 0.18
export const GAP_DEG = 3
export const RADIUS_FRACTION = 0.44
export const LABEL_OFFSET = 14

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// First increment reads bigger; v = 5 reaches the rim.
export function wheelEase(v: number): number {
  return Math.pow(clamp(v, 0, WHEEL_MAX) / WHEEL_MAX, 0.62)
}

export function wheelRadius(v: number, R: number, r0: number): number {
  return r0 + (R - r0) * wheelEase(v)
}

export type WheelWedge = {
  index: number
  /** SVG path data for the wedge (annular sector, open hub). */
  d: string
}

export type WheelLabelAnchor = 'start' | 'middle' | 'end'

export type WheelLabel = {
  index: number
  x: number
  y: number
  anchor: WheelLabelAnchor
}

export type WheelGeometry = {
  size: number
  cx: number
  cy: number
  /** Outer guide-ring radius. */
  R: number
  /** Open-hub inner radius. */
  r0: number
  /** Wedges for values > 0, in input order (index ties back to the input). */
  wedges: WheelWedge[]
  /** Label anchor points for every axis, value > 0 or not. */
  labels: WheelLabel[]
}

const angleAt = (i: number, n: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n

/**
 * Coxcomb flavour-wheel geometry per the Vero handoff: wedges spring from an
 * open hub at 18% of R, fixed 3° gaps, intensity-eased radius (a 5 reaches
 * the rim). Input order is display order starting at 12 o'clock.
 */
export function flavourWheelGeometry(values: number[], size: number): WheelGeometry {
  const n = values.length
  const cx = size / 2
  const cy = size / 2
  const R = size * RADIUS_FRACTION
  const r0 = R * HUB_FRACTION
  const gapAngle = (GAP_DEG * Math.PI) / 180
  const half = Math.PI / n - gapAngle / 2
  const pt = (a: number, rad: number): [number, number] => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]

  const wedges: WheelWedge[] = []
  const labels: WheelLabel[] = []
  values.forEach((v, i) => {
    const a = angleAt(i, n)
    const [lx, ly] = pt(a, R + LABEL_OFFSET)
    const c = Math.cos(a)
    labels.push({
      index: i,
      x: round1(lx),
      y: round1(ly),
      anchor: Math.abs(c) < 0.35 ? 'middle' : c > 0 ? 'start' : 'end',
    })
    if (v <= 0) return
    const r = wheelRadius(v, R, r0)
    const [x1, y1] = pt(a - half, r)
    const [x2, y2] = pt(a + half, r)
    const [ix1, iy1] = pt(a - half, r0)
    const [ix2, iy2] = pt(a + half, r0)
    wedges.push({
      index: i,
      d:
        `M ${round1(ix1)} ${round1(iy1)} L ${round1(x1)} ${round1(y1)} ` +
        `A ${round1(r)} ${round1(r)} 0 0 1 ${round1(x2)} ${round1(y2)} ` +
        `L ${round1(ix2)} ${round1(iy2)} ` +
        `A ${round1(r0)} ${round1(r0)} 0 0 0 ${round1(ix1)} ${round1(iy1)} Z`,
    })
  })
  return { size, cx, cy, R, r0, wedges, labels }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function labelAt(i: number, n: number, size: number): WheelLabel {
  const cx = size / 2
  const cy = size / 2
  const R = size * RADIUS_FRACTION
  const a = angleAt(i, n)
  const c = Math.cos(a)
  return {
    index: i,
    x: round1(cx + c * (R + LABEL_OFFSET)),
    y: round1(cy + Math.sin(a) * (R + LABEL_OFFSET)),
    anchor: Math.abs(c) < 0.35 ? 'middle' : c > 0 ? 'start' : 'end',
  }
}

// ── Comparison wheel · C1b (structure-wheel §7 / design 02d) ────────────────
// Per axis: a min→max range band (two tones, render layer's concern) with a
// quiet arc at the group average, over a full-height faint base wedge that is
// also the tap target. Geometry mirrors .local/design/vero-scoring.js
// comparisonC1b — open hub, 0.62 ease, 3° gaps.

/** A too-thin band still reads as a band: below this it thickens symmetrically around its middle. */
export const MIN_BAND_THICKNESS = 5
/** The average arc spans slightly less than the wedge so it reads as a tick, not a divider. */
export const AVG_ARC_FRACTION = 0.86

export type ComparisonWedge = {
  index: number
  /** Full annular sector r0→R — faint underlay + tap target. */
  baseD: string
  /** min→max range band (min-thickness enforced, inner clamped to the hub). */
  bandD: string
  /** Arc at the group average. */
  avgD: string
}

export type ComparisonWheelGeometry = {
  size: number
  cx: number
  cy: number
  R: number
  r0: number
  wedges: ComparisonWedge[]
  labels: WheelLabel[]
}

export function comparisonWheelGeometry(
  values: ReadonlyArray<{ min: number; max: number; avg: number }>,
  size: number,
): ComparisonWheelGeometry {
  const n = values.length
  const cx = size / 2
  const cy = size / 2
  const R = size * RADIUS_FRACTION
  const r0 = R * HUB_FRACTION
  const gapAngle = (GAP_DEG * Math.PI) / 180
  const half = Math.PI / n - gapAngle / 2
  const pt = (a: number, rad: number): [number, number] => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]
  // Annular sector between radii ri→ro across the wedge's angular span.
  const ringPath = (a: number, ri: number, ro: number): string => {
    const [i1x, i1y] = pt(a - half, ri)
    const [i2x, i2y] = pt(a + half, ri)
    const [o1x, o1y] = pt(a - half, ro)
    const [o2x, o2y] = pt(a + half, ro)
    return (
      `M ${round1(i1x)} ${round1(i1y)} L ${round1(o1x)} ${round1(o1y)} ` +
      `A ${round1(ro)} ${round1(ro)} 0 0 1 ${round1(o2x)} ${round1(o2y)} ` +
      `L ${round1(i2x)} ${round1(i2y)} ` +
      `A ${round1(ri)} ${round1(ri)} 0 0 0 ${round1(i1x)} ${round1(i1y)} Z`
    )
  }

  const wedges: ComparisonWedge[] = []
  const labels: WheelLabel[] = []
  values.forEach((v, i) => {
    const a = angleAt(i, n)
    labels.push(labelAt(i, n, size))
    let inner = wheelRadius(v.min, R, r0)
    let outer = wheelRadius(v.max, R, r0)
    if (outer - inner < MIN_BAND_THICKNESS) {
      const mid = (inner + outer) / 2
      inner = mid - MIN_BAND_THICKNESS / 2
      outer = mid + MIN_BAND_THICKNESS / 2
    }
    // Deliberate improvement over the mock (which lets a min=max=5 band poke
    // past the rim): shift the thickened band back inside R, thickness intact.
    if (outer > R) {
      inner -= outer - R
      outer = R
    }
    inner = Math.max(inner, r0)
    const rAvg = wheelRadius(v.avg, R, r0)
    const lhalf = half * AVG_ARC_FRACTION
    const [a1x, a1y] = pt(a - lhalf, rAvg)
    const [a2x, a2y] = pt(a + lhalf, rAvg)
    wedges.push({
      index: i,
      baseD: ringPath(a, r0, R),
      bandD: ringPath(a, inner, outer),
      avgD:
        `M ${round1(a1x)} ${round1(a1y)} ` +
        `A ${round1(rAvg)} ${round1(rAvg)} 0 0 1 ${round1(a2x)} ${round1(a2y)}`,
    })
  })
  return { size, cx, cy, R, r0, wedges, labels }
}

// ── Overlaid multi-taster radar (02d, 2–4 tasters) ──────────────────────────
// Same radius/hub/ease as the wheels so a value sits at the SAME radius on the
// radar and the C1b wheel (the design's stated intent). Rings at the eased
// whole intensities 1..5; spokes run r0→R; series polygons are the render
// layer's concern via radarSeriesPoints.

export type RadarSpoke = { index: number; x1: number; y1: number; x2: number; y2: number }

export type RadarOverlayGeometry = {
  size: number
  cx: number
  cy: number
  R: number
  r0: number
  /** Guide-ring radii at intensities 1..5 (eased). */
  rings: number[]
  spokes: RadarSpoke[]
  labels: WheelLabel[]
}

export function radarOverlayGeometry(n: number, size: number): RadarOverlayGeometry {
  const cx = size / 2
  const cy = size / 2
  const R = size * RADIUS_FRACTION
  const r0 = R * HUB_FRACTION
  const rings = [1, 2, 3, 4, 5].map((k) => round1(wheelRadius(k, R, r0)))
  const spokes: RadarSpoke[] = []
  const labels: WheelLabel[] = []
  for (let i = 0; i < n; i++) {
    const a = angleAt(i, n)
    spokes.push({
      index: i,
      x1: round1(cx + Math.cos(a) * r0),
      y1: round1(cy + Math.sin(a) * r0),
      x2: round1(cx + Math.cos(a) * R),
      y2: round1(cy + Math.sin(a) * R),
    })
    labels.push(labelAt(i, n, size))
  }
  return { size, cx, cy, R, r0, rings, spokes, labels }
}

/** One taster's polygon vertices (normalized full axis set — every value present, 0 sits on the hub). */
export function radarSeriesPoints(
  values: ReadonlyArray<number>,
  size: number,
): Array<{ x: number; y: number }> {
  const n = values.length
  const cx = size / 2
  const cy = size / 2
  const R = size * RADIUS_FRACTION
  const r0 = R * HUB_FRACTION
  return values.map((v, i) => {
    const a = angleAt(i, n)
    const r = wheelRadius(v, R, r0)
    return { x: round1(cx + Math.cos(a) * r), y: round1(cy + Math.sin(a) * r) }
  })
}

/**
 * Per-star fill fraction (0..1) for a 5-star row at a quarter-step value —
 * e.g. 3.25 → [1, 1, 1, 0.25, 0].
 */
export function starFills(value: number): [number, number, number, number, number] {
  const v = clamp(value, 0, 5)
  return [0, 1, 2, 3, 4].map((i) => clamp(v - i, 0, 1)) as [number, number, number, number, number]
}

/** The Vero star glyph path (24×24 viewBox), shared by every render layer. */
export const STAR_PATH =
  'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73 -1.36 7.04z'
