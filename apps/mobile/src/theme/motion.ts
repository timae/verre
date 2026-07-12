// Spring presets — the token-side companion to vero-tokens' `motion` (which is
// vendored from the design handoff and carries only durations + beziers, so
// engineering-owned spring physics live here). Two contracts:
//   • `enter` — a non-gesture entrance (the feed detail's open). No velocity.
//   • `release` — gesture-release / dismissal legs (pull-down close,
//     spring-back, back-button close). Callers pass `velocity` per-release in
//     the animated value's units/s (e.g. -velocityY / DISMISS_DRAG for a 0..1
//     progress), DIRECTION-GATED toward the target (see the feed detail —
//     clamping terminates on an away-velocity).
// Unlike a fixed-duration bezier a spring inherits release velocity, so
// letting go of a drag continues at finger speed instead of restarting on a
// curve. Never hand-roll damping/stiffness at a call site (the motion-tokens
// ruling applies to springs too).
//
// Both are critically damped + clamped: a presentation's progress must not
// overshoot its endpoints (a clone past the card frame or wider than the
// screen reads as a glitch). ⚠️ Reanimated's duration-springs treat `duration`
// as PERCEPTUAL: the energy threshold that ends the animation (and fires the
// `finished` callback gating e.g. a route pop) lands at ~1.5× the configured
// value (springUtils.ts calculateNewStiffnessToMatchDuration). Tune on device
// with that 1.5× in mind.
import type { WithSpringConfig } from 'react-native-reanimated';
import { motion } from './vero-tokens';

export const springs = {
  // Midpoint of dur2/dur3 (260 → ~390ms actual settle): dur2 read "almost a
  // bit too fast" on Simon's device pass (2026-07-12), dur3's ~480ms settle
  // would delay interactivity (pointer-events unlock at physical settle).
  enter: {
    duration: (motion.dur2 + motion.dur3) / 2,
    dampingRatio: 1,
    overshootClamping: true,
  } satisfies WithSpringConfig,
  // dur1 → ~180ms actual settle — one tier quicker than `enter` (Simon,
  // 2026-07-12: the close at dur2 read a touch slow; dismissal is damage
  // control and should be the fastest motion in the presentation).
  release: {
    duration: motion.dur1,
    dampingRatio: 1,
    overshootClamping: true,
  } satisfies WithSpringConfig,
} as const;
