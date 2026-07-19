// Aroma-overview visualization geometry — SECOND study batch (dev-gallery
// variants E–I, Simon's reference images a–e, 2026-07-16). Same ruled stack as
// batch 1 (aromaVizGeometry.ts): pure d3-shape math + react-native-svg
// rendering, NO numbers on the charts (counts stay in the layout data for the
// future tap-reveal; the sanctioned exception is the aggregate "+N" Others
// vocabulary batch 1 already uses). This file only ADDS forms — batch 1 is
// frozen while Simon compares.
//
//   E  voronoiContinents — circular Voronoi treemap ("continents" = families,
//      "countries" = aromas; cell area = mentions, colour depth = mentions).
//   F  bubbleColumns     — one packed-bubble column per leading family,
//      gravity from the top (reference b1), bubble area = mentions.
//   G  aromaIris         — the two-tier iris: 12 family arcs on an inner ring
//      (data-carrying: family-grain picks tint their arc), all 60 subfamily
//      spokes (fixed fingerprint geometry) with aroma tiles stacked outward.
//   H  ringChain         — the bun's winding sibling (reference d1): shared →
//      niche buckets as linked open rings along an S path.
//   I  radialTreemap     — families as proportional wedges, aromas subdividing
//      the wedge area-true in (angle, r²) space (reference e1).
//
// PURE and node-importable; pinned by .local/test-env/scripts/aroma-viz2-units.ts.
// Outputs are SVG path strings + placements — renderer-agnostic on purpose.
// Angle convention matches d3-shape: 0 at 12 o'clock, increasing CLOCKWISE.
// All radial forms are 0-centered (render inside <G x={cx} y={cy}>) except
// bubbleColumns, which is a plain top-left rect layout.

import { hierarchy } from 'd3-hierarchy'
import { arc, pie, type PieArcDatum } from 'd3-shape'
import { voronoiTreemap } from 'd3-voronoi-treemap'
import { centerlineArc, polarXY, type VizFamily, type VizNote } from './aromaVizGeometry'

const TAU = Math.PI * 2
// Batch-1 fit-gate constants, duplicated on purpose: the pinned batch-1 module
// stays byte-identical while both batches are compared side by side.
const CHAR_EM = 0.62

function fitName(label: string, slotPx: number, fontSize: number, em = CHAR_EM): string | null {
  return label.length * fontSize * em <= slotPx * 0.92 ? label : null
}
function labelNeedPx(label: string, fontSize: number, em = CHAR_EM): number {
  return (label.length * fontSize * em) / 0.92
}

// Deterministic PRNG (mulberry32) — the Voronoi solver's default Math.random
// would re-shuffle the continents every render AND break node-side pinning.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Pt = [number, number]

function polygonPath(polygon: ReadonlyArray<Pt>): string {
  return polygon.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ') + ' Z'
}

function polygonCentroid(polygon: ReadonlyArray<Pt>): Pt {
  let area = 0
  let x = 0
  let y = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i]
    const [x1, y1] = polygon[(i + 1) % polygon.length]
    const cross = x0 * y1 - x1 * y0
    area += cross
    x += (x0 + x1) * cross
    y += (y0 + y1) * cross
  }
  if (Math.abs(area) < 1e-6) {
    const n = polygon.length || 1
    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n]
  }
  return [x / (3 * area), y / (3 * area)]
}

function polygonBBox(polygon: ReadonlyArray<Pt>): { w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of polygon) {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  return { w: maxX - minX, h: maxY - minY }
}

function roundedRectPolygon(x0: number, y0: number, x1: number, y1: number, radius: number): Pt[] {
  const corners = [
    { x: x1 - radius, y: y0 + radius, a0: -Math.PI / 2, a1: 0 },
    { x: x1 - radius, y: y1 - radius, a0: 0, a1: Math.PI / 2 },
    { x: x0 + radius, y: y1 - radius, a0: Math.PI / 2, a1: Math.PI },
    { x: x0 + radius, y: y0 + radius, a0: Math.PI, a1: Math.PI * 1.5 },
  ]
  const steps = 8
  return corners.flatMap((corner) =>
    Array.from({ length: steps + 1 }, (_, i): Pt => {
      const angle = corner.a0 + ((corner.a1 - corner.a0) * i) / steps
      return [corner.x + radius * Math.cos(angle), corner.y + radius * Math.sin(angle)]
    }))
}

// ── E · Voronoi continents ───────────────────────────────────────────────────
// Weighted Voronoi treemap clipped to a circle. Families claim connected
// "continents"; their aromas subdivide them as organic "countries". Cell AREA
// is exactly proportional to mentions (the solver iterates until it is), and
// `share` carries a colour-depth encoding so the strongest aromas read without
// any text. Labels are FAMILY-only, per the zoomed-out ruling on this form.

export type ContinentCell = {
  familyId: string
  label: string
  count: number
  others: boolean
  pathD: string
  /** Colour share 0..1 (√-scaled global mention strength) — the renderer
      mixes family colour toward the ground by (1 − share). */
  share: number
}
export type ContinentOutline = {
  familyId: string
  label: string
  count: number
  pathD: string
  labelX: number
  labelY: number
  labelText: string | null
  labelCellShare: number
  labelCellOthers: boolean
}
export type ContinentsShape = 'round' | 'rectangle'
export type ContinentsLayout = {
  width: number
  height: number
  shape: ContinentsShape
  cx: number
  cy: number
  cells: ContinentCell[]
  outlines: ContinentOutline[]
}

type ContinentDatum = {
  label?: string
  familyId?: string
  count?: number
  others?: boolean
  children?: ContinentDatum[]
}
type VtNode = { data: ContinentDatum; polygon?: Pt[]; children?: VtNode[] }

