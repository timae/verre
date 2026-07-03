# ADR 0006 — Bottom nav is the brand floating pill, not the OS tab bar

**Status:** Accepted · 2026-07-02 · mobile (iOS-first; Android inherits the same bar).
**Supersedes:** the bottom-nav slice of the native-chrome ruling (2026-06-12,
documented in `apps/mobile/CLAUDE.md`; pending back-fill as ADR-0002). The
ruling's other native-chrome assignments (sheet shells, switches, context
menus, alerts, pickers, date pickers, search, share) are untouched.

## Context

The native-chrome ruling put the bottom nav on the genuine OS bar
(`expo-router/unstable-native-tabs`), tint-only, because the design's floating
pill "mimics the iOS 26 bar" — and explicitly deferred a custom bar "until the
core screens exist and we can judge it in use."

The core screens now exist, and the judgment came in from device use
(Simon, 2026-07-02, screenshot in hand): the OS bar **scrambles** — the
selected label truncates ("Mo…" for Moments), items land misaligned on
different baselines — and its **colors drift** between visits. All of it maps
to open upstream issues with no fix path:

- [expo#42364](https://github.com/expo/expo/issues/42364) — NativeTabs
  icons/labels render misaligned/overlapping after returning from a stack
  screen (iOS, release builds, intermittent). Our main flows — impression,
  create, settings — do exactly this push-and-return. Reporter tried five
  workarounds; none held.
- [react-navigation#12908](https://github.com/react-navigation/react-navigation/issues/12908)
  — iOS 26 selected-label truncation + misposition; timing-related, "fixed" by
  a 1s render delay or by tapping a tab.
- [expo#44029](https://github.com/expo/expo/issues/44029) — `labelStyle`
  colors silently not applied on iOS.
- [expo#40389](https://github.com/expo/expo/issues/40389) + documented UIKit
  behavior — iOS 26 Liquid Glass recomputes light/dark on tab re-entry and
  frosts per-content; `backgroundColor`/`blurEffect:'none'` don't force
  opacity (verified on device after a clean rebuild, per the old in-file note).

## Decision

Replace NativeTabs with the design's own floating pill, rendered by us:
`components/PillTabBar.tsx` (handoff `.tabbar-float`/`.tabbar-item`, vendored
icon set, theme tokens) on classic JS tabs (`expo-router/js-tabs`, custom
`tabBar`). The bar is an absolute overlay; content scrolls under it and
clears it via `TAB_BAR_CLEARANCE` (now 96 — real clearance, no longer
breathing room over an auto-inset).

## Rationale

Every observed failure — truncation, misalignment, label-color loss, glass
tint variance, light/dark flip — lives in OS/library appearance machinery we
cannot reach from props. A brand bar is deterministic: same pixels every
render, tokens straight from the theme. The mock was the pill all along; the
OS bar was chosen for physics, not look. What we give up: the OS bar's
scroll-edge behaviors, per-OS iconography, and free future iOS restyles.

## Consequences

- `TAB_BAR_CLEARANCE` 16 → 96 in `lib/layout.ts` (see derivation there);
  consumers (`insets.bottom + TAB_BAR_CLEARANCE`) need no change.
- Hiding the bar (sheets via `sheetVisibility`, reveal mode, keyboard, the
  footer-bar screens) is now "don't render it" — scenes never resize, so the
  old hide/show layout jump class is gone (EmptyLineup's freeze-height guard
  becomes belt-and-braces).
- The SF-symbol baseline quirk (hourglass/person sitting lower than
  house/wineglass) disappears — our 24px glyphs share one optical box. Two
  new glyphs in `Icon.tsx`: `home`, `soon` (the design's dashed `i-ph`).
- The `hidden`-toggle remount risk class (expo#40106) no longer applies.
- **Glass architecture (2026-07-03 addendum, final — supersedes the earlier
  "glass fill" note):** after a full day of device-driven iteration the bar
  ended as a LAYERED SIMULATION with exactly ONE real glass element:
  - **Body**: pseudo-glass — a token-controlled translucent SVG capsule
    (`BODY_ALPHA`) with a punch-through aperture that opens in sync with
    the lens. Cross-platform; deterministic.
  - **Lens** (drag-to-switch, hold ~180ms): the single real glass — UIKit
    `GlassView` `'clear'` + `isInteractive` (`expo-glass-effect` ~56.0.4),
    with a dark counter-tint. Device-established material truth table:
    `'clear'` = the lens optic (edge warp, chromatic rim); `'regular'` =
    frost slab; glass-over-glass dies without a `GlassContainer`, and
    in-container glass cannot optically see siblings — which is why the
    body must NOT be glass.
  - **Layers** bottom→top: body → rest capsule (plain, fades while held) →
    bait item row (held-only; the lens warps it, fringes read as rim
    distortion) → lens + radial-fade center patch → crisp REAL item row.
    Center readability is manufactured, not optical — documented honestly
    in the component header.
  - **Dials are per-scheme** (light bloomed at dark's values); all named
    constants in `PillTabBar.tsx` with their device history.
  - The **glass labs** in the dev gallery (`/you/dev-gallery`) are the
    permanent test rig: re-run them before changing any glass property.
  - Verdict of record (codex + Simon, 2026-07-03): dark mode lands; light
    tuned separately; architecture frozen — do not restart in Swift or
    revert to NativeTabs for this surface.
- **Revisit trigger:** re-evaluate NativeTabs only when expo#42364 (the
  scramble) is actually CLOSED with a fix confirmed on iOS 26 and the fix
  has soaked a release cycle. NOT keyed to an SDK number: SDK 57 (2026-06-30)
  shipped no fix, and the "standard-navigation rewrite" (expo PR #46457) is a
  3-file plumbing refactor with no claimed or evident relation to the bug.
  The community workarounds in the issue thread (DynamicColorIOS, xcasset
  icons) target custom-image-icon configurations and were disproven or
  inapplicable for our SF-symbol setup — see the thread before retrying any.
- If a fixed native bar lands later, reversing this is one layout file +
  this ADR's supersession note.

## Where it lives

`apps/mobile/src/components/PillTabBar.tsx` (the bar),
`apps/mobile/src/app/(tabs)/_layout.tsx` (js-tabs wiring + hide logic),
`apps/mobile/src/lib/layout.ts` (`TAB_BAR_CLEARANCE`).
