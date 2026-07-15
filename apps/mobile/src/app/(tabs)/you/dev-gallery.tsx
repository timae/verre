import { Redirect } from 'expo-router';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, useWindowDimensions, View, type LayoutRectangle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { FullWindowOverlay } from 'react-native-screens';
import Reanimated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '@/components/ui/Icon';
import { Avatar } from '@/components/ui/Avatar';
import { alpha } from '@/theme/color';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AROMA_FAMILIES, resolveAxes, perRatingAxes, aggregateAromaRollup, aromaConsensus, type AromaConsensusOpts, type ConsensusDisplayNode, type AromaSelection } from '@verre/core';
// The compare-VIEW / contributor derivations are still mobile-gallery-owned and
// lazy-required under __DEV__ below (Metro's DCE keeps them out of prod). The
// aromaConsensus SELECTOR moved into @verre/core (Slice 3a) — it's a normal core
// import now. Types are erased at compile → safe as a static import regardless.
import type { StripChip, PopoverContent, CompareSelection } from '@/components/moments/aromaCompareView';
import { AromaCompareStrip } from '@/components/moments/AromaCompareStrip';
import { StructureWheel, type WheelAxis } from '@/components/scoring/StructureWheel';
import { StructureInput } from '@/components/scoring/StructureInput';
import { AromaChip, useTapOrDouble } from '@/components/scoring/aroma/parts';
import { StarScore } from '@/components/scoring/StarScore';
import { QrCode } from '@/components/ui/QrCode';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { contrastRatio } from '@/lib/contrast';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { useFlavourColors } from '@/theme/flavourColors';
import { elevation, radius, space, themes, useTheme, type ThemeChoice } from '@/theme';
// Dev-only modules behind __DEV__ so Metro's constant folding + DCE strips
// them from production bundles (codex: static imports kept lab-only code in
// the production route module even though the screen redirects).
let SwiftGlass: {
  Host: typeof import('@expo/ui/swift-ui').Host;
  HStack: typeof import('@expo/ui/swift-ui').HStack;
  frame: typeof import('@expo/ui/swift-ui/modifiers').frame;
  glassEffect: typeof import('@expo/ui/swift-ui/modifiers').glassEffect;
} | null = null;
if (__DEV__) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ui = require('@expo/ui/swift-ui') as typeof import('@expo/ui/swift-ui');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mods = require('@expo/ui/swift-ui/modifiers') as typeof import('@expo/ui/swift-ui/modifiers');
    SwiftGlass = { Host: ui.Host, HStack: ui.HStack, frame: mods.frame, glassEffect: mods.glassEffect };
  } catch {
    SwiftGlass = null;
  }
}

// ── Glass lab (PillTabBar lens forensics) ───────────────────────────────────
// Apple's Files app renders the FULL lens optic (clear center, chromatic rim,
// heavy edge warp) in the same Simulator where our bar shows frost only. This
// section isolates which property carries the warp: six capsules over
// IDENTICAL high-contrast content, each varying ONE thing. Screenshot the
// section and compare against Files' drag lens.
let LabGlass: typeof import('expo-glass-effect').GlassView | null = null;
let LabGlassBox: typeof import('expo-glass-effect').GlassContainer | null = null;
if (__DEV__) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const g = require('expo-glass-effect') as typeof import('expo-glass-effect');
    if (g.isGlassEffectAPIAvailable() && g.isLiquidGlassAvailable()) {
      LabGlass = g.GlassView;
      LabGlassBox = g.GlassContainer;
    }
  } catch {
    LabGlass = null;
  }
}
// The compare-view + contributor derivations. Both are PRODUCTION modules now
// (CompareBody → AromaCompareStrip/AromaDetailSheet ship them), so the lazy require no
// longer keeps anything out of the prod bundle — it's kept only so the lab's
// access pattern stays uniform with the other DEV-only requires above.
// (aromaConsensus moved to @verre/core in Slice 3a — a normal static import.)
let labCompareView: typeof import('@/components/moments/aromaCompareView') | null = null;
let labBuildContributors: typeof import('@/components/moments/aromaContributors').buildAromaContributors | null = null;
if (__DEV__) {
  // Relative (not '@/') so Metro resolves the require the same way regardless of
  // tsconfig-paths handling — this file is under src/app/(tabs)/you/.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  labCompareView = require('../../../components/moments/aromaCompareView') as typeof import('@/components/moments/aromaCompareView');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  labBuildContributors = (require('../../../components/moments/aromaContributors') as typeof import('@/components/moments/aromaContributors')).buildAromaContributors;
}
// The SHARED ruled candidate — the SAME component the real CmpAccItem mounts
const LAB_W = 150;
const LAB_H = 64;
function LabBackdrop() {
  const stripes = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#ffffff', '#9b59b6'];
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row' }}>
      {stripes.map((c) => (
        <View key={c} style={{ flex: 1, backgroundColor: c }} />
      ))}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'space-around' }}>
        {[0, 1, 2].map((i) => (
          <VText key={i} style={{ color: '#000', fontSize: 13, fontFamily: 'InstrumentSans_600SemiBold' }}>
            waterfall ripple glass 12345 waterfall ripple
          </VText>
        ))}
      </View>
    </View>
  );
}
function LabCase({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ width: LAB_W + 40, height: LAB_H + 40, borderRadius: radius.md, overflow: 'hidden' }}>
        <LabBackdrop />
        <View style={{ position: 'absolute', left: 20, top: 20, width: LAB_W, height: LAB_H }}>{children}</View>
      </View>
      <VText variant="caption" color="inkSoft">{label}</VText>
    </View>
  );
}
function GlassLab() {
  const [mounted, setMounted] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Glass lab (lens forensics)</VText>
      <VText variant="small" color="inkSoft">
        Compare each capsule{'\u2019'}s EDGES against the Files app{'\u2019'}s drag lens. Which cases warp the stripes/text at the rim vs merely blur?
      </VText>
      {!LabGlass ? <VText variant="small">expo-glass-effect unavailable in this binary.</VText> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {LabGlass ? (
          <>
            <LabCase label="1 UIKit regular + interactive">
              <LabGlass glassEffectStyle="regular" isInteractive style={{ flex: 1, borderRadius: LAB_H / 2 }} />
            </LabCase>
            <LabCase label="2 UIKit regular, NOT interactive">
              <LabGlass glassEffectStyle="regular" style={{ flex: 1, borderRadius: LAB_H / 2 }} />
            </LabCase>
            <LabCase label="3 UIKit clear + interactive">
              <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: LAB_H / 2 }} />
            </LabCase>
            <LabCase label="4 UIKit regular+interactive, toggle-mounted">
              {mounted ? <LabGlass glassEffectStyle="regular" isInteractive style={{ flex: 1, borderRadius: LAB_H / 2 }} /> : null}
            </LabCase>
          </>
        ) : null}
        {SwiftGlass ? (
          <LabCase label="5 SwiftUI regular + interactive">
            <SwiftGlass.Host style={{ flex: 1 }}>
              <SwiftGlass.HStack modifiers={[SwiftGlass.frame({ width: LAB_W, height: LAB_H }), SwiftGlass.glassEffect({ glass: { variant: 'regular', interactive: true }, shape: 'capsule' })]}>
                {null}
              </SwiftGlass.HStack>
            </SwiftGlass.Host>
          </LabCase>
        ) : null}
        {SwiftGlass ? (
          <LabCase label="6 SwiftUI clear + interactive">
            <SwiftGlass.Host style={{ flex: 1 }}>
              <SwiftGlass.HStack modifiers={[SwiftGlass.frame({ width: LAB_W, height: LAB_H }), SwiftGlass.glassEffect({ glass: { variant: 'clear', interactive: true }, shape: 'capsule' })]}>
                {null}
              </SwiftGlass.HStack>
            </SwiftGlass.Host>
          </LabCase>
        ) : null}
      </View>
      <Button title={mounted ? 'Unmount case 4' : 'Mount case 4 (post-attach, like the held lens)'} size="sm" variant="secondary" onPress={() => setMounted((m) => !m)} />
    </View>
  );
}

