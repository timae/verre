# Pattern — Collapsing immersive hero with sticky sub-headers

**Use when** a screen has a full-bleed photo running UNDER the status bar, a bar
that floats over it and collapses to a solid title bar on scroll, AND sub-headers
(tabs, a control strip) that must pin **directly under the collapsed bar** while
the list scrolls — sitting inline at rest, sticking once scrolled. (The line-up
cover-hero today; the upcoming feed hero cards.)

**Cost of getting here:** ~5 attempts, settled via 2 code-reviews + a
web-research pass that all converged on the approach below. Read this before
touching any collapsing-hero screen so you don't re-walk it.

## The hard constraint

A `position: absolute` floating bar means native sticky pins at the scroll
viewport's top (offset 0) — which is **behind** the floating bar. **You cannot
make native `stickyHeaderIndices` (or iOS `contentInset`) pin a sub-header BELOW
a floating bar.** Every "just use native sticky" idea dies here.

## The answer — the "Dynamic Overlay" pattern (reanimated)

Render the sticky element **twice**:

1. **INLINE** in the scroll, at its natural at-rest position (this copy is also
   the flow spacer that reserves its space).
2. An **absolute reanimated copy** that tracks `scrollY` and CLAMPS its
   `translateY` so it stops under the bar; gated `opacity`/`pointerEvents` on a
   `stuck` flag so the inline copy owns taps at rest and the overlay owns them
   once pinned. The `stuck` flag flips at the SAME inequality the clamp uses, so
   the opacity swap happens exactly where the two copies coincide → no jump.

Each overlay is one rigid element ⇒ a multi-part sub-header (tabs + strip) can't
tear internally. UI-thread (`useScrollOffset` worklet) ⇒ smooth, iOS == Android,
no native-inset machinery to diverge.

**Stacking two sub-headers** (tabs above, strip below, with the about-block
between them): two overlays. The tabs pin at the bar bottom; the strip's pin
floor = `barBottom + tabsHeight` (it stacks under the pinned tabs). Each tracks
its own measured content-Y.

### Skeleton (one sub-header; two is the same with a second overlay)

```tsx
import Reanimated, { clamp, useAnimatedRef, useAnimatedStyle,
  useScrollOffset, useSharedValue } from 'react-native-reanimated';

const aref = useAnimatedRef<Reanimated.ScrollView>();
const scrollY = useScrollOffset(aref);          // UI thread, both platforms
const top = useSharedValue(0);                   // content-Y of the inline sub-header
const [topJS, setTopJS] = useState(0);           // mirror for the JS stuck gate
const [stuck, setStuck] = useState(false);
const PIN_Y = BAR_H - 1;                          // 1px under the bar (see seam note)

const overlayStyle = useAnimatedStyle(() => ({
  transform: [{ translateY: clamp(top.value - scrollY.value, PIN_Y, top.value || PIN_Y) }],
}));

<View collapsable={false} style={{ width: 0, height: 0 }} />  {/* RNS dead-end, see below */}
<Reanimated.ScrollView
  ref={aref}
  onScroll={(e) => {                              // plain onScroll for JS flags…
    const y = e.nativeEvent.contentOffset.y;
    setStuck(prev => { const s = topJS > 0 && y >= topJS - PIN_Y; return prev === s ? prev : s; });
    // …+ the measured collapse flip (see below)
  }}
  scrollEventThrottle={1}                         // 1, not 16 — see note
  contentInsetAdjustmentBehavior="never"
>
  <Photo/>                                         {/* content-y 0, bleeds under status bar */}
  <View onLayout={e => { const y = e.nativeEvent.layout.y; top.value = y; setTopJS(y); }}>
    <SubHeader/>                                   {/* INLINE copy + flow spacer */}
  </View>
  <About/> ...rows...
</Reanimated.ScrollView>

<Reanimated.View                                    {/* the pinned copy */}
  pointerEvents={stuck ? 'auto' : 'none'}
  style={[overlayStyle, { position: 'absolute', left: 0, right: 0, zIndex: 7, opacity: stuck ? 1 : 0 }]}>
  <SubHeader/>
</Reanimated.View>
```

Real implementation (two stacked overlays): `apps/mobile/src/app/(tabs)/moments/
session/[code]/index.tsx` `CoverHeroLineup`.

