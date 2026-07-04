// Floating-pill bottom nav (handoff .tabbar-float / .tabbar-item) — the
// brand-custom bar that replaced NativeTabs (ADR-0006). The OS iOS-26 glass
// bar scrambled in the field (upstream: expo#42364 label/icon misrender after
// stack return, react-navigation#12908 selected-label truncation) and dropped
// its themed colors (expo#44029 labelStyle ignored, expo#40389 glass
// recompute) — this bar is deterministic: theme tokens, our icon set, no OS
// appearance machinery. Content scrolls UNDER it (absolute overlay): screens
// clear it with `insets.bottom + TAB_BAR_CLEARANCE` (lib/layout.ts — the
// constant carries the bar's real height now, not breathing room).
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { ReduceMotion, runOnJS, type SharedValue, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';
import { alpha } from '@/theme/color';


// FINAL glass architecture (the dev-gallery glass labs 1–3 + Files ground
// truth, ratified by Simon via the codex review — see docs/design/patterns
// when this gets its recipe doc). The physics that forced it:
//   · 'clear' + isInteractive GlassView = the real lens optic (edge warp,
//     chromatic rim); 'regular' = frost slab. (Lab 1, case 3 vs 1.)
//   · A lens over ANOTHER glass dies (smoky slug) unless both share a
//     GlassContainer — but container members can't optically see siblings,
//     so an in-container lens can never warp the bar or items. (Lab 2/3.)
//   · A lens over a SOLID fill goes milky — it magnifies the fill. (Lab 3B.)
// ⇒ ONE glass in the whole bar: the held lens (case-3 recipe), floating over
// a PSEUDO-GLASS body — a token-controlled translucent SVG capsule with a
// punch-through HOLE tracking the lens (lab 3C), so the lens samples pure
// backdrop: clear center, genuine rim distortion. Between body and lens
// sits the BAIT row (a held-only duplicate the lens warps — its fringes
// read as rim distortion); the REAL, touch-receiving row renders crisp
// ABOVE the lens. The rest indicator is a plain capsule (no glass needed
// at rest) that dissolves while the lens is out.
// Bonus: the pseudo body is cross-platform — Android gets the same bar.
// HONESTY NOTE (codex): the clear-center look is a LAYERED SIMULATION —
// crisp duplicate row above the glass, faded center patch, bait fringes —
// not pure native lens optics. That's deliberate: it's what the public
// primitives can deliver stably.
// ⚠️ Still true: never put opacity on the GLASS lens or its parents (the
// effect dies — expo#41024); the rest capsule is a plain View and MAY fade.
let GlassSkin: typeof import('expo-glass-effect').GlassView | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const glass = require('expo-glass-effect') as typeof import('expo-glass-effect');
  // BOTH guards (codex finding): isLiquidGlassAvailable() alone is not the
  // crash guard — some iOS 26 betas lack the glass API entirely and
  // isGlassEffectAPIAvailable() is the package's documented pre-check.
  if (glass.isGlassEffectAPIAvailable() && glass.isLiquidGlassAvailable()) GlassSkin = glass.GlassView;
} catch {
  GlassSkin = null;
}
const AnimatedPath = Reanimated.createAnimatedComponent(Path);
// Capsule subpath (worklet-safe) for the punch-through body.
function capsulePath(x: number, y: number, w: number, h: number) {
  'worklet';
  const r = h / 2;
  return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + r} ${y + h} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

