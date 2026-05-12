'use client'
import { useEffect, useRef, useState } from 'react'

// Detects "pull past the boundary" gestures on a scroll container and
// fires prev/next callbacks when the pull crosses a threshold.
// Returns the live pull distance + which boundary the gesture is at,
// so callers can render a visual indicator.
//
// Touch-only. The container is expected to have `touch-action: pan-y`
// permanently — native iOS scroll handles all in-content scrolling
// including momentum/inertia. We layer a pull gesture on top by
// listening to touchmove with `{passive: false}`: when the user
// reaches a boundary and continues to drag past it, we preventDefault
// the move and accumulate `pullDistance`. Below threshold, releasing
// snaps back; past threshold, fires the swap.
//
// The trick that makes this work: `overscroll-behavior: contain` on
// the container prevents iOS from rubber-banding (or pull-to-refresh).
// When the user reaches the scrollTop=0 or scrollTop=max boundary,
// iOS continues to deliver touchmove events without committing to a
// native scroll/bounce. We can call preventDefault inside touchmove
// because we registered the listener with passive:false; that turns
// the rest of the gesture into a pure JS gesture.
//
// Wheel events do nothing here — desktop users use the prev/next
// footer buttons.
//
// IMPORTANT: requires `overscroll-behavior: contain` AND
// `touch-action: pan-y` on the container.

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

  // Refs for gesture state. Touch events fire 60Hz during a drag; we
  // avoid setState on every tick where possible.
  const dragStartY = useRef<number | null>(null)
  const dragBoundary = useRef<Boundary>(null)
  // Touch identifier of the primary (first) finger that owns the
  // current gesture. Subsequent touches (pinch attempts) are ignored.
  const activeTouchId = useRef<number | null>(null)
  // True once we've committed to a pull gesture (started
  // preventDefault'ing touchmoves). Until then, touches pass through
  // to native iOS scroll.
  const pulling = useRef(false)
  const isFirstRef = useRef(isFirst)
  const isLastRef = useRef(isLast)
  const disabledRef = useRef(disabled)
  const pullDistanceRef = useRef(0)
  const onSwapPrevRef = useRef(onSwapPrev)
  const onSwapNextRef = useRef(onSwapNext)
  onSwapPrevRef.current = onSwapPrev
  onSwapNextRef.current = onSwapNext
  useEffect(() => { isFirstRef.current = isFirst }, [isFirst])
  useEffect(() => { isLastRef.current = isLast }, [isLast])
  useEffect(() => { disabledRef.current = disabled }, [disabled])
  useEffect(() => { pullDistanceRef.current = pullDistance }, [pullDistance])

  // Reset transient state. Called on touchend, touchcancel, or when
  // disabled flips to true mid-gesture.
  function reset() {
    dragStartY.current = null
    dragBoundary.current = null
    activeTouchId.current = null
    pulling.current = false
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
      // Cheaper to compute on demand than to cache and invalidate —
      // and reads here happen at most once per touchstart and once
      // per touchmove that's already at boundary (which is rare for
      // most gestures).
      return Math.ceil(el!.scrollTop + el!.clientHeight) >= el!.scrollHeight
    }

    function onTouchStart(e: TouchEvent) {
      if (disabledRef.current) return
      // Single-touch only. Once a primary touch is active, any
      // additional fingers (pinch attempts) are ignored.
      if (activeTouchId.current !== null) return
      const t = e.changedTouches[0]
      if (!t) return
      // No special bail for form controls (textarea/input). Our pull
      // engages on the first significant touchmove via preventDefault
      // — that fires before iOS commits to text-selection / caret
      // positioning for a fresh gesture, so pull from an unfocused
      // textarea at a boundary works. Focused textareas (user is
      // typing) keep native text-selection behavior because they're
      // not typically at a scroll boundary while editing.
      //
      // Score slider / flavor bars have their own pointer handlers
      // with horizontal-intent detection. They don't need a bail here.
      //
      // Decide initial boundary from scroll position. If we're at a
      // boundary, this gesture is a CANDIDATE for pull. Mid-content:
      // bail entirely — native scroll handles the gesture without
      // any JS involvement.
      const top = atTopBoundary()
      const bot = atBottomBoundary()
      if (!top && !bot) return  // mid-content, native scroll only
      activeTouchId.current = t.identifier
      dragStartY.current = t.clientY
      if (top && bot) dragBoundary.current = null  // short modal: defer to move
      else if (top) dragBoundary.current = 'top'
      else dragBoundary.current = 'bottom'
    }

    function onTouchMove(e: TouchEvent) {
      if (disabledRef.current) { reset(); return }
      if (dragStartY.current === null) return
      // Find the touch that owns the gesture.
      let t: Touch | null = null
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId.current) {
          t = e.changedTouches[i]
          break
        }
      }
      if (!t) return
      const delta = t.clientY - dragStartY.current

      // If we haven't engaged pull yet, decide whether to start.
      if (!pulling.current) {
        let candidate: Boundary = dragBoundary.current
        if (candidate === null) {
          // Short modal case — direction picks the boundary.
          if (Math.abs(delta) < 2) return
          candidate = delta > 0 ? 'top' : 'bottom'
        } else {
          // Direction filter: must be dragging PAST the boundary,
          // not into content. iOS Safari: the FIRST touchmove of a
          // fresh gesture has e.cancelable === true even with
          // touch-action: pan-y, because iOS hasn't committed to
          // native scroll yet. After we preventDefault here, iOS
          // gives the gesture to JS for the rest of its life.
          //
          // CRITICAL: the engage decision must happen on the first
          // significant move (2-3px). If we wait longer (4px+) and
          // native scroll has already started any inertia, cancelable
          // flips to false and preventDefault becomes a no-op — the
          // user ends up scrolling AND triggering a pull simultaneously,
          // producing the "slide through + broken render" bug.
          if (Math.abs(delta) < 2) return
          const pastTop = candidate === 'top' && delta > 0
          const pastBottom = candidate === 'bottom' && delta < 0
          if (!pastTop && !pastBottom) {
            // Wrong direction — user is scrolling into content from
            // the boundary. Disengage entirely so iOS native scroll
            // takes over for the rest of this gesture. dragStartY
            // clears so subsequent moves in this gesture short-
            // circuit at the early-return at top of onTouchMove.
            dragStartY.current = null
            dragBoundary.current = null
            activeTouchId.current = null
            return
          }
        }
        // Engage pull.
        pulling.current = true
        dragBoundary.current = candidate
      }

      // We're pulling. Compute signed distance with resistance, cap
      // at hard boundaries (first/last wine), and visual update.
      let signed = delta * RESISTANCE
      const isBlocked =
        (dragBoundary.current === 'top' && isFirstRef.current) ||
        (dragBoundary.current === 'bottom' && isLastRef.current)
      if (isBlocked) {
        signed = Math.sign(signed) * Math.min(Math.abs(signed), THRESHOLD * 0.4)
      }
      // preventDefault stops iOS from doing any native scroll/bounce
      // for the rest of the gesture. Must be inside touchmove with
      // passive:false (set at listener registration).
      if (e.cancelable) e.preventDefault()
      setBoundary(dragBoundary.current)
      setPullDistance(signed)
    }

    function onTouchEnd(e: TouchEvent) {
      // Only fire on the release of the owning touch.
      let matched = false
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId.current) {
          matched = true
          break
        }
      }
      if (!matched) return
      if (!pulling.current) {
        // No pull engaged — gesture was either native scroll or a tap.
        reset()
        return
      }
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

    function onTouchCancel(e: TouchEvent) {
      let matched = false
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId.current) {
          matched = true
          break
        }
      }
      if (matched) reset()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    // touchmove must be passive:false so we can preventDefault once
    // the pull engages. iOS honors preventDefault to suppress the
    // default scroll for the rest of the gesture.
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
    // Listeners bind once per containerRef. Stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef])

  return { pullDistance, boundary, threshold: THRESHOLD }
}