// ── Glass lab 2: HOSTING conditions (established WHY a lens dies over the
// bar: glass-over-glass without a container, cases 10 vs 12/13; transforms
// are innocent, cases 7-9). Cases as rendered:
//   7  animated TRANSFORM parent (survives — motion is innocent)
//   8  animated LEFT / layout movement (survives)
//   9  static transform parent (survives)
//   10 over another glass, NO container (dies — the smoky slug)
//   12 same as 10 inside ONE GlassContainer (material survives, but members
//      can't optically see siblings — no warp of bar/items)
//   13 container + MOVING clear lens over the slab
const LAB2_W = 230;
const LAB2_H = 84;
function Lab2Case({ label, children, height = 150 }: { label: string; children: React.ReactNode; height?: number }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ width: 320, height, borderRadius: radius.md, overflow: 'hidden' }}>
        <LabBackdrop />
        {children}
      </View>
      <VText variant="caption" color="inkSoft">{label}</VText>
    </View>
  );
}
function MovingLens({ mode }: { mode: 'transform' | 'left' }) {
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withRepeat(withTiming(70, { duration: 1400 }), -1, true);
  }, [x]);
  const st = useAnimatedStyle(() =>
    mode === 'transform' ? { transform: [{ translateX: x.value }] } : { left: x.value },
  );
  if (!LabGlass) return null;
  return (
    <Reanimated.View style={[{ position: 'absolute', top: 32, ...(mode === 'transform' ? { left: 10 } : {}), width: LAB2_W, height: LAB2_H }, st]}>
      <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: LAB2_H / 2 }} />
    </Reanimated.View>
  );
}
function GlassLab2() {
  const { theme } = useTheme();
  if (!LabGlass) return null;
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Glass lab 2 (hosting conditions)</VText>
      <VText variant="small" color="inkSoft">
        All cases use case-3{'\u2019'}s exact lens (clear + interactive). Watch which hosting condition keeps/kills the edge warp.
      </VText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Lab2Case label="7 moving via animated TRANSFORM (bar's current method)">
          <MovingLens mode="transform" />
        </Lab2Case>
        <Lab2Case label="8 moving via animated LEFT (layout)">
          <MovingLens mode="left" />
        </Lab2Case>
        <Lab2Case label="9 static transform parent">
          <View style={{ position: 'absolute', top: 32, left: 10, width: LAB2_W, height: LAB2_H, transform: [{ translateX: 40 }] }}>
            <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: LAB2_H / 2 }} />
          </View>
        </Lab2Case>
        <Lab2Case label="10 over another glass (regular slab beneath)">
          <LabGlass glassEffectStyle="regular" style={{ position: 'absolute', left: 0, right: 0, top: 55, height: 70, borderRadius: 35 }} />
          <View style={{ position: 'absolute', top: 32, left: 45, width: LAB2_W, height: LAB2_H }}>
            <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: LAB2_H / 2 }} />
          </View>
        </Lab2Case>
        {LabGlassBox ? (
          <Lab2Case label="12 SAME as 10, but inside ONE GlassContainer (Apple's rule for overlapping glass)" height={170}>
            <LabGlassBox spacing={20} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
              <LabGlass glassEffectStyle="regular" style={{ position: 'absolute', left: 0, right: 0, top: 65, height: 64, borderRadius: 32 }} />
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 88, flexDirection: 'row', justifyContent: 'space-around' }}>
                <VText style={{ color: theme.ink, fontSize: 12, fontFamily: 'InstrumentSans_600SemiBold' }}>Feed</VText>
                <VText style={{ color: theme.accent, fontSize: 12, fontFamily: 'InstrumentSans_600SemiBold' }}>Moments</VText>
                <VText style={{ color: theme.ink, fontSize: 12, fontFamily: 'InstrumentSans_600SemiBold' }}>Soon</VText>
              </View>
              <View style={{ position: 'absolute', top: 50, left: 55, width: 170, height: 92 }}>
                <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: 46 }} />
              </View>
            </LabGlassBox>
          </Lab2Case>
        ) : null}
        {LabGlassBox ? (
          <Lab2Case label="13 container, MOVING clear lens over regular slab" height={170}>
            <LabGlassBox spacing={20} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
              <LabGlass glassEffectStyle="regular" style={{ position: 'absolute', left: 0, right: 0, top: 65, height: 64, borderRadius: 32 }} />
              <MovingLens mode="transform" />
            </LabGlassBox>
          </Lab2Case>
        ) : null}
      </View>
    </View>
  );
}

// ── Glass lab 3: the design fork as THREE working mockups (drag each lens,
// no hold delay). A = all real glass in one container (lens alive, never
// warps items). B = translucent solid body, containerless lens (full warp,
// milky center — the lens magnifies the body fill). C = punch-through body
// (hole tracks the lens) — the architecture the production bar SHIPPED.
const DEMO_W = 336;
const DEMO_BAR_H = 60;
const DEMO_LENS_W = 96;
const DEMO_LENS_H = 74;
const DEMO_ITEMS = [
  { icon: 'home', label: 'Feed' },
  { icon: 'glass', label: 'Moments' },
  { icon: 'soon', label: 'Soon' },
  { icon: 'user', label: 'You' },
] as const;
function DemoItems({ ink, accent }: { ink: string; accent: string }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 6, right: 6, top: (DEMO_LENS_H - DEMO_BAR_H) / 2 + 8, flexDirection: 'row' }}>
      {DEMO_ITEMS.map((it, i) => (
        <View key={it.label} style={{ flex: 1, alignItems: 'center', gap: 3 }}>
          <Icon name={it.icon} size={22} color={i === 1 ? accent : ink} />
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10.5, color: i === 1 ? accent : ink }}>{it.label}</VText>
        </View>
      ))}
    </View>
  );
}
const AnimatedPath = Reanimated.createAnimatedComponent(Path);
// Capsule subpath for the punch-through body (worklet-safe string builder).
function capsulePath(x: number, y: number, w: number, h: number) {
  'worklet';
  const r = h / 2;
  return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + r} ${y + h} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}
function DemoBar({ variant }: { variant: 'A' | 'B' | 'C' }) {
  const { theme } = useTheme();
  const cx = useSharedValue(DEMO_W / 2);
  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .onUpdate((e) => {
      cx.value = Math.min(Math.max(e.x, DEMO_LENS_W / 2 - 10), DEMO_W - DEMO_LENS_W / 2 + 10);
    });
  const lensStyle = useAnimatedStyle(() => ({ transform: [{ translateX: cx.value - DEMO_LENS_W / 2 }] }));
  // Variant C: the body is an SVG capsule with a HOLE tracking the lens
  // (even-odd fill) — the lens samples pure backdrop through the hole, so
  // its interior stays truly clear (B's milkiness = the lens magnifying the
  // body's own fill; Apple's lens "punches through" its bar the same way).
  const barTop = (DEMO_LENS_H - DEMO_BAR_H) / 2;
  const holeW = DEMO_LENS_W - 8;
  const holeH = DEMO_BAR_H;
  const bodyProps = useAnimatedProps(() => ({
    d:
      capsulePath(0, barTop, DEMO_W - 20, DEMO_BAR_H) +
      ' ' +
      capsulePath(Math.min(Math.max(cx.value - holeW / 2, 0), DEMO_W - 20 - holeW), barTop, holeW, holeH),
  }));
  if (!LabGlass) return null;
  const barShape = { position: 'absolute' as const, left: 0, right: 0, top: barTop, height: DEMO_BAR_H, borderRadius: DEMO_BAR_H / 2 };
  const lens = (
    <Reanimated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: DEMO_LENS_W, height: DEMO_LENS_H }, lensStyle]}>
      <LabGlass glassEffectStyle="clear" isInteractive style={{ flex: 1, borderRadius: DEMO_LENS_H / 2 }} />
    </Reanimated.View>
  );
  const inner =
    variant === 'A' && LabGlassBox ? (
      <LabGlassBox spacing={20} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        <LabGlass glassEffectStyle="regular" style={barShape} />
        <DemoItems ink={theme.ink} accent={theme.accent} />
        {lens}
      </LabGlassBox>
    ) : variant === 'B' ? (
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        <View style={[barShape, { backgroundColor: alpha(theme.surface, 0.45), borderWidth: 1, borderColor: theme.rule }]} />
        <DemoItems ink={theme.ink} accent={theme.accent} />
        {lens}
      </View>
    ) : (
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        <Svg pointerEvents="none" width={DEMO_W - 20} height={DEMO_LENS_H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <AnimatedPath animatedProps={bodyProps} fill={alpha(theme.surface, 0.9)} fillRule="evenodd" />
        </Svg>
        <DemoItems ink={theme.ink} accent={theme.accent} />
        {lens}
      </View>
    );
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} style={{ position: 'absolute', left: 10, right: 10, top: 55, height: DEMO_LENS_H }}>{inner}</View>
    </GestureDetector>
  );
}
function GlassLab3() {
  if (!LabGlass) return null;
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Glass lab 3 (the fork, drag both)</VText>
      <VText variant="small" color="inkSoft">
        Drag each lens horizontally. A: all-glass container — lens alive, but items pass under the rim unwarped. B: solid translucent body — full lens warp on items and backdrop, no glass bar body.
      </VText>
      <Lab2Case label="A · all glass, one container" height={185}>
        <DemoBar variant="A" />
      </Lab2Case>
      <Lab2Case label="B · translucent body (45%) + containerless lens" height={185}>
        <DemoBar variant="B" />
      </Lab2Case>
      <Lab2Case label="C · punch-through body (hole tracks the lens) + containerless lens" height={185}>
        <DemoBar variant="C" />
      </Lab2Case>
    </View>
  );
}