export function voronoiContinents(
  families: ReadonlyArray<VizFamily>,
  opts: { size: number; fontSize?: number; seed?: number; maxCellsPerFamily?: number; shape?: ContinentsShape },
): ContinentsLayout {
  const { size, fontSize = 11, seed = 7, maxCellsPerFamily = 24, shape = 'round' } = opts
  const width = size
  const height = shape === 'round' ? size : Math.round(size * 1.08)
  const cx = size / 2
  const cy = height / 2
  const r = size * 0.47
  const rectInset = 5
  const rectRadius = Math.min(24, height * 0.1)
  const clipArea = shape === 'round'
    ? Math.PI * r * r
    : (width - rectInset * 2) * (height - rectInset * 2) - (4 - Math.PI) * rectRadius * rectRadius
  const shown = families.filter((family) => family.count > 0)
  const totalCount = shown.reduce((sum, family) => sum + family.count, 0) || 1
  // Spend the country budget where the screen has room for it. A fixed
  // per-family cap gave tiny continents as many cells as the dominant ones,
  // while large continents collapsed useful aromas into a huge remainder.
  // The global budget keeps the iterative solver bounded; proportional quotas
  // make the map's visible detail follow its physical area.
  const totalCountryBudget = Math.min(144, Math.max(shown.length * 2, Math.floor(clipArea / 720)))
  const children: ContinentDatum[] = shown.map((family) => {
    const named = family.notes.filter((note) => !note.others && note.count > 0).sort((a, b) => b.count - a.count)
    const quota = Math.min(
      maxCellsPerFamily,
      Math.max(2, Math.round(totalCountryBudget * (family.count / totalCount))),
    )
    const kept = named.slice(0, quota)
    const tail = family.count - kept.reduce((sum, note) => sum + note.count, 0)
    return {
      familyId: family.id,
      label: family.label,
      children: [
        ...kept.map((note) => ({ familyId: family.id, label: note.shortLabel ?? note.label, count: note.count, others: false })),
        ...(tail > 0 ? [{ familyId: family.id, label: 'Others', count: tail, others: true }] : []),
      ],
    }
  })
  const root = hierarchy<ContinentDatum>({ children }).sum((d) => d.count ?? 0)
  const clip: Pt[] = shape === 'round'
    ? Array.from({ length: 72 }, (_, i) => {
        const a = (i / 72) * TAU
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
      })
    : roundedRectPolygon(rectInset, rectInset, width - rectInset, height - rectInset, rectRadius)
  voronoiTreemap()
    .clip(clip)
    .prng(mulberry32(seed))
    .maxIterationCount(64)
    .minWeightRatio(0.004)(root as never)
  const leaves = root.leaves() as unknown as VtNode[]
  const maxCount = Math.max(1, ...leaves.map((leaf) => leaf.data.count ?? 0))
  const cells = leaves
    .filter((leaf) => leaf.polygon && leaf.polygon.length >= 3)
    .map((leaf): ContinentCell => ({
      familyId: leaf.data.familyId ?? 'other',
      label: leaf.data.label ?? '',
      count: leaf.data.count ?? 0,
      others: !!leaf.data.others,
      pathD: polygonPath(leaf.polygon!),
      share: leaf.data.others ? 0.2 : 0.34 + 0.66 * Math.sqrt((leaf.data.count ?? 0) / maxCount),
    }))
  const outlines = ((root.children ?? []) as unknown as VtNode[])
    .filter((node) => node.polygon && node.polygon.length >= 3)
    .map((node): ContinentOutline => {
      // Put the family name wholly inside its largest country. The former
      // continent-centroid label could straddle several internal borders;
      // this gives the text one known ground colour and needs no halo.
      const labelCell = (node.children ?? [])
        .filter((child) => child.polygon && child.polygon.length >= 3)
        .sort((a, b) => (b.data.count ?? 0) - (a.data.count ?? 0))[0]
      const labelPolygon = labelCell?.polygon ?? node.polygon!
      const [lx, ly] = polygonCentroid(labelPolygon)
      const { w } = polygonBBox(labelPolygon)
      const family = shown.find((f) => f.id === node.data.familyId)
      const labelCount = labelCell?.data.count ?? 0
      return {
        familyId: node.data.familyId ?? 'other',
        label: node.data.label ?? '',
        count: family?.count ?? 0,
        pathD: polygonPath(node.polygon!),
        labelX: lx,
        labelY: ly,
        labelText: fitName(node.data.label ?? '', w * 0.8, fontSize + 1),
        labelCellShare: labelCell?.data.others ? 0.2 : 0.34 + 0.66 * Math.sqrt(labelCount / maxCount),
        labelCellOthers: !!labelCell?.data.others,
      }
    })
  return { width, height, shape, cx, cy, cells, outlines }
}

// ── F · Packed-bubble columns ────────────────────────────────────────────────
// One column per leading family (reference b1): bubbles sized by mentions on a
// SHARED global √ scale, dropped from the top with a deterministic greedy
// gravity pack. The family's unnamed remainder rides along as one pale bubble;
// families past the column budget fold into a grey trailing column of
// per-family bubbles.

export type ColumnBubble = {
  familyId: string
  label: string
  count: number
  others: boolean
  cx: number
  cy: number
  r: number
  /** Colour share 0..1 within the family (strongest = 1). */
  share: number
  labelText: string | null
}
export type BubbleColumn = { familyId: string; label: string; x0: number; w: number; labelText: string | null }
export type BubbleColumnsLayout = { width: number; height: number; headerH: number; columns: BubbleColumn[]; bubbles: ColumnBubble[] }

