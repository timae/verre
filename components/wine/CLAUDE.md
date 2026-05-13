# Wine modal components

Local rules for `components/wine/*`. Verre's root `CLAUDE.md` still
applies; this is overlay context for the wine-tasting surfaces.

## Pull-to-swap gesture architecture (iOS-critical)

The wine modal's scrollable body has a pull-to-swap gesture: scrolling
past the top or bottom boundary fires a previous/next wine swap. The
working state took many iterations to land because iOS Safari touch-
gesture classification is unforgiving. **If you change any of the
following, pull-to-swap and/or content scrolling will break.**

Full reference: `docs/dev/ios-touch-gestures.md` — that doc has the
history and the WHY for each rule.

### Load-bearing CSS (do NOT change without reading the doc)

On the modal's inner scroll container (the `<div ref={scrollRef}>` in
`WineModal.tsx`):

- `touch-action: pan-y` — permanent. Native iOS scroll handles
  in-content motion + momentum. Pull engages via `preventDefault()`
  on the first qualifying touchmove, while `e.cancelable` is still
  `true`. Toggling to `none` breaks momentum. Removing breaks pull.
- `overscroll-behavior: contain` — prevents iOS pull-to-refresh and
  rubber-band. Removing breaks pull-from-top.
- `overflow-y: auto` — defines the scroll surface. Otherwise iOS
  scrolls the wrong element.

The hook (`lib/usePullToSwap.ts`) has a dev-mode runtime check that
yells in `console.error` if any of these are missing.

### Other load-bearing details

- **Modal sheet uses `svh` units** (locked at `90svh` for both min and
  max), not `vh`. `vh` changes when iOS Safari's URL bar collapses,
  jumping scroll mid-gesture. The sheet is *locked to fixed height*
  rather than sized-to-content (`minHeight === maxHeight`), so swapping
  between wines of different content heights doesn't resize the modal
  (which would cause two visible jumps: sheet resize, then content
  reflow).
- **Modal sheet is `display: flex; flex-direction: column`** (set by
  `components/ui/Modal.tsx` when both `minHeight` and `maxHeight` are
  passed). Without flex, the inner column doesn't get a definite
  height; scrollRef collapses to content size and the WHOLE sheet
  becomes the scroll surface.
- **Body scroll lock** while any modal is open (set by `Modal.tsx`'s
  mount effect). Otherwise the page behind scrolls when the user
  drags inside the modal.
