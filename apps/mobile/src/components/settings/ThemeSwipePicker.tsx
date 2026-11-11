import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated, { runOnJS, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BadgePill } from '@/components/moments/RoleChip';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { GUTTER } from '@/lib/layout';
import { ThemePreviewProvider, control, elevation, radius, textStyle, themes, useTheme, type ThemeKey } from '@/theme';
import demoPhoto from '../../../assets/images/theme-demo-petnat.jpg';

const KEYS = Object.keys(themes) as ThemeKey[];
// A wrapped label ("Use Cobalt night When Phone Is in Dark Mode") keeps a
// one-line label's inset, so its last line stays the same distance above the
// next button (ruled 2026-11-11).
const LABEL_INSET = (control.h - (textStyle('body').lineHeight ?? 0)) / 2;

// "Light · Default" etc. (ruling Q-F: Light / Dark by the theme's scheme).
const tagOf = (k: ThemeKey) => `${themes[k].scheme === 'light' ? 'Light' : 'Dark'}${themes[k].default ? ' · Default' : ''}`;

// The design's 01 "Choose your theme" swipe picker (vero-screens.js theme()),
// built reusable (Settings → Appearance now, onboarding later). Swiping
// anywhere pages through the six themes. Every theme is a full LAYER (its own
// background, the caller's `header`, the demo card, the foot, all through
// ThemePreviewProvider), stacked in page order and CLIPPED to the right of its
// page's edge on screen: nothing moves, a straight vertical colour wave rides
// the page boundary under the finger and recolours everything it passes
// (ruled 2026-11-11). The wave is transforms only, on the UI thread (the
// clip window slides right by the edge, the content slides back by the same
// amount, so it stays put); the worm dots animate layout props (left/width,
// off the sync fast path; smooth on device, kept for round pill ends). React
// re-renders only when the nearest page changes (`index`: the status bar,
// which layer takes touches + VoiceOver), never per frame, and swaps no
// views, so no registry flash (apps/mobile/CLAUDE.md, reanimated).
// The app's theme is untouched until a button commits. Two per theme (ruled
// 2026-11-11): "Use <Theme>" (always this one) and "Use <Theme> When Phone Is
// in Light / Dark Mode" (Match System, this theme for its own kind; the other
// kind keeps its pick, so the caller stays on the page to set it). Each turns
// into a ✓ state when it is what's in use. Opens on the
// active theme (under Match System, the one the phone's appearance picks).
// Deviation (flagged): the demo card and its chip drop the mock's 1px rule
// border (no-borders ruling; the card keeps its md shadow).
export function ThemeSwipePicker({ header, onPreview, onUse, onUseInSystem }: {
  header: ReactNode;
  onPreview?: (key: ThemeKey) => void;
  onUse: (key: ThemeKey) => void;
  onUseInSystem: (key: ThemeKey) => void;
}) {
  const { themeKey } = useTheme();
  const { width } = useWindowDimensions();
  const opened = useRef(Math.max(0, KEYS.indexOf(themeKey))).current;
  const [index, setIndex] = useState(opened);
  const lastIndex = useSharedValue(opened);
  const x = useSharedValue(opened * width);
  useEffect(() => {
    onPreview?.(KEYS[index]);
  }, [index, onPreview]);
  const onScroll = useAnimatedScrollHandler((e) => {
    x.value = e.contentOffset.x;
    const i = Math.min(KEYS.length - 1, Math.max(0, Math.round(e.contentOffset.x / width)));
    if (i !== lastIndex.value) {
      lastIndex.value = i;
      runOnJS(setIndex)(i);
    }
  });
  // ONE foot height for every layer: the tallest (a label that wraps makes
  // its foot taller), so the demo sits in the same place on every theme and
  // nothing jumps as the wave passes (ruled 2026-11-11).
  const [footH, setFootH] = useState<number | null>(null);
  const onFootHeight = useCallback((h: number) => setFootH((m) => (m == null ? h : Math.max(m, h))), []);
  // VoiceOver's increment / decrement on the theme name: the same paging.
  const pager = useAnimatedRef<Animated.ScrollView>();
  // `contentOffset` alone isn't reliable for the opening page: scroll there
  // ONCE the pages are laid out.
  const placed = useRef(false);
  const place = () => {
    if (placed.current) return;
    placed.current = true;
    pager.current?.scrollTo({ x: opened * width, animated: false });
  };
  const step = (delta: number) => {
    const i = Math.min(KEYS.length - 1, Math.max(0, index + delta));
    if (i === index) return;
    setIndex(i);
    lastIndex.value = i;
    pager.current?.scrollTo({ x: i * width, animated: false });
  };

  return (
    <View style={{ flex: 1, backgroundColor: themes[KEYS[opened]].bg }}>
      {/* .theme-swipe — transparent full-screen pages behind everything. */}
      <Animated.ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: opened * width, y: 0 }}
        onContentSizeChange={place}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        accessibilityLabel="Themes"
        accessibilityHint="Swipe left or right to try the themes."
      >
        {KEYS.map((k) => <View key={k} style={{ width }} />)}
      </Animated.ScrollView>
      {KEYS.map((k, i) => (
        <ThemeLayer
          key={k}
          k={k}
          i={i}
          x={x}
          width={width}
          active={i === index}
          footH={footH ?? 140}
          onFootHeight={onFootHeight}
          header={header}
          onStep={step}
          onUse={onUse}
          onUseInSystem={onUseInSystem}
        />
      ))}
    </View>
  );
}