export function bubbleColumns(
  families: ReadonlyArray<VizFamily>,
  opts: { size: number; fontSize?: number; maxColumns?: number; maxBubblesPerColumn?: number },
): BubbleColumnsLayout {
  const { size, fontSize = 11, maxColumns = 5, maxBubblesPerColumn = 16 } = opts
  const ranked = [...families].filter((family) => family.count > 0).sort((a, b) => b.count - a.count)
  const shown = ranked.slice(0, maxColumns)
  const omitted = ranked.slice(maxColumns)
  const nCols = shown.length + (omitted.length > 0 ? 1 : 0)
  const HEADER_H = fontSize + 20
  if (nCols === 0) return { width: size, height: 0, headerH: HEADER_H, columns: [], bubbles: [] }
  type Entry = { familyId: string; label: string; count: number; others: boolean }
  const columnEntries: Array<{ familyId: string; label: string; entries: Entry[] }> = shown.map((family) => {
    const named = family.notes.filter((note) => !note.others && note.count > 0).sort((a, b) => b.count - a.count)
    const kept = named.slice(0, maxBubblesPerColumn)
    const tail = family.count - kept.reduce((sum, note) => sum + note.count, 0)
    return {
      familyId: family.id,
      label: family.label,
      entries: [
        ...kept.map((note) => ({ familyId: family.id, label: note.shortLabel ?? note.label, count: note.count, others: false })),
        ...(tail > 0 ? [{ familyId: family.id, label: 'Others', count: tail, others: true }] : []),
      ],
    }
  })
  if (omitted.length > 0) {
    // The trailing grey column: one bubble PER omitted family (its total).
    columnEntries.push({
      familyId: 'other',
      label: 'Others',
      entries: omitted.map((family) => ({ familyId: 'other', label: family.label, count: family.count, others: true })),
    })
  }
  // Mildly proportional lanes give the leading families more useful room
  // without turning weak families into unreadable slivers. Bubble radii still
  // share ONE global √ scale; widths only improve packing efficiency.
  const strongestFamily = Math.max(1, ...shown.map((family) => family.count))
  const weights = columnEntries.map((column) => {
    if (column.familyId === 'other') return 0.68
    const family = shown.find((candidate) => candidate.id === column.familyId)
    return 0.58 + 0.42 * Math.sqrt((family?.count ?? 0) / strongestFamily)
  })
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const widths = weights.map((weight) => size * (weight / weightTotal))
  const namedScaleLimits = columnEntries.flatMap((column, i) => {
    const maxNamed = Math.max(0, ...column.entries.filter((entry) => !entry.others).map((entry) => entry.count))
    return maxNamed > 0 ? [(widths[i] * 0.45) / Math.sqrt(maxNamed)] : []
  })
  const k = Math.min(...namedScaleLimits, size * 0.08)
  const GAP = 1.5
  const bubbles: ColumnBubble[] = []
  const columns: BubbleColumn[] = []
  let maxBottom = 0
  let cursorX = 0
  columnEntries.forEach((column, ci) => {
    const colW = widths[ci]
    const x0 = cursorX
    cursorX += colW
    const placed: Array<{ x: number; y: number; r: number }> = []
    const famMax = Math.max(1, ...column.entries.filter((entry) => !entry.others).map((entry) => entry.count))
    let orderFloor = HEADER_H
    for (const entry of column.entries) {
      // Others bubbles are whole-family totals on an aroma scale — they'd all
      // slam into the cap and dominate; hold them visibly below the top aroma.
      const rMax = colW * 0.45
      const cap = entry.others ? rMax * 0.68 : rMax
      const radius = Math.min(cap, Math.max(3.5, k * Math.sqrt(entry.count)))
      // Deterministic greedy drop: sample candidate x slots, take the one that
      // rests highest (then the most central) against everything placed.
      const lo = radius + 1
      const hi = colW - radius - 1
      const steps = hi > lo ? 15 : 1
      let best = { x: colW / 2, y: HEADER_H + radius, dist: 0 }
      let bestScore = Infinity
      for (let s = 0; s < steps; s++) {
        const x = steps === 1 ? colW / 2 : lo + ((hi - lo) * s) / (steps - 1)
        let y = Math.max(HEADER_H + radius, orderFloor)
        for (const p of placed) {
          const dx = Math.abs(x - p.x)
          const reach = radius + p.r + GAP
          if (dx < reach) y = Math.max(y, p.y + Math.sqrt(reach * reach - dx * dx))
        }
        const score = y * 1000 + Math.abs(x - colW / 2)
        if (score < bestScore) {
          bestScore = score
          best = { x, y, dist: 0 }
        }
      }
      placed.push({ x: best.x, y: best.y, r: radius })
      orderFloor = best.y
      const chord = 2 * radius * 0.82
      bubbles.push({
        familyId: entry.familyId,
        label: entry.label,
        count: entry.count,
        others: entry.others,
        cx: x0 + best.x,
        cy: best.y,
        r: radius,
        share: entry.others ? 0.2 : 0.5 + 0.5 * (entry.count / famMax),
        labelText: fitName(entry.label, chord, fontSize) && radius >= fontSize ? entry.label : null,
      })
      maxBottom = Math.max(maxBottom, best.y + radius)
    }
    columns.push({ familyId: column.familyId, label: column.label, x0, w: colW, labelText: fitName(column.label, colW - 4, fontSize) })
  })
  return { width: size, height: maxBottom + 8, headerH: HEADER_H, columns, bubbles }
}

// ── G · Two-tier aroma iris ──────────────────────────────────────────────────
// The wine-aroma-wheel-as-data form. Inner ring: 12 family arcs (fixed
// taxonomy order) — DATA-CARRYING: family-grain picks tint their arc. Spokes:
// the subfamilies, either the full fixed-60 fingerprint (empty spokes render
// as faint stubs so every moment shares one geometry) or the active subset.
// Tiles stack outward per spoke — one per mention, or one per distinct aroma
// with mention depth as colour share. No spoke labels by design (the future
// tap/zoom reveals them); family labels are fit-gated on their arc.

export type IrisAromaEntry = { label: string; count: number }
export type IrisSubInput = { id: string; label: string; count: number; aromas: ReadonlyArray<IrisAromaEntry> }
export type IrisFamilyInput = { id: string; label: string; familyCount: number; subs: ReadonlyArray<IrisSubInput> }

