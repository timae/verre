// Score / flavour input policy for NATIVE clients — the pure math the
// app's gesture layer consumes (gesture-handler does the intent
// detection natively; this is just value mapping). The web widgets
// keep their own inline copies of this logic ON PURPOSE: the web's
// touch behaviour is hand-tuned against iOS Safari and stays untouched
// until the web redesign (Simon's ruling, 2026-06-12 — supersedes the
// 03-topology §2a convergence precondition). Values here must match
// the web's behaviour (0.25 snap, whole-step flavours, 0 = not rated).

export const SCORE_MAX = 5
export const SCORE_STEP = 0.25
export const FLAVOUR_MAX = 5

export function snapScore(v: number): number {
  return Math.round(Math.min(SCORE_MAX, Math.max(0, v)) / SCORE_STEP) * SCORE_STEP
}

// Fraction of track width (0..1, clamped) → snapped score.
export function scoreFromFraction(f: number): number {
  return snapScore(Math.max(0, Math.min(1, f)) * SCORE_MAX)
}

// One step up/down — for accessibility increment/decrement actions
// (VoiceOver adjustable) and stepper affordances. 0 = "not rated",
// never a zero rating.
export function stepScore(value: number, direction: 1 | -1): number {
  return snapScore(value + direction * SCORE_STEP)
}

// Fraction of track width → whole-step flavour level 1..5; f < 0
// (touch left of the track) clears to 0.
export function flavourLevelFromFraction(f: number): number {
  if (f < 0) return 0
  return Math.max(1, Math.min(FLAVOUR_MAX, Math.ceil(Math.min(1, f) * FLAVOUR_MAX)))
}

// Tap on the already-set level toggles it off.
export function toggleFlavourLevel(current: number, tapped: number): number {
  return tapped === current ? 0 : tapped
}
