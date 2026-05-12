'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Module-level stack of open Modal instances. The Escape key closes only
// the topmost (most recently opened) — without this, every open Modal's
// own keydown listener would fire and they'd all close at once. That's
// jarring when modals stack (e.g. RatingScreen has an "edit wine" button
// that opens AddWineModal on top — Escape there should close just the
// inner one and leave the outer one alone).
//
// Tokens are arbitrary objects — we just need referential identity to
// compare "is this the topmost?". A useRef gives us a stable token per
// component instance.
const modalStack: object[] = []

// Current depth of the modal stack — number of open Modal instances.
// Consumers that need to gate window-level handlers (e.g. keyboard
// nav) on "no other modal is on top of mine" can read this and
// compare against their own expected depth.
//
// Example: a modal that knows it should be at depth N when no inner
// confirm is open, depth N+1 when one is open, can compute "am I
// topmost?" without needing a token. Read at call time (e.g. inside
// the event handler), NOT at render time — depth changes don't
// trigger re-renders.
export function getModalStackDepth(): number {
  return modalStack.length
}

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
//   - Escape-key-to-close (only the topmost modal in the stack).
//   - The base "sheet" styling: dark blurred backdrop, sheet anchored
//     to the bottom of the viewport with rounded top corners; scroll
//     handled on the backdrop so tall content doesn't get cropped on
//     short viewports.
//
// What the caller owns:
//   - The contents (forms, content, buttons).
//   - A visible close affordance (top-right `btn-s` "close" button is
//     the convention — see SessionPanel for the canonical example).
export function Modal({ children, onClose, maxWidth = 560, minHeight, maxHeight, align = 'flex-end' }: Props) {
  // Stable token for this Modal instance — used to identify ourselves in
  // the open-modal stack so we only respond to Escape when topmost.
  const tokenRef = useRef<object>({})

  // Capture onClose in a ref so the mount/unmount effect can stay
  // dep-free. Without this, a parent re-render passing a new arrow
  // function would re-run the effect, popping and re-pushing this
  // Modal's token — which reorders the stack when modals are nested
  // and an outer parent re-renders during a poll. The effect below
  // must mount exactly once per Modal lifetime.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Track whether the latest mousedown originated on the backdrop.
  // Only close if BOTH endpoints (mousedown + click) happened on the
  // backdrop. Without this, a drag that starts on an inner control
  // (e.g. the rating slider) and ends with mouseup over the backdrop
  // fires a `click` event whose target IS the backdrop — and we'd
  // close the modal mid-interaction.
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    const token = tokenRef.current
    const wasFirst = modalStack.length === 0
    modalStack.push(token)
    // Body scroll lock — only the FIRST modal in a stack does this;
    // nested modals (e.g. WineModal's inner Save-confirm) leave body
    // styles alone so the outer modal's restore on close cleans up
    // correctly.
    //
    // Why this exists: on iOS Safari, touch-drag gestures inside a
    // `position:fixed` modal can leak through to the body's scroll,
    // causing the page underneath to scroll AND breaking touch
    // gestures inside the modal (the OS routes the drag to the body's
    // scroll instead of to the modal's pointer event listeners).
    // Standard fix: while a modal is open, fix the body in place and
    // restore on close.
    //
    // Preserves the user's scroll position by storing it before
    // locking and applying it as the body's `top` (so the visible
    // viewport doesn't jump to top), then restoring window.scrollTo
    // on unlock.
    let savedScrollY = 0
    let savedBodyStyles: {
      overflow: string
      position: string
      top: string
      width: string
      overscrollBehavior: string
    } | null = null
    if (wasFirst) {
      savedScrollY = window.scrollY
      const body = document.body
      savedBodyStyles = {
        overflow: body.style.overflow,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        overscrollBehavior: body.style.overscrollBehavior,
      }
      body.style.overflow = 'hidden'
      body.style.position = 'fixed'
      body.style.top = `-${savedScrollY}px`
      body.style.width = '100%'
      // `overscroll-behavior: contain` on body suppresses iOS Safari's
      // "pull-down-to-refresh" gesture and Chrome Android's overscroll
      // bounce while a modal is open. Without this, pulling up at the
      // top of the modal's scroll triggers a page refresh on iOS.
      body.style.overscrollBehavior = 'contain'
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (modalStack[modalStack.length - 1] === token) onCloseRef.current()
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      const i = modalStack.indexOf(token)
      if (i !== -1) modalStack.splice(i, 1)
      // Only the FIRST modal's cleanup restores body. Nested modals
      // didn't touch body styles, so their cleanup is a no-op for
      // those styles. After the last modal closes, body returns to
      // its pre-lock state and the user's scroll position is restored.
      if (wasFirst && savedBodyStyles) {
        const body = document.body
        body.style.overflow = savedBodyStyles.overflow
        body.style.position = savedBodyStyles.position
        body.style.top = savedBodyStyles.top
        body.style.width = savedBodyStyles.width
        body.style.overscrollBehavior = savedBodyStyles.overscrollBehavior
        window.scrollTo(0, savedScrollY)
      }
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: align, justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        overflowY: 'auto',
      }}
      onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={e => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose()
        downOnBackdrop.current = false
      }}
    >
      <div
        style={{
          width: '100%', maxWidth,
          // Sizing logic:
          // - Both minHeight + maxHeight set (e.g. WineModal): use
          //   `display: flex; flex-direction: column` on the sheet so
          //   the inner column's `flex:1` children get definite
          //   heights without needing an explicit `height: 100%` on
          //   the sheet itself. This lets the sheet grow naturally
          //   between min and max based on content, while still
          //   propagating a definite height to descendants so nested
          //   `overflow: auto` actually scrolls (rather than just
          //   expanding to fit content).
          // - Just maxHeight: cap + scroll, no minimum.
          // - Just minHeight: floor.
          ...(minHeight && maxHeight
            ? {
                minHeight,
                maxHeight,
                overflowY: 'auto' as const,
                display: 'flex' as const,
                flexDirection: 'column' as const,
              }
            : maxHeight ? { maxHeight, overflowY: 'auto' as const }
            : minHeight ? { minHeight }
            : {}),
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