export type IrisTile = { pathD: string; share: number; label: string; count: number; outerR: number }
export type IrisSpoke = {
  subId: string
  subLabel: string
  familyId: string
  count: number
  tiles: IrisTile[]
  /** Faint skeleton stub for an empty spoke (fixed-60 mode only). */
  stubD: string | null
  /** Position mode's ghost track (Simon's pick, round 5): the spoke's full
      radial rail, rBase → rim, drawn under the tiles at a whisper of the
      family tint — an isolated tile reads against its own rail instead of a
      gridline. Only emitted for depth:'position' on spokes with data. */
  trackD: string | null
  /** Small outward chevron when tiles were capped. */
  overflowD: string | null
}
export type IrisFamilyArc = {
  familyId: string
  label: string
  familyCount: number
  /** Colour share for the arc band (family-grain picks deepen it). */
  share: number
  arcD: string
  labelPathD: string
  labelText: string | null
  /** Family names run one point smaller than the base size — the inner ring
      is the tightest label surface of any study and this is the one label
      class the iris ruling allows at rest. */
  labelFontSize: number
  startRad: number
  endRad: number
}
export type IrisLayout = {
  cx: number
  cy: number
  rHole: number
  bandThickness: number
  families: IrisFamilyArc[]
  spokes: IrisSpoke[]
}

// Per-aroma mention-depth encodings (Simon's round-4 asks): 'uniform' = every
// tile identical (the first cut), 'length' = the tile's radial length grows
// with mentions (max = the space of TWO uniform tiles), 'shade' = colour
// share carries depth (solid = strongest, 0.45 floor keeps the weakest
// clearly filled — the area-aggregate lesson), 'position' = the tile's radial
// LOCATION carries depth (hub-near = most mentioned, rim-near = niche — the
// Bun's shared-at-centre vocabulary; equal counts collision-push outward).
// Only meaningful for tiles:'aromas'; per-mention tiles are unit counters and
// stay uniform.
export type IrisDepth = 'uniform' | 'length' | 'shade' | 'position'

export function aromaIris(
  input: ReadonlyArray<IrisFamilyInput>,
  opts: { size: number; fontSize?: number; spokes?: 'all' | 'active'; tiles?: 'mentions' | 'aromas'; depth?: IrisDepth },
): IrisLayout {
  const { size, fontSize = 11, spokes: spokeMode = 'all', tiles: tileMode = 'mentions', depth = 'uniform' } = opts
  const useDepth: IrisDepth = tileMode === 'aromas' ? depth : 'uniform'
  const cx = size / 2
  const cy = size / 2
  // A generous hub: the family band is the only labelled surface, and at
  // 0.15·size not one family name fit the fixed-60 ring (pinned finding).
  const rHole = size * 0.19
  const BAND = 17
  const rBase = rHole + BAND + 6
  const rMax = size * 0.47
  const TILE_H = 10
  const TILE_GAP = 2.5
  const shownFamilies = (spokeMode === 'all'
    ? input
    : input.filter((family) => family.familyCount > 0 || family.subs.some((sub) => sub.count > 0))
  ).map((family) => ({
    ...family,
    subs: spokeMode === 'all' ? family.subs : family.subs.filter((sub) => sub.count > 0),
  }))
  const FAMILY_GAP = (3 * Math.PI) / 180
  const totalSlots = shownFamilies.reduce((sum, family) => sum + Math.max(1, family.subs.length), 0)
  const slotRad = Math.max(0.001, (TAU - shownFamilies.length * FAMILY_GAP) / Math.max(1, totalSlots))
  const maxFamilyDirect = Math.max(1, ...shownFamilies.map((family) => family.familyCount))
  const maxAroma = Math.max(1, ...shownFamilies.flatMap((family) => family.subs.flatMap((sub) => sub.aromas.map((aroma) => aroma.count))))
  const tileGen = arc<null>()
  const families: IrisFamilyArc[] = []
  const spokes: IrisSpoke[] = []
  let cursor = 0
  for (const family of shownFamilies) {
    const span = Math.max(1, family.subs.length) * slotRad
    const s = cursor
    const e = cursor + span
    cursor = e + FAMILY_GAP
    const rFam = rHole + BAND / 2
    const midDeg = ((((s + e) / 2) * 180) / Math.PI + 360) % 360
    const familyLabelSize = fontSize - 1
    families.push({
      familyId: family.id,
      label: family.label,
      familyCount: family.familyCount,
      share: family.familyCount > 0 ? 0.45 + 0.55 * (family.familyCount / maxFamilyDirect) : 0.16,
      arcD: centerlineArc(0, 0, rFam, s, e),
      labelPathD: centerlineArc(0, 0, rFam, s, e, midDeg > 90 && midDeg < 270),
      labelText: fitName(family.label, (e - s) * rFam - 2, familyLabelSize, 0.54),
      labelFontSize: familyLabelSize,
      startRad: s,
      endRad: e,
    })
    family.subs.forEach((sub, i) => {
      const tick = slotRad * 0.14
      const a0 = s + i * slotRad + tick
      const a1 = s + (i + 1) * slotRad - tick
      const mid = (a0 + a1) / 2
      const entries: Array<{ label: string; count: number; share: number }> = tileMode === 'mentions'
        ? Array.from({ length: sub.count }, () => ({ label: sub.label, count: 1, share: 1 }))
        : [...sub.aromas]
            .sort((a, b) => b.count - a.count)
            .map((aroma) => ({
              label: aroma.label,
              count: aroma.count,
              share: useDepth === 'shade' ? 0.45 + 0.55 * (aroma.count / maxAroma) : 1,
            }))
      // Depth-aware stacking. 'length': radial length grows with mentions up
      // to the space of two uniform tiles. 'position': the tile sits at the
      // radius its count maps to (hub = maxAroma, rim = 1), colliding tiles
      // push outward. Others: uniform stack. Entries that no longer fit the
      // radial budget fold behind the overflow chevron.
      const maxLen = TILE_H * 2 + TILE_GAP
      const depthRatio = (count: number) => (maxAroma <= 1 ? 0 : (count - 1) / (maxAroma - 1))
      const tiles: IrisTile[] = []
      let rc = rBase
      for (const entry of entries) {
        const h = useDepth === 'length' ? TILE_H + (maxLen - TILE_H) * depthRatio(entry.count) : TILE_H
        const inner = useDepth === 'position'
          ? Math.max(rc, rBase + (1 - depthRatio(entry.count)) * (rMax - TILE_H - rBase))
          : rc
        if (inner + h > rMax + 0.01) break
        tiles.push({
          pathD: tileGen.innerRadius(inner).outerRadius(inner + h).cornerRadius(2).startAngle(a0).endAngle(a1)(null) ?? '',
          share: entry.share,
          label: entry.label,
          count: entry.count,
          outerR: inner + h,
        })
        rc = inner + h + TILE_GAP
      }
      const overflow = entries.length > tiles.length
      const rTop = tiles.length ? tiles[tiles.length - 1].outerR : rBase
      let overflowD: string | null = null
      if (overflow) {
        const halfW = Math.min((a1 - a0) / 2, 3.2 / (rTop + 3))
        const p1 = polarXY(0, 0, rTop + 3, mid - halfW)
        const p2 = polarXY(0, 0, rTop + 3, mid + halfW)
        const p3 = polarXY(0, 0, rTop + 8, mid)
        overflowD = `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} Z`
      }
      spokes.push({
        subId: sub.id,
        subLabel: sub.label,
        familyId: family.id,
        count: sub.count,
        tiles,
        stubD: sub.count === 0
          ? tileGen.innerRadius(rBase).outerRadius(rBase + 2.5).cornerRadius(1).startAngle(a0).endAngle(a1)(null) ?? ''
          : null,
        trackD: useDepth === 'position' && sub.count > 0
          ? tileGen.innerRadius(rBase).outerRadius(rMax).cornerRadius(2).startAngle(a0).endAngle(a1)(null) ?? ''
          : null,
        overflowD,
      })
    })
  }
  return { cx, cy, rHole, bandThickness: BAND, families, spokes }
}

