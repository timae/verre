'use client'
import { useState, useRef, useEffect, useMemo } from 'react'
import { COUNTRIES, countryName } from '@/lib/countries'

interface Props {
  value: string
  onChange: (code: string) => void
  placeholder?: string
}

// Country picker with type-to-filter. Trigger button shows current value
// (resolved via `countryName`) or placeholder. Tap opens a panel under
// the trigger with a search input + filtered list. Keyboard support:
// arrows navigate, Enter selects, Escape closes. Tap-outside closes.
//
// Stored value is the ISO 3166-1 alpha-2 code. Display labels come from
// the static list (English). Empty string = no selection.
export function CountrySelect({ value, onChange, placeholder = 'select country' }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // Whether to render the panel ABOVE the trigger instead of below.
  // Decided on open based on available space within the trigger's
  // nearest scrollable ancestor (typically the modal sheet). Without
  // this, a trigger near the bottom of a small modal opens a 320px
  // panel that gets clipped by the sheet's overflow.
  const [openUp, setOpenUp] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COUNTRIES
    return COUNTRIES.filter(c => c.name.toLowerCase().includes(q))
  }, [query])

  // Keep the active index in range as the filter changes.
  useEffect(() => { setActiveIndex(0) }, [query])

  // Focus the search input when the panel opens. The input owns keyboard
  // focus while open; arrow keys navigate via the keydown handler, the
  // text input itself just captures the query.
  //
  // Skip on coarse-pointer devices (touch / mobile) — autofocus there
  // pops the iOS keyboard, which on a small viewport eats most of the
  // dropdown panel before the user has even glanced at the list. Touch
  // users can tap the input themselves if they want to filter.
  useEffect(() => {
    if (!open) return
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches
    if (!isTouch) inputRef.current?.focus()
  }, [open])

  // Scroll the active row into view as the user navigates.
  useEffect(() => {
    if (!open || !listRef.current) return
    const row = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    if (row) row.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function pick(code: string) {
    onChange(code)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[activeIndex]
      if (target) pick(target.code)
    }
  }

  const label = countryName(value) || placeholder
  const isEmpty = !value

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => {
          // Decide flip direction BEFORE opening so the first render
          // is already correct (no flash of below-then-up). Read the
          // trigger's viewport position and compare with available
          // space against the panel's maxHeight (~320 + 56 chrome).
          if (!open && wrapRef.current) {
            const rect = wrapRef.current.getBoundingClientRect()
            const PANEL = 360
            const below = window.innerHeight - rect.bottom
            const above = rect.top
            // Flip up only when there's noticeably more room above.
            // 80px buffer avoids ping-ponging at boundary cases.
            setOpenUp(below < PANEL && above > below + 80)
          }
          setOpen(o => !o)
        }}
        className="fi"
        style={{
          textAlign: 'left',
          cursor: 'pointer',
          color: isEmpty ? 'var(--fg-faint)' : 'var(--fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-faint)', flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            // Flip up when the panel would clip below the modal's
            // scroll bottom. `openUp` decision is made on open.
            ...(openUp
              ? { bottom: 'calc(100% + 4px)' }
              : { top: 'calc(100% + 4px)' }),
            left: 0,
            right: 0,
            background: 'var(--bg2)',
            border: '1px solid var(--border2)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 100,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 320,
          }}
        >
          <input
            ref={inputRef}
            className="fi"
            placeholder="type to search…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            style={{ borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}
          />
          <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
            {value && (
              <button
                type="button"
                onClick={() => pick('')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 13px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--fg-dim)',
                  cursor: 'pointer',
                }}
              >
                × clear
              </button>
            )}
            {filtered.length === 0 ? (
              <div style={{ padding: '12px 13px', fontSize: 12, color: 'var(--fg-faint)', fontStyle: 'italic' }}>
                no matches
              </div>
            ) : filtered.map((c, idx) => (
              <button
                key={c.code}
                data-idx={idx}
                type="button"
                onClick={() => pick(c.code)}
                onMouseEnter={() => setActiveIndex(idx)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 13px',
                  background: idx === activeIndex ? 'rgba(143,184,122,0.08)' : 'transparent',
                  border: 'none',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  color: c.code === value ? 'var(--accent)' : 'var(--fg)',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span>{c.name}</span>
                <span style={{ fontSize: 10, color: 'var(--fg-faint)', flexShrink: 0 }}>{c.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