// Dev-only widget gallery + theme switcher: the Simulator verification surface
// for the scoring widgets and the NativeTabs/theming spike. Not a user surface.
//
// Structure-wheel data: the axes are the real registry set (resolveAxes) with
// colour resolved from the ACTIVE THEME (useFlavourColors) — switch themes above
// to see the wheel + input retint. A sparkling style is used here so Bubbles
// shows; the values are a demo profile.
const SAMPLE_STYLE = 'spark';
const SAMPLE_LEVELS: Record<string, number> = {
  sweet: 2,
  acid: 4,
  body: 3,
  finish: 4,
  aroma: 3,
  flavour: 5,
  funk: 1,
  tannin: 2,
  bubbles: 4,
};

// Dev-only value slider (the app has no slider dep) — pan/tap the track,
// step-snapped. Powers the badge-height exploration in the aroma section.
function DevSlider({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  const { theme } = useTheme();
  const [trackW, setTrackW] = useState(0);
  const setFromX = (x: number) => {
    if (trackW <= 0) return;
    const frac = Math.min(1, Math.max(0, x / trackW));
    const next = Math.round((min + frac * (max - min)) / step) * step;
    if (next !== value) onChange(next);
  };
  const pan = Gesture.Pan().runOnJS(true).activeOffsetX([-6, 6]).failOffsetY([-8, 8]).onUpdate((e) => setFromX(e.x));
  const tap = Gesture.Tap().runOnJS(true).onEnd((e, ok) => { if (ok) setFromX(e.x); });
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} style={{ height: 28, justifyContent: 'center' }}>
        <View style={{ height: 6, borderRadius: 999, backgroundColor: theme.surfaceSunk, overflow: 'hidden' }}>
          <View style={{ width: `${frac * 100}%`, height: '100%', backgroundColor: theme.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: Math.max(0, Math.min(trackW - 18, frac * trackW - 9)), width: 18, height: 18, borderRadius: 999, backgroundColor: theme.accent }}
        />
      </View>
    </GestureDetector>
  );
}