// One theme's full page, visible right of its page edge (i·width − scroll,
// clamped to the screen): with the finger between pages i and i+1, layers up
// to i cover the screen and i+1 shows right of the moving edge.
function ThemeLayer({ k, i, x, width, active, footH, onFootHeight, header, onStep, onUse, onUseInSystem }: {
  k: ThemeKey;
  i: number;
  x: SharedValue<number>;
  width: number;
  active: boolean;
  footH: number;
  onFootHeight: (h: number) => void;
  header: ReactNode;
  onStep: (delta: number) => void;
  onUse: (key: ThemeKey) => void;
  onUseInSystem: (key: ThemeKey) => void;
}) {
  const edge = useDerivedValue(() => Math.min(width, Math.max(0, i * width - x.value)));
  const window = useAnimatedStyle(() => ({ transform: [{ translateX: edge.value }] }));
  const content = useAnimatedStyle(() => ({ transform: [{ translateX: -edge.value }] }));
  return (
    <ThemePreviewProvider themeKey={k}>
      <Animated.View
        pointerEvents={active ? 'box-none' : 'none'}
        accessibilityElementsHidden={!active}
        importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
        style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }, window]}
      >
        <Animated.View pointerEvents="box-none" style={[{ flex: 1, backgroundColor: themes[k].bg }, content]}>
          <PickerBody k={k} i={i} x={x} width={width} footH={footH} onFootHeight={onFootHeight} header={header} onStep={onStep} onUse={onUse} onUseInSystem={onUseInSystem} />
        </Animated.View>
      </Animated.View>
    </ThemePreviewProvider>
  );
}

