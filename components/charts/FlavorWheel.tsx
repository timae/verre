'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { FlItem } from '@/lib/flavours'
import { CHART_SIZE } from './sizes'
import { haptics } from '@/lib/haptics'
import {
  arcPath,
  labelPosition,
  levelFromDist,
  levelToFillRadius,
  slotAngles,
  wedgeFromXY,
} from './wheelGeometry'

// Interactive radial flavour wheel. Replaces the read-only PolarChart +
// slider stack on the rate screen. Each wedge represents one flavour
// dimension; intensity 0–5 is encoded as the wedge's outer radius.
//
// Gesture model:
//   1. Pointer-down inside the inner hub (dist < rInner) is a no-op.
//      Without this, every tap on the central "drag out" hint area
//      would silently zero whichever wedge happened to be under the
//      pointer angularly.
//   2. Pointer-down on a real wedge LOCKS that wedge. The locked index
//      is held in a ref (not state) because the iOS Safari fallback path
//      attaches global listeners that close over their initial state.
//   3. Drag updates the locked wedge's level based on pointer distance
//      from center. Drift inside rInner during a drag clears the wedge
//      (level → 0). The lock means a user dragging tangentially past a
//      wedge boundary doesn't accidentally hop to the neighbour.
//   4. Pointer-up releases the lock.
//
// Geometry: two presets, "spacious" (default) and "compact". Spacious
// uses fat wedges that fill most of the wheel (good touch targets, big
// visual feedback). Compact mirrors the read-only PolarChart's
// proportions so the user can compare. Toggleable via a button below
// the wheel; preference persisted in localStorage.
//
// A11y: each wedge has a hidden <input type="range"> sibling. Screen
// readers (VoiceOver/TalkBack) handle these natively — "adjustable"
// trait, increment/decrement gestures, value announcement, all free.
// Keyboard users tab between them and use arrow keys / Home / End.
// The visible focus ring is drawn on the SVG when an input has focus.
// The SVG itself is marked role="presentation" so spatial AT
// exploration doesn't land on the unlabelled <path>s and produce dead
// air — all interaction goes through the inputs.

export type WheelGeometry = 'spacious' | 'compact'

interface Props {
  flavors: Record<string, number>
  fl: FlItem[]
  onChange: (next: Record<string, number>) => void
  size?: number
  geometry?: WheelGeometry
}

const MAX = 5

// Geometry presets. Numbers are fractions of `size` (the SVG viewBox
// edge length). The wheel is rendered with `aspect-ratio: 1` so x/y
// scaling stays equal even if the parent does something weird with
// width vs height.
//
// labelGutter is the radial space reserved for labels OUTSIDE the
// wedges' outer edge. The wheel's outer radius is therefore
// `size/2 - labelGutter`, NOT `size * fraction`. This way labels never
// clip the SVG box at any reasonable size.
const GEOMETRY = {
  spacious: { rInnerFrac: 0.13, gapDeg: 1, labelGutter: 64 },
  compact:  { rInnerFrac: 0.10, gapDeg: 3, labelGutter: 64 },
} as const

function computeDims(size: number, geometry: WheelGeometry, n: number) {
  const cx = size / 2
  const cy = size / 2
  const cfg = GEOMETRY[geometry]
  const labelGutter = cfg.labelGutter
  const rOuter = size / 2 - labelGutter
  // Compact preset uses the read-only PolarChart's proportions
  // (rInner ≈ 10%, rOuter ≈ 37%) so users can directly compare. We
  // re-derive rInner from the same fraction for visual fidelity.
  const rInner = geometry === 'compact'
    ? Math.max(20, size * cfg.rInnerFrac)
    : Math.max(30, size * cfg.rInnerFrac)
  // Spacious shrinks the inner hub a bit and lets wedges fill most of
  // the available radial space. Compact keeps a thin band, matching
  // PolarChart's "lots of breathing room" aesthetic.
  const effectiveOuter = geometry === 'compact'
    ? rInner + (rOuter - rInner) * 0.5
    : rOuter
  const rLabel = effectiveOuter + 18
  return { cx, cy, rInner, rOuter: effectiveOuter, rLabel, n }
}

// Inter-wedge angular gap, in radians. Both presets get a small gap
// (spacious 1°, compact 3°). The gap is rendered as background
// (transparent), not as a drawn line — wedges sit close but don't touch,
// matching PolarChart's read-only treatment.
function gapRad(geometry: WheelGeometry): number {
  return (GEOMETRY[geometry].gapDeg * Math.PI) / 180
}

