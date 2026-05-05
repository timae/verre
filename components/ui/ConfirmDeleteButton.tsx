'use client'
import { useState, useEffect, useRef } from 'react'

interface Props {
  onConfirm: () => void | Promise<void>
  // Initial label (e.g. "⌫ delete check-in").
  label: string
  // Label shown after the first click (e.g. "tap again to confirm"). Defaults to "tap again to confirm".
  confirmLabel?: string
  // Label shown briefly when onConfirm rejects. Defaults to "failed — tap to retry".
  failedLabel?: string
  // Seconds before the armed (or failed) state reverts. Defaults to 3.
  armedSeconds?: number
  // Pass through to the underlying button class. Defaults to "btn-del" — the project's red-tinted full-width style.
  className?: string
  disabled?: boolean
}

// Two-press delete button. First click arms the action and shows a confirm
// label for a few seconds; a second click within the window triggers the
// onConfirm callback. Replaces native window.confirm() so destructive
// actions stay inside the visual style of the app.
//
// If onConfirm rejects (network failure, server 5xx, etc.) the button
// surfaces a transient "failed — tap to retry" state. The user can tap
// again to re-arm and try once more — no silent failure.
export function ConfirmDeleteButton({
  onConfirm, label, confirmLabel = 'tap again to confirm',
  failedLabel = 'failed — tap to retry',
  armedSeconds = 3, className = 'btn-del', disabled,
}: Props) {
  const [state, setState] = useState<'idle' | 'armed' | 'pending' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function clearTimer() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
  }

  async function handleClick() {
    if (state === 'pending') return
    if (state === 'idle' || state === 'failed') {
      clearTimer()
      setState('armed')
      timer.current = setTimeout(() => setState('idle'), armedSeconds * 1000)
      return
    }
    // state === 'armed': fire it.
    clearTimer()
    setState('pending')
    try {
      await onConfirm()
      setState('idle')
    } catch {
      setState('failed')
      timer.current = setTimeout(() => setState('idle'), armedSeconds * 1000)
    }
  }

  const armedStyle = { borderColor: 'rgba(184,64,64,0.7)', color: 'rgba(184,64,64,0.95)' }
  const failedStyle = { borderColor: 'rgba(184,64,64,0.9)', color: 'rgba(220,90,90,1)' }
  const style =
    state === 'armed' ? armedStyle :
    state === 'failed' ? failedStyle :
    undefined

  const labelText =
    state === 'armed' ? confirmLabel :
    state === 'pending' ? '…' :
    state === 'failed' ? failedLabel :
    label

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      disabled={disabled || state === 'pending'}
      style={style}
    >
      {labelText}
    </button>
  )
}