// ── H · Ring chain (the aroma snail) ─────────────────────────────────────────
// The bun's winding sibling (reference d1), reduced to ONE data point (Simon's
// round-6 ruling — the mention buckets were "useless"): a single continuous
// ribbon meanders top → bottom through tapering loops, carrying EVERY aroma in
// strict mention order, most mentioned first. No bucket captions, no mid-string
// folds — the only aggregate is the pale "+N" tail at the very END. Loop
// winding ALTERNATES like a true meander and each loop-to-loop hand-off is a
// tangent-aligned cubic split at its midpoint so both halves continue their
// neighbouring segment's colour. Angular span ∝ the label's pixel need (every
// segment carries its name — the standing no-anonymous-slivers ruling); the
// ORDER is the encoding, not the span.

export type ChainSegment = {
  label: string
  count: number
  familyId: string
  others: boolean
  arcD: string
  labelPathD: string
  labelText: string | null
}
export type ChainSeparator = { x1: number; y1: number; x2: number; y2: number }
export type ChainRing = {
  xc: number
  yc: number
  r: number
  segments: ChainSegment[]
  separators: ChainSeparator[]
  capStartD: string | null
  capEndD: string | null
}
/** One short, tangent-continuous loop-to-loop hand-off. Its endpoint metadata
    defines the along-path colour transition in the renderer. */
export type ChainConnector = {
  pathD: string
  x1: number
  y1: number
  x2: number
  y2: number
  fromFamilyId: string
  fromOthers: boolean
  toFamilyId: string
  toOthers: boolean
}
export type RingChainLayout = {
  width: number
  height: number
  ribbon: number
  rings: ChainRing[]
  connectors: ChainConnector[]
  /** Named aromas riding the snail vs folded into the end tail (pin data). */
  shownNotes: number
  foldedNotes: number
}

