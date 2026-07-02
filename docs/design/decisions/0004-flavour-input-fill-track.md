# ADR 0004 — Flavour-intensity input is the fill-track ("C") control

**Status:** Accepted · 2026-07-01 · mobile (web keeps its chip input until the
redesign).

## Context

The structure-wheel proposal deferred the native per-attribute input on two
design decisions (§10 #5): the control variant and the flavour colour palette.
The Vero scoring exploration (`Vero - Scoring.html`) offered several input
shapes; Simon decided variant **C — the fill track** (`.filltrack` pixel spec)
and pasted the full 6-theme palette on 2026-07-01.

## Decision

- One **38px fill-track per structure axis** (`resolveAxes` set — sweet/acid/
  body/finish/aroma/flavour/tannin, +bubbles on sparkling): the axis colour
  fills left→right in **whole 0–5 steps**; axis label left, intensity word
  right, both over the fill with a contrast halo. Two tracks per row on a wide
  phone (≥380pt), one when narrow. "Smell"/"Taste" captions under Aroma/Flavour
  (§6f).
- **Colour resolves from the ACTIVE theme at render** (`useFlavourColors()`,
  derived from the tracked design palette) — never a baked hex (proposal §3a).
- **Input is native-first** (the standing ruling): gesture-handler Pan with
  `activeOffsetX(±6)`/`failOffsetY(±8)` + Tap, haptics per change, VoiceOver
  `adjustable` with increment/decrement. Value policy (whole steps, far-left
  clear sliver) lives in `@verre/core` `scoringInput.ts`, shared with the
  future web fill-track.
- **Zero rule (§5)**: the control emits keys only for axes moved above 0; the
  save boundary normalises via `fillFlavourZeros` (any axis rated → all axes
  stored, untouched as explicit 0; all-None → `{}`), and the server write
  boundary applies the same normalisation as the invariant.

## Where it lives

`apps/mobile/src/components/scoring/FlavourInput.tsx` (control),
`apps/mobile/src/theme/flavour-palette/` (palette + rules),
`apps/mobile/src/theme/flavourColors.ts` (theme resolution).
