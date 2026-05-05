'use client'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  children: ReactNode
  onClose: () => void
  // Max width of the inner sheet. Most callers use 560 or 600.
  maxWidth?: number
  // Optional minHeight floor for the inner sheet so sparse content
  // doesn't render as a tiny strip. Pass any CSS length string.
  minHeight?: string
  // Optional maxHeight cap on the inner sheet. When set, the sheet
  // scrolls internally instead of letting tall content grow past
  // viewport (which scrolls the backdrop instead). Pre-refactor
  // sheets defaulted to '90vh' with internal scroll — pass that to
  // preserve the cap, or leave undefined to let the backdrop handle
  // overflow.
  maxHeight?: string
  // Override the inner sheet's vertical alignment. Default 'flex-end'
  // (slide up from bottom) — set to 'center' for centered modals if
  // a future caller needs it.
  align?: 'flex-end' | 'center'
}

// Shared modal/sheet primitive.
//
// Renders children inside a fixed-position backdrop, attached to
// document.body via createPortal so the overlay is never trapped in a
// parent stacking context. Several layout styles in this app create a
// containing block for fixed descendants — most notably `.panel` with
// backdrop-filter — and without the portal, modals opened from inside
// such elements render scoped to the parent rather than the viewport.
//
// What this owns:
//   - Portal escape.
//   - Backdrop click-to-close (only when the click target is the
//     backdrop itself, not bubbled from inside).
//   - Escape-key-to-close.
//   - The base "sheet" styling: dark blurred backdrop, sheet anchored
//     to the bottom of the viewport with rounded top corners and a
//     thin grab handle, scroll handled on the backdrop so tall
//     content doesn't get cropped on short viewports.
//
// What the caller owns:
//   - The contents (forms, content, buttons).
//   - Sheet-bar visibility (call sites add their own `<div className="sheet-bar" />`
//     if they want one — kept here as a caller responsibility for now
//     since not every modal needs it).
export function Modal({ children, onClose, maxWidth = 560, minHeight, maxHeight, align = 'flex-end' }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: align, justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: '100%', maxWidth,
          ...(minHeight ? { minHeight } : {}),
          ...(maxHeight ? { maxHeight, overflowY: 'auto' } : {}),
          background: 'var(--bg2)',
          borderRadius: '22px 22px 0 0',
          padding: 18, paddingBottom: 32,
          ...(align === 'flex-end' ? { marginTop: 'auto' } : {}),
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
