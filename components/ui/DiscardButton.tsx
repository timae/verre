'use client'
import { useState, useEffect } from 'react'

interface Props {
  onDiscard: () => void
  disabled?: boolean
}

// Two-press inline destructive button. First tap arms with a red tint,
// second tap fires `onDiscard`. Auto-disarms after 3s without a second
// tap so the user can't accidentally confirm minutes later. Sits in a
// row alongside primary actions in unsaved-changes confirm modals.
//
// Distinct from <ConfirmDeleteButton>: that one is `.btn-del` styled
// (full-width red), this is a fixed-width ghost button with a red
// border. Both follow the same two-press convention; use this when the
// destructive option sits next to a "Keep editing" / "Save" pair in a
// flex row, and ConfirmDeleteButton when it's a standalone full-width
// action.
//
// Fixed width is sized to the wider label ("Tap to discard") so the
// row layout doesn't reflow when the button arms.
export function DiscardButton({ onDiscard, disabled = false }: Props) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={() => {
        if (disabled) return
        if (armed) onDiscard()
        else setArmed(true)
      }}
      disabled={disabled}
      style={{
        display:'inline-flex',alignItems:'center',justifyContent:'center',
        background:'transparent',
        color: armed ? 'rgba(220,90,90,1)' : 'rgba(220,90,90,0.85)',
        border: `1px solid ${armed ? 'rgba(184,64,64,0.7)' : 'rgba(184,64,64,0.4)'}`,
        padding:'12px 14px',borderRadius:8,
        fontSize:11,letterSpacing:'0.08em',
        textTransform:'uppercase',fontWeight:600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        width:142,flexShrink:0,
        transition:'border-color .15s, color .15s',
      }}
    >{armed ? 'Tap to discard' : 'Discard'}</button>
  )
}
