import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { G, Polygon, Text as SvgText, TSpan } from 'react-native-svg';
import { Directions, Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDecay, withTiming } from 'react-native-reanimated';
import { motion, useTheme } from '@/theme';
import { mix, inkOn } from '@/theme/color';
import { clampAxis, hexPoints, wrapLabel } from './hexMath';

// Shared honeycomb engine for the Map (H3) and Canvas (H2) browse pickers
// (ADR-0008; mock: the honeyStage/mapInner machinery in vero-aroma-input.js,
// visual reference only — flat family-tinted fills instead of the mock's
// gradients, per the tone-not-borders house style). Pure axial-hex lattice
// math (hexMath.ts) + one pannable SVG stage: cells are flat-top hexagons
// with wrapped centred labels. Panning rides a clamped UI-thread translate
// (the mock's panClamp); taps land on the cells' own SVG press handlers — an
// activated pan cancels them, so drag never mis-fires a tap.

export type HexCell = {
  id: string;
  label: string;
  /** Fill colour (already shaded — the stage renders it flat). */
  color: string;
  x: number;
  y: number;
  /** The ARMED pick — rendered like the search's focused result: full
      colour + a slight grow while everything else mutes. */
  pending?: boolean;
  /** Faded while another cell is pending (the search-focus treatment). */
  muted?: boolean;
  /** Pending-Pronounced — the chips' ink border, on the cell. */
  pronounced?: boolean;
};

const EASE = Easing.bezier(...motion.ease);
/** Breathing room the stage keeps around the content bbox (pan clamp +
    sizing) — exported so an owner sizing its stage to content (Canvas)
    matches the clamp math exactly. */
export const STAGE_PAD = 14;
const PAD = STAGE_PAD;

// Pinch thresholds: past these mid-gesture, the stage asks its owner to step
// a level (the Map's pinch-between-levels, Simon's device ask). Raised from
// 1.35/0.75 — the early commit read as "too fast / jumpy" (device round).
const PINCH_IN = 1.6;
const PINCH_OUT = 0.6;

