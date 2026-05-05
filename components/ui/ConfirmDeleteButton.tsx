'use client'
import { useState, useEffect, useRef } from 'react'

interface Props {
  onConfirm: () => void | Promise<void>
  // Initial label (e.g. "⌫ delete check-in").
  label: string
  // Label shown after the first click (e.g. "tap again to confirm"). Defaults to "tap again to confirm".
  confirmLabel?: string
  // Seconds before the armed state reverts. Defaults to 3.
  armedSeconds?: number
  // Pass through to the underlying button class. Defaults to "btn-del" — the project's red-tinted full-width style.
  className?: string
  disabled?: boolean
}

// Two-press delete button. First click arms the action and shows a confirm
// label for a few seconds; a second click within the window triggers the
// onConfirm callback. Replaces native window.confirm() so destructive
// actions stay inside the visual style of the app.
export function ConfirmDeleteButton({
  onConfirm, label, confirmLabel = 'tap again to confirm',
  armedSeconds = 3, className = 'btn-del', disabled,
}: Props) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function handleClick() {
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), armedSeconds * 1000)
      return
    }
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setArmed(false)
    onConfirm()
  }

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      disabled={disabled}
      style={armed ? { borderColor: 'rgba(184,64,64,0.7)', color: 'rgba(184,64,64,0.95)' } : undefined}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}