export function FlavorWheel({ flavors, fl, onChange, size = CHART_SIZE.INPUT, geometry = 'spacious' }: Props) {
  const n = fl.length
  const dims = computeDims(size, geometry, n)
  const { cx, cy, rInner, rOuter, rLabel } = dims
  const gap = gapRad(geometry)

  const svgRef = useRef<SVGSVGElement>(null)

  // Locked wedge index during a drag. Held in a ref because we may
  // attach window-level listeners on the fallback path; React state
  // inside those would stale-close.
  const lockRef = useRef<number | null>(null)

  // The most recently touched wedge index — drives the center readout
  // and the visual focus / "active" indicator. State because it triggers
  // a re-render to update the digit color.
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  // Per-wedge last-known level. Used to detect boundary crossings for
  // haptic ticks — fires on integer level change in either direction.
  const lastLevelsRef = useRef<Record<string, number>>({})

  // Latest values & onChange in refs so the global pointermove fallback
  // doesn't stale-close.
  const flavorsRef = useRef(flavors)
  const onChangeRef = useRef(onChange)
  useEffect(() => { flavorsRef.current = flavors }, [flavors])
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Wine type can change while the rate modal is open if the host edits
  // the wine. The new fl array carries different keys; remap flavors so
  // any keys absent from the new set drop, and any new keys initialise
  // to 0. Preserves overlapping keys.
  useEffect(() => {
    const cur = flavorsRef.current
    let changed = false
    const next: Record<string, number> = {}
    for (const item of fl) {
      next[item.k] = cur[item.k] ?? 0
      if (cur[item.k] === undefined) changed = true
    }
    for (const k of Object.keys(cur)) {
      if (!(k in next)) { changed = true; break }
    }
    if (changed) onChangeRef.current(next)
  }, [fl])

  // SVG-relative coordinate conversion. We compute scaleX and scaleY
  // independently rather than trusting aspect-ratio: 1 to hold — if a
  // parent ever forces a non-square layout (unusual flex constraints,
  // explicit height override on the .panel), x and y must still map
  // correctly into viewBox space.
  const clientToSvg = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = svgRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const scaleX = size / rect.width
    const scaleY = size / rect.height
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    }
  }, [size])

  const setWedgeFromPoint = useCallback((clientX: number, clientY: number, lockedIdx: number) => {
    const pt = clientToSvg(clientX, clientY)
    if (!pt) return
    const dx = pt.x - cx
    const dy = pt.y - cy
    const dist = Math.hypot(dx, dy)
    const level = levelFromDist(dist, rInner, rOuter, MAX)
    const key = fl[lockedIdx].k
    const prev = flavorsRef.current[key] ?? 0
    if (level !== prev) {
      onChangeRef.current({ ...flavorsRef.current, [key]: level })
      const last = lastLevelsRef.current[key]
      if (last === undefined || last !== level) {
        haptics.tick()
        lastLevelsRef.current[key] = level
      }
    }
  }, [clientToSvg, cx, cy, rInner, rOuter, fl])

  // Global-listener fallback. Some iOS Safari versions throw on
  // setPointerCapture for SVG elements after re-render, or silently fail
  // to deliver subsequent pointermove events when the finger leaves the
  // SVG bounds. Falling back to window-level listeners covers both.
  const fallbackHandlersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null)
  const detachFallback = useCallback(() => {
    const h = fallbackHandlersRef.current
    if (!h) return
    window.removeEventListener('pointermove', h.move)
    window.removeEventListener('pointerup', h.up)
    window.removeEventListener('pointercancel', h.up)
    fallbackHandlersRef.current = null
  }, [])

  const endGesture = useCallback(() => {
    lockRef.current = null
    detachFallback()
  }, [detachFallback])

  useEffect(() => () => detachFallback(), [detachFallback])

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Ignore secondary pointers so a second finger (multi-touch on iOS,
    // pinch-zoom attempts, accidental two-handed taps) doesn't hijack
    // the primary pointer's locked wedge.
    if (e.isPrimary === false) return
    // Defensively end any prior gesture before starting a new one. If a
    // previous pointer-up was missed (browser quirk, focus loss, etc.),
    // window listeners from the fallback path could otherwise leak.
    endGesture()

    const pt = clientToSvg(e.clientX, e.clientY)
    if (!pt) return
    const hit = wedgeFromXY(cx, cy, pt.x, pt.y, n, rInner)
    if (!hit) return  // Dead zone — no lock, no commit.

    lockRef.current = hit.idx
    setActiveIdx(hit.idx)
    haptics.tap()

    const level = levelFromDist(hit.dist, rInner, rOuter, MAX)
    const key = fl[hit.idx].k
    if (level !== (flavorsRef.current[key] ?? 0)) {
      onChangeRef.current({ ...flavorsRef.current, [key]: level })
    }
    lastLevelsRef.current[key] = level

    // Try native pointer-capture first; fall back to window listeners.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      const move = (ev: PointerEvent) => {
        if (lockRef.current === null) return
        setWedgeFromPoint(ev.clientX, ev.clientY, lockRef.current)
      }
      const up = () => endGesture()
      fallbackHandlersRef.current = { move, up }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    }
  }, [clientToSvg, cx, cy, rInner, rOuter, n, fl, setWedgeFromPoint, endGesture])
  // (endGesture is referenced both inside the fallback's `up` handler
  // and at the top of onPointerDown for the re-entrant guard.)

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (lockRef.current === null) return
    setWedgeFromPoint(e.clientX, e.clientY, lockRef.current)
  }, [setWedgeFromPoint])

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore — capture may not have been acquired
    }
    endGesture()
  }, [endGesture])

  // Keyboard handler attached to each per-wedge <input type="range">.
  // The native input handles arrow/Home/End semantics, value clamping,
  // and screen-reader announcements for free; we only need to sync the
  // value into our flavors record on change.
  const onInputChange = useCallback((idx: number, value: number) => {
    const key = fl[idx].k
    const prev = flavorsRef.current[key] ?? 0
    if (value !== prev) {
      onChangeRef.current({ ...flavorsRef.current, [key]: value })
      const last = lastLevelsRef.current[key]
      if (last === undefined || last !== value) {
        haptics.tick()
        lastLevelsRef.current[key] = value
      }
    }
    setActiveIdx(idx)
  }, [fl])

  // Render data
  const activeKey = activeIdx !== null ? fl[activeIdx].k : null
  const activeLevel = activeKey !== null ? (flavors[activeKey] ?? 0) : null
  const activeColor = activeIdx !== null ? fl[activeIdx].c : 'var(--fg-dim)'

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: size, margin: '0 auto' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size} ${size}`}
        style={{ width: '100%', aspectRatio: '1 / 1', display: 'block', touchAction: 'none', userSelect: 'none' }}
        // Mark the SVG inert to assistive tech. Spatial exploration
        // (VoiceOver swiping over wedges) would otherwise produce dead
        // air — paths have no semantic role. All a11y goes through the
        // hidden <input type="range"> siblings below.
        role="presentation"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Concentric guide rings — one per integer level. Matches
            PolarChart's dashed treatment (rgba(255,255,255,0.08),
            stroke-width 0.6, stroke-dasharray 1.5,2.5). */}
        {[1, 2, 3, 4, 5].map(k => {
          const r = levelToFillRadius(k, rInner, rOuter, MAX)
          return (
            <circle
              key={k}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={0.6}
              strokeDasharray="1.5,2.5"
            />
          )
        })}

        {/* Wedges */}
        {fl.map((f, i) => {
          const [a0, a1] = slotAngles(i, n)
          // Apply per-wedge gap by shrinking each side of the angular range.
          const a0g = a0 + gap / 2
          const a1g = a1 - gap / 2
          const v = flavors[f.k] ?? 0
          const fillR = levelToFillRadius(v, rInner, rOuter, MAX)
          const isActive = activeIdx === i

          return (
            <g key={f.k}>
              {/* Faint full-radius background guide. Matches PolarChart's
                  0.13 opacity treatment so empty wedges still hint at
                  their flavour color without drawing any boundary
                  strokes. */}
              <path
                d={arcPath(cx, cy, rInner, rOuter, a0g, a1g)}
                fill={f.c}
                opacity={0.13}
              />
              {/* Filled wedge for current value. Same opacity as
                  PolarChart's filled wedges (0.85) for visual
                  consistency between the rate modal and the read-only
                  chart in the feed/history. */}
              {v > 0 && (
                <path
                  d={arcPath(cx, cy, rInner, fillR, a0g, a1g)}
                  fill={f.c}
                  opacity={0.85}
                />
              )}
              {/* Active-wedge indicator. Two modes — both stroke-free
                  so we don't reintroduce the "dotted line" busyness:
                    - v === 0 (empty wedge focused): bump the whole
                      wedge to 0.30 opacity.
                    - v > 0 (filled wedge focused): light up the
                      remaining empty radial space (from fillR to
                      rOuter) at 0.30 opacity, leaving the filled
                      portion at its normal 0.85.
                  WCAG 2.4.7 requires a visible focus state for
                  sighted keyboard / switch users; without this,
                  tabbing through filled wedges would have no visible
                  effect. */}
              {isActive && v === 0 && (
                <path
                  d={arcPath(cx, cy, rInner, rOuter, a0g, a1g)}
                  fill={f.c}
                  opacity={0.30}
                />
              )}
              {isActive && v > 0 && v < MAX && (
                <path
                  d={arcPath(cx, cy, fillR, rOuter, a0g, a1g)}
                  fill={f.c}
                  opacity={0.30}
                />
              )}
              {isActive && v >= MAX && (
                /* Level 5 leaves no empty radial space for the annulus,
                   so we lay a thin highlight strip over the filled
                   wedge — visible difference, still no stroke. */
                <path
                  d={arcPath(cx, cy, rInner, rOuter, a0g, a1g)}
                  fill={f.c}
                  opacity={0.20}
                />
              )}
            </g>
          )
        })}

        {/* Labels — uppercase, letter-spaced, dim grey regardless of
            value. Matches PolarChart's read-only treatment exactly so
            the rate modal and the feed/history charts share visual
            language. */}
        {fl.map((f, i) => {
          const pos = labelPosition(cx, cy, rLabel, i, n)
          return (
            <text
              key={`lbl-${f.k}`}
              x={pos.x}
              y={pos.y}
              textAnchor={pos.anchor}
              dominantBaseline="middle"
              fontSize={Math.max(8, size * 0.04)}
              fontFamily="Manrope, sans-serif"
              fontWeight={700}
              letterSpacing="0.06em"
              fill="rgba(180,170,150,0.8)"
              style={{ pointerEvents: 'none' }}
            >
              {f.l.toUpperCase()}
            </text>
          )
        })}

        {/* Center hub. No stroke — the inner ring lives implicitly via
            contrast with the wedge backgrounds. */}
        <circle cx={cx} cy={cy} r={rInner} fill="var(--bg2)" />

        {/* Center readout — digit only, in active wedge color. Default
            "drag" hint when no wedge has been touched yet.
            dominantBaseline="central" puts the geometric center of the
            glyph on the y coordinate, so y={cy} is exactly centered. */}
        {activeIdx === null ? (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.max(9, size * 0.034)}
            fontFamily="Manrope, sans-serif"
            fill="rgba(180,170,150,0.8)"
            fontWeight={500}
            letterSpacing="0.08em"
            style={{ pointerEvents: 'none', textTransform: 'uppercase' }}
          >
            DRAG
          </text>
        ) : (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            // 28px floor exists for legibility, not to fit any rInner.
            // At INPUT=400 (the only call site today) rInner=52, hub
            // diameter=104, plenty of room for a 40px digit. If a
            // future caller uses a smaller size, verify the digit still
            // fits inside the hub before lowering the floor.
            fontSize={Math.max(28, size * 0.10)}
            fontFamily="var(--mono, 'JetBrains Mono', monospace)"
            fill={activeColor}
            fontWeight={700}
            style={{ pointerEvents: 'none' }}
          >
            {activeLevel}
          </text>
        )}
      </svg>

      {/* Hidden range inputs — one per wedge — for keyboard and screen
          reader access. Visually invisible but focusable; positioned
          via CSS clip so they don't affect layout. */}
      <div
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        {fl.map((f, i) => (
          <input
            key={`a11y-${f.k}`}
            type="range"
            min={0}
            max={MAX}
            step={1}
            value={flavors[f.k] ?? 0}
            onChange={e => onInputChange(i, Number(e.target.value))}
            onFocus={() => setActiveIdx(i)}
            aria-label={`${f.l} intensity, 0 to ${MAX}`}
          />
        ))}
      </div>
    </div>
  )
}
