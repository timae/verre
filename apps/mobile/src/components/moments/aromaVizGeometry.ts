// Aroma-overview visualization geometry (shared by the production compare
// Aroma Bun and the dev-gallery visual studies; ruled stack: d3-shape math +
// react-native-svg rendering, 2026-07-15). V3 per Simon's feedback round:
// NO numbers anywhere (counts stay in the data for the future tap-reveal),
// name-only fit-gated labels; A = stroked rings with ROUND end caps + the
// centre circle IS "Others"; B = bigger hub (family labels ride inside the
// prominence arc, "Others" on the centre circle), wider bars, labels inside
// the bar when they fit; C = SOLID contiguous segments with UNIFORM separator
// ticks (the junction gradients read as "weird chunks" on device — removed)
// and a clamped tail caption.
//
// PURE and node-importable; pinned by .local/test-env/scripts/aroma-viz-units.ts.
// Outputs are SVG path strings + placements — renderer-agnostic on purpose.
// Angle convention matches d3-shape: 0 at 12 o'clock, increasing CLOCKWISE.

import { arc, pie, type PieArcDatum } from 'd3-shape'

export type VizNote = {
  label: string
  /** Optional compact display copy for dense geometry. The canonical label is
      retained for future inspection/tap copy. */
  shortLabel?: string
  count: number
  others?: boolean
}
export type VizFamily = {
  id: string
  label: string
  count: number
  /** Distinct tasters who touched the family (the B "by tasters" variant). */
  tasters?: number
  notes: VizNote[]
}

const TAU = Math.PI * 2
// Conservative glyph width share of fontSize for fit gates (semibold caption).
const CHAR_EM = 0.62

export function polarXY(cx: number, cy: number, r: number, rad: number): { x: number; y: number } {
  // d3 convention: 0 rad = 12 o'clock, clockwise.
  return { x: cx + Math.sin(rad) * r, y: cy - Math.cos(rad) * r }
}

// A centerline arc path (stroked bands + TextPath labels) in the d3 angle
// convention. `reverse` flips the draw direction so bottom-half text reads
// upright.
export function centerlineArc(cx: number, cy: number, r: number, startRad: number, endRad: number, reverse = false): string {
  const pt = (rad: number) => polarXY(cx, cy, r, rad)
  const piece = (a: number, b: number, sweepFlag: 0 | 1): string => {
    const to = pt(b)
    return `A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweepFlag} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`
  }
  const a = reverse ? endRad : startRad
  const b = reverse ? startRad : endRad
  const flag: 0 | 1 = reverse ? 0 : 1
  const from = pt(a)
  const sweep = Math.abs(endRad - startRad)
  if (sweep > Math.PI) {
    const mid = (a + b) / 2
    return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} ${piece(a, mid, flag)} ${piece(mid, b, flag)}`
  }
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} ${piece(a, b, flag)}`
}

// Name-only fit gate (no numbers on the visualisations — Simon's round-3
// ruling; counts remain in the layout data for the future tap-reveal).
// `em` tunes the estimate per surface — ring labels use a slightly tighter
// 0.56 (round 7: "Blackcurrant" was gated off a segment it visually fits).
function fitName(label: string, slotPx: number, fontSize: number, em = CHAR_EM): string | null {
  return label.length * fontSize * em <= slotPx * 0.92 ? label : null
}

function labelNeedPx(label: string, fontSize: number, em = CHAR_EM): number {
  return (label.length * fontSize * em) / 0.92
}

// ── 1 · Ranked concentric family rings (segmented, round-capped) ─────────────
// One STROKED ring per leading family, strongest outermost, growing clockwise
// from 12 o'clock. The caller can compare families by shared physical length
// or spend near-full rings on their internal aroma composition while radius
// carries rank. Tiny nub arcs give every row pill ends. The CENTRE CIRCLE is
// the aggregated family remainder — "Others".

export type RingSegment = {
  label: string
  count: number
  others: boolean
  /** Arc length in px (pinned: unlabelled named segments are ≥ 14). */
  spanPx: number
  /** Centerline path — stroke at layout.thickness, butt caps. */
  arcD: string
  labelPathD: string
  labelText: string | null
}
export type RingSeparator = { x1: number; y1: number; x2: number; y2: number }
export type RingLayout = {
  familyId: string
  familyLabel: string
  count: number
  r: number
  sweepDeg: number
  segments: RingSegment[]
  /** STRAIGHT radial cuts at internal segment boundaries (angular gaps between
      stroked arcs read as slivers whose edges diverge — Simon round 5). */
  separators: RingSeparator[]
  /** Tiny start/end nub arcs — stroke with round caps for the pill ends. */
  capStartD: string
  capEndD: string
  /** Empty physical space reserved for the straight family name. */
  familyGapPx: number
  /** Retained for geometry inspection; the renderer uses straight labels. */
  familyLabelPathD: string
  /** Horizontal family-label coordinates beside the 12-o'clock origin. */
  originX: number
  originY: number
  originAnchor: 'start' | 'end'
}
export type ConcentricRingsLayout = {
  cx: number
  cy: number
  rings: RingLayout[]
  /** The centre circle IS Others (aggregated omitted families); null if none. */
  othersDisc: { r: number; count: number; familyCount: number } | null
  thickness: number
}

