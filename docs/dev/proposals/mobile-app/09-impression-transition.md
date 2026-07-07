# 09 — Impression detail: shared-element open/close transition

**Status**: NOT STARTED — handoff/prep doc so a fresh session can build it cold.
Requested by Simon (2026-07-07). Builds on the read-only detail screen shipped
in `08-feed.md` §3 (commit `7e40d1b`).

## What Simon asked for (verbatim intent)

> "when clicking on the info panel and the info page shows up, it basically should
> unfold from the image, so a smooth extension where the image goes to the top
> where it sits. And you can close the info view by pulling down, which is also
> with a nice visualization (image moves down to feed view, impression rating
> info slides into panel etc)."

Two motions:
- **OPEN** — tap a feed card's glass/impression panel → the card's **photo grows
  and moves to the top** into the detail hero slot (continuous, the actual photo
  travels — Simon chose **true shared element**, not an approximate slide+fade),
  and the rating info **unfolds** below it.
- **CLOSE** — **pull DOWN** to dismiss: the hero photo shrinks/moves back toward
  the feed card's position, the rating info **slides back into the panel**.
  Interactive (finger-tracked), like the iOS Photos / App Store card dismiss.

## Why it's a real build (not a nav flag)

This stack — **Expo SDK 56, New Architecture, Expo Router v7 (vendored
react-navigation), reanimated 4** — has **no first-class shared-element
transition**. `react-navigation-shared-element` is unmaintained + incompatible
with New Arch / reanimated 4. So this is a **custom reanimated presentation**,
hand-rolled. Budget for a multi-iteration device loop (gesture feel can't be
judged from the sandbox).

## The approach (the plan to build to)

Convert the detail screen from a **plain pushed route** into a **custom-presented
animated overlay**. Sketch:

1. **Measure the source frame.** On the feed card, when the panel is tapped,
   `measureInWindow` the card's photo (x/y/w/h) and pass it to the detail
   presentation (via router params — numbers only — or a small shared store).
   The feed card photo is `SessionFeedCard`'s `WineSlide` image / the standalone
   `PhotoHero` image / the `NonPhotoHero` (no photo → no shared element, fall
   back to a plain fade — decide the no-photo open with Simon).
2. **Present over the feed, not push.** The detail lives as a full-screen overlay
   (a modal route or an absolute overlay above the tab scene) with a transparent
   background at t=0, so the feed shows through underneath during the transition.
3. **Drive a floating hero clone** with reanimated shared values from the source
   frame → the target hero frame (top of screen, `HERO_RATIO` height, full
   width). Interpolate x/y/w/h/borderRadius on the UI thread. At t=1 the clone
   sits exactly where the real detail hero renders; swap the clone for the real
   hero (opacity handoff at coincidence, same discipline as the collapsing-hero
   Dynamic Overlay in `docs/design/patterns/collapsing-hero-sticky-subheaders.md`).
4. **Unfold the body.** The rating panel/content fades+translates up from behind
   the hero as the hero settles (the "unfold").
5. **Interactive pull-down dismiss.** A `Gesture.Pan()` on the detail (active
   when scrollY===0, `failOffsetY(-N)` so a pull UP scrolls normally) drives the
   REVERSE interpolation: hero shrinks back toward the source frame, body slides
   down/into the panel, background scrim fades out. Release past a threshold →
   finish the dismiss (spring to source, then pop the route); below → spring
   back to open. Mirrors the iOS card dismiss.

## Load-bearing gotchas (learned already, don't re-walk)

- **The collapsing hero is already solved** in the read screen — read
  `docs/design/patterns/collapsing-hero-sticky-subheaders.md` + the shipped
  `feed/impression/[id].tsx`. The transition is ADDITIVE; don't rebuild the hero.
- **RNS `contentInsetAdjustmentBehavior` trap** — the zero-size `<View
  collapsable={false}>` dead-end is already in the detail screen; a custom
  presentation must keep an equivalent or the hero top-insets under the status
  bar. See `apps/mobile/CLAUDE.md`.
- **The pager complicates the shared element.** The detail is a horizontal pager
  across N impressions. Only the ENTRY page shares an element with the source
  card; swiping to other pages has no source. The pull-down dismiss should
  target the CURRENTLY-ACTIVE page's hero → the feed (the feed card for the
  active impression may be off-screen — decide: dismiss to the original source
  frame regardless, or to a neutral shrink). Resolve with Simon.
- **Gesture composition**: the pull-down Pan must yield to (a) the vertical
  content ScrollView (only arm the dismiss at scrollY 0, pulling down), and (b)
  the horizontal pager pan (fail the dismiss on horizontal intent). Standard
  gesture-handler `simultaneousWithExternalGesture` / `failOffset` work.
- **expo-image + a moving/scaling clone**: verify the image doesn't re-decode /
  flicker mid-flight; may need `recyclingKey` or a plain `<Image>` clone.

## Open decisions to confirm before/at build (with Simon)

- No-photo open (a `NonPhotoHero` card or a blind wine → no photo to share):
  plain fade/scale, or a different affordance?
- Pull-down target when the source card is off-screen (after paging).
- Whether the body "unfolds" as one block or the glass-panel content specifically
  "slides into the panel" on close (his words) — i.e. reverse-animate the panel
  fields to their card positions, or a simpler content fade.

## Reference implementations in-repo to mine

- `components/ui/FullscreenImage.tsx` — a reanimated-4 gesture-image presentation
  (pinch/pan/dismiss) already patched via patch-package; the closest existing
  "image in an interactive overlay" pattern. Its dismiss-drag is a model for the
  pull-down.
- `CoverHeroLineup` (`moments/session/[code]/index.tsx`) — the Dynamic Overlay
  (measure + clamp + stuck-flag opacity handoff) that the clone→real-hero handoff
  mirrors.
- The read detail screen itself (`feed/impression/[id].tsx`).

## Known-imperfect in the shipped read screen (fix opportunistically here)

- Parent passes inline `onCollapse`/`onTitle` arrows to each `DetailPage`
  (recreated per render); `onTitle` is guarded by an effect + equality-checked
  `reportTitle`, but the deps churn. Memoize per-page callbacks if this build
  touches the pager plumbing.
- The bar title tracks the active page via a `titles`/`collapsed` map keyed by
  page index — fine, but if the transition changes the presentation, re-verify
  the active-page tracking survives.
