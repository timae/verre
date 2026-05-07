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
// Gesture model (three states):
//   - idle: no pointer down.
//   - pending-hub: pointer is down inside the inner hub (dist < rInner).
//     No wedge is locked yet, no value committed. If the pointer leaves
//     the hub (dist crosses rInner outward) before pointer-up, we
//     transition to locked using the wedge under the finger AT THAT
//     MOMENT. If pointer-up happens while still in the hub, the gesture
//     ends with no commit (a tap inside the hub is a no-op).
//   - locked: a wedge index is locked in a ref. Drag updates the
//     locked wedge's level based on radial distance. Drift back inside
//     rInner clears the wedge (level → 0). The lock means tangential
//     motion past a wedge boundary doesn't hop to the neighbour.
//
// Why pending-hub exists: users can press in the middle and drag
// outward to set a value. But a *tap* inside the hub must NOT commit
// anything — there's no wedge under the finger angularly to commit to
// in a stable way, and tap-on-hub is naturally how a user explores
// "what does this center thing do."
//
// The locked wedge index is held in a ref (not state) because the iOS
// Safari fallback path attaches global listeners that close over their
// initial state.
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
  spacious: { rInnerFrac: 0.13, gapDeg: 3, labelGutter: 72 },
  compact:  { rInnerFrac: 0.10, gapDeg: 3, labelGutter: 72 },
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

  // Pending-hub state: pointer is down inside the inner hub but no
  // wedge is locked yet. We're waiting to see if the user drags out
  // (transition to locked) or releases without leaving (no-op tap).
  const pendingHubRef = useRef<boolean>(false)

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

  // Process a pointer position during an active gesture. Handles the
  // pending-hub → locked transition: if no wedge is currently locked
  // but the pointer has just crossed outside rInner, lock the wedge
  // under the finger at this moment and start tracking.
  const processGesturePoint = useCallback((clientX: number, clientY: number) => {
    const pt = clientToSvg(clientX, clientY)
    if (!pt) return
    const dx = pt.x - cx
    const dy = pt.y - cy
    const dist = Math.hypot(dx, dy)

    // Pending-hub: waiting for pointer to leave the hub before locking.
    if (pendingHubRef.current && lockRef.current === null) {
      if (dist < rInner) return  // still in hub, do nothing
      // Crossed outward — lock the wedge under the finger now.
      const hit = wedgeFromXY(cx, cy, pt.x, pt.y, n, rInner)
      if (!hit) return
      lockRef.current = hit.idx
      pendingHubRef.current = false
      setActiveIdx(hit.idx)
      haptics.tap()
      lastLevelsRef.current[fl[hit.idx].k] = flavorsRef.current[fl[hit.idx].k] ?? 0
      // Fall through to the level-update block below.
    }

    // Already-locked drags must NOT re-enter pending-hub: a user who
    // drags inward to clear a wedge (level → 0, lock retained) and
    // then drags back outward should keep tracking the original locked
    // wedge, even if the pointer is now angularly over a neighbour.
    // The lock-prevents-tangential-hop contract documented at the top
    // of this file depends on this gating.
    const lockedIdx = lockRef.current
    if (lockedIdx === null) return  // still pending-hub or idle
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
  }, [clientToSvg, cx, cy, rInner, rOuter, n, fl])

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
    pendingHubRef.current = false
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

    if (!hit) {
      // Pointer-down inside the inner hub. Don't lock, don't commit —
      // but mark pending-hub so a subsequent drag outward can pick up
      // the gesture. If pointer-up happens without ever leaving the
      // hub, this becomes a no-op tap.
      pendingHubRef.current = true
    } else {
      // Pointer-down on a real wedge. Lock immediately, commit the
      // tap-to-set value, fire haptic.
      lockRef.current = hit.idx
      setActiveIdx(hit.idx)
      haptics.tap()
      const level = levelFromDist(hit.dist, rInner, rOuter, MAX)
      const key = fl[hit.idx].k
      if (level !== (flavorsRef.current[key] ?? 0)) {
        onChangeRef.current({ ...flavorsRef.current, [key]: level })
      }
      lastLevelsRef.current[key] = level
    }

    // Either way, attach pointer capture / fallback listeners so we
    // can track motion. Pending-hub gestures need this just as much
    // as locked ones — the whole point is to detect the hub-to-wedge
    // crossing.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      const move = (ev: PointerEvent) => {
        if (lockRef.current === null && !pendingHubRef.current) return
        processGesturePoint(ev.clientX, ev.clientY)
      }
      const up = () => endGesture()
      fallbackHandlersRef.current = { move, up }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    }
  }, [clientToSvg, cx, cy, rInner, rOuter, n, fl, processGesturePoint, endGesture])

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (lockRef.current === null && !pendingHubRef.current) return
    processGesturePoint(e.clientX, e.clientY)
  }, [processGesturePoint])

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
        {/* No concentric level guide rings. The user explicitly asked
            for "no more lines between the steps" — visual feedback on
            level comes from wedge fill height alone, plus the live
            digit readout in the center hub during drag. */}

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
            value. Matches PolarChart's read-only treatment in spirit;
            we go a step further by:
              - Wrapping multi-word labels onto two stacked lines
                ("DARK FRUIT" → "DARK" / "FRUIT") so they fit in the
                gutter without clipping at the wheel's east/west edges.
              - Using a slightly smaller font (size * 0.035) than
                PolarChart's 0.04 because the wheel is interactive and
                bigger labels would crowd the touch surface on phones.
            */}
        {fl.map((f, i) => {
          const pos = labelPosition(cx, cy, rLabel, i, n)
          const fontSize = Math.max(8, size * 0.035)
          const lineHeight = fontSize * 1.05
          const upper = f.l.toUpperCase()
          // Split on space OR slash so multi-token labels stack as
          // separate lines. Covers "DARK FRUIT" → "DARK"/"FRUIT" and
          // "FLORAL/HERB" → "FLORAL"/"HERB". Single-token labels render
          // as a single line.
          const lines = upper.split(/[ /]/)
          // Vertically center multi-line labels: shift the first line up
          // by half the total stack height so the visual midpoint sits
          // at pos.y. dominantBaseline="middle" then handles per-line
          // baseline alignment.
          const yStart = pos.y - ((lines.length - 1) * lineHeight) / 2
          return (
            <text
              key={`lbl-${f.k}`}
              x={pos.x}
              y={yStart}
              textAnchor={pos.anchor}
              dominantBaseline="middle"
              fontSize={fontSize}
              fontFamily="Manrope, sans-serif"
              fontWeight={700}
              letterSpacing="0.06em"
              fill="rgba(180,170,150,0.8)"
              style={{ pointerEvents: 'none' }}
            >
              {lines.map((line, j) => (
                <tspan key={j} x={pos.x} dy={j === 0 ? 0 : lineHeight}>{line}</tspan>
              ))}
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