// Slot order + glyphs per the handoff bottomNav (i-home/i-glass/i-ph/i-user).
// "Soon" is the undecided 4th slot — a real, tappable tab (empty-state screen),
// not the mock's disabled placeholder.
const SLOTS: Array<{ name: string; label: string; icon: IconName }> = [
  { name: 'feed', label: 'Feed', icon: 'home' },
  { name: 'moments', label: 'Moments', icon: 'glass' },
  { name: 'soon', label: 'Soon', icon: 'soon' },
  { name: 'you', label: 'You', icon: 'user' },
];
const PAD_V = 8;
const PAD_SIDE = 6;
const HOLD_MS = 180;
// Content-hugging bar (Simon's call vs the App Store reference: Apple's pill
// wraps its items, it doesn't stretch full-width): fixed slot width, bar
// centered. Full-width made the slots huge and kept the lens from ever
// reaching the bar's ends.
const ITEM_W = 78; // baseline at 393pt window width — scaled per device below
// How far the HELD lens may overshoot past the bar's side edges (the OS lens
// visibly pokes out at the end tabs).
const OUT_REACH = 10;
// Body + rest-capsule dials (token-driven; see the header for why the body
// is pseudo-glass). BODY_ALPHA: the bar capsule's translucency. REST_ALPHA:
// the resting selection capsule's ink tint.
const BODY_ALPHA = 0.84; // Simon: 0.72 read too transparent; the punch-through floor carries the lens region
// ⚠️ LENS DIALS ARE PER-SCHEME (codex verdict 2026-07-03: "dark mode lands;
// light mode over-bright"). In light themes the cream surface + the
// material's specular sheen COMPOUND into center bloom/glare — light gets
// lower fills and a stronger counter-tint. Tune each scheme independently;
// don't average them.
// The LENS FLOOR: the aperture is NOT an empty window (a raw hole made the
// content behind the bar "way too visible"; Apple's lens shows the BAR'S OWN
// translucent surface through the lens, not the page). Target is PARITY:
// through the lens you should see the backdrop about as much as through the
// idle bar, never more (Simon's readability ruling). Slightly below
// BODY_ALPHA because the glass itself dims a touch. The historical milk at
// high fills was the aperture-sync bug, not the alpha — don't re-lower this
// on a milk sighting without checking sync first.
const FLOOR_ALPHA = { dark: 0.78, light: 0.68 };
// Counter-tint on the lens glass — cancels the interactive sheen's added
// light (it read as "brighter than the bar"). Light needs more.
const LENS_TINT = { dark: 0.07, light: 0.12 };
// How much of the theme bg's hue goes into the counter-tint (vs black).
// Per-scheme so tuning the cold cast on LIGHT themes (Apricot read blue,
// then "still a bit too cold" at 0.35) cannot move the dark themes Simon
// already approved.
const HUE_MIX = { dark: 0.35, light: 0.55 };
// Rim-only optics (Simon: "don't reflect INTO the lens, only break at the
// edges"): the material always processes its whole footprint, so the CENTER
// PATCH covers the glass interior with the bar's own pseudo-material and
// FADES OUT radially toward the rim (a hard-edged patch drew a visible
// boundary — "should be an organic fade"). Full cover until FADE_HOLD of
// the radius, zero by the edge; the glass ring emerges gradually.
const CENTER_ALPHA = { dark: 0.8, light: 0.6 };
const FADE_HOLD = 0.55; // fraction of the radius at full center cover
const REST_ALPHA = 0.07;