export function ringChain(
  notes: ReadonlyArray<VizNote & { familyId: string }>,
  opts: { size: number; fontSize?: number },
): RingChainLayout {
  const { size, fontSize = 11 } = opts
  const ranked = [...notes].filter((note) => note.count > 0).sort((a, b) => b.count - a.count)
  if (ranked.length === 0) return { width: size, height: 0, ribbon: 18, rings: [], connectors: [], shownNotes: 0, foldedNotes: 0 }
  const RIBBON = 18
  const rings: ChainRing[] = []
  const connectors: ChainConnector[] = []
  const margin = RIBBON / 2 + 4
  const SEG_PAD = 16
  // Loops are packed against a CONSERVATIVE sweep (the clamp floor below), so
  // the actual per-loop sweep can only stretch spans, never squeeze a label.
  const S_PACK = 4.2
  const rCap = size * 0.31
  const R_MIN = 44
  const TAPER = 0.88
  const MAX_LOOPS = 5
  type ChainPart = { label: string; displayLabel: string; count: number; familyId: string; others: boolean; needPx: number }
  const allParts: ChainPart[] = ranked.map((note) => ({
    label: note.label,
    displayLabel: note.shortLabel ?? note.label,
    count: note.count,
    familyId: note.familyId,
    others: false,
    needPx: labelNeedPx(note.shortLabel ?? note.label, fontSize, 0.54) + SEG_PAD,
  }))
  // Greedy loop packing: each loop takes the next run of segments up to its
  // (tapering) circumference; the loop then shrinks its radius to exactly the
  // content it holds, so every loop is full — no stretch slack. Whatever the
  // loop budget can't hold folds into the single "+N" END tail.
  const loopPlans: Array<{ parts: ChainPart[]; r: number }> = []
  let idx = 0
  for (let li = 0; li < MAX_LOOPS && idx < allParts.length; li++) {
    const cap = S_PACK * Math.max(R_MIN, rCap * Math.pow(TAPER, li))
    const parts: ChainPart[] = []
    let used = 0
    while (idx < allParts.length && (parts.length === 0 || used + allParts[idx].needPx <= cap)) {
      used += allParts[idx].needPx
      parts.push(allParts[idx])
      idx++
    }
    if (li === MAX_LOOPS - 1 && idx < allParts.length) {
      // Reserve tail room on the final loop: pop segments until "+N" fits.
      let folded = allParts.length - idx
      let tailNeed = labelNeedPx(`+${folded}`, fontSize, 0.54) + 10
      while (parts.length > 1 && used + tailNeed > cap) {
        idx--
        used -= allParts[idx].needPx
        parts.pop()
        folded = allParts.length - idx
        tailNeed = labelNeedPx(`+${folded}`, fontSize, 0.54) + 10
      }
      const foldedCount = ranked.slice(idx).reduce((sum, note) => sum + note.count, 0)
      parts.push({ label: 'Others', displayLabel: `+${folded}`, count: foldedCount, familyId: 'other', others: true, needPx: tailNeed })
      used += tailNeed
      idx = allParts.length
    }
    loopPlans.push({ parts, r: Math.max(R_MIN, used / S_PACK) })
  }
  const shownNotes = loopPlans.reduce((sum, plan) => sum + plan.parts.filter((part) => !part.others).length, 0)
  const foldedNotes = ranked.length - shownNotes
  const radii = loopPlans.map((plan) => plan.r)
  // KISSING-CIRCLE walk (Simon's never-overlap ruling — wall-pinned centers
  // let long hand-offs swing across other loops): every loop sits tangent
  // (+GAP) to its predecessor, reaching toward the alternating side; if that
  // reach would touch ANY earlier loop or leave the canvas, the reach shrinks
  // toward vertical until clear. Hand-offs become short local bridges at the
  // kiss points — they can't cross anything. ⚠️ Radii are CENTERLINE radii and
  // the ribbon is RIBBON px thick — the gap must clear a full ribbon width
  // plus daylight, not just the centerlines (round-7 catch: 14px looked fine
  // on paper and overlapped ribbon edges by 4px on canvas).
  const GAP = RIBBON + 8
  const edge = RIBBON / 2 + 3
  const centers: Array<{ x: number; y: number }> = []
  loopPlans.forEach((_, i) => {
    const r = radii[i]
    if (i === 0) {
      centers.push({ x: edge + r, y: edge + r })
      return
    }
    const prev = centers[i - 1]
    const d = r + radii[i - 1] + GAP
    const targetX = i % 2 === 0 ? edge + r : size - edge - r
    let dx = Math.max(-d * 0.97, Math.min(d * 0.97, targetX - prev.x))
    for (let guard = 0; guard < 24; guard++) {
      const x = prev.x + dx
      const y = prev.y + Math.sqrt(Math.max(0, d * d - dx * dx))
      const clear = x - r >= edge - 0.5 && x + r <= size - edge + 0.5
        && centers.every((c0, j) => Math.hypot(x - c0.x, y - c0.y) >= r + radii[j] + GAP - 0.5)
      if (clear) break
      dx *= 0.78
    }
    centers.push({ x: prev.x + dx, y: prev.y + Math.sqrt(Math.max(0, d * d - dx * dx)) })
  })
  // d3 angle (0 = 12 o'clock, clockwise) of the vector from a ring center to a
  // point: x grows with sin, y shrinks with cos.
  const headingRad = (from: { x: number; y: number }, to: { x: number; y: number }): number =>
    Math.atan2(to.x - from.x, -(to.y - from.y))
  // The meander: winding ALTERNATES per loop (a same-winding chain forces the
  // hand-off to reverse direction — the "two separate sections" read). Each
  // loop's ribbon ENTERS just past the kiss point with its predecessor and
  // EXITS just before the kiss point with its successor; the sweep between is
  // clamped so it can never drop below the packing sweep (labels stay whole)
  // and the free chain ends get a fixed comfortable opening.
  const INSET = 0.14
  const END_GAP = 0.9
  // The zig-zag centre walk alternates its turn direction. The ribbon must
  // take the OUTSIDE arc of each turn: that is the long, label-bearing route
  // between the two local kiss points. Starting with the opposite winding
  // selects the short inside arc; the S_PACK clamp then pushes the exit far
  // past the next loop and produces a long hand-off that cuts through earlier
  // rings. This phase keeps the winding alternating while making every
  // hand-off genuinely local.
  const winding = loopPlans.map((_, i) => (i % 2 === 0 ? -1 : 1))
  const entryAngles: number[] = []
  const sweeps: number[] = []
  loopPlans.forEach((_, i) => {
    const c = centers[i]
    const w = winding[i]
    const eIn = i > 0 ? headingRad(c, centers[i - 1]) : null
    const eOut = i < loopPlans.length - 1 ? headingRad(c, centers[i + 1]) : null
    if (eIn !== null && eOut !== null) {
      const entry = eIn + w * INSET
      const rawSweep = ((w * (eOut - w * INSET - entry)) % TAU + TAU) % TAU
      entryAngles.push(entry)
      sweeps.push(Math.min(TAU - 0.35, Math.max(S_PACK, rawSweep)))
    } else if (eOut !== null) {
      // Chain start: free end sits one END_GAP behind the exit toward next.
      const exit = eOut - w * INSET
      entryAngles.push(exit - w * (TAU - END_GAP))
      sweeps.push(TAU - END_GAP)
    } else {
      // Chain end (or a single-loop snail): opening faces up-canvas.
      const entry = (eIn ?? Math.PI) + w * INSET
      entryAngles.push(entry)
      sweeps.push(TAU - END_GAP)
    }
  })
  const exitAngles = loopPlans.map((_, i) => entryAngles[i] + winding[i] * sweeps[i])
  loopPlans.forEach((plan, i) => {
    const r = radii[i]
    const c = centers[i]
    const w = winding[i]
    const parts = plan.parts
    // Angular spans ∝ each label's pixel need — every segment fits its name
    // by construction, and slack (when the radius floored up) spreads evenly.
    const totalNeed = parts.reduce((sum, part) => sum + part.needPx, 0) || 1
    const boundaries: number[] = []
    let cum = 0
    const segments = parts.map((part, j): ChainSegment => {
      const span = sweeps[i] * (part.needPx / totalNeed)
      const s = entryAngles[i] + w * cum
      cum += span
      const e = entryAngles[i] + w * cum
      if (j < parts.length - 1) boundaries.push(e)
      const aLo = Math.min(s, e)
      const aHi = Math.max(s, e)
      const midDeg = ((((aLo + aHi) / 2) * 180) / Math.PI + 360) % 360
      return {
        label: part.label,
        count: part.count,
        familyId: part.familyId,
        others: part.others,
        arcD: centerlineArc(c.x, c.y, r, aLo, aHi),
        labelPathD: centerlineArc(c.x, c.y, r, aLo, aHi, midDeg > 90 && midDeg < 270),
        labelText: fitName(part.displayLabel, (aHi - aLo) * r, fontSize, 0.54) ?? part.displayLabel,
      }
    })
    const separators = boundaries.map((rad): ChainSeparator => {
      const inner = polarXY(c.x, c.y, r - RIBBON / 2 - 1, rad)
      const outer = polarXY(c.x, c.y, r + RIBBON / 2 + 1, rad)
      return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y }
    })
    const nub = (0.6 / r) * w
    const capA = (a0: number, a1: number) => centerlineArc(c.x, c.y, r, Math.min(a0, a1), Math.max(a0, a1))
    rings.push({
      xc: c.x,
      yc: c.y,
      r,
      segments,
      separators,
      // Only the two free ends of the whole chain are rounded. Connected ends
      // remain square and meet the connector at the exact same centreline
      // point, so the ribbon keeps one constant width without a doubled bulge.
      capStartD: i === 0 ? capA(entryAngles[i], entryAngles[i] + nub) : null,
      capEndD: i === loopPlans.length - 1 ? capA(exitAngles[i] - nub, exitAngles[i]) : null,
    })
    if (i < loopPlans.length - 1) {
      // One compact tangent-aligned cubic from this loop's exit to the next
      // loop's entry. A short handle keeps the bridge organic without the
      // hourglass/S-bend produced by half-chord handles in this narrow gap.
      // Colour changes along this single stroke in the renderer, avoiding the
      // doubled round caps of the former two-half connector.
      const P = polarXY(c.x, c.y, r, exitAngles[i])
      const Q = polarXY(centers[i + 1].x, centers[i + 1].y, radii[i + 1], entryAngles[i + 1])
      const dirP = { x: w * Math.cos(exitAngles[i]), y: w * Math.sin(exitAngles[i]) }
      const wn = winding[i + 1]
      const dirQ = { x: wn * Math.cos(entryAngles[i + 1]), y: wn * Math.sin(entryAngles[i + 1]) }
      const h = Math.min(RIBBON * 0.72, 0.3 * Math.hypot(Q.x - P.x, Q.y - P.y))
      const c1 = { x: P.x + h * dirP.x, y: P.y + h * dirP.y }
      const c2 = { x: Q.x - h * dirQ.x, y: Q.y - h * dirQ.y }
      const pt = (q: { x: number; y: number }) => `${q.x.toFixed(2)} ${q.y.toFixed(2)}`
      const lastSeg = segments[segments.length - 1]
      const nextParts = loopPlans[i + 1].parts
      connectors.push({
        pathD: `M ${pt(P)} C ${pt(c1)} ${pt(c2)} ${pt(Q)}`,
        x1: P.x,
        y1: P.y,
        x2: Q.x,
        y2: Q.y,
        fromFamilyId: lastSeg.familyId,
        fromOthers: lastSeg.others,
        toFamilyId: nextParts[0].familyId,
        toOthers: nextParts[0].others,
      })
    }
  })
  const height = centers.length ? centers[centers.length - 1].y + radii[radii.length - 1] + margin : 0
  return { width: size, height, ribbon: RIBBON, rings, connectors, shownNotes, foldedNotes }
}