export function HexStage({
  cells,
  R,
  stageH,
  center,
  onCell,
  resetKey,
  capFirst,
  onPinchLevel,
  canZoomIn,
  canZoomOut,
  enterFrom,
  onSwipeBack,
}: {
  cells: HexCell[];
  /** Hex circumradius in stage points. */
  R: number;
  stageH: number;
  /** Content point to centre in the stage (the focused cluster's centroid). */
  center: { x: number; y: number };
  onCell: (id: string) => void;
  /** Changing this resets the pan offset + replays the zoom-in transition. */
  resetKey: string;
  capFirst: (s: string) => string;
  /**
   * Enables pinch-between-levels: called the moment the LIVE pinch crosses
   * the threshold (not on release — device round 2 wanted the transition
   * fluid) with the direction (+1 in / −1 out) and the focal point in
   * CONTENT coordinates (the owner picks the nearest cluster to focus). One
   * continuous pinch can step multiple levels — the scale re-bases on each
   * commit.
   */
  onPinchLevel?: (dir: 1 | -1, contentX: number, contentY: number) => void;
  /** Whether a pinch in/out can currently step a level (level bounds). */
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  /** Scale the settle-in starts from: <1 reads as diving in (default),
      >1 as pulling back out — the owner picks per travel direction. */
  enterFrom?: number;
  /** A fast RIGHT swipe pops one level (Simon 2026-07-17 — the inline
      canvas's back gesture). Races the pan exclusively: a flick goes back,
      a slower drag still pans an overflowing cluster. */
  onSwipeBack?: () => void;
}) {
  const { theme } = useTheme();
  const [stageW, setStageW] = useState(0);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const dx0 = useSharedValue(0);
  const dy0 = useSharedValue(0);
  const zoom = useSharedValue(1);
  const fade = useSharedValue(1);
  // Live pinch scale (relative to the last level commit) + focal point
  // (stage coords) + the re-base divisor for multi-level pinches.
  const pinchS = useSharedValue(1);
  const pinchBase = useSharedValue(1);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  // New level/path: pan home + a settle-in from the travel direction plus a
  // quick fade (the smoother hexZoom dive, device round 2); a mid-pinch
  // level commit hands its residual scale straight to this settle.
  useEffect(() => {
    dx.value = 0;
    dy.value = 0;
    pinchS.value = 1;
    zoom.value = enterFrom ?? 0.86;
    // dur2/dur1 (was dur3/dur2): the longer settle read as the cluster
    // "aligning too slow in the middle" on the inline canvas (Simon
    // 2026-07-17).
    zoom.value = withTiming(1, { duration: motion.dur2, easing: EASE });
    fade.value = 0.35;
    fade.value = withTiming(1, { duration: motion.dur1, easing: EASE });
  }, [resetKey, enterFrom, dx, dy, zoom, fade, pinchS]);

  // Content bbox (cell extents + R), the pan-clamp bounds.
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const minX = Math.min(...xs) - R;
  const maxX = Math.max(...xs) + R;
  const minY = Math.min(...ys) - R;
  const maxY = Math.max(...ys) + R;
  const tx0 = stageW / 2 - center.x;
  const ty0 = stageH / 2 - center.y;
  // Whether the content actually outgrows the stage per axis — gates the pan
  // gesture (a pan that can't move anything must not claim drags from the
  // sheet's scroll/dismiss, review finding).
  const overX = maxX - minX + PAD * 2 > stageW;
  const overY = maxY - minY + PAD * 2 > stageH;

  // Centering is STATIC layout, never animated state (Simon 2026-07-17: a
  // freshly drilled cluster rendered offset+clipped and only centred ~0.5-1s
  // later — the animated transform's re-application after a commit can lag
  // under the global sync-props flag; static left/top renders centred in the
  // SAME commit). The worklet below carries only the pan DELTA, and the
  // wrapper remounts per level (key=resetKey) so a stale transform from the
  // previous level can never linger.
  const baseTx = clampAxis(tx0, stageW - PAD - maxX, PAD - minX);
  const baseTy = clampAxis(ty0, stageH - PAD - maxY, PAD - minY);
  const panStyle = useAnimatedStyle(() => {
    const tx = clampAxis(baseTx + dx.value, stageW - PAD - maxX, PAD - minX);
    const ty = clampAxis(baseTy + dy.value, stageH - PAD - maxY, PAD - minY);
    return { transform: [{ translateX: tx - baseTx }, { translateY: ty - baseTy }] };
  }, [baseTx, baseTy, stageW, stageH, minX, maxX, minY, maxY]);
  // The settle zoom scales around the STAGE centre (a stage-sized wrapper
  // scales about its own middle — where the focused cluster just landed); a
  // live pinch scales around its focal point via the translate-compensation
  // identity T = (F − C)(1 − s).
  const zoomStyle = useAnimatedStyle(() => {
    const s = zoom.value * pinchS.value;
    const cx = stageW / 2;
    const cy = stageH / 2;
    const tx = (focalX.value - cx) * (1 - pinchS.value);
    const ty = (focalY.value - cy) * (1 - pinchS.value);
    return { opacity: fade.value, transform: [{ translateX: tx }, { translateY: ty }, { scale: s }] };
  }, [stageW, stageH]);

  const pan = Gesture.Pan()
    .enabled(overX || overY)
    .minDistance(6)
    .onBegin(() => {
      dx0.value = dx.value;
      dy0.value = dy.value;
    })
    .onUpdate((e) => {
      // Store the CLAMPED offset, not the raw one — an over-pan past the
      // bounds must not accumulate into a dead zone the next drag has to
      // consume before the map moves again (review finding #3).
      const tx = clampAxis(baseTx + dx0.value + e.translationX, stageW - PAD - maxX, PAD - minX);
      const ty = clampAxis(baseTy + dy0.value + e.translationY, stageH - PAD - maxY, PAD - minY);
      dx.value = tx - baseTx;
      dy.value = ty - baseTy;
    })
    .onEnd((e) => {
      // Momentum with a clamped rubber-band, so a flick glides instead of
      // stopping dead (device round 4: panning felt unnatural without it).
      const loX = stageW - PAD - maxX - baseTx;
      const hiX = PAD - minX - baseTx;
      const loY = stageH - PAD - maxY - baseTy;
      const hiY = PAD - minY - baseTy;
      dx.value = withDecay({ velocity: e.velocityX, clamp: [Math.min(loX, hiX), Math.max(loX, hiX)], rubberBandEffect: true });
      dy.value = withDecay({ velocity: e.velocityY, clamp: [Math.min(loY, hiY), Math.max(loY, hiY)], rubberBandEffect: true });
    });

  const emitPinch = (dir: 1 | -1, sx: number, sy: number) => {
    if (!onPinchLevel) return;
    // Stage → content coordinates: undo the pan translate via the SAME
    // clampAxis the render path applies — a min/max reimplementation here
    // returned an edge where the render centres narrower-than-stage content,
    // so the focal landed on the wrong cluster on wide screens (review
    // finding). The focal point itself is scale-invariant (it's the fixed
    // point of the live pinch transform), so undoing the pan is the whole
    // conversion.
    const tx = clampAxis(baseTx + dx.value, stageW - PAD - maxX, PAD - minX);
    const ty = clampAxis(baseTy + dy.value, stageH - PAD - maxY, PAD - minY);
    onPinchLevel(dir, sx - tx, sy - ty);
  };
  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      pinchBase.value = 1;
      focalX.value = e.focalX;
      focalY.value = e.focalY;
    })
    .onUpdate((e) => {
      focalX.value = e.focalX;
      focalY.value = e.focalY;
      // Commit the level change the moment the LIVE scale crosses the
      // threshold; re-base so the same pinch can keep travelling levels.
      const eff = e.scale / pinchBase.value;
      if (eff >= PINCH_IN && canZoomIn) {
        pinchBase.value = e.scale;
        pinchS.value = 1;
        runOnJS(emitPinch)(1, e.focalX, e.focalY);
        return;
      }
      if (eff <= PINCH_OUT && canZoomOut) {
        pinchBase.value = e.scale;
        pinchS.value = 1;
        runOnJS(emitPinch)(-1, e.focalX, e.focalY);
        return;
      }
      pinchS.value = eff;
    })
    .onEnd(() => {
      // Rubber-band home whatever sub-threshold scale is left.
      pinchS.value = withTiming(1, { duration: motion.dur2, easing: EASE });
    });
  const base = onPinchLevel ? Gesture.Simultaneous(pan, pinch) : pan;
  // Back-swipe (owner-gated): EXCLUSIVE with the pan — the fling claims a
  // fast rightward flick before the pan can, everything slower falls through
  // to panning. runOnJS: fling callbacks land on the UI thread.
  const backFling = Gesture.Fling()
    .direction(Directions.RIGHT)
    .enabled(!!onSwipeBack)
    .onEnd(() => {
      if (onSwipeBack) runOnJS(onSwipeBack)();
    });
  const gesture = onSwipeBack ? Gesture.Exclusive(backFling, base) : base;

  const bw = maxX - minX + PAD * 2;
  const bh = maxY - minY + PAD * 2;
  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={(e) => setStageW(e.nativeEvent.layout.width)}
        collapsable={false}
        style={{ width: '100%', height: stageH, overflow: 'hidden' }}
      >
        {stageW > 0 ? (
          <Reanimated.View key={resetKey} style={[{ position: 'absolute', left: 0, top: 0, right: 0, height: stageH }, zoomStyle]}>
            <Reanimated.View style={[{ position: 'absolute', left: baseTx, top: baseTy, width: bw, height: bh }, panStyle]}>
              <Svg
              width={bw}
              height={bh}
              viewBox={`${minX - PAD} ${minY - PAD} ${bw} ${bh}`}
              style={{ position: 'absolute', left: minX - PAD, top: minY - PAD }}
            >
              {[...cells].sort((a, b) => Number(!!a.pending) - Number(!!b.pending)).map((c) => {
                // (Pending cell sorts LAST so its 1.04 grow paints over the
                // neighbours — SVG stacking is document order.)
                // The search-focus treatment (device round 2): the armed
                // cell keeps full colour and grows a touch; everything else
                // recedes to a soft tint while a pick is armed.
                const fill = c.muted ? mix(c.color, theme.surface, 0.35) : c.color;
                // Ink picked by contrast against the ACTUAL fill — muted
                // cells keep readable labels (device round 5: a family-
                // tinted ink washed out on the muted pastel and neighbours
                // read as blank).
                const labelInk = inkOn(fill, theme.ink, theme.bg);
                const name = capFirst(c.label);
                const longest = Math.max(...name.split(' ').map((w) => w.length));
                const fs = longest > 9 ? 11 : name.length > 9 ? 12 : name.length > 7 ? 13 : name.length > 5 ? 13.5 : 15;
                const lines = wrapLabel(name, Math.max(4, Math.floor((R * 1.5) / (fs * 0.55))));
                const lineH = fs * 1.08;
                const y0 = c.y - ((lines.length - 1) / 2) * lineH;
                return (
                  <G
                    key={c.id}
                    onPress={() => onCell(c.id)}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={`${name}${c.pronounced ? ', pronounced' : ''}`}
                    accessibilityState={{ selected: !!c.pending }}
                  >
                    <Polygon
                      points={hexPoints(c.x, c.y, R, c.pending ? 1.04 : 0.972)}
                      fill={fill}
                      // Pending-Pronounced border. The cell fill is the SOLID
                      // family colour, so — like the chips' armed/solid case —
                      // the border takes the contrast-picked label ink
                      // (inkOn), NOT a family-tinted stroke: the old fixed
                      // mix(color, ink, 0.7) measured down to 1.06:1 on
                      // apricot/mauve and gave no visible arm feedback (review
                      // finding; the comment's "tintedInk" was deleted from the
                      // chips in the badge-anatomy pass).
                      stroke={c.pronounced ? labelInk : 'none'}
                      strokeWidth={c.pronounced ? 2.5 : 0}
                    />
                    <SvgText
                      x={c.x}
                      y={y0}
                      fill={labelInk}
                      fontSize={fs}
                      fontFamily="InstrumentSans_600SemiBold"
                      textAnchor="middle"
                      alignmentBaseline="central"
                    >
                      {lines.map((ln, i) => (
                        <TSpan key={i} x={c.x} dy={i === 0 ? 0 : lineH}>
                          {ln}
                        </TSpan>
                      ))}
                    </SvgText>
                  </G>
                );
              })}
              </Svg>
            </Reanimated.View>
          </Reanimated.View>
        ) : null}
      </View>
    </GestureDetector>
  );
}
