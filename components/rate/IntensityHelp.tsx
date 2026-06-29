'use client'
import { useState, useEffect, useRef } from 'react'

export const INTENSITY = ['none', 'faint', 'light', 'medium', 'strong', 'intense'] as const

const DESCRIPTIONS: Record<typeof INTENSITY[number], string> = {
  none:    "the component isn't there",
  faint:   'barely detectable',
  light:   'clearly present but quiet',
  medium:  'balanced',
  strong:  'forward, prominent',
  intense: 'dominating',
}

export function IntensityHelp() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-dim)', marginTop: -6, marginBottom: 12 }}>
      <span>tap or drag to mark perceived intensity</span>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="What do the intensities mean?"
        aria-expanded={open}
        style={{
          width: 16, height: 16, borderRadius: '50%',
          border: '1px solid var(--fg-dim)',
          background: 'transparent',
          color: 'var(--fg-dim)',
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          lineHeight: 1, padding: 0, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >i</button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          minWidth: 220, maxWidth: 280,
        }}>
          <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-faint)', marginBottom: 8, fontFamily: 'var(--mono)' }}>
            intensity scale
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 4 }}>
            {INTENSITY.map(name => (
              <div key={name} style={{ display: 'contents' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', fontWeight: 600, letterSpacing: 0.4 }}>{name}</span>
                <span style={{ fontSize: 11, color: 'var(--fg)', lineHeight: 1.4 }}>{DESCRIPTIONS[name]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