// ── Aroma roll-up lab (compare §8) ───────────────────────────────────────────
// Renders the role-based consensus TREE over the ten pinned panels (P1–P10) with
// the two knobs live, so the selector's behaviour is visible against the real
// spread. The aggregate + the selector (aromaConsensus) both live in @verre/core
// now — the selector moved there in Slice 3a with the ruled defaults baked; the
// knob toggles stay here for future re-evaluation. The math is separately pinned
// in .local/test-env/scripts/aroma-aggregate-units.ts (the gallery must not
// present unverified calculations).
const aS = (a: string, m: string | null = null): AromaSelection => ({ a, m });
const aSp = (a: string, m: string | null = null): AromaSelection => ({ a, m, p: true }); // pronounced
const rep = (n: number, f: () => AromaSelection[]) => Array.from({ length: n }, f);
const ROLLUP_PANELS: { title: string; note: string; tasters: AromaSelection[][] }[] = [
  { title: 'P1 · heading pruned (1 child)', note: '4 straw / 2 rasp / 2 lingon → Berry 8 [P] ↳ Strawberry 4 (Fruity removed)', tasters: [...rep(4, () => [aS('strawberry')]), ...rep(2, () => [aS('raspberry')]), ...rep(2, () => [aS('lingonberry')])] },
  { title: 'P2 · context › primary › peak', note: '4 straw / 2 berry / 2 fruity → Fruity 8 [C] › Berry 6 [P] ↳ Strawberry 4', tasters: [...rep(4, () => [aS('strawberry')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('fruity')])] },
  { title: 'P3 · no strong agreement', note: '9-way rasp / veg / chem → three secondary roots; Chemical 3 > Skunky 2 survives', tasters: [aS('raspberry'), aS('raspberry'), aS('raspberry'), aS('vegetal'), aS('vegetal'), aS('cucumber'), aS('skunky'), aS('skunky'), aS('petrol')].map((s) => [s]) },
  { title: 'P4 · heading kept (2 children)', note: '3× (distinct berry + citrus) → Fruity H › { Citrus 3 [P] · Berry 3 [P] }', tasters: [[aS('strawberry'), aS('lemon')], [aS('raspberry'), aS('lime')], [aS('blackberry'), aS('grapefruit')]] },
  { title: 'P5 · compounding killed', note: '4 fruity / 2 berry / 2 straw → Fruity 8 [P] ↳ Berry 4 ↳ Strawberry 2 (nested peaks)', tasters: [...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])] },
  { title: 'P6 · heading kept, collapse-to-leaf', note: '6×(straw+lemon)+cuke+petrol → Fruity H › { Lemon 6 [P] · Strawberry 6 [P] }', tasters: [...rep(6, () => [aS('strawberry'), aS('lemon')]), [aS('cucumber')], [aS('petrol')]] },
  { title: 'P7 · primary + strong secondary', note: '5 raspberry / 4 vegetal → Raspberry 5 [P] · Vegetal 4 [S] (different families)', tasters: [...rep(5, () => [aS('raspberry')]), ...rep(4, () => [aS('vegetal')])] },
  { title: 'P8 · shared context, mixed roles', note: '5 berry / 4 citrus (distinct) → Fruity 9 [C] › { Berry 5 [P] · Citrus 4 [S] }', tasters: [[aS('strawberry')], [aS('raspberry')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')], [aS('lemon')], [aS('lime')], [aS('grapefruit')], [aS('orange')]] },
  { title: 'P9 · equal-primary + weaker sibling', note: '5 berry; 2 also citrus → Fruity H › { Berry 5 [P] · Citrus 2 [S] }', tasters: [[aS('strawberry'), aS('lemon')], [aS('raspberry'), aS('lime')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')]] },
  { title: 'P10 · unbounded worst case', note: '2 spray 8 families + 6 scattered → ~8+ secondary roots; selector returns ALL (cap deferred)', tasters: [((): AromaSelection[] => [aS('strawberry'), aS('cucumber'), aS('black_pepper'), aS('vanilla'), aS('almond'), aS('toast'), aS('oak'), aS('flint')])(), [aS('strawberry'), aS('cucumber'), aS('black_pepper'), aS('vanilla'), aS('almond'), aS('toast'), aS('oak'), aS('flint')], [aS('honey')], [aS('rose')], [aS('butter')], [aS('yeast')], [aS('acetone')], [aS('lavender')]] },
  // Pronounced demos (Tier-2 only): PR-A clears the panel bar (3 of 5 pronounced, 3×2>5 → group-pronounced chip); PR-B does NOT (3 of 8, 3×2≤8 → chip stays plain, popover still reports "3 of 5 supporters").
  { title: 'PR-A · group-pronounced (3 of 5)', note: '5 strawberry, 3 pronounced → Strawberry chip renders PRONOUNCED', tasters: [[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')], [aS('strawberry')]] },
  { title: 'PR-B · below the bar (3 of 8)', note: '5 strawberry (3 pronounced) + 3 vegetal → visible Strawberry 5 chip NOT group-pronounced (3×2 ≤ 8); popover shows "3 of 5 supporters"', tasters: [[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')], [aS('strawberry')], [aS('vegetal')], [aS('vegetal')], [aS('vegetal')]] },
];

// One display-node row: the count·label lives INSIDE the badge ("3x Strawberry"
// — Simon's ruling), emphasis follows the role. heading = an uncounted grouping
// label (no count, no chip fill); context = a faint counted ancestor; primary =
// full; secondary = lighter; peak = indented. The tree recurses via children[]
// — rendering NEVER re-derives structure. `ancestorCount` is the nearest COUNTED
// displayed ancestor's count (headings are skipped — they're never a
// denominator), threaded down so a peak can show BOTH denominators: count/n
// panel prevalence and count/ancestor branch concentration.
function ConsensusRow({ dn, depth, n, ancestorCount }: { dn: ConsensusDisplayNode; depth: number; n: number; ancestorCount: number | null }) {
  const { theme } = useTheme();
  const { role, counted, node, children } = dn;
  const roleTag = role === 'primary' ? '[P]' : role === 'secondary' ? '[S]' : role === 'context' ? '[C]' : role === 'peak' ? '↳' : 'H';
  const roleColor = role === 'primary' ? theme.ink : role === 'secondary' ? theme.inkSoft : theme.inkFaint;
  // Both denominators, kept distinct: prevalence (count/n) for every counted
  // node; branch concentration (count/ancestor) additionally for a peak, since
  // the peak bar is what the ⅓/⅔ knob rules. A heading shows neither.
  const readout = counted
    ? role === 'peak' && ancestorCount != null
      ? `${node.count}/${n} panel · ${node.count}/${ancestorCount} branch`
      : `${node.count}/${n} panel`
    : '';
  // The counted ancestor threaded to THIS node's children: this node if counted,
  // else the ancestor passed in (a heading is transparent — §rule 6).
  const childAncestor = counted ? node.count : ancestorCount;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: depth * 16 }}>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10.5, color: roleColor, width: 20 }}>{roleTag}</VText>
        {counted
          ? <AromaChip a={node.id} m={null} sub={node.tier} count={node.count} vPad={0} />
          : <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.inkFaint }}>{`${node.label} · grouping`}</VText>}
        <VText variant="caption" color="inkFaint">{readout}</VText>
      </View>
      {children.map((c) => (
        <ConsensusRow key={c.node.id} dn={c} depth={depth + 1} n={n} ancestorCount={childAncestor} />
      ))}
    </View>
  );
}

function AromaRollupLab() {
  const { theme } = useTheme();
  const [primaryMode, setPrimaryMode] = useState<'majority' | 'twoThirds'>('majority');
  const [peak, setPeak] = useState<'third' | 'twoThirds'>('third');
  const opts: AromaConsensusOpts = {
    primary: primaryMode,
    peakNum: peak === 'third' ? 1 : 2,
    peakDen: 3,
  };
  const knobPill = (on: boolean, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
    >
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>{label}</VText>
    </Pressable>
  );
  const tierRank = { leaf: 3, subfamily: 2, family: 1 } as const;
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Aroma roll-up (compare §8)</VText>
      <VText variant="small" color="inkSoft">
        Role-based consensus tree over the ten pinned panels — rule the two knobs here. [P]rimary · [S]econdary · [C]ontext · H grouping · ↳ peak. Two denominators, never merged: count/n prevalence (primary bar) vs count/ancestor concentration (peak bar). Counts are NOT summable across siblings.
      </VText>
      {/* knobs — primary bar + peak bar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(primaryMode === 'majority', 'primary > n/2', () => setPrimaryMode('majority'))}
          {knobPill(primaryMode === 'twoThirds', 'primary ≥ 2n/3', () => setPrimaryMode('twoThirds'))}
        </View>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(peak === 'third', 'peak ≥ ⅓', () => setPeak('third'))}
          {knobPill(peak === 'twoThirds', 'peak ≥ ⅔', () => setPeak('twoThirds'))}
        </View>
      </View>
      {ROLLUP_PANELS.map((panel) => {
        const rollup = aggregateAromaRollup(panel.tasters);
        const res = aromaConsensus(rollup, opts);
        // count(atGrain) distribution, count desc → finer tier → taxonomy order
        // (NEVER atGrain). byFamily is already taxonomy-ordered; a stable sort by
        // (−count, −tierRank) preserves taxonomy order within ties.
        const dist = rollup.byFamily
          .flatMap((f) => f.nodes)
          .slice()
          .sort((a, b) => b.count - a.count || tierRank[b.tier] - tierRank[a.tier])
          .map((nd) => `${nd.label} ${nd.count}(${nd.atGrain})`)
          .join(' · ');
        return (
          <View key={panel.title} style={{ gap: 6, padding: 12, borderRadius: radius.md, backgroundColor: theme.surface }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>{panel.title} · n={rollup.n}</VText>
              {res.hasStrongAgreement
                ? null
                : <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, color: theme.inkFaint }}>— No strong agreement —</VText>}
            </View>
            <VText variant="caption" color="inkFaint">{`default knobs (> n/2, ≥ ⅓): ${panel.note}`}</VText>
            <View style={{ gap: 6 }}>
              {res.roots.length > 0
                ? res.roots.map((r) => <ConsensusRow key={r.node.id} dn={r} depth={0} n={rollup.n} ancestorCount={null} />)
                : <VText variant="caption" color="inkFaint">— nothing clears the bar —</VText>}
            </View>
            <VText variant="caption" color="inkFaint">{`count(atGrain): ${dist || '—'}`}</VText>
          </View>
        );
      })}
    </View>
  );
}

// ── Tier 2 mock (compare §9, Slice 2a) ───────────────────────────────────────
// The "Aroma agreement" strip as it would sit in the expanded compare card:
// tappable count-chips (primaries+secondaries), an always-present "Detailed
// aromas" action, and the anchored contributor popover (header · descendant peak
// branch · 3-name preview · View contributors). Gallery mock over the pinned
// panels — a PRELIMINARY density/interaction pass. The final density + knob
// ruling happens in the real CmpAccItem card context (2b), not here.
// The panels are anonymous AromaSelection[][]; synthesize realistic named raters so
// the popover's contributor preview is populated.

function labRaters(tasters: AromaSelection[][]) {
  const names = ['Mara', 'Jonas', 'Léa', 'David', 'Sofia', 'Noah', 'Clara', 'Theo'];
  return tasters.map((aromas, i) => ({ id: `t${i}`, displayName: names[i] ?? `Guest ${i + 1}`, aromas }));
}

// The strip's inter-chip gap (a layout constant; the pure packStrip lives in
// aromaCompareView and takes gap + the MEASURED pill width as params). No role
// suffix on chips (the chosen 2A design is plain "Nx Label"; role drives ORDER
// only, not the label).
const STRIP_GAP = 8;
const COMPARE_CHIP_PAD = 2;

// A compare-specific INTERACTION wrapper around the presentational AromaChip: it
// owns tap-to-inspect + self-measure (the chip stays dumb). The wrapper footprint
// is CONSTANT (padding 2 always, collapsable={false}) so the strip never
// reflows and the measured anchor stays put. NO selection ring/backing — a
// filled halo around the chip reads as a Pronounced border (Simon, device);
// the anchored popover is itself the "this chip is selected" signal.
function CompareChip({ chip, onLayoutWidth, onTap }: {
  chip: StripChip;
  onLayoutWidth: (id: string, w: number) => void;
  onTap: (rect: LayoutRectangle) => void;
}) {
  const ref = useRef<View>(null);
  // The tap goes through AromaChip.onPress (it IS a Pressable) — no nested
  // Pressable (Codex #3: double responder/a11y). The wrapper View only measures
  // width + the anchor rect.
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={(e) => onLayoutWidth(chip.id, Math.ceil(e.nativeEvent.layout.width))}
      style={{ borderRadius: 999, padding: COMPARE_CHIP_PAD }}
    >
      <AromaChip
        a={chip.id}
        m={null}
        count={chip.count}
        pronounced={chip.pronounced}
        vPad={0}
        onPress={() => ref.current?.measureInWindow((x, y, width, height) => onTap({
          x: x + COMPARE_CHIP_PAD,
          y: y + COMPARE_CHIP_PAD,
          width: width - COMPARE_CHIP_PAD * 2,
          height: height - COMPARE_CHIP_PAD * 2,
        }))}
      />
    </View>
  );
}

// The tapped chip's window rect — a full rect (x + width too), so the popover
// anchors HORIZONTALLY at the chip, not flush to the screen's right edge like the
// shared AnchoredMenu (which is a right-aligned ⋯ dropdown). Gallery-local; if
// the popover graduates to production, AnchoredMenu needs an x-anchor variant.
type ChipRect = { x: number; y: number; width: number; height: number };

// Shared horizontal placement. These are chip inspectors, not right-aligned
// dropdown menus: align to the tapped badge and clamp only at the screen edge.
function usePopoverFrame(rect: ChipRect, width: number, anchorInset = 0) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const margin = 12;
  const maxW = screenW - margin * 2;
  const w = Math.min(width || AROMA_POPOVER_WIDTH, maxW);
  const left = Math.max(margin, Math.min(rect.x - anchorInset, screenW - margin - w));
  return { left, maxW, screenH, bottomLimit: screenH - insets.bottom - 8 };
}

const cardShadow = {
  shadowColor: '#000', shadowOpacity: elevation.menu.ios.shadowOpacity, shadowRadius: elevation.menu.ios.shadowRadius,
  shadowOffset: { width: 0, height: elevation.menu.ios.shadowOffsetY }, elevation: elevation.menu.android.elevation,
} as const;
const AROMA_POPOVER_WIDTH = 228;

// RECOMMENDED — the selected badge expands into the card's title bar. A duplicate
// is drawn at the original badge's exact window coordinates while a shallow
// family-tinted band fully surrounds it; the detail continues below. It reads as
// one badge becoming a panel, without repeating the aroma or cutting a rule/band
// through the pill. Near the screen bottom the title bar moves to the lower edge.
function AttachedBadgePopover({ rect, onClose, badge, body }: {
  rect: ChipRect;
  onClose: () => void;
  badge: React.ReactNode;
  body: React.ReactNode;
}) {
  const { theme } = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const titlePad = 8;
  const { left, maxW, bottomLimit } = usePopoverFrame(rect, size.w, titlePad);
  const titleH = rect.height + titlePad * 2;
  const downTop = rect.y - titlePad;
  const flip = size.h > 0 && downTop + size.h > bottomLimit;
  const top = flip ? rect.y + rect.height + titlePad - size.h : downTop;
  const badgeLeft = Math.max(0, Math.min(rect.x - left, Math.max(0, (size.w || AROMA_POPOVER_WIDTH) - rect.width)));
  const titleBar = (
    <View
      style={{
        height: titleH,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: badgeLeft,
        paddingRight: 8,
        backgroundColor: theme.surfaceSunk,
        borderBottomWidth: flip ? 0 : 1,
        borderTopWidth: flip ? 1 : 0,
        borderColor: theme.ruleSoft,
      }}
    >
      <View style={{ flexDirection: 'row', flexShrink: 0 }}>{badge}</View>
      <VText
        variant="caption"
        color="inkFaint"
        numberOfLines={1}
        style={{ marginLeft: 'auto', paddingLeft: 8 }}
      >
        Agreement
      </VText>
    </View>
  );
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1 }} accessibilityLabel="Close Aroma Details" onPress={onClose}>
        <View
          onLayout={(e) => setSize({ w: Math.ceil(e.nativeEvent.layout.width), h: Math.ceil(e.nativeEvent.layout.height) })}
          style={{
            position: 'absolute', top, left, width: Math.min(AROMA_POPOVER_WIDTH, maxW),
            borderRadius: radius.md, ...cardShadow,
          }}
        >
          <View style={{ backgroundColor: theme.surface, borderRadius: radius.md, borderWidth: 1, borderColor: theme.ruleSoft, overflow: 'hidden' }}>
            {!flip ? titleBar : null}
            <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>{body}</View>
            {flip ? titleBar : null}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// EXPERIMENT — the popup grows directly out of the selected badge. There is no
// full-width header: the badge overlaps the neutral detail card at either an
// inset corner or its centre. This keeps the source unmistakable without
// clipping the badge to an outer edge, repeating the title, or adding a tint.
export type ExtensionAnchor = 'corner' | 'center';

function BadgeExtensionPopover({ rect, onClose, badge, body, anchor, glass = false }: {
  rect: ChipRect;
  onClose: () => void;
  badge: React.ReactNode;
  body: React.ReactNode;
  anchor: ExtensionAnchor;
  glass?: boolean;
}) {
  const { theme } = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const desiredBadgeLeft = anchor === 'center'
    ? Math.max(10, (AROMA_POPOVER_WIDTH - rect.width) / 2)
    : 10;
  const { left, maxW, bottomLimit } = usePopoverFrame(rect, size.w, desiredBadgeLeft);
  const downTop = rect.y;
  const flip = size.h > 0 && downTop + size.h > bottomLimit;
  const top = flip ? rect.y + rect.height - size.h : downTop;
  const badgeLeft = Math.max(0, Math.min(rect.x - left, Math.max(0, (size.w || AROMA_POPOVER_WIDTH) - rect.width)));
  const badgeOverlap = rect.height / 2;
  const badgeCap = (
    <View
      collapsable={false}
      style={{
        zIndex: 4,
        position: 'absolute',
        left: badgeLeft,
        ...(flip ? { bottom: 0 } : { top: 0 }),
        flexDirection: 'row',
        borderRadius: radius.pill,
      }}
    >
      {badge}
    </View>
  );
  const detailStyle = {
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingTop: flip ? 10 : badgeOverlap + 8,
    paddingBottom: flip ? badgeOverlap + 8 : 10,
    shadowColor: '#000',
    shadowOpacity: elevation.sm.ios.shadowOpacity,
    shadowRadius: elevation.sm.ios.shadowRadius,
    shadowOffset: { width: 0, height: elevation.sm.ios.shadowOffsetY },
    elevation: elevation.sm.android.elevation,
  } as const;
  const detail = glass && LabGlass ? (
    <LabGlass
      glassEffectStyle="regular"
      colorScheme={theme.scheme}
      tintColor={alpha(theme.surface, 0.14)}
      style={detailStyle}
    >
      {body}
    </LabGlass>
  ) : (
    <View style={{ ...detailStyle, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.ruleSoft }}>
      {body}
    </View>
  );
  const overlay = (
    <Pressable style={{ flex: 1 }} accessibilityLabel="Close Aroma Details" onPress={onClose}>
        <View
          onLayout={(e) => setSize({ w: Math.ceil(e.nativeEvent.layout.width), h: Math.ceil(e.nativeEvent.layout.height) })}
          style={{ position: 'absolute', top, left, width: Math.min(AROMA_POPOVER_WIDTH, maxW) }}
        >
          <View style={flip ? { marginBottom: rect.height - badgeOverlap } : { marginTop: rect.height - badgeOverlap }}>{detail}</View>
          {/* Always mount AFTER the native glass view. UIGlassEffect can paint
              over an earlier React sibling even when that sibling has zIndex;
              absolute + last-mounted keeps the duplicate badge above the
              material for both down- and up-opening panels. */}
          {badgeCap}
        </View>
    </Pressable>
  );
  // A React Native Modal lives in a separate native window. Liquid Glass in
  // that window cannot sample the badges/tab bar underneath and turns into an
  // opaque-looking slab. FullWindowOverlay stays in the app's UIWindow, above
  // its content, so the native material can refract what it actually overlaps.
  if (glass && LabGlass) {
    return <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{overlay}</FullWindowOverlay>;
  }
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {overlay}
    </Modal>
  );
}

// Shared compact content. Hierarchy is visual rather than prose-heavy: descendant
// paths are real aroma badges, supporters stay one line, Pronounced gets its
// canonical glyph, and the one navigation action is a canonical Button.
function PopoverBody({ content, onViewContributors, onMoreBranches }: {
  content: PopoverContent;
  onViewContributors: () => void;
  onMoreBranches: () => void;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      {content.ledBy.length > 0 ? (
        <View style={{ gap: 6 }}>
          <VText variant="caption" color="inkFaint">Includes mentions of</VText>
          {content.ledBy.map((branch, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
              {branch.map((step, j) => (
                <View key={step.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {j > 0 ? <Icon name="chevron-right" size={12} color={theme.inkFaint} /> : null}
                  <AromaChip a={step.id} m={null} count={step.count} vPad={0} />
                </View>
              ))}
            </View>
          ))}
          {content.moreBranches > 0 ? (
            <Pressable onPress={onMoreBranches} accessibilityRole="button">
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.accent }}>{`+${content.moreBranches} More →`}</VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {content.contributors.length > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View style={{ flexDirection: 'row', paddingLeft: 2 }}>
            {content.contributors.map((c, i) => (
              <View key={c.id} style={{ marginLeft: i === 0 ? 0 : -7 }}>
                <Avatar name={c.displayName} size={26} ring initialsSize={9.5} />
              </View>
            ))}
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <VText variant="caption" color="inkFaint">Supported By</VText>
            <VText numberOfLines={1} surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 12.5, color: theme.inkSoft }}>
              {content.contributors.map((c) => c.displayName).join(', ')}{content.moreContributors > 0 ? ` +${content.moreContributors}` : ''}
            </VText>
          </View>
        </View>
      ) : null}
      {content.pronouncedCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="pronounced" size={14} color={content.isPanelPronounced ? theme.accent : theme.inkFaint} />
          <VText variant="caption" color={content.isPanelPronounced ? 'accent' : 'inkFaint'}>
            {`${content.pronouncedCount} of ${content.count} marked pronounced`}
          </VText>
        </View>
      ) : null}
      <View style={{ borderTopWidth: 1, borderTopColor: theme.rule, paddingTop: 4 }}>
        <Button title="View Contributors" variant="tertiary" size="sm" block onPress={onViewContributors} />
      </View>
    </View>
  );
}

export type PopoverVariant = 'attached' | 'extension' | 'glass';

function Tier2Popover({ content, rect, variant, extensionAnchor, onClose, onViewContributors, onMoreBranches }: {
  content: PopoverContent;
  rect: ChipRect;
  variant: PopoverVariant;
  extensionAnchor: ExtensionAnchor;
  onClose: () => void;
  onViewContributors: () => void;
  onMoreBranches: () => void;
}) {
  const body = <PopoverBody content={content} onViewContributors={onViewContributors} onMoreBranches={onMoreBranches} />;
  // Both variants lead with the ACTUAL tapped badge as the header — the panel
  // literally starts with the chip you tapped (family tint + count preserved),
  // so it reads as that badge's detail, not a generic menu.
  const badge = (
    <View style={{ flexDirection: 'row' }}>
      <AromaChip
        a={content.id}
        m={null}
        count={content.count}
        pronounced={content.isPanelPronounced}
        focused={variant === 'extension' || variant === 'glass'}
        vPad={0}
      />
    </View>
  );
  if (variant === 'extension' || variant === 'glass') {
    return (
      <BadgeExtensionPopover
        rect={rect}
        onClose={onClose}
        badge={badge}
        body={body}
        anchor={extensionAnchor}
        glass={variant === 'glass'}
      />
    );
  }
  return <AttachedBadgePopover rect={rect} onClose={onClose} badge={badge} body={body} />;
}

// One panel card: owns its own strip-width + per-chip-width measurement and the
// two-line pack, so overflow chips hide behind a "+N" pill while "Detailed
// aromas" stays visible. Selection/popover/route state is LIFTED to the lab so
// only one popover is ever open and selection is panel-scoped (the selection id
// is `${panelTitle}|${chipId}`, globally unique — tapping Berry in one panel
// never highlights Berry in another).
function Tier2PanelCard({ panel, opts, pronBar, onTapChip, onDetailed, popover }: {
  panel: { title: string; note: string; tasters: AromaSelection[][] };
  opts: AromaConsensusOpts;
  pronBar: 'majority' | 'twoThirds';
  onTapChip: (fullId: string, chipId: string, rect: LayoutRectangle) => void;
  onDetailed: () => void;
  popover: React.ReactNode; // rendered by the lab when this card owns the open popover
}) {
  const { theme } = useTheme();
  const [rowW, setRowW] = useState(0);
  // Measure EVERY strip chip (not just the shown ones — a hidden chip would
  // never report its width and packing could never stabilize) + the "+N" pill,
  // off-screen, before packing. Keyed by chip id; the pill by its EXACT label so
  // a digit-count change re-measures (Codex #1 — a hard-coded pill width can
  // wrongly fit one extra chip and spill onto a 3rd line).
  const [chipW, setChipW] = useState<Record<string, number>>({});
  const [pillW, setPillW] = useState<Record<string, number>>({});
  const res = aromaConsensus(aggregateAromaRollup(panel.tasters), opts);
  const contrib = labBuildContributors!(labRaters(panel.tasters));
  const strip = labCompareView!.tier2Strip(res, contrib, pronBar);
  const widths = strip.map((c) => chipW[c.id] ?? 0);
  const measured = strip.length === 0 || widths.every((w) => w > 0);
  const pillLabelFor = (n: number) => `+${n} more`;
  const pillWidthFor = (n: number) => pillW[pillLabelFor(n)] ?? 64; // 64 = conservative until measured
  // Iterate to a FIXED POINT: pack with the pill width for the CURRENT produced
  // overflow, and if that changes the overflow (so a different pill label), pack
  // again with the new label's width — until the label the pack produces matches
  // the label whose width was reserved (Codex #1: probe-then-lookup could measure
  // a label it never reserved, e.g. "+9 more" → "+10 more"). All candidate pill
  // labels are pre-measured off-screen (below), so every lookup resolves.
  let fit = strip.length, overflow = 0;
  if (measured && rowW > 0) {
    let prev = -1;
    for (let i = 0; i < strip.length + 2; i++) {
      const r = labCompareView!.packStrip(widths, rowW, STRIP_GAP, overflow > 0 ? pillWidthFor(overflow) : 0);
      fit = r.fit; overflow = r.overflow;
      if (overflow === prev) break; // stable: the reserved label == the produced label
      prev = overflow;
    }
  }
  const shown = strip.slice(0, fit);
  const pillLabel = pillLabelFor(overflow);
  // Every overflow count the strip could produce (1..length) — pre-measured so
  // the fixed-point loop never looks up an unmeasured label.
  const candidateOverflows = strip.map((_, i) => i + 1);
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: radius.md, backgroundColor: theme.surface }}>
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>{`${panel.title} · n=${res.n}`}</VText>
      <VText variant="caption" color="inkFaint">Aroma agreement</VText>
      {/* Off-screen measure pass: every chip + EVERY candidate pill label
          (+1..+N more) so the fixed-point pack never looks up an unmeasured
          width, whatever overflow it settles on (Codex #1). */}
      <View pointerEvents="none" style={{ position: 'absolute', opacity: 0, left: 0, top: 0, flexDirection: 'row', flexWrap: 'wrap' }}>
        {strip.map((c) => (
          <View key={c.id} onLayout={(e) => { const w = Math.ceil(e.nativeEvent.layout.width); setChipW((prev) => (prev[c.id] === w ? prev : { ...prev, [c.id]: w })); }}>
            <View style={{ padding: COMPARE_CHIP_PAD }}><AromaChip a={c.id} m={null} count={c.count} pronounced={c.pronounced} vPad={0} /></View>
          </View>
        ))}
        {candidateOverflows.map((n) => {
          const label = pillLabelFor(n);
          return (
            <View key={label} onLayout={(e) => { const w = Math.ceil(e.nativeEvent.layout.width); setPillW((prev) => (prev[label] === w ? prev : { ...prev, [label]: w })); }}>
              <View style={{ paddingVertical: 4, paddingHorizontal: 10 }}><VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }}>{label}</VText></View>
            </View>
          );
        })}
      </View>
      {strip.length > 0 ? (
        <View onLayout={(e) => setRowW(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: STRIP_GAP }}>
          {shown.map((chip) => (
            <CompareChip
              key={chip.id}
              chip={chip}
              onLayoutWidth={(id, w) => setChipW((prev) => (prev[id] === w ? prev : { ...prev, [id]: w }))}
              onTap={(rect) => onTapChip(`${panel.title}|${chip.id}`, chip.id, rect)}
            />
          ))}
          {overflow > 0 ? (
            <Pressable accessibilityRole="button" onPress={onDetailed} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: theme.bg }}>
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.inkSoft }}>{pillLabel}</VText>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <VText variant="caption" color="inkFaint">— mixed; no shared aromas —</VText>
      )}
      {/* Always present — the door to Participants + All aromas, not just overflow. */}
      <Pressable accessibilityRole="button" onPress={onDetailed}>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.inkSoft }}>Detailed aromas →</VText>
      </Pressable>
      {popover}
    </View>
  );
}