export function PillTabBar({ state, navigation }: BottomTabBarProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  // Measured height → an EXACT capsule radius (height/2). The Liquid Glass
  // material derives its lens shape from the corner radius — the shorthand
  // radius.pill (999) far exceeds half-height and degraded the effect to
  // flat shine-through on device (no capsule lensing). RN clamps 999
  // visually, so the opaque fallback never cared; the glass does.
  const [barH, setBarH] = useState(0);
  const [barW, setBarW] = useState(0);
  const capsule = barH > 0 ? barH / 2 : 31; // ≈ the bar's natural half-height pre-measure
  const mode: 'dark' | 'light' = theme.scheme === 'dark' ? 'dark' : 'light';
  // Lens counter-tint carries the THEME'S temperature: pure black left the
  // system glass's cool cast visible, which read as a BLUE hue against warm
  // themes (Apricot worst — Simon's all-themes screenshot pass). 35% of the
  // theme bg's hue blended into black, at the per-scheme alpha. (mix() emits
  // rgb() which alpha() can't parse — hence the local blend.)
  const lensTint = (() => {
    const m = /^#([0-9a-f]{6})$/i.exec(theme.bg.trim());
    if (!m) return alpha('#000000', LENS_TINT[mode]);
    const n = parseInt(m[1], 16);
    const ch = (shift: number) => Math.round(((n >> shift) & 255) * HUE_MIX[mode]);
    return `rgba(${ch(16)},${ch(8)},${ch(0)},${LENS_TINT[mode]})`;
  })();

  const slots = SLOTS.filter((s) => state.routes.some((r) => r.name === s.name));
  // Apple's floating bar widens with the device (Simon's 15 Pro Max showed
  // ours undersized): scale the slot from the 393pt baseline, clamped so
  // small phones don't crush labels and tablets don't stretch the pill.
  const { width: winW } = useWindowDimensions();
  const itemW = Math.round(Math.min(92, Math.max(72, ITEM_W * (winW / 393))));
  const activeSlot = Math.max(0, slots.findIndex((s) => s.name === state.routes[state.index]?.name));

  // ── The lens (native feel, Simon's ask): a second glass capsule that rests
  // under the ACTIVE tab, and on press-and-hold grows past the bar's edges and
  // rides along under the finger — a selection tick each time it crosses a
  // tab, a light impact on commit (the OS bar's drag behavior). Taps keep
  // working through the item Pressables (the pan only activates after a 180ms
  // hold, and its activation cancels the underlying press).
  //
  // (The layer architecture is defined ONCE in the file header — one glass
  // lens over a pseudo-glass punched body. Earlier container-era guidance
  // that lived here sent implementations in circles and was removed.)
  const lensCX = useSharedValue(0); // lens CENTER x, bar-space coords
  const lensOn = useSharedValue(0); // 0 = resting indicator, 1 = held/dragging
  const hovered = useSharedValue(0);
  const started = useSharedValue(0); // 1 while a pan has ACTIVATED (held past HOLD_MS)
  // ⚠️ ORDER IS LOAD-BEARING: this geometry block must sit ABOVE the pan
  // gesture below. Worklets capture their closure when the handler is built
  // during render — consts declared after that point are captured as
  // undefined (the on-device crash: "undefined is not a function" inside
  // onEnd, which called a then-uninitialized slotLeft).
  // Lens geometry, matched frame-by-frame against Simon's App Store
  // reference recording: native size = the HELD size — WIDER than a tab slot
  // (the OS capsule clearly exceeds its label/slot) and taller than the bar
  // (bulges past both edges); held, it may overshoot PAST the bar's side
  // edges by OUT_REACH (the OS lens pokes out at the end tabs). At rest it
  // scales down to the selection capsule. Scale/translate only — never
  // opacity (see header).
  // OVER = 0 on the opaque fallback ON PURPOSE: a solid capsule poking past
  // a solid bar reads as a rendering bug; only glass earns the bulge.
  const OVER = GlassSkin ? 7 : 0;
  const REST_INSET = 5; // resting capsule inset — same vertically and at the bar's end curves (concentric nest)
  // Rest/held sizes are DECOUPLED (uniform scaling made the resting capsule
  // both too narrow — "too snug around the item" — and egg-ended once width
  // and height needed different ratios). Rest width = the full slot, so the
  // item sits centered with Apple's generous padding; held adds width and
  // the vertical bulge.
  const REST_W = itemW;
  const HELD_W = itemW + 12;
  const restH = Math.max(0, barH - REST_INSET * 2);
  const heldH = barH + OVER * 2;
  // Center-based coords: scale shrinks around the center, so positioning the
  // CENTER (not the left edge) keeps rest/held states aligned.
  // 'worklet' directives: these run in the gesture's onEnd/onFinalize on the
  // UI thread — a plain closure there is `undefined is not a function`.
  const heldCenter = (x: number) => {
    'worklet';
    return Math.min(Math.max(x, HELD_W / 2 - OUT_REACH), barW - HELD_W / 2 + OUT_REACH);
  };
  // End slots SNAP to the bar's end curves (reviewer proved the clamp alone
  // never engages at these sizes: the shrunken capsule is narrower than its
  // slot, so slot-centering leaves a ~14pt gap vs the 5pt vertical inset —
  // not the App Store's concentric nesting). First/last rest AT the inset.
  const restCenter = (i: number) => {
    'worklet';
    if (i === 0) return REST_INSET + REST_W / 2;
    if (i === slots.length - 1) return barW - REST_INSET - REST_W / 2;
    return PAD_SIDE + i * itemW + itemW / 2;
  };

  // Motion: overshoot-CLAMPED springs — the OS lens settles dead, no wobble
  // (Simon called the overshoot twice; clamping keeps the spring's fast
  // decel without the bounce) + a short timed grow.
  // reduceMotion: System — the OS setting turns snaps/grows into jumps
  // (codex: no reduced-motion gate existed).
  const SNAP = { damping: 26, stiffness: 340, overshootClamping: true, reduceMotion: ReduceMotion.System };
  // Rest placement. barW gate is LOAD-BEARING (reviewer F3): itemW is a
  // constant now, and pre-measure the clamps invert — the lens would spring
  // in from off-bar on EVERY remount (and the bar remounts for every
  // sheet/keyboard/route hide). First post-measure placement is a direct
  // set, not a spring, for the same reason.
  const placed = useRef(false);
  useEffect(() => {
    if (barW <= 0) return;
    const target = restCenter(activeSlot);
    if (!placed.current) {
      placed.current = true;
      lensCX.value = target;
      return;
    }
    lensCX.value = withSpring(target, SNAP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, itemW, barW]);

  // While dragging, the ITEM TINT follows the lens (OS behavior — Simon's
  // call): hoverJS mirrors the hovered slot to React; content still swaps
  // only on release.
  const [hoverJS, setHoverJS] = useState<number | null>(null);
  // Tap-fly (Simon, matching the OS): a TAP also forms the lens — it lifts,
  // travels to the tapped slot (the activeSlot effect's spring), settles and
  // dissolves. tapFly mounts the glass layers for the flight's duration;
  // navigation itself stays immediate, like the OS.
  const [tapFly, setTapFly] = useState(false);
  const tapFlyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (tapFlyTimer.current) clearTimeout(tapFlyTimer.current);
  }, []);
  const flyTo = () => {
    setTapFly(true);
    if (tapFlyTimer.current) clearTimeout(tapFlyTimer.current);
    tapFlyTimer.current = setTimeout(() => setTapFly(false), 500);
    lensOn.value = withSequence(
      withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System }),
      withDelay(80, withTiming(0, { duration: 200, reduceMotion: ReduceMotion.System }), ReduceMotion.System),
    );
  };
  const held = hoverJS !== null || tapFly;
  // ⚠️ Drag guard for the item Pressables: pan activation SHOULD cancel the
  // underlying press, but on device a drag's release could still fire the
  // item's onPress — a second input path that re-introduced the same-tab
  // pop-to-root after commit() was already fixed. Refs (always current, no
  // stale closure) block presses during a drag and briefly after it.
  const dragActive = useRef(false);
  const dragUntil = useRef(0);
  const hoverTo = (slotIndex: number) => {
    dragActive.current = true;
    setHoverJS(slotIndex);
    Haptics.selectionAsync().catch(() => {});
  };
  const commit = (slotIndex: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const slot = slots[slotIndex];
    const route = slot ? state.routes.find((r) => r.name === slot.name) : undefined;
    // Landing the drag on the CURRENT tab is NOT input (Simon's ruling): no
    // tabPress emit at all — the emit alone would pop the tab's stack to root
    // (the vendored native-stack listens for it). Only a deliberate TAP on
    // the active item does that, via the Pressable path.
    if (route && state.index !== state.routes.indexOf(route)) {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!event.defaultPrevented) navigation.navigate(route.name);
    }
    dragActive.current = false;
    dragUntil.current = Date.now() + 400;
    setHoverJS(null);
  };
  const cancelHover = () => {
    // Belt to the worklet-side `started` guard: never arm the cooldown
    // unless a drag was actually in progress.
    if (!dragActive.current) return;
    dragActive.current = false;
    dragUntil.current = Date.now() + 400;
    setHoverJS(null);
  };

  const pan = Gesture.Pan()
    .activateAfterLongPress(HOLD_MS)
    .shouldCancelWhenOutside(false)
    .onStart((e) => {
      // e.x is bar-space (the gesture view is the full padded row).
      started.value = 1;
      lensOn.value = withTiming(1, { duration: 160, reduceMotion: ReduceMotion.System });
      const h = Math.min(slots.length - 1, Math.max(0, Math.floor((e.x - PAD_SIDE) / itemW)));
      hovered.value = h;
      lensCX.value = withSpring(heldCenter(e.x), SNAP);
      runOnJS(hoverTo)(h);
    })
    .onUpdate((e) => {
      // Direct follow while dragging (no spring lag); ticks on slot crossings.
      lensCX.value = heldCenter(e.x);
      const h = Math.min(slots.length - 1, Math.max(0, Math.floor((e.x - PAD_SIDE) / itemW)));
      if (h !== hovered.value) {
        hovered.value = h;
        runOnJS(hoverTo)(h);
      }
    })
    .onEnd((_e, success) => {
      // A CANCELLED active drag reaches onEnd with success=false BEFORE
      // onFinalize (RNGH 2.31 eventReceiver) — bail so the retreat branch in
      // onFinalize handles it; committing on a system interruption navigated
      // to wherever the finger happened to hover (reviewer catch).
      if (!success) return;
      started.value = 0;
      lensOn.value = withTiming(0, { duration: 160, reduceMotion: ReduceMotion.System });
      lensCX.value = withSpring(restCenter(hovered.value), SNAP);
      runOnJS(commit)(hovered.value);
    })
    .onFinalize((_e, success) => {
      // ⚠️ Guard on `started` (reviewer F1): a plain TAP also runs this pan
      // through BEGAN→FAILED (activateAfterLongPress means every touch
      // begins the gesture), so an unguarded !success branch fired
      // cancelHover on EVERY tap — arming the 400ms press-cooldown and
      // swallowing rapid tab taps. Only an ACTIVATED drag may clean up here.
      if (!success && started.value === 1) {
        started.value = 0;
        // Cancelled (system interruption): retreat to the active tab.
        lensOn.value = withTiming(0, { duration: 160, reduceMotion: ReduceMotion.System });
        lensCX.value = withSpring(restCenter(activeSlot), SNAP);
        runOnJS(cancelHover)();
      }
    });

  // Size-interpolated (layout props animate only during the 160ms grow;
  // drag movement is transform-only). Capsule radius tracks height, so the
  // ends stay perfectly round in BOTH states.
  const lensStyle = useAnimatedStyle(() => {
    const t = lensOn.value;
    const w = REST_W + (HELD_W - REST_W) * t;
    const h = restH + (heldH - restH) * t;
    return {
      width: w,
      height: h,
      borderRadius: h / 2,
      top: barH / 2 - h / 2,
      transform: [{ translateX: lensCX.value - w / 2 }],
    };
  });
  // Material, matched to the reference frames: the OS lens is the CLEAR
  // style — transparent with rim refraction, and the item label inside stays
  // CRISP (Apple renders items ON TOP of the lens; 'regular' + a strong tint
  // read as a milky frosted sticker smearing the label — Simon's screenshot).
  // A 5% ink tint gives the resting capsule its faint presence.
  // Resting selection: a PLAIN tinted capsule (no glass — codex ruling: the
  // rest state and the optical lens are different jobs). It rides the same
  // position machinery and DISSOLVES while the lens is out — if it stayed,
  // it would sit over the body's punch-through hole and re-tint the lens
  // sample (the lab-3B milk, from a different layer). Plain views may fade;
  // the no-opacity rule only binds GLASS.
  const restStyle = useAnimatedStyle(() => ({ opacity: 1 - lensOn.value }));
  const lens =
    barW > 0 ? (
      <Reanimated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ position: 'absolute', left: 0 }, lensStyle, restStyle]}
      >
        <View style={{ flex: 1, borderRadius: (hoverJS !== null ? heldH : restH) / 2, backgroundColor: alpha(theme.ink, REST_ALPHA) }} />
      </Reanimated.View>
    ) : null;

  const items = slots.map((slot, slotIndex) => {
    const route = state.routes.find((r) => r.name === slot.name)!;
    const active = hoverJS !== null ? slotIndex === hoverJS : state.index === state.routes.indexOf(route);
    return (
      <TabItem
        key={route.key}
        slot={slot}
        active={active}
        color={active ? theme.accent : theme.inkSoft}
        centerX={PAD_SIDE + slotIndex * itemW + itemW / 2}
        width={itemW}
        reach={HELD_W / 2}
        lensCX={lensCX}
        lensOn={lensOn}
        onPress={() => {
          // A drag's release must not double-fire as a tap (see dragActive).
          if (dragActive.current || Date.now() < dragUntil.current) return;
          Haptics.selectionAsync().catch(() => {});
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!active && !event.defaultPrevented) {
            flyTo();
            navigation.navigate(route.name);
          }
        }}
      />
    );
  });

  // The in-flow items row DEFINES the bar's size (paddings live here); the
  // bar material is an absolute-fill layer behind it. Measures both the
  // height (capsule radius) and the width (slot math).
  const row = (
    <GestureDetector gesture={pan}>
      <View
        collapsable={false}
        style={{ flexDirection: 'row', paddingVertical: PAD_V, paddingHorizontal: PAD_SIDE }}
        onLayout={(e) => {
          setBarH(e.nativeEvent.layout.height);
          setBarW(e.nativeEvent.layout.width);
        }}
      >
        {items}
      </View>
    </GestureDetector>
  );

  // .tabbar-float position: detached pill, 14px side/bottom margins (above
  // the home indicator). NO overflow hidden anywhere — the held lens must
  // poke past the bar's edges.
  const outerPos = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: insets.bottom + 14,
  };

  // Pseudo-glass body (lab 3C, codex-ratified): a translucent token capsule
  // drawn as SVG so it can carry a punch-through HOLE (even-odd fill)
  // tracking the lens. The hole grows with lensOn — in sync with the lens's
  // own 160ms grow, so there's no lag or mismatch — and vanishes at rest,
  // leaving a plain unbroken capsule. Cross-platform (Android gets the same
  // bar); no glass beneath the lens, so nothing can kill or tint its optics.
  // Aperture OVERSIZED relative to the glass footprint (codex: prove the
  // clear center with a full-lens aperture first, tighten the rim allowance
  // later): +6pt wider than the glass at every scale step, full bar height.
  const holeW = HELD_W + 6;
  const bodyProps = useAnimatedProps(() => {
    const t = lensOn.value;
    const outer = capsulePath(0, 0, barW, barH);
    if (t < 0.03 || barW <= 0) return { d: outer };
    const w = holeW * (0.25 + 0.75 * t);
    const h = Math.min(barH, heldH * (0.25 + 0.75 * t));
    const x = Math.min(Math.max(lensCX.value - w / 2, 0), Math.max(0, barW - w));
    return { d: outer + ' ' + capsulePath(x, (barH - h) / 2, w, h) };
  });
  // Same geometry as the hole — fills it at FLOOR_ALPHA (see the dial note).
  const floorProps = useAnimatedProps(() => {
    const t = lensOn.value;
    if (t < 0.03 || barW <= 0) return { d: '' };
    const w = holeW * (0.25 + 0.75 * t);
    const h = Math.min(barH, heldH * (0.25 + 0.75 * t));
    const x = Math.min(Math.max(lensCX.value - w / 2, 0), Math.max(0, barW - w));
    return { d: capsulePath(x, (barH - h) / 2, w, h) };
  });
  const barLayer =
    barW > 0 ? (
      <Svg pointerEvents="none" width={barW} height={barH} style={{ position: 'absolute', left: 0, top: 0 }}>
        {/* Static outer outline (the .tabbar-float rule border), fill above
            it carries the animated even-odd hole. */}
        <Path
          d={`M ${capsule} 0.5 L ${barW - capsule} 0.5 A ${capsule - 0.5} ${capsule - 0.5} 0 0 1 ${barW - capsule} ${barH - 0.5} L ${capsule} ${barH - 0.5} A ${capsule - 0.5} ${capsule - 0.5} 0 0 1 ${capsule} 0.5 Z`}
          fill="none"
          stroke={theme.rule}
          strokeWidth={1}
        />
        <AnimatedPath animatedProps={bodyProps} fill={alpha(theme.surface, BODY_ALPHA)} fillRule="evenodd" />
        <AnimatedPath animatedProps={floorProps} fill={alpha(theme.surface, FLOOR_ALPHA[mode])} />
      </Svg>
    ) : null;
  // Content-hugging: the outer strip is full-width box-none; the bar box
  // centers within it and wraps its fixed-width slots (Apple's pill wraps
  // content — full-width stretched the slots and pushed the ends out of the
  // lens's reach).
  // Held overlay + the BAIT ROW (codex's fallback, adopted after Simon
  // ruled the center must stay crisp): the REAL row renders ABOVE the glass
  // — crisp everywhere, always, no hiding, no popping — and a full duplicate
  // of the items (the bait) renders BENEATH the glass while held. The lens
  // displaces the bait; its fringes peek out from behind the crisp glyphs,
  // which reads as RIM-ONLY distortion with a clean magnifying center —
  // manufactured, because the material itself warps its whole footprint
  // (mid-drag full-soup was tried and rejected).
  // ⚠️ SYNC IS LOAD-BEARING (codex catch): the glass must GROW WITH THE
  // HOLE. An earlier cut mounted the glass at full size while the hole
  // animated from zero — for the whole engage the lens sampled un-opened
  // body fill: the milky blob. Both now scale from the same lensOn value.
  const overStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: lensCX.value - HELD_W / 2 }, { scale: 0.25 + 0.75 * lensOn.value }],
  }));
  const bait =
    held && GlassSkin && barW > 0 ? (
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, top: 0, flexDirection: 'row', paddingVertical: PAD_V, paddingHorizontal: PAD_SIDE }}
      >
        {items}
      </View>
    ) : null;
  const heldGlass =
    held && GlassSkin && barW > 0 ? (
      <Reanimated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ position: 'absolute', left: 0, top: barH / 2 - heldH / 2, width: HELD_W, height: heldH }, overStyle]}
      >
        {/* GLASS LAB CASE 3 (+ device tune): UIKit 'clear' + isInteractive,
            scheme auto, with a WHISPER of dark tint — the interactive
            material's specular sheen BRIGHTENS whatever it covers and hazes
            the center; the black tint cancels the added light without
            touching the warp (Simon's device call). Do not change without
            re-running the dev-gallery glass labs. */}
        <GlassSkin
          glassEffectStyle="clear"
          isInteractive
          tintColor={lensTint}
          style={{ flex: 1, borderRadius: heldH / 2 }}
        />
        {/* The center patch (see CENTER_ALPHA note) — above the glass, below
            the crisp items; radial fade does the shaping, no hard edge. */}
        <Svg
          pointerEvents="none"
          width={HELD_W}
          height={heldH}
          style={{ position: 'absolute', left: 0, top: 0 }}
        >
          <Defs>
            <RadialGradient id="lensCenterFade" cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0%" stopColor={theme.surface} stopOpacity={CENTER_ALPHA[mode]} />
              <Stop offset={`${FADE_HOLD * 100}%`} stopColor={theme.surface} stopOpacity={CENTER_ALPHA[mode]} />
              <Stop offset="100%" stopColor={theme.surface} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={HELD_W} height={heldH} fill="url(#lensCenterFade)" />
        </Svg>
      </Reanimated.View>
    ) : null;
  return (
    <View pointerEvents="box-none" style={[outerPos, { alignItems: 'center' }]}>
      <View>
        {barLayer}
        {lens}
        {bait}
        {heldGlass}
        {row}
      </View>
    </View>
  );
}

