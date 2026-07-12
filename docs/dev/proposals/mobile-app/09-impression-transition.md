# 09 — Impression detail: shared-element open/close transition

**Status**: BUILT (2026-07-08, `feature/impression-transition`) — both the
transition and the §B back-nav wrapper, per the plan below. **Device-verify
pending** (gesture/animation feel can't be judged from the sandbox). See §"As
built" at the end for the implementation map, the defaults picked for the open
decisions, and the device checklist.
Requested by Simon (2026-07-07). Builds on the read-only detail screen shipped
in `08-feed.md` §3 (commit `7e40d1b`). **Also carries the deferred FEED→SESSION
back-nav rework (§B below) — done in this pass since both reshape feed nav.**

## §B — Deferred: enter-a-moment-from-feed returns to the feed post

**Problem (Simon, 2026-07-07):** tapping a moment from the feed (card header or
the detail attribution) opens `/moments/session/[code]` — which lives in the
**Moments** tab. So it cross-navigates to Moments, and back returns to the
Moments list, NOT the feed post you came from. Current behaviour: **accepted as
standard tab UX for now** (deferred here).

**Research verdict (expo-router v7 / SDK 56, cross-tab back nav):**
- `router.dismissTo` / `dismiss` / `dismissAll` all operate on the **current
  stack ONLY** — none cross tab boundaries. No one-call primitive exists.
- `router.navigate('/feed/impression/[id]')` from the session DOES return to the
  feed detail, but leaves the session **mounted on the Moments stack** → later
  tapping Moments lands you inside that session (tab state is preserved by
  design, not a bug).
- `CommonActions.reset(...)` / `StackActions.popToTop()` (vendored RN) can force
  it but need the exact nested route shape hardcoded — brittle, discouraged on v7.
- Root-level MODAL presentation avoids the lingering-screen problem but signals
  "temporary overlay," and still needs the session sub-tree paths relocated.

**Chosen direction (Simon): the "wrapper under feed" — a SHARED session screen
reachable from BOTH stacks.** Open the session under the Feed stack
(`/feed/session/[code]`) so Feed→Detail→Session stays in Feed (back walks
correctly); the Moments tab keeps its own `/moments/session/[code]`; both mount
the SAME session component; each tab has independent state (so you can be viewing
the session in Feed AND see it "normally" in Moments — Simon's exact model).

**The tax (why it's deferred to a real refactor, not a one-liner):** the session
sub-tree hardcodes **9 absolute `/(tabs)/moments/session/...` paths** for its own
forward navigation (verified 2026-07-07):
- `index.tsx`: open impression (340), open add (341), open settings (503)
- `settings/index.tsx`: → details (130), → reveal (135)
- `add.tsx` (88) + `edit-impression/[wineId].tsx` (31): fatal `router.replace` → session
- `impression/[wineId].tsx`: → impression (284), → edit-impression (314)

To make ONE shared session screen work under both `/moments/` and `/feed/`, all 9
must become **stack-relative** (compute the base — `feed` vs `moments` — from the
current route, e.g. via a param threaded from the entry point or `useSegments()`)
and the route files mirrored under `app/(tabs)/feed/session/` as thin re-exports
of the shared screen components. None currently use relative nav.

**Plan when built:** (1) extract each session screen's body into a shared
component that takes a `basePath` (or reads it from segments); (2) mirror the 7-8
route files under `/feed/session/`; (3) convert the 9 pushes to `${basePath}/...`;
(4) `useEnterableMoment` pushes `/feed/session/[code]` from feed contexts,
`/moments/session/[code]` stays for the Moments tab; (5) device-verify both tabs'
nav + back thoroughly (gesture-heavy, can't be sandbox-verified). Big, do it with
the transition rework, not piecemeal.

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

## As built (2026-07-08, `feature/impression-transition`)

### §B — the dual-mounted session sub-tree

- **`lib/sessionStack.ts`** (new): `useSessionTab()` reads `useSegments()[1]`
  (`'feed' | 'moments'`); `sessionHref(tab, sub, params)` builds the typed
  `Href` (the one sanctioned cast — a computed pathname can't satisfy the
  typed-routes literal union); `tabHomeHref(tab)` for home bounces.
- **7 mirror route files** under `app/(tabs)/feed/session/[code]/…` (index,
  add, impression/[wineId], edit-impression/[wineId], settings/{index,
  details,reveal}) — thin `export { default } from '@/app/(tabs)/moments/…'`.
- **All 10 in-subtree absolute pushes converted** (the 9 verified in the plan
  + `useSettingsSession`'s fatal bounce, which post-dates the count), plus:
  `useEnterableMoment` now pushes the session onto the CURRENT tab's stack
  (feed cards/detail → `/feed/session/[code]`), and the settings hub's
  delete-moment bounce goes to the OWNING tab's home (`tabHomeHref`), so a
  feed-entered delete lands back on Feed.
- Moments-tab entry points (home carousel, recents, join, create) still push
  `/moments/session/[code]` — correct, they live on that stack.
- The tabs layout's bar-hide matchers are suffix-based (`/impression/`,
  `/add`, `/settings/details`, `/settings/reveal`) so they cover the mirrors
  with no change.

### The transition

- **Route presentation** (`feed/_layout.tsx`): `impression/[id]` is
  `presentation: 'transparentModal'`, `animation: 'none'`, `gestureEnabled:
  false` (the pull-down IS the dismiss; a native edge-swipe would pop without
  reversing the presentation), transparent `contentStyle`. Android hardware
  back is intercepted (`BackHandler` → `requestClose`) so it takes the same
  reversed presentation instead of a native instant pop. ⚠️ The layout MUST
  keep `unstable_settings = { initialRouteName: 'index' }` (+ `<Stack.Screen
  name="index" />` declared first): declaring a `Stack.Screen` hoists that
  route to the front of the route order, and react-navigation's default
  initial route is the first one — without the anchor, a fresh Feed-tab mount
  (app reload → tab press) cold-mounted `impression/[id]` with no params →
  a stuck "This impression is gone" screen (Simon's device catch,
  2026-07-08).
- **Source handoff** (`lib/feedTransition.ts`, new): the tapped card measures
  its photo frame (`measureInWindow`) and stores `{kind:'photo', x,y,w,h,
  uri}` — or `{kind:'fade'}` when there's no real photo (NonPhotoHero, blind
  slide, placeholder) — in a one-shot module store (1.5s freshness window);
  the detail consumes it on mount. Cards: `SessionFeedCard.openImpression`
  (carousel container ref) + `StandaloneFeedCard.PhotoHero`.
- **One shared `progress` value** (0 = at card, 1 = open) drives everything in
  `feed/impression/[id].tsx`. Layer order (bottom → top): settle bg (opacity)
  · content (pager/body, opacity ramp [0.35,1] + 56px rise) · the hero CLONE
  (expo-image cover, interpolating left/top/width/height source-frame → hero
  slot, plus a FEED_PANEL_SCRIM→HERO_SCRIM crossfade so both handoff
  endpoints are pixel-identical) · the GLASS-PANEL CLONE · the bar (own
  layer, fade only — chrome, no rise). **The photo slides BEHIND the card's
  glass panel** (Simon's device ruling 2026-07-08, round 2): a pixel-matched
  `FeedGlassPanel` clone (the ENTRY wine — the card beneath keeps showing the
  tapped slide) sits pinned at the measured card frame ABOVE the photo,
  opacity [0→0.35 progress]→[1→0], handing off seamlessly to the real card
  panel at rest. The clone also rides above the fading body content (round 1:
  no detail text drawn over the traveling photo). The real hero image renders
  transparent while `isClonePage && progress < 1` and takes over at
  coincidence — the Dynamic-Overlay opacity-handoff discipline. Open:
  `withTiming` 360ms ease-out-cubic. No source → progress seeds 1 (deep link
  renders as before).
- **Pull-down dismiss** (per `DetailPage`): pages became
  `Reanimated.ScrollView` (animated ref + `useScrollOffset`; the plain JS
  `onScroll` keeps the measured collapse). A `Gesture.Pan`
  (`activeOffsetY(12)`, `failOffsetY(-12)`, `failOffsetX(±16)`,
  simultaneous with the scroll's `Gesture.Native()`) arms only when the touch
  went down at scrollY ≤ 1 (`dismissArmed` shared value — a drag that starts
  mid-list can't jump-start a dismiss), maps `translationY / 340` to
  progress, and on release closes below 0.6 (or velocity > 900) else springs
  back. `bounces` flips off while the page sits at the top so the iOS
  rubber-band doesn't double the motion. The bar's back button reverses the
  same presentation (230ms) before popping.
- **Dismiss after paging** targets the ORIGINAL card frame (the card's photo
  carousel occupies the same frame for every slide, so it's spatially honest);
  the clone shows the ACTIVE page's photo. A photoless active page → fade
  dismiss (no clone).

### Round 3 (Simon's device feedback, 2026-07-08 — built on `feature/checkin-create`)

- **Open sped up, two levers**: the timings moved onto the **motion tokens**
  (Simon's catch — the original `Easing.out(Easing.cubic)` 360ms was off-token
  AND the cause of the "info panel lags at the end" feel: out-cubic's
  deceleration tail spends ~half the wall-clock creeping through the last 10%
  of progress, so the content's `[0.35→1]` fade/rise visibly crawled). Now
  `OPEN_TIMING = motion.dur3 + motion.ease`, `CLOSE_TIMING = motion.dur2 +
  motion.ease` — the standard ease settles into its endpoint much sooner.
  **Round 3b (frame-by-frame off Simon's simulator recording)** found the two
  REMAINING end-lag causes and fixed both: (1) the content/bar ramps rode
  progress to 1.0 — now they FINISH EARLY (opacity `[0.35, 0.8]`, rise settled
  by 0.85), so the body is crisp while the photo alone does the final settle;
  (2) ⭐**the on-photo hero TITLE popped in at coincidence** — the traveling
  clone paints OVER the page content, occluding the page's own name block for
  the whole flight, so the title could only appear when the clone hid at
  progress === 1. Fix: a second copy of the title (the shared `HeroTitle`
  component) fades in over `[0.7, 1]`, gliding in with the settle and handing
  off pixel-identically to the real block.
  **Round 3c (second recording — "still a bit stuttery"):** the frame gaps
  (~50ms at the start, 20–35ms mid-flight vs the 16.7ms budget) are DROPPED
  FRAMES from per-frame LAYOUT work: the clone animates layout props
  (left/top/width/height → full re-layout every frame), and round 3b's first
  cut had put HeroTitle INSIDE that container — per-frame text re-shaping.
  Fixed: the title is now a STATIC sibling overlay at the final hero rect,
  opacity-only (safe because it only shows past 0.7, when the clone is within
  a few px of final geometry). **Round 3c/3d (Simon frame-by-frame, 19→20): the body panel's rounded TOP
  popped in at coincidence** — the body is `marginTop: -radius.xl` into the
  hero, so with the clone painting over the content its rounded top was
  occluded for the whole flight. A first fix (a detached seam-strip overlay
  pinned at the final position) was REJECTED on sight — it floated over the
  traveling photo "like scissors". **The real fix (3d) is layer order: the
  hero CLONE now travels BENEATH the content layer**, so the body panel —
  rounded top + content, ONE piece — slides up uniformly over the photo and
  the photo disappears behind its edge (the card metaphor). Consequences
  baked in: the page hero's scrim + title hide together with the image while
  the clone flies (static chrome over a traveling photo reads as floating;
  the clone carries the scrim crossfade, the title overlay fades the name in
  near settle), and everything hands off pixel-identically at coincidence.
  Watch on device: while the body is still fading in (progress 0.35→0.8) the
  photo can show through the panel where they overlap — if that ghosting
  bothers, finish the opacity ramp earlier (e.g. [0.35, 0.6]).
  ⚠️ Remaining stutter levers,
  in order: (a)
  judge on a PHYSICAL device with a release-ish build — the simulator renders
  on CPU and dev-mode Metro exaggerates dropped frames badly; (b) the
  documented transform-based clone (translate/scale on a fixed-size layout —
  compositor-only, no re-layout) — its trade-off: scaleY on a cover-fit image
  STRETCHES the photo instead of sliding the crop window open, so it needs
  the fixed-hero-size-image-in-a-clipping-container variant, which accepts a
  small crop jump at flight start; (c) the entry page's mount cost (wheel SVG
  etc.) overlaps the first ~100ms — deferring body mount to first-frame would
  trade a beat of empty body for smoothness. And a
  **mount-cost gate** — during
  the presentation only the ENTRY page mounts (siblings render as empty slot
  views, keeping pager offsets); the rest mount at coincidence (`warm`, set by
  the open timing's completion callback + a fallback timer for an interrupted
  open). Mounting every DetailPage up front blocked the JS thread before the
  open animation could start. Content pointerEvents are 'none' until fully
  open, so nothing can swipe to an unmounted page mid-flight.
- **Pull-down commit haptic**: a light impact, fired the moment the drag
  CROSSES the commit threshold ("release now and it closes") — Simon asked
  for it earlier than the original release-time tick (round 3e). One tick per
  gesture; dragging back out of the zone re-arms silently; a fast flick that
  commits from above the threshold gets the tick at release instead. Not on
  the bar back button. Same haptic language as the like/commit ticks.
- **Open veil (round 3e)**: the settle background is DIRECTION-AWARE — on
  open it snaps opaque within the first ~12% of progress (1–2 frames), so the
  feed around the post pops away instead of shining through the flight (the
  photo + panel clones carry all the continuity); on dismiss (`dismissing`
  shared value, set by the pan's first movement or a back-button close, reset
  on spring-back) it follows progress linearly so the feed grows back behind
  the shrinking photo.
- **LANDING SYNC — close lands the feed on the page you dismissed** (was: the
  slide you opened from). `lib/feedTransition.ts` gained a landing registry
  (`registerFeedLanding(feedItemId, sync)` / `requestFeedLanding`):
  `SessionFeedCard` registers a callback that snaps its carousel
  (`setActiveIdx` + un-animated `scrollTo`); the detail mirrors EVERY active-
  page change into it (`landCard` in `onPagerScroll` + the gallery's
  `landPager`, deduped via `lastLandRef`). The card sits invisible beneath the
  opaque detail, so the mid-read churn is unseen, and any close — pull-down,
  back button, Android back — finds the card already on the right slide.
  Consequence: the **glass-panel clone now shows the ACTIVE wine** (was the
  entry wine — it must match the landing-synced card panel it fades onto).
  Standalone cards have a single impression — no registration needed.

### Defaults picked for the "open decisions" (flag to Simon, cheap to change)

1. **No-photo open** = fade + 56px rise of the whole detail (no clone), same
   progress choreography. (Same for no-photo dismiss.)
2. **Pull-down target when the source card is "off-screen"** — moot for
   paging (same frame, see above); the feed can't scroll while the modal is
   up. Kept the original frame unconditionally.
3. **The body "unfolds" as one block** (single content layer fading/rising);
   the reverse-animate-fields-into-the-panel variant was NOT built. If the
   close should literally slide the rating into the glass panel, that's a
   follow-up on this scaffolding.

### Snappiness pass (2026-07-12, `feature/aroma-checkins` — steps 1–3 + 5 of the agreed plan)

Converged plan (Claude + Codex review rounds; every claim verified against the
installed RN 0.85.3 / Reanimated 4.3.1 sources):

- **Close legs are velocity-inheriting SPRINGS** (step 1): pan-release close,
  spring-back, and the bar/Android-back close all use `withSpring` with the new
  `springs.release` preset (`theme/motion.ts` — engineering-owned spring tokens
  beside the vendored `motion`; critically damped, `overshootClamping` so
  progress can't leave [0,1]; `duration: dur1` → ~180ms actual settle, one
  tier quicker than the open per Simon's post-device-pass "close could be a
  bit faster" (2026-07-12) — note reanimated's duration-springs settle at
  ~1.5× the configured value). The
  pan release converts its gesture velocity into progress units
  (`-velocityY / DISMISS_DRAG`) so the photo keeps moving at finger speed
  instead of restarting on a bezier — the "handbrake at release" fix. The
  carried velocity is DIRECTION-GATED to the leg's target: reanimated's
  clamping TERMINATES a spring that leaves the [release-point, target]
  interval and snaps to the target, so an away-pointing velocity (cancel while
  still moving down; upward flick released under the commit line) would read
  as a jump cut — gated to 0 instead (no "dip" on a fast cancel, by design).
  The back-button close self-writes `progress` first to cancel a running
  spring-back (a new spring ADDS the running one's velocity — same jump-cut
  class). **The OPEN moved onto a spring after Simon's device pass confirmed
  the close feel (2026-07-12)** — its own `springs.enter` preset (dur2/dur3
  midpoint 260 → ~390ms settle; dur2 read "almost a bit too fast" on device,
  dur3 would delay the pointer-events unlock), no velocity (not
  gesture-driven); the warm-stage fallback
  timer keys on the ~1.5× physical settle (`OPEN_SETTLE_MS`). The old
  `motion.dur3 + motion.ease` open timing is gone.
- **Entry-page mount split** (step 2): during a presentation the entry
  `DetailPage` commits hero + dots + header first (`deferBody`), and the heavy
  body (StructureWheel SVG, aroma chips, About) mounts one `requestAnimationFrame`
  later — on the JS thread, concurrent with the UI-thread flight, committed
  well before the content fade (progress 0.35) makes it visible.
- **Staged sibling warming** (step 3): `warm` became `warmLevel` 0/1/2 — entry
  only in flight → + the ACTIVE page's neighbours from coincidence (the window
  follows the page as the user swipes, so a quick second swipe / a gallery
  close landing far away finds its target mounted in the same commit that
  moves `active` — Codex P2 catch) → everything on `requestIdleCallback`
  (`{ timeout: 800 }` floor; InteractionManager is deprecated in RN 0.85).
  Monotonic `mountedLo/Hi` BOUNDS (state, expanded in an effect — post-commit,
  render stays pure; the union of the window's walk is contiguous so two
  bounds suffice) keep every once-covered page mounted as the window moves
  (no scroll-state loss / blank back-swipe). Mounting ALL siblings in one
  commit at settle was a JS spike right when the user starts interacting. Residual sliver: mid-swipe, a target ≥2 pages out is blank
  until `active` crosses the rounding midpoint — transient, self-heals within
  the gesture, gone once the ≤800ms idle bump fires.
- **Dismiss pickup 12 → 8px** (step 5): `activeOffsetY(8)` / `failOffsetY(-8)`
  — the dead zone before the photo tracks the finger is felt on every dismiss;
  arm-at-top + bounce-off already disambiguate from the scroll.

- **Clone flies on transform + opacity only, with the
  `IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS` static flag** (step 4, built 2026-07-12
  as one package — round 3c's frame-by-frame had already measured the dropped
  frames from per-frame layout, satisfying the profiling gate). The clone
  renders statically at the FINAL hero rect; the worklet derives the OLD
  lerped x/y/w/h trajectories and expresses them as center-translate + axis
  scales, so the flight path is pixel-identical. The photo rides an
  INTRINSIC-ASPECT image layer (Codex P1 catch, round 2 — the first cut
  counter-scaled the image at the hero box's dimensions, but expo-image bakes
  its cover crop at layout bounds, so a differently-shaped card frame showed
  a zoomed crop that snapped at rest — the close artifact Simon reported):
  the layer renders unclipped at the final box's cover-fit size for the
  photo's REAL aspect (handed off from the card's measured `aspects` map via
  `feedTransition.ts`, backfilled by the clone image's own `onLoad` for
  swiped-to pages), and the per-frame counter-scale applies the CURRENT box's
  uniform cover scale `u` — undistorted, covering (outer `overflow: hidden`
  crops), and matching the true cover crop at BOTH endpoints — a continuous
  transform-only "cover". The flag (in `apps/mobile/package.json`
  `reanimated.staticFeatureFlags`; needs `pod install` + native rebuild) puts
  the per-frame updates on reanimated's synchronous UI-thread fast path.
  ⚠️ Invariants + the global hit-testing caveat live in the toolchain bullet
  in `apps/mobile/CLAUDE.md` — hot worklets must return ONLY allowlisted keys
  (`transform`/`opacity`/colors/radii; even a static `left: 0` demotes the
  whole view), and `ENABLE_SHARED_ELEMENT_TRANSITIONS` must stay off (it
  disables the path entirely).

**Still open**: (6) interruptible open + finger-tracking dismiss are DESIGN
options for Simon, and the feed-owned overlay (clone starts before the route
mounts) only if tap latency still disappoints.

### Device checklist (Simon)

- Open from: session card photo slide · standalone photo card · NonPhotoHero
  (fade) · blind slide (fade) · all-photoless carousel (fade).
- Clone↔hero handoff seam (any flicker at settle / at pull-start), expo-image
  re-decode flicker mid-flight (if seen: try `recyclingKey` or a plain RN
  Image for the clone), layout-prop interpolation smoothness on device (if
  janky: switch the clone to transform-based scaling).
- Panel clone: pixel match with the real card panel at rest (font/wheel/glass
  fill), the [0→0.35] fade window feel on open AND pull-down, the ACTIVE-wine
  panel showing when dismissing from a swiped-to page (round 3).
- Pull-down: arm only at top · horizontal swipe still pages · pager swipe vs
  pan · release threshold feel (0.6 / velocity 900 / drag 340) · cancel
  spring-back · dismiss from a swiped-to page (clone shows THAT photo, lands
  on the card frame) · back button reverse.
- Round 3: open feels snappy now? (260ms + lazy siblings — swiping to page 2
  IMMEDIATELY after open should never show a blank slot) · pull-down commit
  haptic feel · swipe to page N, pull down → the FEED CARD sits on page N
  (dots + photo + panel) and the close shrinks into it seamlessly · same after
  closing via the back button · gallery → close → pull down lands right.
- Snappiness pass: release a slow drag mid-way and a fast flick — both should
  CONTINUE at finger speed into the close (no hitch at release) · cancel a pull
  while still moving down — the return should start from rest, NO jump cut to
  fully-open (the away-velocity is deliberately dropped; a "dip" is not
  achievable with clamping) · open → immediately swipe to a neighbour page
  (must be mounted at settle; further pages within a beat) · the entry page's
  body (wheel/chips) must never be visibly absent during the open fade · 8px
  dismiss pickup vs scroll/pager disambiguation still clean — especially
  diagonal pager swipes (≥8px vertical drift before ±16px horizontal now claims
  the pan) · spring close ✅ device-confirmed 2026-07-12, then sped up to dur1
  ≈ 180ms actual on Simon's "a bit faster" — re-check the quicker close +
  flick feel (tune `springs.release`) · OPEN on `springs.enter` (dur2 ≈ 300ms)
  since that pass — re-check the open glide + that the entry unfold (content
  fade from 0.35) still reads right on the spring's front-loaded curve.
- Step 4 (transform clone + sync flag — needs `pod install` + rebuild): flight
  smoothness vs before · NO photo distortion mid-flight (the counter-scale) ·
  crop at the card endpoint matches the card's own cover crop · scrims ride
  the shrinking box correctly · GLOBAL flag check: drag surfaces still hit-test
  right mid-animation (PillTabBar drag-lens, DraggableRows reorder, score
  slider, Map/Canvas picker pans).
- §B: feed → detail → moment → back walks back to the post; Moments tab keeps
  its own independent session state; settings/add/edit/impression pushes stay
  on the feed stack; delete-a-moment from a feed-entered settings lands on
  Feed; kicked/fatal bounces land on the feed-stack line-up.
