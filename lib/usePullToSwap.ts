'use client'
import { useEffect, useRef, useState } from 'react'

// Detects "pull past the boundary" gestures on a scroll container and
// fires prev/next callbacks when the pull crosses a threshold.
// Returns the live pull distance + which boundary the gesture is at,
// so callers can render a visual indicator.
//
// Mental model: standard vertical scrolling within the container works
// normally. When the user reaches the top (scrollTop===0) and keeps
// dragging down — or reaches the bottom and keeps dragging up — that
// extra drag is captured here. Past ~80px, releasing fires the swap.
// Below ~80px, releasing snaps back.
//
// Touch + mouse: handled via PointerEvents (one API for both).
// Wheel: a parallel path accumulates wheel deltas over a short window
// for trackpad/mouse-wheel overscroll-to-swap on desktop.
//
// IMPORTANT: relies on `overscroll-behavior: contain` and
// `touch-action: pan-y` being set on the container element by the
// caller. Without `overscroll-behavior: contain`, the browser's
// native pull-to-refresh on mobile interferes with the gesture.

export type Boundary = 'top' | 'bottom' | null

interface Options {
  containerRef: React.RefObject<HTMLDivElement | null>
  isFirst: boolean
  isLast: boolean
  // True while a commit POST is in flight — gesture is disabled so
  // mid-flight swaps don't queue up behind it.
  disabled: boolean
  onSwapPrev: () => void
  onSwapNext: () => void
}

const THRESHOLD = 80          // pixels of pull past boundary to fire
const RESISTANCE = 0.5        // visual feel — pull lags behind actual drag
const WHEEL_WINDOW = 400      // ms; wheel-delta accumulation reset window

