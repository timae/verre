import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  resolveAxes,
  FLAVOUR_MAX,
  flavourLevelFromFraction,
  type StructureAxis,
} from '@verre/core';
import { intensityWord } from '@/lib/scoreWords';
import { contrastRatio } from '@/lib/contrast';
import { usePhoneTokens } from '@/lib/layout';
import { VText } from '@/components/ui/VText';
import { useFlavourColors } from '@/theme/flavourColors';
import { alpha } from '@/theme/color';
import { radius, useTheme } from '@/theme';

// Per-attribute flavour-intensity input — the decided "C · Fill track" control
// (Vero - Scoring.html .filltrack pixel spec): a 38px track per axis, the axis
// colour fills left→right in whole 0–5 steps, the axis label sits at the left
// and the intensity word at the right, both over the fill. Two tracks per row
// on a wide phone, one per row when narrow.
//
// Data model (structure wheel): the rated axes are structure INTENSITIES
// resolved from the wine style (resolveAxes) — sweet/acid/aroma/flavour/
// (+bubbles on sparkling)/funk/tannin/body/finish (2026-07-09 order). Colour is per-platform presentation:
// native reads it from the ACTIVE THEME (useFlavourColors), never a baked hex
// (proposal §3a).
//
// Input behavior is native-first (Simon's ruling, native-first-input): a
// gesture-handler Pan with activeOffsetX/failOffsetY lets the OS arbitrate
// drag-vs-scroll against the surrounding ScrollView (what the web mimics with
// its SLOP dance), a Tap sets/toggles a level, and VoiceOver adjusts each track
// via accessibility increment/decrement. Only the value policy
// (flavourLevelFromFraction, whole 1..5, small-fraction→0 clear) comes from
// @verre/core.
//
// ⚠️ ZERO RULE (structure wheel §5, and the save-boundary note in the rate
// screen): the caller must store {} when EVERY axis is None. This control emits
// a keys-present map only for axes the taster actually moved above 0 — it does
// NOT seed a zeros-only {sweet:0,acid:0,…} map. An axis the user never touches
// stays ABSENT (not 0), matching the server's drop-all-or-keep-all shape and the
// perRatingAxes render (absent → no wedge; present-and-0 → centre point).

const TRACK_H = 38;
const TRACK_H_COMFORT = 44; // Pro-Max-class device height (phone.lerp by comfort)
// Left-edge "fill this way" triangle affordance (see FillTrack). Rounded SVG.
// Near-full track height, kept slim so it doesn't reach the label inset (13).
const TRI_W = 9;
const TRI_H = 30;
const TRI_H_COMFORT = 35;
// Left inset of the axis label inside the track (.ft-name padding-left). The
// `sub` caption centers under the label word using this + the measured label width.
const LABEL_INSET = 13;

interface Props {
  // The wine style drives the axis set (sparkling adds Bubbles). null/unknown →
  // base wine set (resolveAxes is defensive).
  style: string | null | undefined;
  // The current rating's flavour map — keys present are rated (0 = perceived
  // None but explicitly set). Absent keys are not rated.
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}