- **`scrollRef.current.scrollTop = 0` on `activeWineId` change** (in
  `WineModal.tsx`'s state-reset effect). Without this, swapping
  wines leaves the new wine rendered with the previous wine's
  scrollTop — usually past the new content bounds, showing empty
  space.

### Horizontal-drag controls (score slider, flavor bars)

Inside scrollRef, the rate-tab has controls the user drags
horizontally to set a score or flavor intensity. They must NOT use
`touch-action: none`. The pattern (in `RatingPane.tsx`):

1. Container `touch-action: pan-y` (inherits from scrollRef or set
   explicitly).
2. On `pointerdown`: record start, but do not capture.
3. On the first move past 6px (SLOP), check `|dx| > |dy|`. If
   horizontal-dominant → `setPointerCapture`. If vertical-dominant →
   release: iOS native pan-y scrolls the parent.

Adding a new horizontal-drag control inside scrollRef? Copy this
pattern from `FlavourBar` in `RatingPane.tsx` or `FlavorChips` on
main. Don't reinvent.

### Notes textarea

The textarea sits inside scrollRef. iOS owns native text-selection
gestures on `<textarea>`. The hook does NOT bail on textarea touches;
the first-move preventDefault wins the race against iOS's text-
selection classification, so pull-from-textarea works. Focused
textareas (user typing) keep native text behavior.

If you bail on textarea/input targets in `usePullToSwap.onTouchStart`,
pull-from-textarea breaks. We tried that and reverted.

### `data-no-pull` attribute

Set on score, flavor, and notes `<section>` elements. Read **only**
by the WineModal arrow-key handler — to skip wine navigation when
focus is on a flavor segment or another focusable control inside.
The pull-to-swap hook does NOT read it.

## Dirty-guard composition

`lib/dirtyGuard.tsx` exposes a context that lets WineModal block
bottom-nav navigation while the user has unsaved rating edits. The
guard registration in WineModal uses ref-stash + last-attempt-wins
to handle stacked nav attempts. See the comments around
`pendingNavRef` and the `dirtyGuard.register` call.

## Slide-on-swap animation (framer-motion)

When `activeWineId` changes via `commitAndSwap`, the modal plays a
vertical slide: OLD pane exits, NEW pane enters from the opposite
edge. The implementation lives in `WineModal.tsx` and uses
framer-motion (already a project dependency; ProfileTabs uses the
same pattern horizontally).

Architecture: a `motion.div` "track" is a vertical flex column. The
LIVE scrollRef is always one child. During a slide an OLD snapshot
pane is added as a sibling (above scrollRef for direction='up',
below for direction='down'). The track's `y` motion value is
animated by `animate(slideY, target, ...)`. Because both panes are
flex children of ONE translating parent, they cannot drift apart —
overlap is geometrically impossible (the invariant is enforced by
CSS layout, not by per-pane transform math).

**The slideY-reset gotcha:** when the animation completes and
`outgoing` clears, the track collapses from 2 children back to 1
(scrollRef alone via flex:1). slideY MUST be reset to 0 in
`animate.onComplete` BEFORE `setOutgoing(null)` — otherwise the
single remaining child sits at translate(±H) (off-screen) for a
frame, then the pull-rubber-band sync effect detects
`pullDistance=0 && slideY≠0` and spring-animates back to 0, visible
as a "rubber-band in from above" glitch right after settle. Locked
order in `commitAndSwap`'s onComplete: `slideY.set(0)` then
`setOutgoing(null)`. Same applies to the commit-failure abort path.

**In-flight gating across the slide:** `commitInFlightRef` is held
from commitAndSwap entry until the slide's `onComplete` (NOT just
until the POST resolves). The POST often resolves in <100ms but the
slide takes 300ms — a rapid second tap on a footer button or arrow
key during that gap would re-enter commitAndSwap, overwrite
`outgoing` mid-animation, and trigger the slideY-reset gotcha. The
gate ownership is tracked via a local `releaseInFinally` flag in
commitAndSwap — when the slide kicks off, gate-release ownership
moves to onComplete; when the slide doesn't run (reduced-motion or
edge), the finally block releases.

**Concurrent animate() controls:** framer's `animate()` does NOT
preempt concurrent animations on the same motion value. Both keep
ticking. The late finisher's onComplete (slideY.set(0)+setOutgoing(null))
can nuke a fresh slide. Defense: `slideAnimRef` stores the in-flight
animation controls; commitAndSwap calls `.stop()` on the prior ref
before starting a new animate(). With the in-flight gate held
through onComplete this path should be unreachable, but the
defensive stop is kept as a belt-and-braces invariant.

## Tab-switch state preservation

When the user switches between the Wine info and Rate tabs, the
content in `scrollRef` changes but `scrollRef` itself stays mounted.
The `ResizeObserver` in `usePullToSwap.ts` was removed because the
new architecture doesn't need it — but the scrollTop=0 reset on
`activeWineId` change is still required (different concern: wine
swap, not tab switch).

## Visual primitives

Score display: always via `<StarRating>` or `formatScore()` (see root
CLAUDE.md). The inline `ScoreSection` in `RatingPane.tsx` is the
write-side score input for this branch; it does not yet route through
the canonical `<ScoreSlider>` primitive. That migration is out of
scope for the current branch but tracked as future work.

`<WineIdentity>` is the canonical read-side wine identity renderer
(name + vintage + producer + grape). Use it on every surface that
displays a wine; don't reimplement.