export function usePullToSwap({
  containerRef, isFirst, isLast, disabled, onSwapPrev, onSwapNext,
}: Options) {
  // pullDistance: signed. Positive = pulling down at the top boundary
  // (= "load previous"). Negative = pulling up at the bottom boundary
  // (= "load next"). Zero when not pulling.
  const [pullDistance, setPullDistance] = useState(0)
  // Which boundary the active gesture is anchored to. null when the
  // user isn't pulling. Used by the caller to render the right
  // indicator copy ("pull to load previous" vs "next").
  const [boundary, setBoundary] = useState<Boundary>(null)

  // Refs for gesture state — kept out of React state to avoid re-renders
  // on every pointermove tick. Only the visible `pullDistance` triggers
  // renders, throttled implicitly by browser layout.
  const dragStartY = useRef<number | null>(null)
  const dragBoundary = useRef<Boundary>(null)
  const isFirstRef = useRef(isFirst)
  const isLastRef = useRef(isLast)
  const disabledRef = useRef(disabled)
  // Mirror pullDistance into a ref so pointerup can read the latest
  // committed value without depending on closure capture timing.
  const pullDistanceRef = useRef(0)
  // Callback refs — mirror the latest swap handlers without forcing
  // the main listener-binding effect to re-run on every parent render.
  // Direct assignment on every render keeps `.current` fresh; the
  // event listeners read `.current` at call time, so they always see
  // the latest closure (which captures the latest `commitAndSwap`,
  // `activeWineId`, `rating`, etc. from WineModal). Without this
  // pattern the main effect would have to re-bind 5 listeners on
  // every parent render — a noisy perf wart in the modal that polls.
  const onSwapPrevRef = useRef(onSwapPrev)
  const onSwapNextRef = useRef(onSwapNext)
  onSwapPrevRef.current = onSwapPrev
  onSwapNextRef.current = onSwapNext
  useEffect(() => { isFirstRef.current = isFirst }, [isFirst])
  useEffect(() => { isLastRef.current = isLast }, [isLast])
  useEffect(() => { disabledRef.current = disabled }, [disabled])
  useEffect(() => { pullDistanceRef.current = pullDistance }, [pullDistance])

  // Reset transient state at session/wine boundaries.
  function reset() {
    dragStartY.current = null
    dragBoundary.current = null
    setPullDistance(0)
    setBoundary(null)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function atTopBoundary(): boolean {
      return el!.scrollTop <= 0
    }
    function atBottomBoundary(): boolean {
      return Math.ceil(el!.scrollTop + el!.clientHeight) >= el!.scrollHeight
    }

    function onPointerDown(e: PointerEvent) {
      if (disabledRef.current) return
      // Only primary button / single touch. Ignore mouse middle/right.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // Skip interactive controls that own their own pointer drag —
      // notably the score slider and flavor-intensity bars in
      // RatingPane. Those controls are sized to fill the rate pane's
      // top/bottom regions, which sit at scroll boundaries, so a
      // vertical wobble during their horizontal drag would otherwise
      // trip a pull-swap. Marking those elements with `data-no-pull`
      // is the integration contract: anything inside such an element
      // skips the pull gesture.
      const target = e.target as Element | null
      if (target?.closest('[data-no-pull]')) return
      // Only start tracking if we're sitting at a boundary at the
      // moment of pointerdown. If the user is mid-scroll, normal
      // scrolling handles it; we only kick in at the edge.
      if (atTopBoundary()) dragBoundary.current = 'top'
      else if (atBottomBoundary()) dragBoundary.current = 'bottom'
      else { dragBoundary.current = null; return }
      dragStartY.current = e.clientY
    }

    function onPointerMove(e: PointerEvent) {
      if (disabledRef.current) { reset(); return }
      if (dragStartY.current === null || !dragBoundary.current) return
      const delta = e.clientY - dragStartY.current
      // Direction filter: at top, only count positive (downward) pulls.
      // At bottom, only count negative (upward) pulls. The opposite
      // direction = normal scroll, handled by the browser.
      let signed = 0
      if (dragBoundary.current === 'top' && delta > 0) {
        signed = delta * RESISTANCE
      } else if (dragBoundary.current === 'bottom' && delta < 0) {
        signed = delta * RESISTANCE  // already negative
      } else {
        // Wrong direction — user is scrolling back into the content.
        // Let the browser handle it; release our anchor so we don't
        // keep tracking until pointerup.
        reset()
        return
      }
      // If this is the first wine + pulling down at top, OR the last
      // wine + pulling up at bottom, we still show the boundary
      // indicator but cap the visual pull at ~half the threshold so
      // the user gets a hint they're stuck.
      const isBlocked =
        (dragBoundary.current === 'top' && isFirstRef.current) ||
        (dragBoundary.current === 'bottom' && isLastRef.current)
      if (isBlocked) {
        signed = Math.sign(signed) * Math.min(Math.abs(signed), THRESHOLD * 0.4)
      }
      setBoundary(dragBoundary.current)
      setPullDistance(signed)
    }

    function onPointerUp() {
      if (dragStartY.current === null) return
      const dist = pullDistanceRef.current
      const bnd = dragBoundary.current
      const blocked =
        (bnd === 'top' && isFirstRef.current) ||
        (bnd === 'bottom' && isLastRef.current)
      // Fire swap when past threshold AND not at a hard boundary.
      if (!blocked && Math.abs(dist) >= THRESHOLD) {
        if (bnd === 'top' && dist > 0) onSwapPrevRef.current()
        else if (bnd === 'bottom' && dist < 0) onSwapNextRef.current()
      }
      reset()
    }

    function onPointerCancel() { reset() }

    // Wheel path — accumulates deltaY over a short window when the
    // container is at a boundary and the wheel is pushing past it.
    let wheelAccum = 0
    let wheelBoundary: Boundary = null
    let wheelTimer: ReturnType<typeof setTimeout> | null = null
    function clearWheel() {
      wheelAccum = 0
      wheelBoundary = null
      if (wheelTimer) { clearTimeout(wheelTimer); wheelTimer = null }
      setPullDistance(0)
      setBoundary(null)
    }
    function onWheel(e: WheelEvent) {
      if (disabledRef.current) return
      // Only count wheel events when sitting at a boundary in the
      // direction of the wheel push. Otherwise the browser handles
      // normal scrolling.
      const downward = e.deltaY < 0
      const upward = e.deltaY > 0
      if (atTopBoundary() && downward) {
        wheelBoundary = 'top'
      } else if (atBottomBoundary() && upward) {
        wheelBoundary = 'bottom'
      } else {
        clearWheel()
        return
      }
      // Block at hard boundaries (capped visual hint, no fire).
      const blocked =
        (wheelBoundary === 'top' && isFirstRef.current) ||
        (wheelBoundary === 'bottom' && isLastRef.current)
      // Accumulate. deltaY sign: positive = scroll down = at bottom
      // pushing further down. We want pullDistance signed same as the
      // pointer path: positive at top (going prev), negative at
      // bottom (going next). Map: top + downward (negative deltaY) →
      // positive pullDistance; bottom + upward (positive deltaY) →
      // negative pullDistance.
      const contribution = -e.deltaY * RESISTANCE
      wheelAccum += contribution
      // Cap visual pull at hard boundaries.
      let displayed = wheelAccum
      if (blocked) {
        displayed = Math.sign(displayed) * Math.min(Math.abs(displayed), THRESHOLD * 0.4)
      }
      setBoundary(wheelBoundary)
      setPullDistance(displayed)
      // Prevent the browser's overscroll bounce from interfering when
      // we've taken over the gesture.
      e.preventDefault()
      // Fire when accumulated past threshold (and not blocked).
      if (!blocked && Math.abs(wheelAccum) >= THRESHOLD) {
        if (wheelBoundary === 'top' && wheelAccum > 0) onSwapPrevRef.current()
        else if (wheelBoundary === 'bottom' && wheelAccum < 0) onSwapNextRef.current()
        clearWheel()
        return
      }
      // Reset the accumulator after a brief idle — prevents stale
      // pull state if the user pauses the wheel.
      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = setTimeout(clearWheel, WHEEL_WINDOW)
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('wheel', onWheel)
      clearWheel()
    }
    // Listeners bind ONCE per scroll container — callbacks and
    // booleans flow through refs (onSwapPrevRef/onSwapNextRef +
    // isFirstRef/isLastRef/disabledRef) so the parent's renders
    // never re-bind. The empty-array spirit is preserved by depending
    // only on `containerRef` (stable across renders by the caller's
    // useRef contract).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef])

  return { pullDistance, boundary, threshold: THRESHOLD }
}
