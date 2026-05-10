'use client'
import { useRef } from 'react'

// Touch-and-drag score input. Big number left, proportional track
// right. Tap to position, drag to refine; snaps to 0.25 on every
// pointermove. Tick strokes at integer positions 1..4 (0 and 5 are
// the track ends). Always shows two decimals (`0.00`, `4.25`) so
// digit churn during drag doesn't reflow the layout.

const MAX = 5
const STEP = 0.25
const THUMB = 20

interface Props {
  value: number  // 0..5 in 0.25 steps; 0 = unrated
  onChange: (value: number) => void
}

function snap(v: number): number {
  return Math.round(Math.min(MAX, Math.max(0, v)) / STEP) * STEP
}

export function ScoreSlider({ value, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  // Clamp to [0, MAX] for display only — the snap on input already
  // bounds saved values, but defending here keeps the thumb on-track
  // if any caller ever passes legacy/dirty data outside the range.
  const pct = (Math.min(MAX, Math.max(0, value)) / MAX) * 100
  const rated = value > 0

  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    onChange(snap(((e.clientX - rect.left) / rect.width) * MAX))
  }

  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(snap(value - STEP)) }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(snap(value + STEP)) }
    else if (e.key === 'Home') { e.preventDefault(); onChange(0) }
    else if (e.key === 'End') { e.preventDefault(); onChange(MAX) }
    else if (e.key === 'PageDown') { e.preventDefault(); onChange(snap(value - 1)) }
    else if (e.key === 'PageUp') { e.preventDefault(); onChange(snap(value + 1)) }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 4,
        color: rated ? 'var(--accent)' : 'var(--fg-faint)',
        fontWeight: 800, fontSize: 26, lineHeight: 1,
      }}>
        <span>★</span>
        {/* tabular-nums + always 2 decimals = no width churn during drag. */}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(2)}</span>
      </div>

      {/* Track is the entire pointer target. The 32px flex container
          gives a generous vertical hit zone above and below the 8px
          visual stroke. `touchAction: none` keeps horizontal drags
          on the slider, not on browser scroll. */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Score"
        aria-valuemin={0}
        aria-valuemax={MAX}
        aria-valuenow={value}
        aria-valuetext={`${value.toFixed(2)} of ${MAX}`}
        onPointerDown={e => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          handlePointer(e)
        }}
        onPointerMove={e => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) handlePointer(e)
        }}
        onKeyDown={handleKey}
        style={{
          flex: 1, position: 'relative',
          height: 32, display: 'flex', alignItems: 'center',
          cursor: 'pointer', touchAction: 'none',
          outline: 'none',
        }}
        onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent)' }}
        onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
      >
        {/* Bar — border2 keeps the unfilled end visible against the
            surrounding panel (bg3 was too dim and faded out). */}
        <div style={{
          position: 'relative', width: '100%', height: 8,
          background: 'var(--border2)', borderRadius: 999,
        }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${pct}%`, background: 'var(--accent)',
            borderRadius: 999, transition: 'width 0.08s linear',
          }} />
          {[1, 2, 3, 4].map(n => (
            <div key={n} style={{
              position: 'absolute', left: `calc(${(n / MAX) * 100}% - 1px)`,
              top: 0, bottom: 0, width: 2,
              background: value >= n ? 'var(--bg2)' : 'var(--fg-dim)',
              pointerEvents: 'none',
            }} />
          ))}
        </div>
        {/* Thumb centered on `pct` — the standard slider behavior.
            Half of the thumb hangs past the bar at 0 and 5, which is
            the price of uniform tick spacing across all five units. */}
        <div style={{
          position: 'absolute',
          left: `calc(${pct}% - ${THUMB / 2}px)`,
          top: '50%', transform: 'translateY(-50%)',
          width: THUMB, height: THUMB, borderRadius: '50%',
          background: rated ? 'var(--accent)' : 'var(--bg3)',
          border: `2px solid ${rated ? 'var(--bg2)' : 'var(--fg-faint)'}`,
          boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          transition: 'left 0.08s linear, background 0.15s, border-color 0.15s',
        }} />
      </div>
    </div>
  )
}