export function concentricRings(
  families: ReadonlyArray<VizFamily>,
  opts: {
    size: number
    maxRings?: number
    fontSize?: number
    originDeg?: number
    maxSweepDeg?: number
    thicknessPx?: number
    gapPx?: number
    /** `length` compares physical arc length; `angle` uses one common angular
        scale so inner circumference never drops a family; `hierarchy` gives
        the leading families near-full rings and lets radius carry rank. */
    mode?: 'length' | 'angle' | 'hierarchy'
    hierarchyStepDeg?: number
  },
): ConcentricRingsLayout {
  // originDeg rotates the shared start (0 = 12 o'clock; the bottom variant
  // starts at ~7 o'clock = 210). maxSweepDeg caps the longest ring; the study
  // defaults to 313.2° (87%), leaving a generous family-label notch.
  // thicknessPx/gapPx are the round-6 SLIDER overrides — the ring count then
  // adapts: fatter rows or wider gaps may cost a ring (auto-fit), gap 0 is
  // the "no space between arcs" version.
  const {
    size,
    maxRings = 6,
    fontSize = 11,
    originDeg = 0,
    maxSweepDeg = 313.2,
    thicknessPx,
    gapPx,
    mode = 'length',
    hierarchyStepDeg = 4,
  } = opts
  const originRad = (originDeg * Math.PI) / 180
  const cx = size / 2
  const cy = size / 2
  const ranked = [...families].sort((a, b) => b.count - a.count)

  const outerR = size * 0.46
  const thickness = thicknessPx ?? Math.min(16, (size * 0.33) / Math.max(1, Math.min(maxRings, ranked.length)))
  const gap = gapPx ?? thickness * 0.19
  // Auto-fit: only as many rings as the radial span allows above a minimum
  // core (the Others disc needs a home).
  const MIN_CORE = 30
  const pitch = thickness + gap
  const fitCount = Math.max(1, Math.floor((outerR - thickness / 2 - MIN_CORE + gap) / pitch))
  const radiusAt = (rank: number) => outerR - rank * pitch - thickness / 2

  // LENGTH mode uses a shared mentions→physical-length scale, capped at the
  // 87% safety notch instead of deleting an otherwise usable inner ring.
  // ANGLE uses count/maxCount × max sweep independent of radius. HIERARCHY
  // spends near-full rings on composition; radius carries rank.
  const MAX_SWEEP = (maxSweepDeg * Math.PI) / 180
  const r0Ring = radiusAt(0)
  const scale = ranked.length ? (MAX_SWEEP * r0Ring) / ranked[0].count : 1
  const shown: VizFamily[] = []
  let othersCount = 0
  let othersFamilyCount = 0
  for (const family of ranked) {
    const overCap = shown.length >= Math.min(maxRings, fitCount)
    if (overCap) {
      othersCount += family.count
      othersFamilyCount += 1
      continue
    }
    shown.push(family)
  }

  // One shared physical reservation, sized for the longest shown family name.
  // The equivalent ANGLE is therefore larger on an inner ring, exactly like a
  // fixed-width label cut out of concentric circles.
  const longestFamilyLabel = shown.reduce((longest, family) => family.label.length > longest.length ? family.label : longest, '')
  const familyLabelWidth = labelNeedPx(longestFamilyLabel, fontSize, 0.56)

  const rings = shown.map((family, rank): RingLayout => {
    const r = radiusAt(rank)
    const hierarchySweep = Math.max(0, maxSweepDeg - rank * hierarchyStepDeg) * Math.PI / 180
    const requestedSweep = mode === 'hierarchy'
      ? Math.min(hierarchySweep, MAX_SWEEP)
      : mode === 'angle'
        ? MAX_SWEEP * (family.count / Math.max(1, ranked[0].count))
        : Math.min((scale * family.count) / r, MAX_SWEEP)
    const normOrigin = ((originDeg % 360) + 360) % 360
    const bottomish = normOrigin > 90 && normOrigin < 270
    const originOffset = thickness / 2 + 9
    const familyGapPx = familyLabelWidth + originOffset + 6
    const sweepRad = Math.min(requestedSweep, Math.max(0, TAU - familyGapPx / r))
    // Readability-capacity rule: keep the largest count-ranked prefix whose
    // compact names all fit. The raw tail count stays truthful for inspection,
    // but its DRAWN span is capped in physical pixels — the overview spends its scarce
    // circumference on recognisable aromas, not a dominant anonymous tail.
    const named = family.notes.filter((note) => !note.others).sort((a, b) => b.count - a.count)
    const explicitTail = Math.max(0, family.count - family.notes.reduce((n, note) => n + note.count, 0))
      + family.notes.filter((note) => note.others).reduce((n, note) => n + note.count, 0)
    let keep = [...named]
    const allocation = () => {
      const omitted = named.filter((note) => !keep.includes(note)).reduce((n, note) => n + note.count, 0)
      const tail = explicitTail + omitted
      const namedCount = keep.reduce((n, note) => n + note.count, 0)
      const rawTailShare = tail / Math.max(1, namedCount + tail)
      const ringLength = sweepRad * r
      const compactTailWidth = labelNeedPx(`+${tail}`, fontSize, 0.54) + 4
      const tailPx = tail > 0 ? Math.min(112, Math.max(compactTailWidth, ringLength * rawTailShare)) : 0
      const tailShare = Math.min(1, tailPx / Math.max(1, ringLength))
      return { tail, namedCount, tailShare }
    }
    while (keep.length > 0) {
      const { namedCount, tailShare } = allocation()
      const namedSweep = sweepRad * (1 - tailShare)
      const allFit = keep.every((note) => {
        const displayLabel = note.shortLabel ?? note.label
        return fitName(displayLabel, namedSweep * (note.count / Math.max(1, namedCount)) * r, fontSize, 0.54) !== null
      })
      if (allFit) break
      keep = keep.slice(0, -1)
    }
    const { tail, namedCount, tailShare } = allocation()
    const parts = [
      ...keep.map((note) => ({
        label: note.label,
        displayLabel: note.shortLabel ?? note.label,
        count: note.count,
        others: false,
        visualShare: (1 - tailShare) * (note.count / Math.max(1, namedCount)),
      })),
      ...(tail > 0 ? [{ label: 'Others', displayLabel: 'Others', count: tail, others: true, visualShare: keep.length > 0 ? tailShare : 1 }] : []),
    ]
    // CONTIGUOUS segments + straight radial cuts at the boundaries (angular
    // gaps between stroked arcs read as diverging slivers — round 5).
    // Every data arc begins at the selected origin (12 o'clock for From Top).
    // The family name gets the empty remainder AFTER the arc; it never moves
    // the data origin and never sits over a pale Others segment.
    const drawOriginRad = originRad
    let cursor = 0
    const boundaries: number[] = []
    const segments = parts.map((part, i): RingSegment => {
      const span = sweepRad * part.visualShare
      const s = cursor + drawOriginRad
      cursor += span
      const e = cursor + drawOriginRad
      if (i < parts.length - 1) boundaries.push(e)
      const midDeg = ((((s + e) / 2) * 180) / Math.PI + 360) % 360
      const bottom = midDeg > 90 && midDeg < 270
      const slotPx = (e - s) * r
      const labelText = part.others
        ? fitName(`+${part.count} Others`, slotPx, fontSize, 0.54) ?? fitName(`+${part.count}`, slotPx, fontSize, 0.54)
        : fitName(part.displayLabel, slotPx, fontSize, 0.54)
      return {
        label: part.label,
        count: part.count,
        others: part.others,
        spanPx: slotPx,
        arcD: centerlineArc(0, 0, r, s, e),
        labelPathD: centerlineArc(0, 0, r, s, e, bottom),
        labelText,
      }
    })
    const separators = boundaries.map((rad): RingSeparator => {
      const inner = polarXY(0, 0, r - thickness / 2 - 1, rad)
      const outer = polarXY(0, 0, r + thickness / 2 + 1, rad)
      return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y }
    })
    const nub = 0.6 / r
    // The origin label sits at the ring's start point, offset horizontally
    // into the free notch (anti-clockwise of the origin), beyond the cap.
    const base = polarXY(0, 0, r, originRad)
    const familyGapStart = drawOriginRad + sweepRad + 2 / r
    const familyGapEnd = drawOriginRad + TAU - 2 / r
    const familyGapMidDeg = ((((familyGapStart + familyGapEnd) / 2) * 180) / Math.PI + 360) % 360
    return {
      familyId: family.id,
      familyLabel: family.label,
      count: family.count,
      r,
      sweepDeg: (sweepRad * 180) / Math.PI,
      segments,
      separators,
      capStartD: centerlineArc(0, 0, r, drawOriginRad, drawOriginRad + nub),
      capEndD: centerlineArc(0, 0, r, drawOriginRad + sweepRad - nub, drawOriginRad + sweepRad),
      familyGapPx,
      familyLabelPathD: centerlineArc(0, 0, r, familyGapStart, familyGapEnd, familyGapMidDeg > 90 && familyGapMidDeg < 270),
      originX: base.x + (bottomish ? originOffset : -originOffset),
      originY: base.y + fontSize * 0.35,
      originAnchor: bottomish ? 'start' : 'end',
    }
  })
  const innermost = rings.length ? rings[rings.length - 1].r - thickness / 2 : outerR
  const discR = Math.max(14, innermost - gap - 5)
  return { cx, cy, rings, othersDisc: othersCount > 0 ? { r: discR, count: othersCount, familyCount: othersFamilyCount } : null, thickness }
}