export function FlavourInput({ style, value, onChange }: Props) {
  const phone = usePhoneTokens();
  const axisColor = useFlavourColors();
  const axes = resolveAxes('wine', style);
  // Two columns on a roomy phone, one on a narrow one (the design's 640px
  // grid break — phones below ~380pt read cramped with two 38px tracks + words).
  const twoCol = phone.width >= 380;

  // Latest map, updated SYNCHRONOUSLY on every edit — not just mirrored from
  // the prop. Two tracks edited in one JS batch (a two-finger drag: sibling
  // Pans share no pointer, so RNGH keeps both ACTIVE) must each build on the
  // other's write; spreading the render-captured `value` would make the second
  // onChange silently drop the first axis's edit.
  const valueRef = useRef(value);
  valueRef.current = value;

  const setLevel = (key: string, level: number) => {
    // `?? 0`: an absent key IS level 0 — without the coercion a VoiceOver
    // decrement on an unrated axis (undefined !== 0) fires a spurious
    // "changed" haptic + a content-identical onChange.
    const prev = valueRef.current[key] ?? 0;
    if (prev === level) return;
    // Keys-present map: a level > 0 sets the key; level 0 REMOVES it so an
    // untouched-then-cleared axis returns to absent (the zero rule — never a
    // lingering explicit 0 unless another axis keeps the map non-empty… which
    // the caller collapses to {} when all are gone).
    const next = { ...valueRef.current };
    if (level <= 0) delete next[key];
    else next[key] = level;
    valueRef.current = next;
    Haptics.selectionAsync().catch(() => {});
    onChange(next);
  };

  return (
    // .inputgrid — two columns via `space-between` (NOT columnGap): a fixed
    // columnGap + 48% widths overflows 100% and forces every item to wrap to its
    // own row (the single-column bug). space-between distributes the 4% slack as
    // the inter-column gap, and — crucially — a LONE last track on an odd row
    // stays flush-left at 48%, never stretched to fill the row. rowGap handles
    // vertical spacing.
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: twoCol ? 'space-between' : 'flex-start',
        marginTop: 4,
        rowGap: 14,
      }}
    >
      {axes.map((axis) => (
        <View key={axis.k} style={{ width: twoCol ? '48%' : '100%' }}>
          <FillTrack
            axis={axis}
            color={axisColor(axis.k)}
            level={value[axis.k] ?? 0}
            onSet={(lvl) => setLevel(axis.k, lvl)}
          />
        </View>
      ))}
    </View>
  );
}