// Inside its layer's preview provider: everything here reads THAT theme.
function PickerBody({ k, i, x, width, footH, onFootHeight, header, onStep, onUse, onUseInSystem }: {
  k: ThemeKey;
  i: number;
  x: SharedValue<number>;
  width: number;
  footH: number;
  onFootHeight: (h: number) => void;
  header: ReactNode;
  onStep: (delta: number) => void;
  onUse: (key: ThemeKey) => void;
  onUseInSystem: (key: ThemeKey) => void;
}) {
  const { theme, choice, systemThemes } = useTheme();
  const kind = themes[k].scheme;
  const mode = kind === 'light' ? 'Light' : 'Dark';
  const inUse = choice === k;
  const inSystem = choice === 'system' && systemThemes[kind] === k;
  const insets = useSafeAreaInsets();
  // The demo centres in the space above the foot (.theme-static's bottom
  // padding): the picker's shared, measured height (larger text can't push
  // it under the buttons, and every layer agrees).
  return (
    <View style={{ flex: 1 }} pointerEvents="box-none">
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: GUTTER }} pointerEvents="box-none">{header}</View>
      {/* .tdemo + the theme's name and dots under it (ruled 2026-11-11: close
          to the card, not down by the buttons), centred together in the space
          above the foot. Touches pass through to the swipe layer; VoiceOver
          skips the demo (its button is only for show) and reads the name. */}
      <View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: footH }}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: '100%', alignItems: 'center', gap: 22 }}>
          <VText variant="heading" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            Verre<VText variant="heading" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>.</VText>
          </VText>
          <View
            style={{
              width: '100%', maxWidth: 250, backgroundColor: theme.surface, borderRadius: radius.lg, overflow: 'hidden',
              shadowColor: '#000',
              shadowOpacity: elevation.md.ios.shadowOpacity,
              shadowRadius: elevation.md.ios.shadowRadius,
              shadowOffset: { width: 0, height: elevation.md.ios.shadowOffsetY },
              elevation: elevation.md.android.elevation,
            }}
          >
            <Image source={demoPhoto} style={{ width: '100%', height: 130 }} contentFit="cover" />
            <View style={{ paddingTop: 13, paddingHorizontal: 15, paddingBottom: 15 }}>
              <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                Sour cherry pét-nat <VText variant="subhead" color="inkSoft">2024</VText>
              </VText>
              <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>Garden Tap · Berlin</VText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 12 }}>
                <StarScore value={4.5} size={13} />
                <BadgePill label="cherry" bg={theme.surfaceSunk} color={theme.inkSoft} uppercase={false} paddingHorizontal={10} paddingVertical={4} />
              </View>
              <Button title="Check In" size="sm" block onPress={() => {}} style={{ marginTop: 14 }} />
            </View>
          </View>
        </View>
        <View
          style={{ alignItems: 'center', marginTop: 22 }}
          pointerEvents="none"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Theme"
          accessibilityValue={{ text: `${themes[k].name}, ${tagOf(k)}, ${i + 1} of ${KEYS.length}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => onStep(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        >
          <VText variant="bodyLg" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{themes[k].name}</VText>
          <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{tagOf(k)}</VText>
        </View>
        <View style={{ marginTop: 12 }}>
          <Dots x={x} width={width} />
        </View>
      </View>
      {/* .theme-foot */}
      <View
        onLayout={(e) => onFootHeight(Math.round(e.nativeEvent.layout.height))}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: GUTTER, paddingBottom: insets.bottom + 22 }}
        pointerEvents="box-none"
      >
        <Button
          title={inSystem ? `Used When Phone Is in ${mode} Mode` : `Use ${themes[k].name} When Phone Is in ${mode} Mode`}
          titleLines={2}
          icon={inSystem ? 'check' : undefined}
          variant="tertiary"
          block
          disabled={inSystem}
          onPress={() => onUseInSystem(k)}
          style={{ marginBottom: 12, paddingVertical: LABEL_INSET }}
        />
        <Button title={inUse ? 'In Use' : `Use ${themes[k].name}`} icon={inUse ? 'check' : undefined} block disabled={inUse} onPress={() => onUse(k)} />
      </View>
    </View>
  );
}

// .theme-dots — a "worm" over the mock's layout (ruled 2026-11-11): at rest
// the active slot is the 18pt pill, the others 6pt dots, 6 apart EVERYWHERE.
// Driven by the scroll position: the slots morph (the one you leave shrinks,
// the one you approach grows, so the row keeps its width and never
// re-centres), and the accent pill's FRONT end runs over the first LEAD of
// the swipe while its back end follows over the last LEAD, so it stretches
// over the next dot (eating it) and pulls its back in early: about 25pt at
// its longest, not double. The geometry is the same on every layer; the
// wave recolours it.
const DOT = 6;
const PILL = 18;
const GAP = 6;
const LEAD = 0.65;
const smooth = (t: number) => {
  'worklet';
  return t * t * (3 - 2 * t);
};
// Slot n's width / left edge at scroll position p (pages).
const slotW = (p: number, n: number) => {
  'worklet';
  return DOT + (PILL - DOT) * Math.max(0, 1 - Math.abs(p - n));
};
const slotL = (p: number, n: number) => {
  'worklet';
  let l = 0;
  for (let m = 0; m < n; m++) l += slotW(p, m) + GAP;
  return l;
};
function Dots({ x, width }: { x: SharedValue<number>; width: number }) {
  const { theme } = useTheme();
  const pill = useAnimatedStyle(() => {
    const p = Math.min(KEYS.length - 1, Math.max(0, x.value / width));
    const i = Math.min(KEYS.length - 2, Math.floor(p));
    const f = p - i;
    const front = smooth(Math.min(1, f / LEAD));
    const back = smooth(Math.max(0, (f - (1 - LEAD)) / LEAD));
    const l0 = slotL(p, i);
    const l1 = slotL(p, i + 1);
    const left = l0 + (l1 - l0) * back;
    const right = l0 + slotW(p, i) + (l1 + slotW(p, i + 1) - l0 - slotW(p, i)) * front;
    return { left, width: right - left };
  });
  return (
    <View style={{ width: (KEYS.length - 1) * (DOT + GAP) + PILL, height: DOT }}>
      {KEYS.map((key, n) => <Dot key={key} n={n} x={x} width={width} />)}
      <Animated.View style={[{ position: 'absolute', top: 0, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.accent }, pill]} />
    </View>
  );
}
function Dot({ n, x, width }: { n: number; x: SharedValue<number>; width: number }) {
  const { theme } = useTheme();
  const slot = useAnimatedStyle(() => {
    const p = Math.min(KEYS.length - 1, Math.max(0, x.value / width));
    return { left: slotL(p, n), width: slotW(p, n) };
  });
  return <Animated.View style={[{ position: 'absolute', top: 0, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.inkFaint, opacity: 0.4 }, slot]} />;
}