## Load-bearing details

- **Measure content-Y via `onLayout` on a DIRECT child of the scroll content.**
  `onLayout` reports parent-relative Y; a direct child of the ScrollView content
  IS in content space. Nesting it deeper gives a wrong (parent-relative) value →
  the pin fires at the wrong scroll position. Re-fires for free if the about
  block above it reflows.
- **`useScrollOffset(ref)` + a plain `onScroll` coexist.** The hook attaches its
  own native worklet handler (it doesn't consume the `onScroll` prop), so use
  `onScroll` for the JS flips (`stuck`, the collapse boolean) and the hook for
  the worklet. Don't `runOnJS` the flips — the plain `onScroll` already has them.
- **`scrollEventThrottle={1}`** on the reanimated ScrollView (its own default):
  the overlay reads `scrollY` every frame, so a coarser throttle shows a
  sub-pixel seam on a fast fling. The JS flip work is cheap (equality-guarded).
- **Collapse is MEASURED, never a magic scroll constant.** Flip the bar solid
  when the on-photo title's bottom scrolls under the bar: `scrollY >= titleBottom
  - BAR_H`, `titleBottom` from `onLayout` on the title. A hardcoded threshold
  mis-fires on a **proportional-height** hero (collapses early → the on-photo
  title AND the bar title both visible). The hero height here is `windowH *
  ratio`, so a fixed constant is always wrong on some device.
- **`BAR_H` = the bar's TRUE painted height; pin 1px under it.** `BAR_H =
  insets.top + rowHeight + bottomPad` — do NOT add the bar's bottom-rule px: a
  border on an absolute `top:0/bottom:0` bg layer is drawn INSIDE the box, it
  doesn't add to height; adding it pins the overlay 1px low → a content hairline
  shines through. Then pin at `PIN_Y = BAR_H - 1` (1px overlap under the bar) as
  belt-and-suspenders against sub-pixel rounding. Share `BAR_H` (a
  `heroBarHeight(insetTop)` helper) with the bar component so they can't drift.
- **react-native-screens dead-end stays.** Keep the zero-size `<View
  collapsable={false} style={{width:0,height:0}}/>` as the FIRST sibling before
  the scroll view — it stops RNSScreen's `subviews[0]` finder from flipping
  `contentInsetAdjustmentBehavior` never→automatic (which would top-inset the
  photo below the status bar). `Reanimated.ScrollView` wraps a real ScrollView,
  so the finder still applies. (See `apps/mobile/CLAUDE.md` "full-bleed scroll
  content vs react-native-screens".)
- **Bars over scrolling content are opaque** — see ADR-0003.

## What FAILS — do not retry (each cost an attempt)

- **Native `stickyHeaderIndices` under a floating bar** → pins at offset 0,
  behind the bar. (Fine on the PLAIN/no-cover layout, whose bar is fixed: the
  line-up's plain layout uses a sticky FlatList cell — but note ⚠️
  `stickyHeaderIndices` is offset **+1** when a `ListHeaderComponent` exists
  [RN `stickyOffset = header ? 1 : 0`], so it's `[1]` to stick data item 0.)
- **iOS `contentInset.top` to relocate the pin** → **silent no-op on Android**
  (verified from RN source); also made two sticky cells diverge + collapse
  mis-fire + a double title.
- **A fixed (non-scrolling) header region** for the sub-header → pins it
  permanently above the about block; it never sits inline-at-rest.
- **One combined tabs+strip block** → moves the tabs below the about block (wrong
  order). Tabs sit UNDER the photo, ABOVE the about; the strip is separate, below
  the about. Two elements, not one.

## When to graduate off "roll your own"

The web-research pass found no library that cleanly does immersive-hero +
sticky-sub-headers-under-a-floating-bar on this stack (Expo SDK 56, New Arch,
reanimated 4): `react-native-collapsible-tab-view` is Reanimated-3/old-arch (its
RN4 RC is iOS-broken); `@codeherence/react-native-header` does the collapse but
not sticky sub-headers; FlashList v2 has `stickyHeaderConfig.offset` (the one
native "pin below an offset" primitive) but isn't installed and would replace the
list. So roll-your-own Dynamic Overlay is the current best fit — revisit if a
maintained library closes the gap.
