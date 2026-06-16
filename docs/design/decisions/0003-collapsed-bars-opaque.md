# ADR 0003 — Collapsed title bars and in-flow action bars are solid opaque

**Status:** Accepted · 2026-06-16 · mobile (web unaffected — slated for redesign).
**Supersedes:** the mockup's translucent-blur bar (`.hero-topfix.collapsed` in the
Vero handoff: `bg 86% + blur(14px) + box-shadow`).

> ADR numbering note: 0001 (terminology Moment/Impression) and 0002 (native-chrome
> vs brand-custom) are settled decisions documented elsewhere (the vero-handoff
> memory + `apps/mobile/CLAUDE.md`); back-filling them as formal ADRs is a small
> pending task. This is the first ADR authored in this format.

## Context

The mockup renders the collapsed hero title bar (and the impression's bottom
action bar) as frosted glass: ~86% opacity over a backdrop blur, plus a 1px
bottom rule. We ported that faithfully. On device, two problems showed:

1. **Shine-through.** Content scrolling under the sticky tabs was faintly visible
   through the translucent bar — and any sub-pixel seam between the bar and the
   pinned tabs read as a hairline gap.
2. The 1px **bottom rule** accentuated that seam.

## Decision

Collapsed / in-flow bars are a **flat, fully-opaque `theme.bg` fill with NO bottom
rule.** BlurView is removed. Applies to: the cover-hero `HeroTopBar` (collapsed
state), the impression `FloatHead` (collapsed state), and the impression bottom
action bar (`FootBar`).

The **pre-collapse, over-the-photo** state is unchanged — fully transparent with
glass *controls* (the immersive look). Only the *collapsed* / in-flow bars go
solid.

Generalize: **any floating/sticky bar over scrolling content defaults to opaque,
not glass**, unless there's a specific reason (and then verify on device).

## Rationale

Opacity is the only reliable way to guarantee nothing shows through a bar that
sits over scrolling content; translucent + any rounding error = a visible seam.
The frosted look was aesthetic, not load-bearing; Simon ruled the clean opaque
bar preferable after seeing both on device.

## Consequences

- The line-up cover-hero now differs from the immersive *impression* hero only in
  the collapsed-bar treatment (both keep the immersive photo).
- Both `expo-blur` imports were dropped from those screens (blur is pointless
  behind an opaque fill — a small perf win).
- Pairs with the measured pin-offset that makes the seam vanish — see
  `patterns/collapsing-hero-sticky-subheaders.md`.

## Where it lives

`apps/mobile/src/app/(tabs)/moments/session/[code]/index.tsx` (`HeroTopBar`),
`.../impression/[wineId].tsx` (`FloatHead`, `FootBar`).