// ── 2 · Weighted grouped polar WEDGES ────────────────────────────────────────
// The Stalder circular-barplot form (Simon's reference, unnamed-chunk-8-1.png):
// families claim ANGULAR SECTORS proportional to prominence (d3 pie, ranked
// order); inside a sector each aroma is a WEDGE — an annular sector filling
// its equal angular slot (wedges partition the angle, so bars can never
// collide) — whose OUTER RADIUS grows with its count. The global strongest
// wedge reaches the rim minus a safety margin; everything scales relative to
// it. The hub is big: the family name rides INSIDE its prominence arc and the
// centre circle is "Others". Labels stay inside their bars; non-fitting names
// fold into the centre Others total. No gridlines or perimeter callouts.

export type PolarWedge = {
  familyId: string
  label: string
  labelText: string | null
  count: number
  others: boolean
  angleDeg: number
  /** Radial length (outerR − innerR − 3) — pinned proportional to count. */
  len: number
  /** Filled annular-sector path. */
  wedgeD: string
  /** Current ruled study keeps every rendered label inside its bar. */
  labelInside: boolean
  labelOrientation: 'radial' | 'tangential'
  labelX: number
  labelY: number
  /** SVG rotation for radial or tangential in-bar text. */
  labelRotate: number
  labelAnchor: 'start' | 'middle' | 'end'
}
export type PolarSector = {
  familyId: string
  familyLabel: string
  startDeg: number
  endDeg: number
  guideD: string
  /** TextPath INSIDE the prominence arc (upright on the bottom half). */
  labelPathD: string
  labelText: string | null
}
export type WeightedPolarLayout = { cx: number; cy: number; innerR: number; maxLen: number; sectors: PolarSector[]; wedges: PolarWedge[]; othersCount: number }

// Sector weighting (Simon round 5, three variants):
// - 'mentions': sector ∝ the family's total mentions (V1).
// - 'equal':    every AROMA the same angular width → the sector simply grows
//               with its number of aromas; wedge height carries mentions (V2).
// - 'tasters':  sector ∝ how many distinct tasters touched the family (V3).
export type PolarMode = 'mentions' | 'equal' | 'tasters'

