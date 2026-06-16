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

## Score input (slider) — milestone 3 (shipped native; web untouched)

- **Steps**: 0.25; `0` = not rated (ghost star, never a "0 rating").
- **Web recognizer (reference, frozen)**: `touch-action: pan-y` + SLOP-gated
  capture — defer pointer capture until movement past **6 px** (`FLAVOR_SLOP`,
  `RatingPane.tsx:371`) reveals horizontal (capture, drag-to-set) vs vertical
  (let the page scroll) intent. A tap (release under SLOP) commits the tapped
  value directly. This is the web's hand-built mimicry of OS gesture
  arbitration.
- **Native recognizer (as built, milestone 3)**: gesture-handler `Gesture.Pan`
  with `activeOffsetX(±6)` + `failOffsetY(±8)` — the OS gesture system does
  the drag-vs-scroll arbitration natively — plus `Gesture.Tap` for tap-commit.
  Value policy (`snapScore`/`scoreFromFraction`/`stepScore`) from
  `@verre/core` `scoringInput.ts`. A11y: `accessibilityRole="adjustable"` +
  increment/decrement actions (the native analogue of the web's arrow keys).
- **~~Precondition (03 §2a)~~ RESCINDED (Simon, 2026-06-12)**: the web
  recognizer convergence + `useScoreSlider` extraction is dropped — the web's
  touch behaviour stays byte-identical until the web redesign, and the native
  app shares only the pure value policy, not the recognizer. The two web
  score inputs keep their (differing) recognizers; revisit at web-redesign
  time. See 03-topology §2a note.
- **Haptic intent (native, shipped)**: selection tick (`selectionAsync`) on
  each 0.25 step while dragging; light impact on commit (drag release, tap,
  number-field commit).

## Flavour fill-track input

- Whole steps 0–5, tap or drag fills in the flavour's colour, no thumb.
- Web: same SLOP recognizer as the score slider (6 px, horizontal intent).
  Native: same `activeOffsetX`/`failOffsetY` pattern as the native score
  slider; level policy (`flavourLevelFromFraction`, `toggleFlavourLevel`)
  in `@verre/core`.
- Clear affordance (×) resets to 0.
- **Native build is palette-gated**: lands once the flavour-colour brief
  (`.local/design/prompts/flavour-colours-brief.md`) produces the decided
  per-attribute palette.

## Bottom sheets (native shells)

- Native sheet shell per the locked native-chrome ruling: OS
  presentation/dismiss/scrim physics; design's "dismiss past ~40% of height or
  on velocity" describes the OS default — do not re-implement.
- Contents are brand-custom; fixed ~92%-height sheets for add-impression /
  settings / invite / reveal.

## Reveal toggle (blind manage mode)

- Tap toggles Reveal/Hide in place; must NOT scroll-jump and must NOT close an
  open "Add tasting detail" panel (handoff §5).
