# Pattern — Theming & gesture-taming native OS components

**Use when** you drop in a native OS component (a `@react-native-community`
picker, the native stack back-gesture, any UIKit-backed control) and it looks or
behaves wrong against Verre's dark themes or brand-custom surfaces. These are
system components — they don't read `theme.*` on their own, and their gestures
compete with the app's. Two traps hit during the scoring-UX work, each with a
one-line fix that is non-obvious until you've lost time to it.

---

## 1. Native pickers render in the OS default appearance, not your theme

**Symptom.** The inline `@react-native-community/datetimepicker` calendar showed
near-black day/weekday numerals on the dark-blue cobalt sheet — nearly
illegible. Only the accent-coloured selection honoured the theme.

**Why.** The picker is a real UIKit control. Passing `accentColor` themes only
the selection tint; the base numerals follow the picker's *own inferred
light/dark appearance*, which does not track the app-drawn `theme.surface` behind
it. On a dark theme the OS can render the picker light (black text) over your
dark sheet → dark-on-dark.

**Fix — drive `themeVariant` off the active theme's scheme, plus an explicit
text colour:**

```tsx
<DateTimePicker
  themeVariant={theme.scheme}   // 'light' | 'dark' — matches OS chrome to the theme
  textColor={theme.ink}         // iOS: pins numerals to theme ink where the lib exposes it
  accentColor={theme.accent}
  ...
/>
```

`themeVariant` is the load-bearing prop. **Do NOT hardcode `"dark"`** — the app
has light themes (apricot, mauve) too; drive it off `theme.scheme` (every theme
in `vero-tokens` carries `scheme: 'light' | 'dark'`). Same class of trap applies
to any native control with its own light/dark chrome (native menus, action
sheets, other pickers): give it the theme's scheme, don't assume it inherits.

---

## 2. Left-aligned horizontal-drag controls fight the iOS edge-back gesture

**Symptom.** Dragging the left-column structure-profile fill-tracks (which start
~20pt from the screen edge) regularly triggered an accidental navigation
back-pop instead of setting the value.

**Why.** iOS's interactive edge-swipe-back responds from a **wide** left strip
(~44pt by default, wider than it looks). Any horizontal-drag control that lives
inside that strip competes with it, and the control usually loses the first few
px of the drag (the `activeOffsetX` threshold hasn't tripped yet) → the OS pops
the screen. This is a *horizontal* gesture-arbitration conflict, **not** a
vertical touch-target miss — a bigger hitbox does not fix it (and extending the
target left makes it worse).

**Fix — narrow the edge-back zone on the screen (the pattern real apps use):**

```tsx
<Stack.Screen
  options={{ gestureResponseDistance: { start: 15 } }}  // iOS-only
/>
```

This shrinks the edge-back trigger to the true screen edge (15pt), so a control
sitting ~20pt in stops competing. Back-swipe from the actual edge still works —
it is **not** disabled (that would break the native-chrome back affordance). This
mirrors how Instagram/Spotify-class apps keep left-aligned sliders draggable.

`gestureResponseDistance` is `{ start, end, top, bottom }` (all optional numbers)
on the expo-router / react-native-screens native stack; `start` is the LTR
leading edge.

### Bonus caveat — enlarging a gesture control's touch target has TWO traps

If you ever try to give a `GestureDetector`-owned control a bigger touch area
(we tried this on the fill-tracks, then **dropped it** — the tracks are already
38–44pt, a fine target on their own, and it wasn't worth the layout churn), know
both traps before you start:

1. **A positive `Gesture.*().hitSlop(...)` is a no-op on iOS.** RNGH's own source
   (`apple/RNGestureHandler.mm`, `shouldReceiveTouch`) says hit slop "only works
   for negative values… To achieve similar effect with positive values one should
   set hitSlop for the underlying view" — iOS's `hitTest` rejects an out-of-bounds
   touch before the recognizer ever runs the slop check. So put slop on the
   **View** (`<View hitSlop={{top,bottom}}>`), not the gesture.
2. **A View's hitSlop is clipped to its ANCESTOR bounds.** RN never extends a
   view's touch area past its parent's frame. If the parent (and grandparent…)
   collapse to the control's own height — a common case in a flex grid where the
   inter-row space is `rowGap` (which lives *outside* the item) — the slop has
   nowhere to extend and is clipped to nothing. The extra room must be real
   `paddingVertical` on an ancestor *within* its bounds, not `rowGap`.

Net: "just add hitSlop" rarely works for enlarging a target inside a dense flex
grid. Prefer making the control genuinely taller, or leave it if the target is
already adequate. (Two review passes surfaced these in order — the API compiled
and looked right at each step but did nothing until both were satisfied.)

---

**Both fixes verified statically only (`tsc` + the mobile gates).** Native
appearance and gesture arbitration are device-truth — confirm on a real device,
not the Simulator (haptics no-op in the sim; the edge-back conflict is felt, not
screenshotted).