function AromaTier2Lab() {
  const { theme } = useTheme();
  const [primaryMode, setPrimaryMode] = useState<'majority' | 'twoThirds'>('majority');
  const [peak, setPeak] = useState<'third' | 'twoThirds'>('third');
  const [pronBar, setPronBar] = useState<'majority' | 'twoThirds'>('majority');
  const [popVariant, setPopVariant] = useState<PopoverVariant>('extension');
  const [extensionAnchor, setExtensionAnchor] = useState<ExtensionAnchor>('corner');
  const opts: AromaConsensusOpts = { primary: primaryMode, peakNum: peak === 'third' ? 1 : 2, peakDen: 3 };
  // Lifted so exactly ONE popover is open. openKey = `${title}|${chipId}`.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<ChipRect | null>(null);
  const [sel, dispatch] = useReducer(labCompareView!.compareSelectionReducer, { kind: 'none' } as CompareSelection);
  const [routeNote, setRouteNote] = useState<string>('');
  // One coordinated close: clears the reducer selection AND the popover together
  // (Codex #4 — closing must clear selection; a retap toggles via the reducer).
  const closeAll = () => { dispatch({ type: 'clear' }); setOpenKey(null); setAnchor(null); };
  const knobPill = (on: boolean, label: string, onPress: () => void) => (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}>
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>{label}</VText>
    </Pressable>
  );
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Aroma agreement · Tier 2 mock (§9)</VText>
      <VText variant="small" color="inkSoft">
        The compact strip as it sits in the expanded compare card — primaries + secondaries only, “Nx Label” chips, packed to two lines with a “+N” tail. Tap a chip → the anchored contributor popover (qualifying descendant mentions · 3-name preview · pronounced nuance · View contributors). Three knobs: primary + peak (selector) and pron (group-pronounced bar — see PR-A/PR-B panels). “Detailed aromas” always shows (opens Tier 3, not built yet). Preliminary pass — the final density + knob ruling happens in the real card context (2b), not here.
      </VText>
      <VText variant="caption" color="inkFaint">
        Popup variants: Title Bar keeps the badge inside a neutral recessed header. Badge Extension overlaps a compact Verre surface. Glass Extension uses the same geometry with native regular Liquid Glass, matched to the active Verre theme’s color scheme and surface tone, with a solid fallback elsewhere.
      </VText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(primaryMode === 'majority', 'primary > n/2', () => setPrimaryMode('majority'))}
          {knobPill(primaryMode === 'twoThirds', 'primary ≥ 2n/3', () => setPrimaryMode('twoThirds'))}
        </View>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(peak === 'third', 'peak ≥ ⅓', () => setPeak('third'))}
          {knobPill(peak === 'twoThirds', 'peak ≥ ⅔', () => setPeak('twoThirds'))}
        </View>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(pronBar === 'majority', 'pron > n/2', () => setPronBar('majority'))}
          {knobPill(pronBar === 'twoThirds', 'pron ≥ 2n/3', () => setPronBar('twoThirds'))}
        </View>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(popVariant === 'attached', 'popup: Title Bar', () => setPopVariant('attached'))}
          {knobPill(popVariant === 'extension', 'popup: Badge Extension', () => setPopVariant('extension'))}
          {knobPill(popVariant === 'glass', 'popup: Glass Extension', () => setPopVariant('glass'))}
        </View>
        <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
          {knobPill(extensionAnchor === 'corner', 'extension: Corner', () => setExtensionAnchor('corner'))}
          {knobPill(extensionAnchor === 'center', 'extension: Center', () => setExtensionAnchor('center'))}
        </View>
      </View>
      {routeNote ? <VText variant="caption" color="inkFaint">{`route → ${routeNote}  ·  selection: ${sel.kind}${sel.kind !== 'none' ? ` ${sel.id}` : ''}`}</VText> : null}
      {ROLLUP_PANELS.map((panel) => {
        // Recompute (cheap) so the popover reads this panel's result/contributors.
        const res = aromaConsensus(aggregateAromaRollup(panel.tasters), opts);
        const isOpenHere = openKey?.startsWith(panel.title + '|') ?? false;
        const openContent = isOpenHere
          ? labCompareView!.popoverContent(res, labBuildContributors!(labRaters(panel.tasters)), openKey!.slice(panel.title.length + 1), pronBar)
          : null;
        return (
          <Tier2PanelCard
            key={panel.title}
            panel={panel}
            opts={opts}
            pronBar={pronBar}
            onTapChip={(fullId, chipId, rect) => {
              // Retap the OPEN chip → close+clear (reducer toggles); else open it.
              dispatch({ type: 'tapAroma', id: fullId });
              if (openKey === fullId) { setOpenKey(null); setAnchor(null); }
              else { setOpenKey(fullId); setAnchor({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); }
              setRouteNote('');
            }}
            onDetailed={() => { setRouteNote('Detailed aromas (Tier 3 — not built)'); closeAll(); }}
            popover={openContent && anchor ? (
              <Tier2Popover
                content={openContent}
                rect={anchor}
                variant={popVariant}
                extensionAnchor={extensionAnchor}
                onClose={closeAll}
                onMoreBranches={() => { setRouteNote(`agreement · focus=${openContent.id} (+${openContent.moreBranches} peak branches)`); closeAll(); }}
                onViewContributors={() => {
                  const route = labCompareView!.viewContributorsRoute(openContent.id);
                  setRouteNote(`${route.mode} · filter=${route.aromaFilter}`);
                  closeAll();
                }}
              />
            ) : null}
          />
        );
      })}
    </View>
  );
}