// ── I · Radial treemap ───────────────────────────────────────────────────────
// Families claim proportional wedges (reference e1); inside a wedge the aromas
// subdivide AREA-TRUE by working in (angle, r²) space — a rectangle there maps
// to an annular sector of exactly proportional area. Balanced binary splits
// pick the physically longer direction, so tiles stay chunky. Small aromas
// fold into a pale per-family Others tile; family names ride the outer rim.

export type RadialTile = {
  familyId: string
  label: string
  count: number
  others: boolean
  pathD: string
  share: number
  labelText: string | null
  labelFontSize: number
  labelX: number
  labelY: number
  labelRotate: number
  labelAnchor: 'start' | 'middle' | 'end'
}
export type RadialFamilyLabel = { familyId: string; outlineD: string; labelPathD: string; labelText: string | null }
export type RadialTreemapLayout = { cx: number; cy: number; rIn: number; rOut: number; tiles: RadialTile[]; famLabels: RadialFamilyLabel[] }

type RadialEntry = { label: string; displayLabel: string; count: number; others: boolean }
type UVRect = { u0: number; u1: number; v0: number; v1: number }

function splitUV(
  entries: ReadonlyArray<RadialEntry>,
  rect: UVRect,
  out: Array<{ entry: RadialEntry; rect: UVRect }>,
): void {
  if (entries.length === 0) return
  if (entries.length === 1) {
    out.push({ entry: entries[0], rect })
    return
  }
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1
  let leftTotal = 0
  let split = 1
  let best = Infinity
  for (let i = 1; i < entries.length; i++) {
    leftTotal += entries[i - 1].count
    const distance = Math.abs(total / 2 - leftTotal)
    if (distance < best) {
      best = distance
      split = i
    }
  }
  const first = entries.slice(0, split)
  const second = entries.slice(split)
  const ratio = first.reduce((sum, entry) => sum + entry.count, 0) / total
  const rMid = (Math.sqrt(rect.v0) + Math.sqrt(rect.v1)) / 2
  const wPx = (rect.u1 - rect.u0) * rMid
  const hPx = Math.sqrt(rect.v1) - Math.sqrt(rect.v0)
  if (wPx >= hPx) {
    const uSplit = rect.u0 + (rect.u1 - rect.u0) * ratio
    splitUV(first, { ...rect, u1: uSplit }, out)
    splitUV(second, { ...rect, u0: uSplit }, out)
  } else {
    const vSplit = rect.v0 + (rect.v1 - rect.v0) * ratio
    splitUV(first, { ...rect, v1: vSplit }, out)
    splitUV(second, { ...rect, v0: vSplit }, out)
  }
}

