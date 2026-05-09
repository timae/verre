'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, useDragControls, useMotionValue, animate, type PanInfo } from 'framer-motion'

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

const SWIPE_DISMISS = 100
const SWIPE_VELOCITY = 500

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
//   - The sheet-bar drag handle: rendered automatically for bottom-
//     anchored sheets. Only the handle starts a drag — the sheet body
//     is left alone so form scroll inside the modal never gets
//     hijacked by an accidental swipe.
//
// What the caller owns:
//   - The contents (forms, content, buttons).
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

  useEffect(() => {
    const token = tokenRef.current
    modalStack.push(token)
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (modalStack[modalStack.length - 1] === token) onCloseRef.current()
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      const i = modalStack.indexOf(token)
      if (i !== -1) modalStack.splice(i, 1)
    }
  }, [])

  // Drag-to-dismiss is bottom-anchored sheets only. dragListener=false +
  // explicit dragControls.start ensures only specific gestures arm a drag:
  //   1. Pointerdown on the sheet-bar handle (always arms).
  //   2. Pointerdown anywhere on the body when scrollTop === 0 — i.e.
  //      the user is at scroll-top, an upward drag has nothing to scroll
  //      to, and a downward drag should pull the sheet (iOS native
  //      sheet behaviour). When mid-scroll, body scroll wins.
  const dragControls = useDragControls()
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const draggable = align === 'flex-end'
  const y = useMotionValue(0)
  // Active per-gesture cleanup functions — drained on unmount so that any
  // pointermove/pointerup window listeners don't outlive the component.
  const activeCleanupsRef = useRef<Set<() => void>>(new Set())
  useEffect(() => {
    return () => { activeCleanupsRef.current.forEach(fn => fn()); activeCleanupsRef.current.clear() }
  }, [])

  // Defer-arm: instead of calling dragControls.start on pointerdown (which
  // would steal pointer-capture from anything beneath, breaking chips and
  // form controls), watch for movement direction. Only when the user
  // actually moves vertically — and we're at scroll-top — arm the sheet
  // drag. Horizontal movement leaves the gesture alone so things like
  // FlavorChips' horizontal pan-to-set-intensity still work.
  function onSheetPointerDown(e: React.PointerEvent) {
    if (!draggable) return
    if (e.pointerType !== 'touch') return
    const el = sheetRef.current
    if (!el) return
    if (el.scrollTop > 0) return
    // Skip text-input interactions: typing inside an input shouldn't even
    // be considered for arming. Buttons get clean clicks because no
    // movement = no arm.
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable], a[href]')) return

    const startX = e.clientX
    const startY = e.clientY
    const pointerId = e.pointerId
    const SLOP = 8

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      const dx = Math.abs(ev.clientX - startX)
      const dy = ev.clientY - startY
      if (dy < SLOP) return
      if (dx > Math.abs(dy)) { cleanup(); return }
      cleanup()
      dragControls.start(ev)
    }
    function onEnd(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      cleanup()
    }
    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      activeCleanupsRef.current.delete(cleanup)
    }
    activeCleanupsRef.current.add(cleanup)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  function dismiss() {
    // Slide the sheet off-screen before unmounting so swipe dismissals
    // don't visually cut. ~700px covers any reasonable viewport height.
    animate(y, 700, { duration: 0.18, ease: 'easeIn', onComplete: () => onCloseRef.current() })
  }

  function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.y > SWIPE_DISMISS || info.velocity.y > SWIPE_VELOCITY) dismiss()
  }

  function onHandleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      dismiss()
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: align, justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        overflowY: 'auto',
        // Stop overscroll from pulling the underlying page (which triggers
        // pull-to-refresh on iOS / an aggressive bounce on Safari).
        overscrollBehavior: 'contain',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        ref={sheetRef}
        drag={draggable ? 'y' : false}
        dragControls={dragControls}
        dragListener={false}
        onPointerDown={onSheetPointerDown}
        // Both constraints anchor the rest position. Elastic 1 on the
        // bottom = no resistance, sheet follows finger 1:1 going down.
        // Elastic 0.2 on top = upward drag resists. On release without
        // dismissing, the sheet springs back to y=0 because the value
        // is outside the constraint range while > 0.
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.2, bottom: 1 }}
        onDragEnd={onDragEnd}
        style={{
          width: '100%', maxWidth,
          y,
          ...(minHeight ? { minHeight } : {}),
          ...(maxHeight ? { maxHeight, overflowY: 'auto' } : {}),
          background: 'var(--bg2)',
          borderRadius: '22px 22px 0 0',
          padding: 18, paddingBottom: 32,
          ...(align === 'flex-end' ? { marginTop: 'auto' } : {}),
          // Keep momentum-scroll inside the sheet from bubbling out.
          overscrollBehavior: 'contain',
        }}
      >
        {draggable && (
          // Padded hit area around the visible 36×3px bar — so a slightly-
          // off pointerdown still arms the drag.
          <div
            role="button"
            tabIndex={0}
            aria-label="Dismiss"
            onPointerDown={e => { e.stopPropagation(); dragControls.start(e) }}
            onKeyDown={onHandleKeyDown}
            style={{
              padding: '8px 0', margin: '-8px 0 10px',
              cursor: 'grab', touchAction: 'none',
              display: 'flex', justifyContent: 'center',
            }}
          >
            <div className="sheet-bar" style={{ margin: 0 }} />
          </div>
        )}
        {children}
      </motion.div>
    </div>,
    document.body,
  )
}
