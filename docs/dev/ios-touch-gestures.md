# iOS touch gestures inside scrollable modals

Developer-internal reference for the wine-modal pull-to-swap gesture
architecture and the iOS Safari constraints that shape it.

> **Quick rules** for editing the affected files are in
> `components/wine/CLAUDE.md` (auto-loaded by Claude Code when editing
> those files). This doc is the longer-form WHY, including the
> architectures we tried and discarded before arriving at the current
> one.

If you're touching `lib/usePullToSwap.ts`, `components/ui/Modal.tsx`
(the sheet sizing / body lock), or any `touch-action` /
`overscroll-behavior` CSS on a scroll container, read this first.

## What it does

The wine modal's body scrolls vertically. When the user reaches the
top or bottom of the scrollable content and continues to drag past it,
the gesture fires a "previous wine" or "next wine" swap. Below an 80px
threshold, releasing snaps back. Past threshold, releasing fires the
swap callback.

Touch-only. Desktop users navigate via prev/next footer buttons and
arrow keys; see `usePullToSwap.ts` header for the rationale on why
wheel-driven swap was abandoned.

## The constraints that must all be true simultaneously

Each of these is load-bearing. Changing any one breaks the gesture on
iOS in a specific way. The runtime assertion in `usePullToSwap.ts`
checks 1 and 2 at hook mount; the others are protected by inline
comments at their declaration sites.

### 1. `touch-action: pan-y` permanent on the scroll container

iOS Safari uses `touch-action` to classify the gesture at touchstart.
`pan-y` tells iOS "vertical pan is native scroll, JS handles
everything else." That gives us **native iOS scroll with momentum/
inertia for free** — which is what makes content scrolling feel right.

**Why not `none`?** We tried it. `touch-action: none` makes JS own
every gesture, including content scrolls. That kills momentum (we'd
have to reimplement scroll-with-inertia in JS) and causes the
abrupt-stop UX bug.

**Why not toggle between `pan-y` and `none`?** We tried that too —
flipping based on scroll-boundary state. Two problems:
(a) the toggle had to happen at gesture-start, before JS sees touchstart
— iOS reads `touch-action` synchronously when the gesture begins;
(b) the layout-property reads in the scroll handler stuttered momentum.

### 2. `overscroll-behavior: contain` on the scroll container

This does two things on iOS:
- Prevents iOS's pull-to-refresh from triggering when scrolling up past
  scrollTop=0 inside the modal.
- Prevents the rubber-band/bounce when overscrolling past the boundary.

Without it, the pull-to-refresh fires immediately on any top-overscroll,
canceling our gesture before it can engage.

### 3. `{ passive: false }` on the touchmove listener

We need to call `e.preventDefault()` inside `touchmove`. Without
`passive: false`, the browser silently ignores `preventDefault()` and
native scroll proceeds.

### 4. The 2px engagement threshold (NOT 4px+)

The trick that makes pull-to-swap work despite `touch-action: pan-y`:
on the FIRST touchmove of a fresh gesture, `e.cancelable` is `true`
even with `pan-y`, because iOS hasn't committed to native scroll yet.
If we `preventDefault()` here, iOS hands the gesture to JS for the
rest of its life.

**The deadline**: this decision has to happen within the first ~3px
of finger movement. If we wait until the user has dragged 4px+, iOS
has already committed to native scroll and `e.cancelable` flips to
`false`. `preventDefault()` becomes a silent no-op. The user gets a
"slide through past boundary" bug + a broken-render on the next wine
(because the gesture both scrolled AND fired the swap).

The engagement code lives in `usePullToSwap.ts` around lines 155–180.
If you change the magic 2 to a larger value, the slide-through bug
returns.

### 5. The gesture must START at a boundary

A continuous gesture that starts mid-content and crosses a boundary via
native scroll **cannot** be reclassified as a pull. By the time scroll
reaches the boundary, iOS has been running native scroll for hundreds
of ms; `cancelable` is false.

So pull-to-swap engages only on gestures whose touchstart was already
at a boundary (`scrollTop === 0` or `scrollTop === max`). Users who
scrolled to the boundary inside the current gesture must lift their
finger and re-touch to initiate a pull. This matches the iOS Mail /
Photos / Messages "lift and pull again" pattern.

### 6. `scrollTop = 0` reset on wine swap

When the user swaps to a different wine via pull, button, or keyboard,
the modal's scrollRef element stays mounted (only its children change).
Without an explicit reset, the new wine renders with the previous
wine's scrollTop preserved — usually invalid for the new content
height, showing mostly empty space.

The reset lives in `components/wine/WineModal.tsx`, inside the
`useEffect` keyed on `activeWineId`.

