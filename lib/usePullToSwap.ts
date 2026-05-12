'use client'
import { useEffect, useRef, useState } from 'react'

// Detects "pull past the boundary" gestures on a scroll container and
// fires prev/next callbacks when the pull crosses a threshold.
// Returns the live pull distance + which boundary the gesture is at,
// so callers can render a visual indicator.
//
// Touch-only. Standard PointerEvent drag — the user is at the top
// (scrollTop===0) or bottom of the container's scroll area, keeps
// dragging in the same direction. Past ~80px, releasing fires the
// swap. Below threshold, releasing snaps back.
//
// Wheel events deliberately do nothing here. Multiple attempts to
// implement wheel-driven swap (instant fire, accumulation, dwell
// timers, idle-gap filters) all produced either over-eager swaps on
// momentum scrolls or unresponsive gestures on slow scrolls. The
// browser's native scroll handles wheel events. Desktop users
// navigate between wines via the prev/next footer buttons.
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
  // The pointerId of the touch/pointer that started the active
  // gesture. Used to ignore secondary fingers — e.g. when a user
  // pinch-zooms the bottle photo, iOS Safari fires pointerdown for
  // each new finger. Without tracking the active id, the second
  // finger would overwrite dragStartY mid-pull and produce wildly
  // wrong delta on the next pointermove (potentially firing a stray
  // swap on release).
  const activePointerId = useRef<number | null>(null)
  // Last clientY of the gesture — used by the wrong-direction
  // manual-scroll branch to compute incremental delta and translate it
  // into a scrollTop adjustment. When `touch-action: none` is active
  // at a boundary, iOS won't fall back to native scroll if the user
  // drags into content. We replicate the scroll manually here.
  const lastClientY = useRef<number | null>(null)
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
    activePointerId.current = null
    lastClientY.current = null
    setPullDistance(0)
    setBoundary(null)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // Boundary detection. When the container has no scrollable
    // content (scrollHeight === clientHeight), both `atTopBoundary`
    // and `atBottomBoundary` return true simultaneously. onPointerDown
    // handles that case by deferring the boundary decision to the
    // first onPointerMove (drag direction disambiguates).
    // Cache `maxScrollTop = scrollHeight - clientHeight` so the scroll
    // callback doesn't read layout-dependent properties on every
    // frame. Reading scrollHeight/clientHeight inside a scroll handler
    // forces iOS Safari to flush pending layout, which can stutter or
    // abort momentum scroll. The cache is refreshed on resize (via
    // the ResizeObserver below) — that covers tab switches, viewport
    // resizes, and any other content-height changes.
    //
    // -1 sentinel: "not yet computed." First scroll event after
    // mount computes it once.
    let maxScrollTop = -1
    function refreshMaxScrollTop() {
      maxScrollTop = Math.max(0, el!.scrollHeight - el!.clientHeight)
    }
    function atTopBoundary(): boolean {
      return el!.scrollTop <= 0
    }
    function atBottomBoundary(): boolean {
      if (maxScrollTop < 0) refreshMaxScrollTop()
      return el!.scrollTop >= maxScrollTop
    }

    // iOS Safari's `touch-action` is read at the START of each
    // gesture and locked for that gesture's duration. Flipping it
    // inside `pointerdown` is too late — iOS already classified the
    // gesture. So we proactively toggle based on SCROLL POSITION:
    //
    //   - At a boundary (scrollTop===0 or scrollTop===max): set
    //     `touch-action: none` so the NEXT pointerdown gives the
    //     gesture to JS (we can pull).
    //   - Within scrollable content: set `touch-action: pan-y` so
    //     native scroll handles the gesture.
    //
    // Trade-off: the user has to LIFT their finger and re-touch
    // once they've scrolled to a boundary — they can't continue the
    // same scroll-into-pull gesture in one motion. This matches the
    // iOS Mail / Twitter web pull-to-refresh pattern: scroll to top,
    // lift, then pull.
    //
    // The `scroll` event fires AFTER the scroll happens — by then
    // the gesture is already JS-classified-or-not. So the next
    // pointer gesture is what we're prepping for. The next gesture
    // starts with the new touch-action value.
    // Last-known boundary state — used to skip redundant DOM writes
    // during scroll. The scroll event fires on every frame; without
    // this cache we'd be doing style reads/writes 60 times per second
    // even when boundary state hasn't changed, which stutters iOS
    // momentum scroll.
    let lastAtBoundary: boolean | null = null
    function updateTouchAction() {
      const atBoundary = atTopBoundary() || atBottomBoundary()
      if (atBoundary === lastAtBoundary) return  // no change, skip all DOM work
      lastAtBoundary = atBoundary
      el!.style.touchAction = atBoundary ? 'none' : 'pan-y'
      if (atBoundary) el!.setAttribute('data-at-boundary', '')
      else el!.removeAttribute('data-at-boundary')
    }
    // Initialize once on mount — at modal open, scrollTop is 0 so
    // we're at top boundary, so touchAction starts as 'none' and the
    // first touch is JS-owned (pull works without scrolling first).
    updateTouchAction()

    // ResizeObserver invalidates the cache + re-checks boundary state
    // when scrollRef's content height changes. This happens when the
    // user switches tabs (info ↔ rate) within the wine modal: the
    // body swaps, scrollHeight changes, and the cached boundary state
    // may no longer reflect reality. Without this, switching from a
    // tall tab (where we were at boundary, touch-action: none) to a
    // short tab leaves touch-action stuck at none — locking the user
    // out of native scroll on the new tab.
    let resizeObs: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        // Refresh the cached scroll-bounds and force the boundary
        // cache to be stale so updateTouchAction does the work this
        // time. Cheap.
        refreshMaxScrollTop()
        lastAtBoundary = null
        updateTouchAction()
      })
      resizeObs.observe(el)
    }

    function onPointerDown(e: PointerEvent) {
      if (disabledRef.current) return
      // Only primary button / single touch. Ignore mouse middle/right.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // Single-pointer guard. If a gesture is already in progress
      // (active touch hasn't been released yet), ignore secondary
      // fingers. Without this, a pinch-zoom or stray second-finger
      // touch would overwrite dragStartY mid-pull.
      if (activePointerId.current !== null) return
      // Skip interactive controls that own their own pointer drag —
      // notably the score slider and flavor-intensity bars in
      // RatingPane. Those controls are sized to fill the rate pane's
      // top/bottom regions, which sit at scroll boundaries, so a
      // vertical wobble during their horizontal drag would otherwise
      // trip a pull-swap. Marking those elements with `data-no-pull`
      // is the integration contract: anything inside such an element
      // skips the pull gesture.
      const target = e.target as Element | null
      if (target?.closest('[data-no-pull]')) {
        // Within a control that owns its own gesture (score slider /
        // flavor bars). Those use directional intent detection to
        // claim only horizontal drags; vertical drags fall through
        // to scrollRef's native pan-y (when not at boundary) or the
        // pull-gesture path below (when at boundary). We don't have a
        // separate branch here — falling through to the normal
        // boundary check yields the right behavior.
      }
      const top = atTopBoundary()
      const bot = atBottomBoundary()
      // If NOT at a boundary, the gesture is just a content scroll.
      // - `inNoPull` controls handle horizontal themselves via their
      //   own setPointerCapture; vertical falls through to pan-y
      //   native scroll on scrollRef.
      // - Non-no-pull areas similarly use pan-y native scroll.
      // Either way, no JS gesture tracking is needed here.
      if (!top && !bot) { dragBoundary.current = null; return }
      // We're at a boundary. Arm the gesture for either:
      // - Pull (drag in the "load adjacent wine" direction)
      // - Manual scroll (drag into content; iOS can't pan-y because
      //   touch-action:none is active at the boundary — see
      //   updateTouchAction).
      // Both branches are handled by onPointerMove below. The
      // inNoPull flag doesn't change this logic: vertical drag on a
      // flavor bar at boundary should pull OR scroll the same as a
      // drag on plain section padding.
      //
      // Short modals (scrollHeight === clientHeight) satisfy BOTH
      // atTopBoundary AND atBottomBoundary simultaneously. We defer
      // the boundary decision to the first onPointerMove in that
      // case — drag direction disambiguates which boundary the user
      // is pulling away from.
      if (top && bot) dragBoundary.current = null  // defer to first move
      else if (top) dragBoundary.current = 'top'
      else dragBoundary.current = 'bottom'
      dragStartY.current = e.clientY
      lastClientY.current = e.clientY
      activePointerId.current = e.pointerId
    }

    function onPointerMove(e: PointerEvent) {
      if (disabledRef.current) { reset(); return }
      if (dragStartY.current === null) return
      // Only the pointer that originated the gesture contributes.
      // Other pointers (e.g. second finger of an attempted pinch)
      // are ignored.
      if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return
      const delta = e.clientY - dragStartY.current
      // Deferred-boundary case (short modal: both edges
      // satisfied at pointerdown). The first non-trivial move
      // resolves which boundary the user is pulling away from:
      // dragging down = pull from top (load previous); dragging
      // up = pull from bottom (load next).
      if (!dragBoundary.current) {
        if (Math.abs(delta) < 4) return  // ignore micro-jitter
        dragBoundary.current = delta > 0 ? 'top' : 'bottom'
      }
      // Direction filter: at top, only count positive (downward) pulls.
      // At bottom, only count negative (upward) pulls. The opposite
      // direction = manual scroll, see below.
      let signed = 0
      if (dragBoundary.current === 'top' && delta > 0) {
        signed = delta * RESISTANCE
      } else if (dragBoundary.current === 'bottom' && delta < 0) {
        signed = delta * RESISTANCE  // already negative
      } else {
        // Wrong direction — the user is scrolling INTO content, away
        // from the boundary. Normally the browser would handle this
        // as native scroll. But we've set `touch-action: none` on the
        // element to claim pull gestures (see updateTouchAction), so
        // iOS won't fall back to native scroll for this gesture.
        // Instead we scroll the container manually: subtract the
        // incremental clientY delta from scrollTop. This replicates
        // native scroll behavior for the rest of the gesture.
        //
        // We do NOT call reset() here — we keep dragStartY/boundary
        // intact so the user can continue dragging in this gesture.
        // The boundary value is sticky (set at pointerdown); if the
        // user reverses direction back toward the boundary later in
        // the gesture, the original boundary direction is still
        // honored. (Edge case; unlikely real-world.)
        const lastY = lastClientY.current ?? e.clientY
        const incremental = e.clientY - lastY  // signed
        // To scroll: positive incremental (finger moving down) at top
        // boundary should pull content DOWN under the finger, which
        // means scrollTop... actually we want the OPPOSITE. Finger
        // moves down → user sees content move down → in scroll terms,
        // scrollTop decreases (showing earlier content). Since we're
        // at scrollTop=0, this is a no-op. At top boundary, wrong-
        // direction is finger moving UP (negative delta), which means
        // scroll DOWN to see later content → scrollTop increases.
        // Formula: scrollTop -= incremental (finger up = negative
        // incremental = scrollTop increases).
        el!.scrollTop -= incremental
        lastClientY.current = e.clientY
        if (e.cancelable) e.preventDefault()
        return
      }
      lastClientY.current = e.clientY
      // We've now confirmed this is a pull gesture, not a scroll.
      // preventDefault stops iOS Safari from giving the gesture to
      // its native vertical-pan scroll handler, which would
      // otherwise eat the move events and prevent our translateY
      // rubber-band from rendering.
      if (e.cancelable) e.preventDefault()
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

    function onPointerUp(e: PointerEvent) {
      // Only respond to release of the pointer that owned the gesture.
      // Releases of secondary fingers (during a multi-touch attempt)
      // are ignored — the gesture continues on the original pointer
      // until it's released too.
      if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return
      if (dragStartY.current === null) return
      const dist = pullDistanceRef.current
      const bnd = dragBoundary.current
      const blocked =
        (bnd === 'top' && isFirstRef.current) ||
        (bnd === 'bottom' && isLastRef.current)
      if (!blocked && Math.abs(dist) >= THRESHOLD) {
        if (bnd === 'top' && dist > 0) onSwapPrevRef.current()
        else if (bnd === 'bottom' && dist < 0) onSwapNextRef.current()
      }
      reset()
    }

    function onPointerCancel(e: PointerEvent) {
      if (activePointerId.current !== null && e.pointerId !== activePointerId.current) return
      reset()
    }

    // Wheel-based swap is deliberately NOT implemented. Multiple
    // attempts to make it feel right (instant fire, threshold
    // accumulation, dwell timers, idle-gap filters) all produced
    // either over-eager swaps on momentum scrolls or unresponsive
    // gestures on slow scrolls. Trackpad delta semantics + browser
    // scroll integration are too messy to get right without a heavy
    // state machine that introduces its own bugs. Desktop users
    // navigate via the prev/next footer buttons; touch users get the
    // pull gesture above. Wheel just scrolls content natively.

    // Proactively re-evaluate touch-action whenever scroll position
    // changes — that's when boundary state can flip.
    function onScroll() { updateTouchAction() }
    el.addEventListener('scroll', onScroll, { passive: true })

    el.addEventListener('pointerdown', onPointerDown)
    // `pointermove` registered with `{passive: false}` so we can call
    // preventDefault inside the handler once the gesture has engaged.
    // Without this, iOS Safari hands the vertical-drag gesture to its
    // native scroll handler — even when scrollTop is at the boundary
    // and there's no content to scroll. The result: our handler never
    // sees pointermove deltas, the user pulls but nothing happens.
    // With passive:false + preventDefault, we explicitly take over the
    // gesture once we know it's a pull-to-swap (not a content scroll).
    el.addEventListener('pointermove', onPointerMove, { passive: false })
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)

    return () => {
      if (resizeObs) resizeObs.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
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
