// Semantic haptics API. Two events: tap (deliberate confirmation, e.g.
// pointer-down on a wheel wedge) and tick (a continuous-gesture boundary
// crossing, e.g. crossing a level threshold while dragging).
//
// The web implementation uses navigator.vibrate. iOS Safari (and every
// "Firefox/Chrome on iOS" that's actually WebKit underneath) doesn't
// support the Vibration API at all — those callers get a silent no-op.
// Android Chrome and Firefox vibrate.
//
// The reason this module exists rather than calling navigator.vibrate
// directly: when this app gets a native iOS/Android wrapper, the call
// sites stay identical. The implementation here gets swapped for
// expo-haptics (React Native), UIImpactFeedbackGenerator (Swift), or
// HapticFeedbackConstants (Kotlin) — all of which are richer than the
// web Vibration API. Semantic naming (tap/tick) is what those native
// APIs already use, so the boundary is portable by design.

const TAP_MS = 10
const TICK_MS = 8
const MIN_INTERVAL_MS = 30  // Rate-limit ticks so fast drags don't buzz

let lastTickAt = 0

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function vibrate(ms: number): void {
  if (typeof navigator === 'undefined') return
  if (typeof navigator.vibrate !== 'function') return
  if (reducedMotion()) return
  try {
    navigator.vibrate(ms)
  } catch {
    // Some browsers throw outside a user-gesture context. Swallow —
    // haptics are polish, not load-bearing.
  }
}

export const haptics = {
  // Pointer-down on an interactive target. Single short pulse.
  tap(): void {
    vibrate(TAP_MS)
    // Reset the tick rate-limiter clock so any tick fired immediately
    // after this tap (e.g. when crossing a level boundary at the same
    // moment as engaging the target) is suppressed. The user feels one
    // intentional buzz at engagement, not tap-then-tick stacked.
    lastTickAt = Date.now()
  },

  // Continuous-gesture boundary crossing (e.g. level changed during drag).
  // Rate-limited to MIN_INTERVAL_MS so a fast drag from level 0 to 5
  // doesn't fire 5 pulses in 100ms.
  tick(): void {
    const now = Date.now()
    if (now - lastTickAt < MIN_INTERVAL_MS) return
    lastTickAt = now
    vibrate(TICK_MS)
  },
}
