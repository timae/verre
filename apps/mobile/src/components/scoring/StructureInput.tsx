import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  resolveAxes,
  FLAVOUR_CLEAR_FRACTION,
  FLAVOUR_MAX,
  flavourLevelFromFraction,
  type StructureAxis,
} from '@verre/core';
import { intensityRangeWord, intensityWord } from '@/lib/scoreWords'; // range: VoiceOver value only
import { usePhoneTokens } from '@/lib/layout';
import { VText } from '@/components/ui/VText';
import { useFlavourColors } from '@/theme/flavourColors';
import { mix } from '@/theme/color';
import { radius, useTheme } from '@/theme';

// Per-attribute structure-intensity input — the decided "C · Fill track"
// control (Vero - Scoring.html .filltrack pixel spec for anatomy; the FILL
// COLOUR is a sanctioned deviation, see the ruled-look note in FillTrack): a
// 38px track per axis, the axis colour's badge tint fills left→right in
// whole 0–5 steps, the axis label at the left in plain ink. Two tracks per
// row on a wide phone, one per row when narrow.
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

// RANGE mode (Filter for Structure, ruled 2026-11-14: "the structure input we
// have in the ratings … a small adaption, namely that you can make a range"):
// the SAME grid, tracks, colours and level policy as rating (two columns from
// 380pt, name + fill; a set track adds its range as numbers at the right end,
// ruled 2026-11-15), but each track holds a
// from–to range instead of one level. Drag (ruled 2026-11-15): a touch ON the
// coloured part grabs the end nearer the finger, which follows it (push in to
// shrink, pull out to extend; pulled past the other end, the range flips
// around that end); a touch elsewhere draws a new range from there. A tap
// sets that one step, a tap on a one-step range clears the track back to Any
// (so "tap twice" always clears). None is the far-left end, as in rating (no
// extra cell). Absent key = Any.
export type StructureRanges = Record<string, readonly [number, number]>;

// How far outside a range's fill (pt) a drag still grabs its nearer end: about
// a third of a step on a two-column track.
const GRAB_SLOP = 10;

// A range's fill as track fractions: step k covers (k−1)/5 … k/5, None the
// far-left sliver the clear policy gives it (so None – Light reaches the edge,
// Faint – Light starts just right of it), None alone the sliver only.
function rangeEdges([lo, hi]: readonly [number, number]): [number, number] {
  return [lo === 0 ? 0 : Math.max(FLAVOUR_CLEAR_FRACTION, (lo - 1) / FLAVOUR_MAX), Math.max(FLAVOUR_CLEAR_FRACTION, hi / FLAVOUR_MAX)];
}

type Props =
  | {
      // The wine style drives the axis set (sparkling adds Bubbles). null/unknown →
      // base wine set (resolveAxes is defensive).
      style: string | null | undefined;
      range?: false;
      // The current rating's flavour map — keys present are rated (0 = perceived
      // None but explicitly set). Absent keys are not rated.
      value: Record<string, number>;
      onChange: (next: Record<string, number>) => void;
    }
  | {
      style: string | null | undefined;
      range: true;
      value: StructureRanges;
      onChange: (next: StructureRanges) => void;
    };