export function weightedPolar(
  families: ReadonlyArray<VizFamily>,
  opts: { size: number; padDeg?: number; fontSize?: number; mode?: PolarMode; maxFamilies?: number },
): WeightedPolarLayout {
  // Round 8: only the most relevant families claim sectors (the centre circle
  // is Others anyway); callers pass ranked data, we keep the head.
  const { size, padDeg = 6, fontSize = 11, mode = 'equal', maxFamilies = 6 } = opts
  const omittedFamilyCount = families.slice(maxFamilies).reduce((sum, family) => sum + family.count, 0)
  let othersCount = omittedFamilyCount
  families = families.slice(0, maxFamilies)
  const cx = size / 2
  const cy = size / 2
  const innerR = size * 0.19
  const maxLen = size / 2 - 9 - innerR - 6
  const maxNote = Math.max(1, ...families.flatMap((f) => f.notes.filter((note) => !note.others).map((note) => note.count)))
  const WEDGE_PAD = (1.1 * Math.PI) / 180
  // Choose the labelled overview before allocating sectors. In particular,
  // Equal Wedges must count bars that survive, not hidden aromas already
  // folded into the centre — otherwise one Floral bar can inherit the width
  // of an entire invisible family list.
  const LABEL_BUDGET = 18
  const budgetCandidates = families
    .flatMap((f) => f.notes.filter((n) => !n.others).map((n) => ({ f: f.id, l: n.label, c: n.count })))
    .sort((x, y) => y.c - x.c)
  const budgetKeys: string[] = []
  for (const family of families) {
    const first = budgetCandidates.find((candidate) => candidate.f === family.id)
    if (first) budgetKeys.push(`${first.f}|${first.l}`)
  }
  for (const candidate of budgetCandidates) {
    const key = `${candidate.f}|${candidate.l}`
    if (!budgetKeys.includes(key)) budgetKeys.push(key)
    if (budgetKeys.length >= LABEL_BUDGET) break
  }
  const budgetSet = new Set(budgetKeys)
  const weight = (f: VizFamily): number =>
    mode === 'equal'
      ? Math.max(1, f.notes.filter((note) => !note.others && budgetSet.has(`${f.id}|${note.label}`)).length)
      : mode === 'tasters'
        ? f.tasters ?? f.count
        : f.count
  const slices = pie<VizFamily>()
    .value(weight)
    .sort(null) // keep the caller's ranked order
    .padAngle((padDeg * Math.PI) / 180)(families as VizFamily[])
  const sectors = slices.map((s: PieArcDatum<VizFamily>): PolarSector => {
    const a0 = s.startAngle + s.padAngle / 2
    const a1 = s.endAngle - s.padAngle / 2
    const midDeg = ((((a0 + a1) / 2) * 180) / Math.PI + 360) % 360
    // Round 6: the family line hugs the tiles (gap 4) and its name sits just
    // inside it — the hub stops eating labelling space.
    const labelR = innerR - 13
    return {
      familyId: s.data.id,
      familyLabel: s.data.label,
      startDeg: (s.startAngle * 180) / Math.PI,
      endDeg: (s.endAngle * 180) / Math.PI,
      guideD: centerlineArc(cx, cy, innerR - 4, a0, a1),
      labelPathD: centerlineArc(cx, cy, labelR, a0, a1, midDeg > 90 && midDeg < 270),
      labelText: fitName(s.data.label, (a1 - a0) * labelR, fontSize),
    }
  })
  // Every shown label must fit in its own bar; the rest merge into the centre
  // Others total rather than leaving blank or anonymous perimeter wedges.
  const wedgeGen = arc<null>()
  const wedges = slices.flatMap((s: PieArcDatum<VizFamily>): PolarWedge[] => {
    const a0 = s.startAngle + s.padAngle / 2
    const a1 = s.endAngle - s.padAngle / 2
    const namedAll = s.data.notes.filter((n) => !n.others).sort((x, y) => y.count - x.count)
    const remainder = s.data.notes.filter((n) => n.others).reduce((n, x) => n + x.count, 0)
    const maxNotes = Math.max(1, Math.floor((a1 - a0) / (11 / (innerR + 3))))
    let visible = namedAll.filter((n) => budgetSet.has(`${s.data.id}|${n.label}`))
    for (let pass = 0; pass <= namedAll.length; pass++) {
      const slots = Math.max(1, visible.length)
      if (slots > maxNotes) {
        visible = visible.slice(0, maxNotes)
        continue
      }
      const slot = (a1 - a0) / slots
      const fitting = visible.map((note, i) => {
        const w0 = a0 + slot * i + (i > 0 ? WEDGE_PAD / 2 : 0)
        const w1 = a0 + slot * (i + 1) - (i < slots - 1 ? WEDGE_PAD / 2 : 0)
        const len = Math.max(8, maxLen * (note.count / maxNote))
        const widthPx = (w1 - w0) * (innerR + 3 + len / 2)
        const displayLabel = note.shortLabel ?? note.label
        const textPx = displayLabel.length * fontSize * 0.5
        const radialFits = textPx <= len - 8 && widthPx >= fontSize + 3
        const tangentialFits = textPx <= widthPx - 6 && len >= fontSize + 6
        return { note, fits: radialFits || tangentialFits }
      })
      if (fitting.every((candidate) => candidate.fits)) break
      // Preserve a strict count-ranked prefix. A lower-count short word must
      // never replace a stronger aroma merely because it is easier to typeset.
      visible = visible.slice(0, -1)
    }
    const foldedNamed = namedAll.filter((n) => !visible.includes(n))
    const foldCount = foldedNamed.reduce((n, x) => n + x.count, 0) + remainder
    othersCount += foldCount
    const notes: VizNote[] = visible
    if (notes.length === 0) return []
    const slot = (a1 - a0) / notes.length
    return notes.map((note, i): PolarWedge => {
      const w0 = a0 + slot * i + (i > 0 ? WEDGE_PAD / 2 : 0)
      const w1 = a0 + slot * (i + 1) - (i < notes.length - 1 ? WEDGE_PAD / 2 : 0)
      const rad = (w0 + w1) / 2
      const len = Math.max(8, maxLen * (note.count / maxNote))
      const outerR = innerR + 3 + len
      const deg = ((rad * 180) / Math.PI + 360) % 360
      const wedgeD = wedgeGen
        .innerRadius(innerR + 3)
        .outerRadius(outerR)
        .cornerRadius(2)
        .startAngle(w0)
        .endAngle(w1)(null) ?? ''
      const displayLabel = note.shortLabel ?? note.label
      const widthPx = (w1 - w0) * (innerR + 3 + len / 2)
      const textPx = displayLabel.length * fontSize * 0.5
      const radialFits = textPx <= len - 8 && widthPx >= fontSize + 3
      const tangentialFits = textPx <= widthPx - 6 && len >= fontSize + 6
      const radialFlip = deg > 180
      const tangentialFlip = deg > 90 && deg < 270
      const orientation = radialFits ? 'radial' : 'tangential'
      const p = polarXY(cx, cy, orientation === 'radial' ? innerR + 9 : innerR + 3 + len / 2, rad)
      return {
        familyId: s.data.id, label: note.label, count: note.count, others: !!note.others, angleDeg: deg, len, wedgeD,
        labelText: radialFits || tangentialFits ? displayLabel : null,
        labelInside: true,
        labelOrientation: orientation,
        labelX: p.x,
        labelY: p.y,
        labelRotate: orientation === 'radial' ? (radialFlip ? deg + 90 : deg - 90) : (tangentialFlip ? deg + 180 : deg),
        labelAnchor: orientation === 'radial' ? (radialFlip ? 'end' : 'start') : 'middle',
      }
    })
  })
  // If a family cannot produce even one readable bar, remove its now-empty
  // sector and lay the remaining sectors out again. This prevents a broad
  // Floral (or any other) sector from surviving after all of its aromas have
  // moved into the centre.
  const represented = new Set(wedges.map((wedge) => wedge.familyId))
  const emptyFamilies = families.filter((family) => !represented.has(family.id))
  if (emptyFamilies.length > 0 && emptyFamilies.length < families.length) {
    const rerun = weightedPolar(families.filter((family) => represented.has(family.id)), opts)
    return {
      ...rerun,
      othersCount: rerun.othersCount + omittedFamilyCount + emptyFamilies.reduce((sum, family) => sum + family.count, 0),
    }
  }
  return { cx, cy, innerR, maxLen, sectors, wedges, othersCount }
}

