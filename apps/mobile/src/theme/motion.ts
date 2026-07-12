// Spring presets — the token-side companion to vero-tokens' `motion` (which is
// vendored from the design handoff and carries only durations + beziers, so
// engineering-owned spring physics live here). Springs are for gesture-driven
// presentation legs: unlike a fixed-duration bezier they inherit the release
// velocity, so letting go of a drag continues at finger speed instead of
// restarting on a curve (the feed pull-down's "handbrake at release").
// Callers pass `velocity` per-release in the animated value's units/s
// (e.g. -velocityY / DISMISS_DRAG for a 0..1 progress) — everything else
// comes from these presets; never hand-roll damping/stiffness at a call site
// (the motion-tokens ruling applies to springs too).
import type { WithSpringConfig } from 'react-native-reanimated';
import { motion } from './vero-tokens';

export const springs = {
  // Gesture-release / dismissal settle: critically damped, clamped — a
  // presentation's progress must not overshoot its endpoints (a clone past
  // the card frame or wider than the screen reads as a glitch). ⚠️ Reanimated's
  // duration-springs treat `duration` as PERCEPTUAL: the energy threshold that
  // ends the animation (and fires the `finished` callback gating e.g. a route
  // pop) lands at ~1.5× the configured value (springUtils.ts
  // calculateNewStiffnessToMatchDuration). dur2 → ~300ms actual settle, close
  // to the old 200ms bezier close; travel front-loads so it reads snappier.
  // Tune on device with that 1.5× in mind.
  release: {
    duration: motion.dur2,
    dampingRatio: 1,
    overshootClamping: true,
  } satisfies WithSpringConfig,
} as const;