// The SHIPPED AromaCompareStrip (a production component) rendered over the
// pinned panels — the same component the real CmpAccItem mounts, with the ruled
// defaults (no opts). "Detailed aromas" is a no-op here (the Tier 3 Agreement
// sheet is wired in the real card). The experiment lab above keeps the Title Bar
// / Glass / knob toggles for comparison; this is the single source of truth for
// the shipped look.
function AromaRuledLab() {
  return (
    <View style={{ gap: space.xs }}>
      <VText variant="heading">Aroma agreement · shipped component</VText>
      <VText variant="small" color="inkSoft">
        The production `AromaCompareStrip` — Badge Extension + Corner popover, ruled defaults (majority / ⅓). The experiment lab above is the parked variants only.
      </VText>
      {ROLLUP_PANELS.map((panel) => (
        <View key={panel.title} style={{ gap: 6, padding: 12, borderRadius: radius.md }}>
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{panel.title}</VText>
          <AromaCompareStrip model={labCompareView!.buildCompareAromaModel(labRaters(panel.tasters))} onOpenDetails={() => {}} />
        </View>
      ))}
    </View>
  );
}

export default function DevGallery() {
  const insets = useSafeAreaInsets();
  const { theme, choice, setChoice } = useTheme();
  const axisColor = useFlavourColors();
  const [levels, setLevels] = useState<Record<string, number>>(SAMPLE_LEVELS);
  const [monoWords, setMonoWords] = useState<'mono' | 'resting' | 'solid'>('mono');
  const [monoPronounced, setMonoPronounced] = useState<Set<string>>(new Set());
  const [monoSolidFill, setMonoSolidFill] = useState(false);
  const [badgeArmed, setBadgeArmed] = useState<Set<string>>(new Set());
  const [badgePron, setBadgePron] = useState<Set<string>>(new Set());
  const [armedStyle, setArmedStyle] = useState<'ruled' | 'solid' | 'map'>('ruled');
  const [dotArmed, setDotArmed] = useState(true);
  const [paleAll, setPaleAll] = useState(false);
  const [badgeVPad, setBadgeVPad] = useState(4.5);
  const galleryTap = useTapOrDouble();
  const [wheelBadge, setWheelBadge] = useState(false);
  const [wheelGhost, setWheelGhost] = useState(false);
  const [wheelStraight, setWheelStraight] = useState(false);
  if (!__DEV__) return <Redirect href="/moments" />;

  // Wheel reads the SAME resolved axes + theme colours the input writes.
  const sample: WheelAxis[] = perRatingAxes(levels, resolveAxes('wine', SAMPLE_STYLE)).map((a) => ({
    label: a.l,
    color: axisColor(a.k),
    value: levels[a.k] ?? 0,
  }));

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE, gap: space.lg }}
      >
        <View style={{ gap: space.xs }}>
          <VText variant="heading">Theme</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
            {(['system', ...Object.keys(themes)] as ThemeChoice[]).map((c) => (
              <Button key={c} title={c} size="sm" variant={choice === c ? 'primary' : 'secondary'} onPress={() => setChoice(c)} />
            ))}
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Star + value</VText>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <StarScore value={4.25} />
            <StarScore value={5} />
            <StarScore value={0.75} size={18} />
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Structure input</VText>
          <VText variant="small" color="inkSoft">Fill-track — tap/drag; wheel below updates live. Badge-tint fill + ink font (ruled 2026-07-11).</VText>
          <StructureInput style={SAMPLE_STYLE} value={levels} onChange={setLevels} />
        </View>

        <View style={{ gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="heading">Structure wheel</VText>
            {/* wash = the mock's 0.72 wedge opacity (shipped); badge tint =
                the Structure input's badge look — opaque 0.72 mix over the
                ground + readable axis-coloured labels. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((sol) => {
                const on = wheelBadge === sol;
                return (
                  <Pressable
                    key={String(sol)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelBadge(sol)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {sol ? 'Badge Tint' : 'Wash (0.72)'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
          </View>
          {/* exploration toggles, each on its own row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {/* Ghost remainder: fill to the rating, then a paled same-colour
                tint continues to the rim (=5) as a scale reference. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((g) => {
                const on = wheelGhost === g;
                return (
                  <Pressable
                    key={String(g)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelGhost(g)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {g ? 'Ghost Remainder' : 'No Remainder'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
            {/* Straight separators: parallel side edges (straight gaps between
                wedges) vs the coxcomb's radial-sided (angled/triangular gap)
                wedges. Wedge length + arcs are unchanged. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((s) => {
                const on = wheelStraight === s;
                return (
                  <Pressable
                    key={String(s)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelStraight(s)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {s ? 'Straight Separators' : 'Angled Separators'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={{ alignItems: 'center' }}>
            <StructureWheel axes={sample} badgeTint={wheelBadge} ghostRemainder={wheelGhost} straightSides={wheelStraight} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <StructureWheel axes={sample} size={72} labels={false} badgeTint={wheelBadge} ghostRemainder={wheelGhost} straightSides={wheelStraight} />
            <VText variant="small" color="inkSoft">mini (feed-card scale)</VText>
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Aroma badges</VText>
          <VText variant="small" color="inkSoft">
            One per family, on a surface card (where badges actually sit). Switch themes above.
          </VText>
          <View style={{ gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
            {/* badge-height exploration (Simon, 2026-07-13): the slider drives
                every chip's vPad. Shipped values: 4.5 = write surfaces,
                0 = READ surfaces (AromaReadChips). Negative range =
                padding 0 + tightened label line (see the vPad prop doc) so
                the shrink continues past the padding floor. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <VText variant="caption" color="inkFaint">height</VText>
              <View style={{ flex: 1 }}>
                <DevSlider value={badgeVPad} onChange={setBadgeVPad} min={-4} max={12} step={0.5} />
              </View>
              <VText variant="caption" color="inkSoft" style={{ width: 88, textAlign: 'right' }}>
                vPad {badgeVPad}{badgeVPad === 4.5 ? ' (write)' : badgeVPad === 0 ? ' (read)' : ''}
              </VText>
            </View>
            {/* ONE interactive row (Simon, 2026-07-12): every chip starts
                resting; tap toggles ARMED, double-tap toggles PRONOUNCED
                (useTapOrDouble runs single on tap 1, so the double handler
                reverts that arm — a double-tap nets pronounced only). The
                pill picks which armed treatment renders. */}
            <View style={{ gap: 6 }}>
              <VText variant="caption" color="inkFaint">
                resting — tap = armed, double-tap = pronounced; armed treatment:
              </VText>
              {/* switches wrap onto their own lines (Simon) — no overflow on
                  narrow screens. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                  {(['ruled', 'solid', 'map'] as const).map((k) => {
                    const on = armedStyle === k;
                    return (
                      <Pressable
                        key={k}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: on }}
                        onPress={() => setArmedStyle(k)}
                        style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                      >
                        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                          {k === 'ruled' ? 'Ruled: Mute Rest' : k === 'solid' ? 'Solid (old armed)' : 'Map (All Solid, Arm Pales Rest)'}
                        </VText>
                      </Pressable>
                    );
                  })}
                </View>
                {/* all-or-nothing arm toggle — whole-row compare per theme. */}
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    setBadgeArmed((prev) =>
                      prev.size === AROMA_FAMILIES.length ? new Set() : new Set(AROMA_FAMILIES.map((f) => f.id)),
                    )
                  }
                  style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: theme.bg }}
                >
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.inkSoft }}>
                    {badgeArmed.size === AROMA_FAMILIES.length ? 'Disarm All' : 'Arm All'}
                  </VText>
                </Pressable>
                {/* Contextual modes (deep/map) change NO colour on the armed
                    chip — with everything armed there is no rest to pale, so
                    Arm All is colour-inert there by design. Pale All previews
                    the pale state on every un-armed chip instead. */}
                {armedStyle !== 'solid' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: paleAll }}
                    onPress={() => setPaleAll((b) => !b)}
                    style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: paleAll ? theme.surface : theme.bg }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: paleAll ? theme.ink : theme.inkSoft }}>
                      Pale All
                    </VText>
                  </Pressable>
                ) : null}
                {/* the ListPicker's round-mark armed vocabulary, on a chip. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: dotArmed }}
                  onPress={() => setDotArmed((b) => !b)}
                  style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: dotArmed ? theme.surface : theme.bg }}
                >
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: dotArmed ? theme.ink : theme.inkSoft }}>
                    ● Dot Armed
                  </VText>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {AROMA_FAMILIES.map((f) => {
                  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) =>
                    set((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    });
                  const armed = badgeArmed.has(f.id);
                  return (
                    <AromaChip
                      key={f.id}
                      a={f.id}
                      m={null}
                      // 'ruled' = Simon's 2026-07-12 search ruling (now live in
                      // AromaInput): armed keeps its resting colours, the ONLY
                      // change is the rest muting. 'map' = the hexStage anatomy
                      // verbatim (all solid, arm pales rest). 'solid' = the old
                      // armed flip, kept for comparison.
                      focused={(armedStyle === 'solid' || armedStyle === 'map') && armed}
                      mapSolid={armedStyle === 'map'}
                      muted={armedStyle === 'ruled' && (badgeArmed.size > 0 || paleAll) && !armed}
                      pale={armedStyle === 'map' && (badgeArmed.size > 0 || paleAll) && !armed}
                      armedDot={dotArmed && armed}
                      pronounced={badgePron.has(f.id)}
                      vPad={badgeVPad}
                      onPress={() =>
                        galleryTap(
                          f.id,
                          () => toggle(setBadgeArmed),
                          () => { toggle(setBadgeArmed); toggle(setBadgePron); },
                        )
                      }
                    />
                  );
                })}
              </View>
            </View>
            <View style={{ gap: 6 }}>
              <VText variant="caption" color="inkFaint">theme-coloured rows — font (tap a chip = pronounced):</VText>
              <View style={{ flexDirection: 'row', alignSelf: 'flex-start', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                {(['tint', 'solid'] as const).map((k) => {
                  const on = monoSolidFill === (k === 'solid');
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMonoSolidFill(k === 'solid')}
                      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                    >
                      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                        {k === 'tint' ? 'Tint Fill' : 'Solid Fill'}
                      </VText>
                    </Pressable>
                  );
                })}
              </View>
              <View style={{ flexDirection: 'row', alignSelf: 'flex-start', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                {(['mono', 'resting', 'solid'] as const).map((k) => {
                  const on = monoWords === k;
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMonoWords(k)}
                      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                    >
                      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                        {k === 'mono' ? 'Mono' : k === 'resting' ? 'Family' : 'Family 100%'}
                      </VText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {([['accent', theme.accent], ['neutral ink', theme.ink]] as const).map(([label, tintColor]) => (
              <View key={label} style={{ gap: 5 }}>
                <VText variant="caption" color="inkFaint">theme-coloured — {label} (exploration: all families one colour)</VText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {AROMA_FAMILIES.map((f) => (
                    <AromaChip
                      key={f.id}
                      a={f.id}
                      m={null}
                      tint={tintColor}
                      tintSolid={monoSolidFill}
                      monoWords={monoWords === 'mono' ? undefined : monoWords}
                      pronounced={monoPronounced.has(f.id)}
                      vPad={badgeVPad}
                      onPress={() =>
                        setMonoPronounced((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        })
                      }
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">QR code</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} />
              </View>
              <VText variant="caption" color="inkSoft">
                {contrastRatio(theme.ink, theme.surface) >= 3 ? 'auto: themed' : 'auto: fallback (white)'}
              </VText>
            </View>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} forceThemed />
              </View>
              <VText variant="caption" color="inkSoft">forced: theme colors</VText>
            </View>
          </View>
          <VText variant="small" color="inkSoft">
            {`ink/surface contrast ${contrastRatio(theme.ink, theme.surface).toFixed(2)} (clamp at 3.0)`}
          </VText>
          <VText variant="caption" color="inkFaint">
            Left = the real component (clamps to white below 3.0; all current themes pass). Right = forced theme colors, no clamp. Scan each with the Camera app.
          </VText>
        </View>

        <AromaRollupLab />

        <AromaTier2Lab />

        <AromaRuledLab />

        <GlassLab />
        <GlassLab2 />
        <GlassLab3 />
      </ScrollView>
    </>
  );
}
