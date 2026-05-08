'use client'
import { useRef, useState, useEffect } from 'react'
import type { FlItem } from '@/lib/flavours'
import { INTENSITY } from './IntensityHelp'

interface Props {
  flavors: Record<string, number>
  fl: FlItem[]
  onChange: (next: Record<string, number>) => void
}

const MAX = 5
const ACCENT_SET = 0.85
const ACCENT_EMPTY = 0.5
const BAR_OPACITY = 0.34
const SLOP = 6

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export function FlavorChips({ flavors, fl, onChange }: Props) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
      {fl.map(f => (
        <Chip
          key={f.k}
          item={f}
          value={flavors[f.k] || 0}
          onSet={v => onChange({ ...flavors, [f.k]: v })}
        />
      ))}
    </div>
  )
}

interface ChipProps {
  item: FlItem
  value: number
  onSet: (v: number) => void
}

function Chip({ item, value, onSet }: ChipProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const pendingDownRef = useRef<{ x: number; y: number } | null>(null)
  const draggingRef = useRef(false)
  // Mirror of the source-of-truth value for use inside event listeners
  // that close over an old render. Keeps the < trackR.left logic and the
  // "no-op if same level" guard accurate without rebinding listeners.
  const valueRef = useRef(value)
  useEffect(() => { valueRef.current = value }, [value])

  const setFromX = (clientX: number) => {
    const track = trackRef.current
    if (!track) return
    const r = track.getBoundingClientRect()
    let lvl: number
    if (clientX < r.left) {
      lvl = 0
    } else {
      const tx = Math.max(0, Math.min(r.width, clientX - r.left))
      lvl = Math.max(1, Math.min(MAX, Math.ceil((tx / r.width) * MAX)))
    }
    if (valueRef.current !== lvl) onSet(lvl)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return
    pendingDownRef.current = { x: e.clientX, y: e.clientY }
    draggingRef.current = false
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      setFromX(e.clientX)
      return
    }
    const pd = pendingDownRef.current
    if (!pd) return
    const dx = e.clientX - pd.x
    const dy = e.clientY - pd.y
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
    if (Math.abs(dx) > Math.abs(dy)) {
      draggingRef.current = true
      try { trackRef.current?.setPointerCapture(e.pointerId) } catch {}
      setFromX(e.clientX)
    } else {
      pendingDownRef.current = null
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pendingDownRef.current && !draggingRef.current) {
      setFromX(e.clientX)
    }
    pendingDownRef.current = null
    draggingRef.current = false
  }

  const onPointerCancel = () => {
    pendingDownRef.current = null
    draggingRef.current = false
  }

  const v = value
  const fillPct = (v / MAX) * 100
  const accent = hexToRgba(item.c, v ? ACCENT_SET : ACCENT_EMPTY)

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, height: 46 }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); if (v) onSet(0) }}
        aria-label={`clear ${item.l}`}
        style={{
          width: 24, flexShrink: 0,
          background: 'transparent', border: 'none', padding: 0,
          fontFamily: 'monospace', fontSize: 18,
          color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', touchAction: 'pan-y',
          transition: 'color 120ms',
        }}
      >×</button>
      <div style={{
        flex: 1, position: 'relative', display: 'flex', alignItems: 'stretch',
        border: `1.5px solid ${accent}`, borderRadius: 999,
        background: 'var(--bg3)', overflow: 'hidden',
        userSelect: 'none', WebkitUserSelect: 'none',
        transition: 'border-color 120ms',
      }}>
        <div
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          style={{
            flex: 1, position: 'relative', cursor: 'pointer',
            overflow: 'hidden', touchAction: 'pan-y',
          }}
        >
          <div style={{
            position: 'absolute', inset: 0,
            width: `${fillPct}%`, background: item.c,
            opacity: v ? BAR_OPACITY : 0,
            transition: 'width 120ms, opacity 120ms',
            pointerEvents: 'none',
          }} />
          <div style={{
            position: 'relative', display: 'flex', flexDirection: 'column',
            justifyContent: 'center', alignItems: 'flex-start',
            height: '100%', padding: '0 14px 0 18px',
            pointerEvents: 'none', lineHeight: 1.15,
          }}>
            <span style={{
              fontWeight: v ? 600 : 500,
              color: 'var(--fg)', fontSize: 13,
            }}>{item.l}</span>
            <span style={{
              fontFamily: 'monospace', fontSize: 10,
              color: v ? item.c : 'var(--fg-dim)',
              fontWeight: 600, letterSpacing: 0.4, marginTop: 2,
            }}>{INTENSITY[v]}</span>
          </div>
        </div>
        {/* Hidden range input mirrors the chip value for keyboard a11y.
            Tab moves focus here; arrow keys nudge level. Visually hidden
            (size 0, opacity 0) but kept in the layout so focus rings can
            still anchor against the chip on browsers that support
            :focus-visible reflection — the chip's visible focus state is
            currently delegated to the browser default outline on the
            input itself. */}
        <input
          type="range" min={0} max={MAX} step={1} value={v}
          onChange={e => onSet(Number(e.target.value))}
          aria-label={item.l}
          style={{
            position: 'absolute', width: 1, height: 1,
            opacity: 0, pointerEvents: 'none',
            margin: 0, padding: 0, border: 0,
          }}
        />
      </div>
    </div>
  )
}