export function StructureInput(props: Props) {
  const { style } = props;
  const phone = usePhoneTokens();
  const axisColor = useFlavourColors();
  const axes = resolveAxes('wine', style);
  // Two columns on a roomy phone, one on a narrow one (the design's 640px
  // grid break — phones below ~380pt read cramped with two 38px tracks).
  const twoCol = phone.width >= 380;
  const ranges = props.range ? props.value : null;
  const onRanges = props.range ? props.onChange : null;
  const value = props.range ? null : props.value;
  const onChange = props.range ? null : props.onChange;
  // Latest maps, updated SYNCHRONOUSLY on every edit — not just mirrored from
  // the prop. Two tracks edited in one JS batch (a two-finger drag: sibling
  // Pans share no pointer, so RNGH keeps both ACTIVE) must each build on the
  // other's write; spreading the render-captured value would make the second
  // onChange silently drop the first axis's edit.
  const rangesRef = useRef<StructureRanges>(ranges ?? {});
  if (ranges) rangesRef.current = ranges;
  const valueRef = useRef<Record<string, number>>(value ?? {});
  if (value) valueRef.current = value;

  const setRange = (key: string, next: readonly [number, number] | null) => {
    const prev = rangesRef.current[key];
    if (prev ? next && prev[0] === next[0] && prev[1] === next[1] : !next) return;
    const map = { ...rangesRef.current };
    if (next) map[key] = next;
    else delete map[key];
    rangesRef.current = map;
    Haptics.selectionAsync().catch(() => {});
    onRanges?.(map);
  };

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
    onChange?.(next);
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
          {ranges ? (
            <FillTrack
              axis={axis}
              color={axisColor(axis.k)}
              range={ranges[axis.k] ?? null}
              onRange={(r) => setRange(axis.k, r)}
            />
          ) : (
            <FillTrack
              axis={axis}
              color={axisColor(axis.k)}
              level={value?.[axis.k] ?? 0}
              onSet={(lvl) => setLevel(axis.k, lvl)}
            />
          )}
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
  level = 0,
  onSet,
  range,
  onRange,
}: {
  axis: StructureAxis;
  color: string;
  /** RATING mode: the level and its setter. */
  level?: number;
  onSet?: (level: number) => void;
  /** RANGE mode (with onRange): the track's from–to, null = Any. */
  range?: readonly [number, number] | null;
  onRange?: (next: readonly [number, number] | null) => void;
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
    if (next !== levelRef.current) onSet?.(next);
  };

  const commitHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  // Pan claims the gesture once movement is clearly horizontal; a clearly
  // vertical drag fails to the parent ScrollView. Mirrors ScoreInput. The fill
  // jumps in whole steps as the finger moves (stepped, not a smooth glide — the
  // smooth version felt off, Simon).
  // Range mode: the level under a point, by the same core policy.
  const rangeMode = !!onRange;
  const rangeRef = useRef(range ?? null);
  rangeRef.current = range ?? null;
  // The end that stays put while a drag runs; the other follows the finger.
  const anchorRef = useRef<number | null>(null);
  // Where the finger came down. Read in onBegin: at activation (onStart) the
  // finger is already ≥6pt on, and RNGH 3 ZEROES the pan's translation there
  // (iOS RNPanHandler setTranslation 0, Android activate → resetProgress), so
  // `e.x - e.translationX` is the activation point, not the touch-down.
  const downXRef = useRef<number | null>(null);
  const levelAt = (x: number) => (widthRef.current > 0 ? flavourLevelFromFraction(x / widthRef.current) : null);
  // A drag that came down at x0 (moving dx so far): on the coloured part (or
  // GRAB_SLOP outside it: a finger aimed at an edge lands either side) the
  // end NEARER the finger moves, so the anchor is the other end; a
  // dead-centre touch moves the end it heads for. Anywhere else a new range
  // starts at the finger.
  const anchorFor = (x0: number, dx: number) => {
    const v0 = levelAt(x0);
    const r = rangeRef.current;
    if (v0 === null || !r) return v0;
    const [l, h] = rangeEdges(r).map((f) => f * widthRef.current);
    if (x0 < l - GRAB_SLOP || x0 > h + GRAB_SLOP) return v0;
    const toLow = Math.abs(x0 - l);
    const toHigh = Math.abs(x0 - h);
    return (toHigh === toLow ? dx > 0 : toHigh < toLow) ? r[0] : r[1];
  };
  const dragRange = (x: number) => {
    const cur = levelAt(x);
    const anchor = anchorRef.current;
    if (cur === null || anchor === null || !onRange) return;
    const next = [Math.min(anchor, cur), Math.max(anchor, cur)] as const;
    const prev = rangeRef.current;
    if (!prev || prev[0] !== next[0] || prev[1] !== next[1]) onRange(next);
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-8, 8])
    .onBegin((e) => {
      downXRef.current = e.x;
    })
    .onStart((e) => {
      if (!rangeMode) return;
      const x0 = downXRef.current ?? e.x;
      anchorRef.current = anchorFor(x0, e.x - x0);
    })
    .onUpdate((e) => (rangeMode ? dragRange(e.x) : setFromX(e.x)))
    .onEnd(() => commitHaptic());
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e, success) => {
      if (!success) return;
      if (rangeMode) {
        const k = levelAt(e.x);
        if (k === null || !onRange) return;
        const prev = rangeRef.current;
        onRange(prev && prev[0] === k && prev[1] === k ? null : [k, k]);
      } else {
        setFromX(e.x);
      }
      commitHaptic();
    });
  const gesture = Gesture.Race(pan, tap);

  const pct = Math.max(0, Math.min(FLAVOUR_MAX, level)) / FLAVOUR_MAX;
  const [rangeLeft, rangeRight] = range ? rangeEdges(range) : [0, 0];
  const rangeText = range ? intensityRangeWord(range[0], range[1]) : 'Any';
  // THE RULED LOOK (Simon, 2026-07-11 gallery pass — supersedes the original
  // solid-fill + halo'd-ink .filltrack port, a sanctioned deviation from the
  // mock): the fill is the BADGE TINT — mix(colour, surface, 0.72), exactly
  // the structure wheel's wedge wash composited over surface — and the label
  // is plain theme.ink with NO halo. The tint ground is mild enough that ink
  // reads on it; the old halo existed for ink over the SOLID axis colour.
  // (History: a 'readable' coloured-words variant and the solid fill were
  // compared in the dev gallery and not picked.)
  const fillColor = mix(color, theme.surface, 0.72);
  const labelStyle = {
    fontFamily: 'InstrumentSans_600SemiBold' as const,
    ...phone.text('small'),
    color: theme.ink,
  };

  return (
    <View>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={rangeMode ? `${axis.l} range` : `${axis.l} intensity`}
          accessibilityValue={rangeMode ? { text: rangeText.replace(' – ', ' to ') } : { min: 0, max: FLAVOUR_MAX, now: level, text: intensityWord(level) }}
          // Range: swipe up / down moves the UPPER end (from Any up starts at
          // None); the lower end and Clear are named actions.
          accessibilityActions={rangeMode
            ? [{ name: 'increment' }, { name: 'decrement' }, { name: 'raiseLow', label: 'Raise Lower End' }, { name: 'lowerLow', label: 'Lower Lower End' }, { name: 'clear', label: 'Clear' }]
            : [{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const name = e.nativeEvent.actionName;
            if (rangeMode && onRange) {
              const r = rangeRef.current;
              if (name === 'clear') return onRange(null);
              if (name === 'increment') return onRange(r ? [r[0], Math.min(FLAVOUR_MAX, r[1] + 1)] : [0, 0]);
              if (!r) return;
              if (name === 'decrement') return onRange(r[1] > r[0] ? [r[0], r[1] - 1] : null);
              if (name === 'raiseLow') return onRange([Math.min(r[1], r[0] + 1), r[1]]);
              if (name === 'lowerLow') return onRange([Math.max(0, r[0] - 1), r[1]]);
              return;
            }
            const dir = name === 'increment' ? 1 : -1;
            onSet?.(Math.max(0, Math.min(FLAVOUR_MAX, levelRef.current + dir)));
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
              {/* right-pointing triangle; base at x=1 so the 2px round stroke's
                  left edge lands at 0 — flush against the track border (a 2px
                  inset left a visible gap, Simon's nit) */}
              <Path
                d="M1 2 L7 15 L1 28 Z"
                fill={color}
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </Svg>
          </View>
          {/* .fill — the axis colour's badge tint, width = level/5. Whole-step jumps (no width
              tween) — matches ScoreInput's plain-View fill; crisper per tap. A
              minWidth floor keeps a few px of colour showing at level 0 (a
              resting "this fills" cue); at level ≥1 the % already exceeds it, so
              the floor only affects the empty state. */}
          <View
            style={{
              position: 'absolute',
              left: rangeMode ? `${rangeLeft * 100}%` : 0,
              top: 0,
              bottom: 0,
              width: `${(rangeMode ? (range ? rangeRight - rangeLeft : 0) : pct) * 100}%`,
              backgroundColor: fillColor,
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
          {/* Range: the set range as the ⓘ scale's numbers at the right end
              ("1 – 3", one step "2"), an unset track stays plain (ruled
              2026-11-15: words don't fit two columns, "Sweetness" + "Strong –
              Intense" needs 165pt where a 393pt phone has 137). Plain ink,
              regular weight under the semibold name: it can sit on the fill
              (hi = 5) as well as on the sunk ground. */}
          {range ? (
            <VText
              surface="compactList"
              numberOfLines={1}
              style={{ marginLeft: 'auto', marginRight: LABEL_INSET, flexShrink: 0, ...phone.text('small'), color: theme.ink, fontVariant: ['tabular-nums'] }}
            >
              {range[0] === range[1] ? String(range[0]) : `${range[0]} – ${range[1]}`}
            </VText>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}