// ── 3 · Readable proportional mosaic ───────────────────────────────────────
// Family mode is a proportional treemap and never removes a represented
// family. Aroma mode is columnar: family share owns the column width, aroma
// share owns height inside it, and unreadable tails fold into bounded Others.

export type MosaicMode = 'aromas' | 'family'
export type MosaicTile = {
  key: string
  label: string
  labelText: string | null
  count: number
  familyId: string
  others: boolean
  labelOrientation: 'horizontal' | 'vertical'
  labelFontSize: number
  x: number
  y: number
  w: number
  h: number
}
export type MosaicLayout = { width: number; height: number; tiles: MosaicTile[]; othersCount: number }

type MosaicEntry = {
  key: string
  label: string
  displayLabel: string
  count: number
  familyId: string
  others: boolean
  weight: number
}

function binaryMosaicRects(
  entries: ReadonlyArray<MosaicEntry>,
  x: number,
  y: number,
  w: number,
  h: number,
  out: Array<{ entry: MosaicEntry; x: number; y: number; w: number; h: number }>,
): void {
  if (entries.length === 0) return
  if (entries.length === 1) {
    out.push({ entry: entries[0], x, y, w, h })
    return
  }
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0) || 1
  let leftTotal = 0
  let split = 1
  let best = Infinity
  for (let i = 1; i < entries.length; i++) {
    leftTotal += entries[i - 1].weight
    const distance = Math.abs(total / 2 - leftTotal)
    if (distance < best) {
      best = distance
      split = i
    }
  }
  const first = entries.slice(0, split)
  const second = entries.slice(split)
  const ratio = first.reduce((sum, entry) => sum + entry.weight, 0) / total
  if (w >= h) {
    const firstW = w * ratio
    binaryMosaicRects(first, x, y, firstW, h, out)
    binaryMosaicRects(second, x + firstW, y, w - firstW, h, out)
  } else {
    const firstH = h * ratio
    binaryMosaicRects(first, x, y, w, firstH, out)
    binaryMosaicRects(second, x, y + firstH, w, h - firstH, out)
  }
}

function mosaicLabelFit(
  label: string,
  w: number,
  h: number,
  fontSize: number,
  allowShrink = false,
): { orientation: 'horizontal' | 'vertical'; fontSize: number } | null {
  const minimum = allowShrink ? 8 : fontSize
  for (let size = fontSize; size >= minimum; size -= 1) {
    const textWidth = labelNeedPx(label, size, 0.56)
    if (textWidth <= w - 10 && size + 10 <= h) return { orientation: 'horizontal', fontSize: size }
    if (textWidth <= h - 10 && size + 10 <= w) return { orientation: 'vertical', fontSize: size }
  }
  return null
}

