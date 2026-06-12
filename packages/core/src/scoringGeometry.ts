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