### 7. Modal sheet height in `svh`, not `vh`

`vh` units change when iOS Safari's URL bar collapses during scroll.
That changes scrollRef's `clientHeight` mid-gesture, which causes
`scrollTop` to clamp, which iOS interprets as scroll-end → momentum
dies abruptly.

`svh` (small viewport height) is stable across URL-bar collapse.
Modal sheet uses `90svh` / `70svh`. See `WineModal.tsx` where it
passes `maxHeight="90svh" minHeight="70svh"` to `<Modal>`.

### 8. Modal sheet is `display: flex; flex-direction: column` when min+max height are both set

Without this, the inner column with `flex: 1` doesn't get a definite
height to claim. scrollRef inside collapses to its content size, and
the WHOLE Modal sheet becomes the scroll surface (not scrollRef).
Pointer events on scrollRef then don't track scroll, and our gesture
logic is operating on the wrong element.

The flex layout in `Modal.tsx` propagates a definite height down to
scrollRef, so `overflow: auto` actually creates a scroll surface inside.

### 9. Body scroll lock while modal is open

`body { overflow: hidden; position: fixed; overscroll-behavior: contain }`
while any modal is in the stack. Otherwise:
- The page behind scrolls when the user drags inside the modal.
- iOS routes the drag to the body's scroll instead of to scrollRef's
  pointer events.

See `Modal.tsx`'s mount/unmount effect.

## Gesture flow walkthrough

For touch gestures on the wine modal's scrollRef:

```
touchstart
  └─ scrollTop at 0 or max?
       NO → bail entirely. iOS native scroll handles the gesture.
       YES → record boundary direction, dragStartY, activeTouchId.

touchmove (first qualifying ≥2px)
  └─ pulling past the boundary direction (down at top, up at bottom)?
       YES → preventDefault(). Engage pull. JS owns the gesture.
       NO  → drag is into content. Clear state. iOS native scroll
             takes over.

touchmove (subsequent)
  └─ if pulling: accumulate pullDistance with resistance, update visual.
  └─ if not engaged: returns early (dragStartY was cleared).

touchend
  └─ if pulling and dist past threshold: fire swap. Reset.
  └─ if not pulling: reset.
```

## Adding a new modal that needs the same pattern

If you add another scrollable modal that needs pull-to-swap or similar
boundary-overscroll handling:

1. Pass `maxHeight="90svh" minHeight="70svh"` (or your sizes — both in
   `svh`) to `<Modal>`. This triggers the flex-column layout that
   propagates definite height inward.

2. Build an inner scroll container with `overflow-y: auto`,
   `touch-action: pan-y`, `overscroll-behavior: contain`. Pass a ref
   to it.

3. Call `usePullToSwap({ containerRef, ...callbacks })`. The hook's
   runtime check will scream in dev if you forgot a CSS property.

4. If you have horizontal-drag controls inside (sliders, etc.), they
   should use the intent-detection pattern in `components/rate/
   FlavorChips.tsx` (the canonical reference) — `touch-action: pan-y`
   on the control, defer `setPointerCapture` until the first move
   resolves direction.

## Don't do these things

- **Don't set `touch-action` on individual children inside the scroll
  container.** Let them inherit from scrollRef. Setting `pan-y` on a
  child while scrollRef also has `pan-y` is fine but redundant.
  Setting `none` on a child overrides scrollRef and breaks scroll.

- **Don't add pointer-event listeners on scrollRef.** TouchEvents are
  what we use; PointerEvents have different iOS gesture-classification
  semantics. We tried both during the iteration.

- **Don't call `e.preventDefault()` outside the engagement check.**
  Preventing every touchmove blocks native scroll entirely. Only
  preventDefault when `pulling.current === true` (i.e. we've already
  engaged via the first-move logic).

- **Don't add a `touchmove`-debouncer.** Each touchmove must be
  evaluated for engagement; throttling delays the engagement past the
  cancelable-deadline window.

- **Don't change the body scroll-lock pattern in Modal.** It uses the
  "save scrollY → fix position → restore on unmount" pattern. Each
  step is necessary.

## History

Five architectures tried. In rough order:

1. **Wheel-based swap** with state machine. Removed because wheel
   handling on trackpads vs. mice vs. inertia-mode was unfixable;
   desktop got prev/next buttons instead.

2. **`touch-action` toggle on scroll** (pan-y mid-content, none at
   boundary). Worked for the engagement but the at-boundary state
   forced a JS-managed scroll branch (no native momentum) when the
   user dragged INTO content from a boundary. Caused the abrupt-stop
   UX bug.