// One axis fill-track. Isolated so its gesture + measured width are self-scoped
// (a shared measure across all tracks would misread the touch fraction).
function FillTrack({
  axis,
  color,
  level,
  onSet,
}: {
  axis: StructureAxis;
  color: string;
  level: number;
  onSet: (level: number) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  // Track + triangle height scale on BOTH axes: device size (phone.lerp by
  // `comfort` — a Pro Max gets the taller value, an SE the base) AND text size
  // (the compactList surface floors at 1× and grows with Dynamic Type, capped
  // 1.35×, so enlarged labels never clip the fixed box). Base→comfort pairs
  // mirror the PHONE_SIZE token convention.
  const listSurface = phone.surface('compactList');
  const trackH = listSurface.height(phone.lerp(TRACK_H, TRACK_H_COMFORT));
  const triH = listSurface.height(phone.lerp(TRI_H, TRI_H_COMFORT));
  const [trackW, setTrackW] = useState(0);
  const levelRef = useRef(level);
  levelRef.current = level;
  const widthRef = useRef(0);
  widthRef.current = trackW;

  // Touch x → whole level, entirely core policy (flavourLevelFromFraction):
  // a touch in the leftmost sliver (≤ FLAVOUR_CLEAR_FRACTION) clears to 0 —
  // the "drag/tap far-left to unset" affordance — above it, whole 1..5.
  const setFromX = (x: number) => {
    const w = widthRef.current;
    if (w <= 0) return;
    const next = flavourLevelFromFraction(x / w);
    if (next !== levelRef.current) onSet(next);
  };

  const commitHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  // Pan claims the gesture once movement is clearly horizontal; a clearly
  // vertical drag fails to the parent ScrollView. Mirrors ScoreInput. The fill
  // jumps in whole steps as the finger moves (stepped, not a smooth glide — the
  // smooth version felt off, Simon).
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-8, 8])
    .onUpdate((e) => setFromX(e.x))
    .onEnd(() => commitHaptic());
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e, success) => {
      if (!success) return;
      setFromX(e.x);
      commitHaptic();
    });
  const gesture = Gesture.Race(pan, tap);

  const pct = Math.max(0, Math.min(FLAVOUR_MAX, level)) / FLAVOUR_MAX;
  // Text colour is FIXED (theme.ink), never flipped by fill — the label/word each
  // span TWO grounds at once (the fill on the left, surfaceSunk on the right), so
  // no single solid colour can read over both; changing it also made the word
  // jump colour when the fill was nowhere near it. Legibility comes from a HALO
  // (text-shadow) in the ink's OPPOSITE tone: a near-black glow for light ink,
  // a near-white glow for dark ink — so light ink over a near-white fill (Clay
  // Bubbles) still gets a crisp dark outline. Pure black/white (softened to 0.85)
  // is a stronger, more predictable outline than theme.bg, which on some themes
  // (Clay's mid terracotta) was too weak against a near-white fill. Two stacked
  // properties can't exist in RN, so the single shadow is the whole outline.
  const inkIsLight = contrastRatio(theme.ink, '#ffffff') < contrastRatio(theme.ink, '#000000');
  const haloColor = alpha(inkIsLight ? '#000000' : '#ffffff', 0.85);
  const labelStyle = {
    fontFamily: 'InstrumentSans_600SemiBold' as const,
    ...phone.text('small'),
    color: theme.ink,
    textShadowColor: haloColor,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  };

  return (
    <View>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`${axis.l} intensity`}
          accessibilityValue={{ min: 0, max: FLAVOUR_MAX, now: level, text: intensityWord(level) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const dir = e.nativeEvent.actionName === 'increment' ? 1 : -1;
            onSet(Math.max(0, Math.min(FLAVOUR_MAX, levelRef.current + dir)));
          }}
          style={{
            height: trackH,
            borderRadius: radius.sm,
            backgroundColor: theme.surfaceSunk,
            // 1px border so the EMPTY track reads as an input field on every
            // theme — surfaceSunk sits close to bg/surface on several themes
            // (cobalt), where a borderless empty track dissolves into the page
            // (user feedback: "can't tell it's a slider / the 0-tint is
            // invisible"). The container border renders OVER the absolute fill
            // at the edges (overflow: hidden clips the fill to this radius), so
            // one border works filled or empty. Mirrors the design's other
            // inputs (.vslider track) which already carry `border: 1px rule`.
            borderWidth: 1,
            borderColor: theme.rule,
            overflow: 'hidden',
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          {/* Left-edge triangle affordance — points right (the fill direction),
              in the AXIS FILL COLOUR so an empty track previews what a tap will
              add. Flush to the left border. Declared BEFORE the fill so the fill
              (a later, same-colour sibling starting at left:0) paints seamlessly
              OVER it: on an EMPTY track (fill width 0) it's a visible "start
              here, fill this way" cue; at level ≥1 it merges into the fill (user
              feedback: "not clear you can slide it"). SVG (not the border trick)
              so the corners can round: a filled wedge + a round-joined stroke of
              the same colour softens the tips. It sits at the left edge, BEFORE
              the label's inset, so the label never moves empty↔filled (no
              reflow). */}
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, top: trackH / 2 - triH / 2 - 1 }}
          >
            <Svg width={TRI_W} height={triH} viewBox="0 0 9 30">
              {/* right-pointing triangle inset ~2px so the round stroke stays in-canvas */}
              <Path
                d="M2 2 L8 15 L2 28 Z"
                fill={color}
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </Svg>
          </View>
          {/* .fill — axis colour, width = level/5. Whole-step jumps (no width
              tween) — matches ScoreInput's plain-View fill; crisper per tap. A
              minWidth floor keeps a few px of colour showing at level 0 (a
              resting "this fills" cue); at level ≥1 the % already exceeds it, so
              the floor only affects the empty state. */}
          <View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${pct * 100}%`,
              backgroundColor: color,
              borderRadius: radius.sm,
            }}
          />
          {/* .ft-name — axis label, left, over the fill. Capped Dynamic Type
              (compactList): the fixed 38px track can't grow, so the label/word
              must stop scaling before they clip vertically. */}
          <VText
            surface="compactList"
            numberOfLines={1}
            style={{ marginLeft: LABEL_INSET, marginRight: 6, flexShrink: 1, ...labelStyle }}
          >
            {axis.l}
          </VText>
        </View>
      </GestureDetector>
    </View>
  );
}
