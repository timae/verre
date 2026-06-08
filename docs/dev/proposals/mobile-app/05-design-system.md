# 05 — Design system port (web design → React Native)

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). Covers porting the new "Vero" design handoff into the RN stack. The design team has already adapted the handoff for RN portability (tokens emitted as JS, scoring widgets kept as plain SVG geometry); this doc records what ports cleanly, what doesn't, and the guidance still owed.

> **Read this first — three things are in play, don't conflate them.** (1) **Existing web components** (`WineModal.tsx`, `ScoreSlider.tsx`, the charts, etc.) are the **current web app's code**, referenced here as the **behavioral reference to port** — the interaction logic + the hard-won technical lessons — **NOT a design to preserve**. They keep serving the live web app until web is redesigned (the last phase). (2) The **"Vero" redesign** is the new *look* the native app (and eventual new web) will wear. (3) The **native app** is built fresh: new look (Vero) + behavior ported from the old web code. So when this doc says "port `ScoreSlider`'s keyboard handling" it means *reproduce that behavior*, not *keep that appearance*.

## 1. The design handoff (what exists)

The redesign is **generated web code**, not Figma and not conceptual:
- **`vero-tokens.css` + `vero-tokens.js`** — semantic tokens (colors, spacing, radii, type scale, motion durations/easings, an elevation map) across six theme blocks. The team has **already emitted a JS/unitless version** (`vero-tokens.js`) specifically for RN. This is the most portable artifact.
- **`vero-components.css`** — themeable plain-CSS component styles (buttons, fields, chips, switches, list rows, tabs, app bar, bottom nav, sheets, badges, avatars, stepper, empty state, PRO badge).
- **`vero-screens.js` + `Vero - Screens.html`** — vanilla-JS prototype screens (template strings + one-off listeners). **Demonstration code**, not architecture: no component model, no state, no data layer. It shows *what* to build, not *how* it's structured.
- **`vero-scoring.js`** — the stars, flavour wheel, fill-track input, comparison wheel, radar, drawn in plain JS/SVG geometry.

The handoff's §11/§12 cover RN portability and explicitly **leave the architecture decisions (realtime, auth, data model) unmade** — correctly, those are owned by [01](01-identity-and-auth.md)/[02](02-realtime.md), not invented by the design.

## 2. What ports cleanly

| Artifact | Ports to RN? | Notes |
|---|---|---|
| `vero-tokens.js` (colors, spacing, radii, type scale, motion, elevation) | ✅ near-mechanical | Already unitless JS. Becomes the RN theme object directly. **The single biggest reuse win.** |
| `vero-scoring.js` SVG **geometry** (radar, wheels, stars, fill-track) | ⚠️ split | The coordinate **math** (`arcSeg`, `radiusForLevel`, label-stacking) ports cleanly → put it in `packages/core`. But the **render layer is a rewrite, not a port**: the existing charts emit an SVG *string* via `dangerouslySetInnerHTML` (`components/charts/PolarChart.tsx:112`, `components/charts/RadarChart.tsx:66`), which doesn't exist in RN — `react-native-svg` needs real `<Path>` elements. If `vero-scoring.js` also emits strings, the rendering is rewritten. (Geometry = durable asset; string-assembly = throwaway, same as gestures.) |
| Component *visual language* (what things look like) | ✅ via re-implementation | The look is fully specified by tokens; the RN components carry the same token values. |

## 3. What does NOT port (rebuild in RN's model)

These have **no RN equivalent** and the `vero-components.css` rules relying on them must be rethought, not translated:

- **`svh` / viewport units** — RN has *no* viewport units. The modal sheet is locked at `90svh` (`components/wine/CLAUDE.md`) precisely to survive Safari's collapsing URL bar. In RN, heights come from `useWindowDimensions`/`Dimensions`. **Every `svh`-based layout is a manual port.** (Used in 3 files: `WineModal`, `AddWineModal`, `AccountSettingsModal`. `SessionShell` uses `100vh`, not `svh`.)
- **Safe-area insets** — web uses `env(safe-area-inset-*)`; RN uses `react-native-safe-area-context` (a different API + provider). Notch / Dynamic Island / home-indicator regions need explicit per-platform handling. Tokens don't bridge this.
- **`box-shadow`** — RN's shadow model differs, and **iOS and Android shadows differ from each other**. The elevation map in `vero-tokens.js` helps, but shadow rendering is per-platform.
- **Gradients** — no `linear-gradient` in RN; needs a gradient *component* (`expo-linear-gradient`).
- **Pseudo-elements (`::before`/`::after`), `:hover`** — don't exist (and phones don't hover). Any component leaning on them needs restructuring.
- **Flexbox defaults differ** — RN defaults to `flexDirection: column`; web defaults to `row`. Silent layout bugs if assumed.

**Owed from the design team** (the guidance still worth sending): mark which `vero-components.css` styles depend on the above (especially `box-shadow`, gradients, `svh`) so the rebuild knows where the visual won't transfer 1:1.

## 4. Gestures — the part the token advice doesn't cover

The design's procedural JS is a fine *behavioral reference* but the gesture *implementations* are throwaway for RN. Verre's signature interactions:

- **Pull-to-swap wine modal** — the mobile reviewer's correction: this is **over-feared, not under.** The entire discarded-architectures history (`docs/dev/ios-touch-gestures.md`) and load-bearing CSS (`touch-action: pan-y`, `overscroll-behavior: contain`, `svh`; `components/wine/CLAUDE.md`) is **fighting iOS Safari** — no URL bar, no `touch-action`, no browser pull-to-refresh in RN, so most of that complexity simply *doesn't exist* in native. `react-native-gesture-handler`'s scroll-then-pull composition is a *solved* pattern (every RN bottom-sheet does it). The real RN cost is elsewhere: (a) the **`runOnJS` thread boundary** — Reanimated gestures run on the UI thread, so committing a swap (which calls TanStack/mutates a rating on the JS thread) is a thread-crossing dance, the genuine new mental model; (b) the **framer-motion slide animation** (`WineModal.tsx`'s dual-axis `slideOffset` machinery) is web-only and needs a **full Reanimated rewrite** — a real chunk the gesture framing hides; (c) `GestureHandlerRootView` setup + Fabric/New-Arch config (easy to miss → gestures silently no-op).
- **`<ScoreSlider>`** — the score input; RN needs its own gesture + haptic implementation. The *interactive* (drag-to-set) SVG widgets are meaningfully harder than the read-only radar — gesture-handler must be wired onto SVG elements, not the SVG's own pointer events.

**Build these as headless behavior hooks, not monolithic components** ([03](03-topology.md) §2a): the gesture *state machine* (thresholds, what snaps where, what haptic fires) lives in a `useWineSwapGesture`/`useScoreSlider` hook, the rendering in a per-platform view. This is what lets Android reuse the gesture logic without reimplementing it, and makes the logic unit-testable. **Owed from the design team**: the plain-language interaction spec (thresholds, directions, snap points, haptic triggers) — *that* spec is the durable asset and feeds the hook directly; the web gesture code is throwaway. Example: "sheet dismisses on downward drag past 40% of height; below 40% it springs back; a light haptic fires on the swap commit."

## 5. Native-only additions the web design has no concept of

- **Haptics** — native users expect a haptic tick on the score slider, on rating commit, on join. Web has none. Add to the interaction specs (`expo-haptics`).
- **Typography/fonts** — bundled fonts load differently in RN (`expo-font`); the type scale values port but font *loading* is platform work.
- **Accessibility** — RN uses `accessibilityRole`/`accessibilityLabel`, a *different* API from web ARIA. The `role="slider"` + keyboard handling on the current `<ScoreSlider>` do **not** carry over; native a11y is a separate pass.

## 5a. Token drift — a deferred concern, not near-term infra

`vero-tokens.js` is the single source for RN, and **iOS consumes it directly today** — no pipeline needed for v1. A multi-representation token build (CSS-vars *and* JS, e.g. Style Dictionary) only earns its keep *if* O1 resolves to two codebases *and* the redesigned web hand-maintains a separate CSS-var copy — both phases away (the current `var(--…)` sites are the legacy design being replaced anyway). **So don't stand up Style Dictionary now** (efficiency review); iOS uses `vero-tokens.js` as-is, and you decide the pipeline if/when O1 → separate-web, against two known consumers.

Two notes for *whenever* that pipeline is built, so it's done right rather than redone:
- **Author tokens at the *semantic* layer, not the raw-value layer.** An "elevation level" must derive to three different formats (`box-shadow` web / `shadowColor/Offset/Radius/Opacity` iOS / `elevation` Android); a "motion role" derives to a CSS `cubic-bezier` vs a Reanimated `Easing.bezier`. Only a semantic source + per-platform transforms keeps these in sync; a raw-shadow-string source can't.
- **Motion is an un-tokenized drift axis today — capture it NOW, with the gesture spec, not when the pipeline is built.** The signature slide curve `[0.25, 0.1, 0.25, 1]` plus its `0.2s`/`0.3s` durations are **hardcoded literals** in `WineModal.tsx` (two sites). These are *inputs to the gesture/slide hook you extract during iOS* — if you don't record "slide = this bezier, 300ms" in the plain-language interaction spec ([03](03-topology.md) §2a) now, you'll hardcode the same literal into the Reanimated rewrite and the (deferred) token pipeline won't retroactively catch it. The *pipeline* is correctly deferred; *capturing the values* is not.

## 6. Summary

- **Reuse directly**: `vero-tokens.js` → RN theme (as-is, no pipeline for v1); `vero-scoring.js` **geometry math** → `packages/core`.
- **Rewrite in RN's model**: every `svh`/safe-area/shadow/gradient/pseudo/hover style; the chart **render layer** (SVG-string → `<Path>` elements); the gesture **orchestration** (framer-motion → Reanimated); the component logic (prototype JS was always greenfield).
- **Extract opportunistically (not mandated)**: gesture/scoring *policy* (thresholds/snap/haptics) into hooks where it's free — see [03](03-topology.md) §2a. Converge the two existing score inputs first.
- **Add (native-only)**: haptics, font loading, native accessibility (iOS/Android-divergent).
- **Defer**: the multi-representation token pipeline (§5a) until O1 → separate-web.
- **Still owed from design**: flag no-RN-equivalent CSS; spec gestures behaviorally (the durable Android de-risk), not in CSS.

The one-line brief already sent and confirmed: *tokens as JS (done), scoring widgets as plain SVG geometry (done), component states + gestures as behavioral specs rather than CSS implementations.* This doc is the expanded version of that.