export function radialTreemap(
  families: ReadonlyArray<VizFamily>,
  opts: { size: number; fontSize?: number; minTileArea?: number },
): RadialTreemapLayout {
  const { size, fontSize = 11, minTileArea = 300 } = opts
  const minLabelFont = Math.max(8.5, fontSize - 2)
  const rIn = size * 0.13
  const rOut = size / 2 - 18
  const ranked = [...families].filter((family) => family.count > 0).sort((a, b) => b.count - a.count)
  const slices = pie<VizFamily>()
    .value((family) => family.count)
    .sort(null)
    .padAngle((1.6 * Math.PI) / 180)(ranked as VizFamily[])
  const tileGen = arc<null>()
  const tiles: RadialTile[] = []
  const famLabels: RadialFamilyLabel[] = []
  for (const slice of slices as Array<PieArcDatum<VizFamily>>) {
    const a0 = slice.startAngle + slice.padAngle / 2
    const a1 = slice.endAngle - slice.padAngle / 2
    if (a1 <= a0) continue
    const family = slice.data
    const famArea = 0.5 * (a1 - a0) * (rOut * rOut - rIn * rIn)
    const named = family.notes.filter((note) => !note.others && note.count > 0).sort((a, b) => b.count - a.count)
    const explicitTail = Math.max(0, family.count - family.notes.reduce((sum, note) => sum + note.count, 0))
      + family.notes.filter((note) => note.others).reduce((sum, note) => sum + note.count, 0)
    let kept = named.filter((note) => famArea * (note.count / family.count) >= minTileArea)
    const initiallyFolded = named.filter((note) => !kept.includes(note))
    let foldedCount = initiallyFolded.reduce((sum, note) => sum + note.count, 0) + explicitTail
    let foldedItems = initiallyFolded.length + family.notes.filter((note) => note.others).length
    let entries: RadialEntry[] = []
    let rects: Array<{ entry: RadialEntry; rect: UVRect }> = []
    // Area alone is not enough: binary treemap splits can still create a long,
    // thin tile whose name cannot fit. Repack after folding the weakest
    // unreadable aroma until every named tile earns its screen space.
    while (true) {
      entries = [
        ...kept.map((note) => ({ label: note.label, displayLabel: note.shortLabel ?? note.label, count: note.count, others: false })),
        ...(foldedCount > 0 ? [{ label: 'Others', displayLabel: `+${Math.max(1, foldedItems)}`, count: foldedCount, others: true }] : []),
      ]
      rects = []
      splitUV(entries, { u0: a0, u1: a1, v0: rIn * rIn, v1: rOut * rOut }, rects)
      const unreadable = rects
        .filter(({ entry }) => !entry.others)
        .filter(({ entry, rect }) => {
          const inner = Math.sqrt(rect.v0)
          const outer = Math.sqrt(rect.v1)
          const rMid = (inner + outer) / 2
          const wPx = (rect.u1 - rect.u0) * rMid
          const hPx = outer - inner
          const textPx = entry.displayLabel.length * minLabelFont * 0.5
          return !(textPx <= wPx - 6 && hPx >= minLabelFont + 5)
            && !(textPx <= hPx - 8 && wPx >= minLabelFont + 3)
        })
      if (unreadable.length === 0 || kept.length === 0) break
      const remove = unreadable.reduce((weakest, current) =>
        current.entry.count < weakest.entry.count ? current : weakest)
      kept = kept.filter((note) => note.label !== remove.entry.label)
      foldedCount += remove.entry.count
      foldedItems++
    }
    if (entries.length === 0) continue
    const famMax = Math.max(1, ...kept.map((note) => note.count))
    for (const { entry, rect } of rects) {
      const inner = Math.sqrt(rect.v0)
      const outer = Math.sqrt(rect.v1)
      const rMid = (inner + outer) / 2
      const uMid = (rect.u0 + rect.u1) / 2
      const wPx = (rect.u1 - rect.u0) * rMid
      const hPx = outer - inner
      const deg = ((uMid * 180) / Math.PI + 360) % 360
      const fitsAt = (candidateSize: number) => {
        const textPx = entry.displayLabel.length * candidateSize * 0.5
        return {
          tangential: textPx <= wPx - 6 && hPx >= candidateSize + 5,
          radial: textPx <= hPx - 8 && wPx >= candidateSize + 3,
        }
      }
      let labelFontSize = fontSize
      let labelFit = fitsAt(labelFontSize)
      while (!labelFit.tangential && !labelFit.radial && labelFontSize > minLabelFont) {
        labelFontSize = Math.max(minLabelFont, labelFontSize - 0.5)
        labelFit = fitsAt(labelFontSize)
      }
      const tangentialFits = labelFit.tangential
      const radialFits = labelFit.radial
      const orientation = tangentialFits ? 'tangential' : 'radial'
      const fits = tangentialFits || radialFits
      const tangentialFlip = deg > 90 && deg < 270
      const radialFlip = deg > 180
      const p = polarXY(0, 0, orientation === 'tangential' ? rMid : inner + 5, uMid)
      tiles.push({
        familyId: family.id,
        label: entry.label,
        count: entry.count,
        others: entry.others,
        pathD: tileGen.innerRadius(inner).outerRadius(outer).cornerRadius(1.5).startAngle(rect.u0).endAngle(rect.u1)(null) ?? '',
        share: entry.others ? 0.2 : 0.62 + 0.38 * Math.sqrt(entry.count / famMax),
        labelText: fits ? entry.displayLabel : null,
        labelFontSize,
        labelX: p.x,
        labelY: p.y,
        labelRotate: orientation === 'tangential' ? (tangentialFlip ? deg + 180 : deg) : (radialFlip ? deg + 90 : deg - 90),
        labelAnchor: orientation === 'tangential' ? 'middle' : radialFlip ? 'end' : 'start',
      })
    }
    const rLabel = rOut + 9
    const midDeg = ((((a0 + a1) / 2) * 180) / Math.PI + 360) % 360
    famLabels.push({
      familyId: family.id,
      outlineD: tileGen.innerRadius(rIn).outerRadius(rOut).cornerRadius(1.5).startAngle(a0).endAngle(a1)(null) ?? '',
      labelPathD: centerlineArc(0, 0, rLabel, a0, a1, midDeg > 90 && midDeg < 270),
      labelText: fitName(family.label, (a1 - a0) * rLabel - 4, fontSize, 0.56),
    })
  }
  return { cx: size / 2, cy: size / 2, rIn, rOut, tiles, famLabels }
}