// One item, with the proximity zoom: scale follows the lens's live distance
// to this item's center on the UI thread — the item swells as the lens
// approaches and relaxes as it leaves ("smoother with the movement"), gated
// by lensOn so nothing zooms at rest. Crisp above the lens; only the rim
// caps ever overlap it.
function TabItem({
  slot, active, color, centerX, width, reach, lensCX, lensOn, onPress,
}: {
  slot: (typeof SLOTS)[number];
  active: boolean;
  color: string;
  centerX: number;
  width: number;
  /** The lens's half-width: the zoom window. Only content actually UNDER the
   * glass magnifies (Simon's ruling — proximity-radius zoom made items grow
   * before the lens reached them). */
  reach: number;
  lensCX: SharedValue<number>;
  lensOn: SharedValue<number>;
  onPress: () => void;
}) {
  const zoom = useAnimatedStyle(() => {
    const prox = Math.max(0, 1 - Math.abs(lensCX.value - centerX) / reach);
    return { transform: [{ scale: 1 + 0.1 * prox * lensOn.value }] };
  });
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={slot.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      // .tabbar-item: column, 3px icon→label gap, 24px icon,
      // 10.5px/600 label (letterSpacing 0.01em → 0.105).
      style={{ width, alignItems: 'center', paddingVertical: 2 }}
    >
      <Reanimated.View style={[{ alignItems: 'center', gap: 3 }, zoom]}>
        <Icon name={slot.icon} size={24} color={color} />
        <VText
          surface="badge"
          style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10.5, lineHeight: 13, letterSpacing: 0.105, color }}
        >
          {slot.label}
        </VText>
      </Reanimated.View>
    </Pressable>
  );
}