export function aromaMosaic(
  families: ReadonlyArray<VizFamily>,
  opts: { width: number; height: number; fontSize?: number; mode?: MosaicMode; maxOthersShare?: number },
): MosaicLayout {
  const { width, height, fontSize = 11, mode = 'aromas', maxOthersShare = 0.12 } = opts
  const familyEntries: MosaicEntry[] = families.map((family) => ({
    key: family.id,
    label: family.label,
    displayLabel: family.label,
    count: family.count,
    familyId: family.id,
    others: false,
    weight: family.count,
  }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const GAP = 2
  if (mode === 'family') {
    const rects: Array<{ entry: MosaicEntry; x: number; y: number; w: number; h: number }> = []
    binaryMosaicRects(familyEntries, 0, 0, width, height, rects)
    const tiles = rects.map(({ entry, x, y, w, h }): MosaicTile => {
      const tileW = Math.max(0, w - GAP)
      const tileH = Math.max(0, h - GAP)
      const fit = mosaicLabelFit(entry.displayLabel, tileW, tileH, fontSize, true)
      return {
        key: entry.key,
        label: entry.label,
        labelText: entry.displayLabel,
        count: entry.count,
        familyId: entry.familyId,
        others: false,
        labelOrientation: fit?.orientation ?? 'vertical',
        labelFontSize: fit?.fontSize ?? 8,
        x: x + GAP / 2,
        y: y + GAP / 2,
        w: tileW,
        h: tileH,
      }
    })
    return { width, height, tiles, othersCount: 0 }
  }

  // Aroma mode is explicitly columnar: every family owns a width equal to its
  // share of all mentions, then its readable aromas partition that height.
  const familyTotal = families.reduce((sum, family) => sum + family.count, 0) || 1
  const tiles: MosaicTile[] = []
  let x = 0
  let allOthers = 0
  for (const family of families) {
    const columnW = width * (family.count / familyTotal)
    const named = family.notes.filter((note) => !note.others && note.count > 0).sort((a, b) => b.count - a.count)
    const explicitOthers = Math.max(0, family.count - family.notes.reduce((sum, note) => sum + note.count, 0))
      + family.notes.filter((note) => note.others).reduce((sum, note) => sum + note.count, 0)
    let selectedRects: Array<{ note: VizNote; y: number; h: number; fit: { orientation: 'horizontal' | 'vertical'; fontSize: number } }> = []
    let selectedTail = family.count
    let selectedTailH = height

    for (let count = named.length; count >= 1; count--) {
      const visible = named.slice(0, count)
      const visibleCount = visible.reduce((sum, note) => sum + note.count, 0)
      const omitted = explicitOthers + named.slice(count).reduce((sum, note) => sum + note.count, 0)
      const rawTailShare = omitted / Math.max(1, visibleCount + omitted)
      const tailShare = omitted > 0 ? Math.min(maxOthersShare, rawTailShare) : 0
      const namedH = height * (1 - tailShare)
      let cursorY = 0
      const rects = visible.map((note) => {
        const h = namedH * (note.count / Math.max(1, visibleCount))
        const fit = mosaicLabelFit(note.shortLabel ?? note.label, columnW - GAP, h - GAP, fontSize)
        const rect = { note, y: cursorY, h, fit }
        cursorY += h
        return rect
      })
      if (rects.every((rect) => rect.fit !== null)) {
        selectedRects = rects as typeof selectedRects
        selectedTail = omitted
        selectedTailH = height * tailShare
        break
      }
    }

    for (const rect of selectedRects) {
      tiles.push({
        key: `${family.id}|${rect.note.label}|${rect.y}`,
        label: rect.note.label,
        labelText: rect.note.shortLabel ?? rect.note.label,
        count: rect.note.count,
        familyId: family.id,
        others: false,
        labelOrientation: rect.fit.orientation,
        labelFontSize: rect.fit.fontSize,
        x: x + GAP / 2,
        y: rect.y + GAP / 2,
        w: Math.max(0, columnW - GAP),
        h: Math.max(0, rect.h - GAP),
      })
    }
    if (selectedTail > 0) {
      const tileW = Math.max(0, columnW - GAP)
      const tileH = Math.max(0, selectedTailH - GAP)
      const full = `+${selectedTail} Others`
      const compact = `+${selectedTail}`
      const fullFit = mosaicLabelFit(full, tileW, tileH, fontSize)
      const compactFit = fullFit ?? mosaicLabelFit(compact, tileW, tileH, fontSize)
      tiles.push({
        key: `${family.id}|others`,
        label: 'Others',
        labelText: fullFit ? full : compactFit ? compact : null,
        count: selectedTail,
        familyId: family.id,
        others: true,
        labelOrientation: compactFit?.orientation ?? 'vertical',
        labelFontSize: compactFit?.fontSize ?? fontSize,
        x: x + GAP / 2,
        y: height - selectedTailH + GAP / 2,
        w: tileW,
        h: tileH,
      })
      allOthers += selectedTail
    }
    x += columnW
  }

  return { width, height, tiles, othersCount: allOthers }
}

// ── 4 · Proportional spiral ribbon (tight coil, solid segments) ──────────────
// A continuous badge-height ribbon coiling centre → out, adjacent turns
// touching, the start curling the centre closed. SOLID per-segment colour —
// the earlier junction gradients read as smeared "chunks" on device — with
// UNIFORM separator ticks at every boundary (short bg-coloured cuts), so
// where an aroma starts and ends is always visible. Segment length is
// ARC-LENGTH-proportional to mentions; name-only labels ride the ribbon,
// upright on the bottom half. The aggregated remainder is the grey outer tail.

export type SpiralSegment = {
  label: string
  displayLabel: string
  count: number
  familyId: string
  others: boolean
  tStart: number
  tEnd: number
  /** Drawn arc length. Others is deliberately display-capped. */
  spanPx: number
  /** Centreline retained for labels, caps and regression diagnostics. */
  pathD: string
  /** Filled ribbon polygon. Adjacent segments share exact edge endpoints. */
  bandD: string
  labelPathD: string
  labelText: string | null
  /** Colour-fade vector for the LAST few px before the next segment: own
      colour at (x1,y1) → the MIDPOINT blend at the cut (x2,y2). Absent on the
      last segment. */
  fade?: { pathD: string; bandD: string; x1: number; y1: number; x2: number; y2: number; nextFamilyId: string; nextOthers: boolean }
  /** The mirror fade AFTER the cut (round 5: the transition sits on BOTH
      sides): a short overlay path over the segment's first few px, blending
      the midpoint colour back into the segment's own. Absent on the first. */
  fadeIn?: { pathD: string; bandD: string; x1: number; y1: number; x2: number; y2: number; prevFamilyId: string; prevOthers: boolean }
}
export type SpiralSeparator = {
  /** Straight parallel-sided rectangle. */
  pathD: string
  /** Small local ribbon clip preventing the rectangle reaching another turn. */
  clipD: string
}
/** Classic data-viz callout for an outer-turn segment too small to hold its
    name: ribbon edge → radial elbow → horizontal to the label (round 6). */
export type SpiralCallout = {
  label: string
  px: number; py: number
  ex: number; ey: number
  lx: number; ly: number
  anchor: 'start' | 'end'
}
export type SpiralLayout = {
  cx: number
  cy: number
  segments: SpiralSegment[]
  /** Parallel-sided rectangles clipped to their own local ribbon turn. */
  separators: SpiralSeparator[]
  /** Tiny centreline nubs for round caps at the coil's start + tail (the
      filled segment polygons themselves end flat at those two boundaries). */
  capStartD: string
  capEndD: string
  ribbon: number
  separatorWidth: number
  /** Where the coil's tail points (degrees, d3 convention) — snapped to 30°
      (1 o'clock) or 210° (7 o'clock) for optimal width use (Simon round 7). */
  endDeg: number
  /** Outer-turn small-segment callouts (only when opts.callouts). */
  callouts: SpiralCallout[]
  /** Content bounding box (ribbon edges + caps + callout room) — set the Svg
      viewBox to this so the coil fills the available WIDTH; height is cheap. */
  bbox: { x: number; y: number; w: number; h: number }
  /** Family ids actually visible on the coil (legend shows only these). */
  representedFamilyIds: string[]
}

export function spiralRibbon(
  notes: ReadonlyArray<VizNote & { familyId: string }>,
  othersCount: number,
  opts: { size: number; ribbon?: number; fontSize?: number; callouts?: boolean; fadePx?: number; labelPaddingPx?: number },
): SpiralLayout {
  const {
    size,
    ribbon: ribbonWanted = 24,
    fontSize = 11,
    callouts: wantCallouts = false,
    fadePx = 14,
    labelPaddingPx = 6,
  } = opts
  const cx = size / 2
  const cy = size / 2
  const r1 = size * 0.47
  // Turn count SNAPS so the tail lands at 1 o'clock (30°) or 7 o'clock (210°)
  // — Simon round 7: the freed corner is where the canvas breathes; pick the
  // larger snapped turn count (more winds). Ribbon re-derives from the pitch.
  // OPEN START (round 9 — taper + disc tried and ruled failures): the
  // tightest central curl is removed, the ribbon opens on a small empty
  // centre with a clean round cap.
  const pitchGuess = ribbonWanted + 2
  const r0Guess = pitchGuess * 1.45
  const rawTurns = (r1 - r0Guess) / pitchGuess
  const candidates = [1 / 12, 7 / 12].map((frac) => {
    const k = Math.floor(rawTurns + 0.1 - frac)
    return k + frac
  })
  const turns = Math.max(1 + 7 / 12, ...candidates.filter((t) => t <= rawTurns + 0.1))
  const pitch = (r1 - r0Guess) / turns
  const r0 = r0Guess
  const ribbon = pitch - 2
  const point = (t: number) => polarXY(cx, cy, r0 + (r1 - r0) * t, t * TAU * turns)
  const SAMPLES = 900
  const pts = Array.from({ length: SAMPLES }, (_, i) => point(i / (SAMPLES - 1)))
  const lens = [0]
  for (let i = 1; i < SAMPLES; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const totalLen = lens[SAMPLES - 1]
  const tAtLen = (target: number): number => {
    const goal = Math.max(0, Math.min(totalLen, target))
    let lo = 0
    let hi = SAMPLES - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lens[mid] < goal) lo = mid + 1; else hi = mid }
    if (lo === 0) return 0
    const span = lens[lo] - lens[lo - 1] || 1
    return (lo - 1 + (goal - lens[lo - 1]) / span) / (SAMPLES - 1)
  }
  const seg = (a: number, b: number, reverse = false): string => {
    const n = Math.max(8, Math.ceil((b - a) * 300))
    const p = Array.from({ length: n }, (_, i) => point(a + ((b - a) * i) / (n - 1)))
    if (reverse) p.reverse()
    return p.map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(' ')
  }
  // A real filled ribbon, not a thick centreline stroke. The analytic normal
  // makes every segment boundary use the exact same inner/outer points; a
  // dense shared sampling removes the faceted top/bottom edges visible when
  // independently stroked M/L segments met.
  const frameAt = (t: number) => {
    const theta = t * TAU * turns
    const r = r0 + (r1 - r0) * t
    const dr = r1 - r0
    const dTheta = TAU * turns
    const dx = dr * Math.sin(theta) + r * Math.cos(theta) * dTheta
    const dy = -dr * Math.cos(theta) + r * Math.sin(theta) * dTheta
    const norm = Math.hypot(dx, dy) || 1
    const tx = dx / norm
    const ty = dy / norm
    const nx = -dy / norm
    const ny = dx / norm
    return { x: cx + Math.sin(theta) * r, y: cy - Math.cos(theta) * r, tx, ty, nx, ny }
  }
  const edgePoint = (t: number, side: -1 | 1): { x: number; y: number } => {
    const frame = frameAt(t)
    return { x: frame.x + frame.nx * side * ribbon / 2, y: frame.y + frame.ny * side * ribbon / 2 }
  }
  const band = (a: number, b: number): string => {
    const n = Math.max(4, Math.ceil((b - a) * 1200) + 1)
    const ts = Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
    const first = ts.map((t) => edgePoint(t, 1))
    const second = [...ts].reverse().map((t) => edgePoint(t, -1))
    return [...first, ...second]
      .map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(2)} ${q.y.toFixed(2)}`)
      .join(' ') + ' Z'
  }

  // INDIVIDUAL-AROMA overview: use the largest strict count-ranked prefix
  // whose compact names ALL fit on the ribbon. Drawing dozens of anonymous
  // coloured slivers technically exposed more rows but made the overview
  // unreadable. Omitted data remains truthful in the Others count, while the
  // Others DRAWING is capped so it cannot consume the useful spiral.
  const rankedAll = [...notes].filter((note) => note.count > 0).sort((a, b) => b.count - a.count)
  const rankedCount = rankedAll.reduce((n, note) => n + note.count, 0)
  const rawGrandTotal = Math.max(1, rankedCount + Math.max(0, othersCount))
  const OTHERS_MAX_PX = Math.min(112, totalLen * 0.075)
  const othersVisualLength = (tailCount: number): number => {
    if (tailCount <= 0) return 0
    const proportional = totalLen * (tailCount / rawGrandTotal)
    const compactWidth = labelNeedPx(`+${tailCount}`, fontSize) + 6
    return Math.min(OTHERS_MAX_PX, Math.max(compactWidth, proportional))
  }
  // Selection is independent of the appearance-only fade slider. Otherwise
  // widening a colour blend silently moves an aroma into Others.
  let named: typeof rankedAll = []
  for (const candidate of rankedAll) {
    const trial = [...named, candidate]
    const trialCount = trial.reduce((n, note) => n + note.count, 0)
    const tailCount = Math.max(0, othersCount) + rankedCount - trialCount
    const namedSpace = totalLen - othersVisualLength(tailCount)
    const allFit = trial.every((note) => {
      const displayLabel = note.shortLabel ?? note.label
      const segmentLength = namedSpace * (note.count / Math.max(1, trialCount))
      return segmentLength >= labelNeedPx(displayLabel, fontSize) + labelPaddingPx
    })
    if (!allFit) break
    named = trial
  }
  const shownCount = named.reduce((n, note) => n + note.count, 0)
  const folded = Math.max(0, othersCount) + rankedCount - shownCount
  const tailVisualLen = named.length === 0 && folded > 0 ? totalLen : othersVisualLength(folded)
  const namedVisualLen = totalLen - tailVisualLen
  const tailDisplayLabel = `+${folded} Others`
  const parts = [
    ...named.map((note) => ({
      label: note.label,
      displayLabel: note.shortLabel ?? note.label,
      count: note.count,
      familyId: note.familyId,
      others: false,
      visualLen: namedVisualLen * (note.count / Math.max(1, shownCount)),
    })),
    ...(folded > 0 ? [{
      label: 'Others',
      displayLabel: tailDisplayLabel,
      count: folded,
      familyId: 'other',
      others: true,
      visualLen: tailVisualLen,
    }] : []),
  ]
  const FADE_PX = fadePx
  let cumLen = 0
  const boundaries: number[] = []
  const segments = parts.map((part, index): SpiralSegment => {
    const segLen = part.visualLen
    const startLen = cumLen
    cumLen += segLen
    if (cumLen < totalLen - 0.5) boundaries.push(cumLen)
    const tStart = tAtLen(startLen)
    const tEnd = tAtLen(cumLen)
    const mid = (tStart + tEnd) / 2
    const before = point(Math.max(tStart, mid - 0.004))
    const after = point(Math.min(tEnd, mid + 0.004))
    const next = parts[index + 1]
    const prev = parts[index - 1]
    // 1:3:1 rule (round 7): each fade may take at most a FIFTH of the segment,
    // so at least three-fifths always shows the segment's own colour.
    const fadeLen = Math.min(FADE_PX, segLen / 5)
    const fadeFrom = point(tAtLen(cumLen - fadeLen))
    const fadeTo = point(tEnd)
    const inLen = Math.min(FADE_PX, segLen / 5)
    const inStart = point(tStart)
    const inEnd = point(tAtLen(startLen + inLen))
    return {
      label: part.label,
      displayLabel: part.displayLabel,
      count: part.count,
      familyId: part.familyId,
      others: part.others,
      tStart,
      tEnd,
      spanPx: segLen,
      pathD: seg(tStart, tEnd),
      bandD: band(tStart, tEnd),
      labelPathD: seg(tStart, tEnd, after.x < before.x),
      labelText: fitName(part.displayLabel, segLen, fontSize)
        ?? (part.others ? fitName(`+${part.count}`, segLen, fontSize) : null),
      ...(next
        ? {
            fade: {
              pathD: seg(tAtLen(cumLen - fadeLen), tEnd),
              bandD: band(tAtLen(cumLen - fadeLen), tEnd),
              x1: fadeFrom.x,
              y1: fadeFrom.y,
              x2: fadeTo.x,
              y2: fadeTo.y,
              nextFamilyId: next.familyId,
              nextOthers: next.others,
            },
          }
        : null),
      ...(prev
        ? {
            fadeIn: {
              pathD: seg(tStart, tAtLen(startLen + inLen)),
              bandD: band(tStart, tAtLen(startLen + inLen)),
              x1: inStart.x, y1: inStart.y, x2: inEnd.x, y2: inEnd.y,
              prevFamilyId: prev.familyId, prevOthers: prev.others,
            },
          }
        : null),
    }
  })
  // Separator = a true rectangle in the boundary's local tangent/normal frame.
  // Its opposite sides are exactly parallel. A SMALL per-separator ribbon clip
  // trims the overlong rectangle to this turn only, so it fully reaches both
  // band edges without reappearing on a neighbouring coil.
  const separatorWidth = 3
  const separators = boundaries.map((L): SpiralSeparator => {
    const t = tAtLen(L)
    const frame = frameAt(t)
    const along = separatorWidth / 2
    const across = ribbon / 2 + separatorWidth
    const corners = [
      { x: frame.x + frame.nx * across - frame.tx * along, y: frame.y + frame.ny * across - frame.ty * along },
      { x: frame.x + frame.nx * across + frame.tx * along, y: frame.y + frame.ny * across + frame.ty * along },
      { x: frame.x - frame.nx * across + frame.tx * along, y: frame.y - frame.ny * across + frame.ty * along },
      { x: frame.x - frame.nx * across - frame.tx * along, y: frame.y - frame.ny * across - frame.ty * along },
    ]
    const pathD = corners.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z'
    const clipHalf = separatorWidth * 1.5
    return {
      pathD,
      clipD: band(tAtLen(Math.max(0, L - clipHalf)), tAtLen(Math.min(totalLen, L + clipHalf))),
    }
  })
  const nubT = tAtLen(1)
  const capStartD = seg(0, nubT)
  const capEndD = seg(tAtLen(totalLen - 1), 1)
  // Round 6: outer-turn segments too small for an on-ribbon name get the
  // classic callout — ribbon edge → radial elbow → horizontal label, one
  // column per side, de-collided vertically.
  const callouts: SpiralCallout[] = []
  if (wantCallouts) {
    const raw = segments
      .filter((s) => s.labelText === null && !s.others)
      .map((s) => {
        const tMid = (s.tStart + s.tEnd) / 2
        const rMid = r0 + (r1 - r0) * tMid
        return { s, tMid, rMid }
      })
      .filter((x) => x.rMid >= r1 - pitch * 1.15) // outer turn only — inner leaders would cross the ribbon
    for (const side of [false, true]) {
      const col = raw
        .map((x) => {
          const rad = x.tMid * TAU * turns
          const edge = polarXY(cx, cy, x.rMid + ribbon / 2 + 2, rad)
          const elbow = polarXY(cx, cy, x.rMid + ribbon / 2 + 9, rad)
          return { ...x, rad, edge, elbow, right: elbow.x >= cx }
        })
        .filter((x) => x.right === side)
        .sort((a, b) => b.s.count - a.s.count)
        .slice(0, 3)
        .sort((a, b) => a.elbow.y - b.elbow.y)
      const SP = Math.max(13, fontSize + 2)
      let lastY = -Infinity
      for (const x of col) {
        let ly = x.elbow.y
        if (ly < lastY + SP) ly = lastY + SP
        lastY = ly
        const lx = Math.max(4, Math.min(size - 4, x.elbow.x + (side ? 8 : -8)))
        callouts.push({
          label: x.s.displayLabel,
          px: x.edge.x, py: x.edge.y,
          ex: x.elbow.x, ey: x.elbow.y,
          lx, ly: ly + fontSize * 0.35,
          anchor: side ? 'start' : 'end',
        })
      }
    }
  }
  // Content bbox: the ribbon's outer edge over the whole coil + cap
  // protrusions + a callout margin, so the component's viewBox crops to the
  // real footprint and the coil fills the available width.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < SAMPLES; i += 4) {
    const t = i / (SAMPLES - 1)
    const r = r0 + (r1 - r0) * t + ribbon / 2
    const q = polarXY(cx, cy, r, t * TAU * turns)
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  const pad = wantCallouts ? 12 : 5
  for (const c of callouts) {
    minX = Math.min(minX, c.lx - 4)
    maxX = Math.max(maxX, c.lx + 4)
    minY = Math.min(minY, c.ly - fontSize)
    maxY = Math.max(maxY, c.ly + 4)
  }
  return {
    cx,
    cy,
    segments,
    separators,
    capStartD,
    capEndD,
    ribbon,
    separatorWidth,
    endDeg: ((turns * 360) % 360 + 360) % 360,
    callouts,
    bbox: { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 },
    representedFamilyIds: [...new Set(segments.filter((s) => !s.others).map((s) => s.familyId))],
  }
}
