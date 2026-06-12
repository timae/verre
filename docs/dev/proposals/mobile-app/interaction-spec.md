# Interaction spec — gestures & motion (plain-language, platform-neutral)

**Status**: LIVING. Started with milestone 2 (sessions core) to discharge the
[05 §5a](05-design-system.md) obligation: capture the web app's hardcoded
motion/gesture literals BEFORE the Reanimated rewrite (milestone 3) re-hardcodes
them. This file is the durable spec the native gesture hooks implement; the web
gesture code is the behavioral reference, not the asset. Extend it whenever a
gesture/animation behavior is ported or designed.

Sources of truth captured here: `components/wine/WineModal.tsx`,
`components/wine/RatingPane.tsx`, `components/wine/CLAUDE.md`,
`docs/dev/ios-touch-gestures.md`, the Vero handoff §8/§11.

## Motion

| Role | Value | Where it lives today |
|---|---|---|
| Signature slide curve | cubic-bezier `0.25, 0.1, 0.25, 1` | `WineModal.tsx:200` + `:426` (framer-motion literals) |
| Wine-swap slide | 300 ms, slide curve | `WineModal.tsx:425` |
| Sub-threshold spring-back | 200 ms, slide curve | `WineModal.tsx:200` |
| Sheet/slide-over (design) | `--dur-3` + `--ease-out` / `--ease-in` | `vero-tokens.js` motion block (handoff §8) |

Native rewrite note: express the slide curve as `Easing.bezier(0.25, 0.1, 0.25, 1)`
once, in the theme/motion module — never re-inline the literal.

## Pull-to-swap (wine modal)

- **Commit threshold**: pull distance ≥ **80 px** (`PULL_THRESHOLD`,
  `WineModal.tsx:787`) commits the swap to the previous/next wine; below it the
  sheet springs back (200 ms).
- **Direction**: vertical pull at list ends; the slide animates 300 ms in the
  pull direction, content swaps at animation start, scroll position resets
  before the incoming wine renders.
- **Single-flight**: a commit in flight blocks re-entry until the slide's
  `onComplete` releases the gate (the gate is held THROUGH the animation, not
  just the network call).
- **Order**: slide fires before the rating POST; a failed POST aborts the swap
  and surfaces the error in place.
- **Haptic intent (native-only, new)**: light impact on swap commit; none on
  spring-back.

## Score input (slider) — milestone 3, preconditions first

- **Steps**: 0.25; `0` = not rated (ghost star, never a "0 rating").
- **Recognizer (the converged target)**: `touch-action: pan-y` + SLOP-gated
  capture — defer pointer capture until movement past **6 px** (`FLAVOR_SLOP`,
  `RatingPane.tsx:371`) reveals horizontal (capture, drag-to-set) vs vertical
  (let the page scroll) intent. A tap (release under SLOP) commits the tapped
  value directly.
- **Keyboard/a11y (port from canonical `ScoreSlider.tsx`)**: `role=slider`,
  arrows ±0.25, PageUp/Down ±1, Home/End 0/5.
- **Precondition (03 §2a)**: converge the two web score inputs onto the
  SLOP/pan-y recognizer + port the keyboard handler BEFORE extracting any
  `useScoreSlider` hook. The flavour widgets converge the OPPOSITE way
  (`FlavorChips`' hidden-range-input a11y is the stronger source) — verify per
  widget.
- **Haptic intent (native-only, new)**: selection tick on each 0.25 step while
  dragging; light impact on commit.

## Flavour fill-track input

- Whole steps 0–5, tap or drag fills in the flavour's colour, no thumb.
- Same SLOP recognizer as the score slider (6 px, horizontal intent).
- Clear affordance (×) resets to 0.

## Bottom sheets (native shells)

- Native sheet shell per the locked native-chrome ruling: OS
  presentation/dismiss/scrim physics; design's "dismiss past ~40% of height or
  on velocity" describes the OS default — do not re-implement.
- Contents are brand-custom; fixed ~92%-height sheets for add-impression /
  settings / invite / reveal.

## Reveal toggle (blind manage mode)

- Tap toggles Reveal/Hide in place; must NOT scroll-jump and must NOT close an
  open "Add tasting detail" panel (handoff §5).