3. **Scroll-only mode** for `[data-no-pull]` controls. Replaced by
   intent detection in the controls themselves.

4. **Pan-y always + touchmove preventDefault at any past-boundary
   move.** Had the slide-through bug because the user could scroll
   to the boundary inside the same gesture, by which point iOS had
   already classified the gesture as native scroll and our
   `preventDefault` was a no-op.

5. **Current: pan-y always + touchmove preventDefault ONLY when the
   touchstart was at the boundary AND the first move is past it
   (≥2px).** The 2px threshold and the "started at boundary"
   precondition together ensure we preventDefault while
   `e.cancelable === true`.

The current architecture is captured in commit `f32ead9` with
follow-up cleanup. The checkpoint of the previous (working but
abrupt-stop) state is at `b9983e3` for reference.

## Horizontal-drag controls inside the scroll container

The rate-tab contains three sub-surfaces that all sit inside the
scrollable container: the score slider, the flavor bars, and the
notes textarea. Each was a source of iOS gesture bugs during the
iteration. The patterns below are what works.

### Score slider + flavor bars: horizontal-intent detection

**The bug we kept hitting**: a control with `touch-action: none`
captures EVERY gesture, including vertical wobbles during a
horizontal drag. iOS then doesn't let the user scroll vertically
when their finger is on the control — frustrating on dense rate-tab
layouts where the user wants to scroll through content.

**The pattern that works** (mirrored from `components/rate/
FlavorChips.tsx` on main):

1. Container has `touch-action: pan-y`. Browser claims vertical pans
   for native scroll.

2. On `pointerdown`, record the start position. **Don't claim the
   pointer yet.** A `pendingDownRef = { x, y }` stores the start.

3. On the first `pointermove` past a slop threshold (~6px), check
   `Math.abs(dx) > Math.abs(dy)`:
   - **Horizontal-dominant** → `setPointerCapture(pointerId)`. The
     gesture is now JS-owned for sliding/flavor adjustment.
   - **Vertical-dominant** → clear `pendingDownRef`, do nothing.
     iOS continues with native pan-y scroll.

4. On `pointerup`, commit the value if dragging or treat as tap.

5. On `pointercancel` (iOS reclassifying the gesture as a scroll),
   clear state — discard whatever was in-progress.

The relevant code lives in `components/wine/RatingPane.tsx`:
- `ScoreSection` (lines around 130–280) — single-track slider.
- `FlavourBar` (lines around 380–460) — per-flavor segment bars.

Both follow the same shape: `pendingDownRef` + `draggingRef` + the
`|dx| > |dy|` check. **If you add a new horizontal-drag control inside
scrollRef, copy this pattern.** Don't use `touch-action: none`.

### Notes textarea: special-case iOS text handling

**The bug**: the textarea sits at the bottom of the rate-tab content.
A user wanting to pull-up at the bottom boundary often lands their
finger on the textarea (it has the biggest visible surface there).
iOS Safari intercepts touches on `<textarea>` for native text-
selection / caret positioning. By the time JS sees touchmove, iOS
has already classified the gesture and `e.cancelable === false` —
our preventDefault is a no-op, pull doesn't engage.

**The solution**: don't bail in `usePullToSwap` when the target is a
textarea. The trick is the gesture engagement on the FIRST qualifying
touchmove (≥2px in pull direction) — that fires BEFORE iOS commits to
text-selection on a fresh gesture. By preventDefault'ing then, we
claim the gesture for JS before iOS routes it to text-handling.

This works only because:
- The textarea is unfocused when the user pulls (they're not actively
  editing).
- A focused textarea (user typing) doesn't typically sit at a scroll
  boundary — they've already scrolled into editing position.

If you change `usePullToSwap.onTouchStart` to bail on `TEXTAREA` or
`INPUT` targets, pull-from-textarea breaks. Earlier iterations did
this and reverted.

### `data-no-pull` attribute

This attribute is set on the score, flavor, and notes `<section>`
elements in RatingPane. It's read **only by** the WineModal
keyboard-arrow handler — to skip wine-navigation when focus is on a
flavor segment button or another focusable control inside one of
these sections.

**The hook does NOT read `[data-no-pull]`.** Earlier iterations did,
but the current architecture relies on intent detection in the
controls themselves rather than scrollRef-level opt-outs. The
attribute is kept because it's a clean way to extend the keyboard
opt-out to future controls.

## Other related concerns (not iOS-touch specific)

- Keyboard arrow-key navigation — see `components/wine/WineModal.tsx`
  around the `useEffect` with the window-level `keydown` listener.
- Dirty-guard composition with bottom-nav — see
  `lib/dirtyGuard.tsx`.
