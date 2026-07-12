import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '@/components/ui/Icon';
import { alpha } from '@/theme/color';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AROMA_FAMILIES, resolveAxes, perRatingAxes } from '@verre/core';
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
import { radius, space, themes, useTheme, type ThemeChoice } from '@/theme';
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
  const galleryTap = useTapOrDouble();
  const [wheelBadge, setWheelBadge] = useState(false);
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
          <View style={{ alignItems: 'center' }}>
            <StructureWheel axes={sample} badgeTint={wheelBadge} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <StructureWheel axes={sample} size={72} labels={false} badgeTint={wheelBadge} />
            <VText variant="small" color="inkSoft">mini (feed-card scale)</VText>
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Aroma badges</VText>
          <VText variant="small" color="inkSoft">
            One per family, on a surface card (where badges actually sit). Switch themes above.
          </VText>
          <View style={{ gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
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

        <GlassLab />
        <GlassLab2 />
        <GlassLab3 />
      </ScrollView>
    </>
  );
}
