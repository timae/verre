import * as Haptics from 'expo-haptics';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  runOnJS,
  runOnUI,
  scrollTo,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { VText } from '@/components/ui/VText';
import { elevation, radius, useTheme } from '@/theme';

// Long-press drag-to-reorder over NON-virtualized mapped rows — the line-up's
// two layouts both render rows inside a scroll container (plain converted to
// a ScrollView for this; hero always was one), so ONE implementation serves
// both. Hand-rolled: the reorder libraries either must own a FlatList
// (reorderable-list — the hero can't give it one) or can't be device-verified
// against reanimated 4 from the sandbox (sortables — the image-viewer lesson).
//
// Feel (Apple Reminders): hold ~400ms → medium haptic + the row LIFTS (scale,
// shadow, zIndex) and rides the finger; the OTHER rows flow apart around it
// (each sibling shifts by exactly the lifted row's height — the vacated gap
// shows the drop slot; selection tick per slot change); edge zones
// auto-scroll; release springs the row into the gap (light haptic) and THEN
// commits — the re-render in the new order has identical geometry, so the
// handoff is seamless.
//
// Mechanics are deliberately SCALAR-reactive: rows report {y, height} from
// onLayout; during a drag the only animated inputs are `activeIdx`, `target`
// (the insertion slot, a number) and `dragTrans`. Sibling shift is a pure
// function of (naturalIndex, activeIdx, target) — no array bookkeeping on the
// UI thread, nothing to fall out of sync.
//
// ⚠️ Worklet closure capture: every const a gesture/style worklet reads is
// declared BEFORE the builder that captures it (the PillTabBar crash class).

const HOLD_MS = 400;
const SPRING = { damping: 30, stiffness: 340, mass: 0.8 };
const LIFT_SCALE = 1.03;
// Auto-scroll: engage within this many points of the window edges, ramping to
// the max speed (pt/frame) at the very edge.
const EDGE_ZONE = 110;
const MAX_SPEED = 9;

type Props = {
  /** Row ids in their current (server/cache) order. */
  ids: string[];
  /** False = no drag. With `denied`, a hold still answers with a warning
   *  haptic + wiggle (host holding while a sort/search is active). */
  enabled: boolean;
  denied?: boolean;
  /** Fired on a denied hold — the host surfaces the why (toolbar flash). */
  onDenied?: () => void;
  /** Popup copy for a denied hold, shown AT the held row. */
  deniedNote?: string;
  renderRow: (id: string, renderIndex: number) => React.ReactNode;
  onCommit: (orderedIds: string[]) => void;
  /** The hosting scroll container (auto-scroll target) + its live offset. */
  scrollRef: AnimatedRef<Reanimated.ScrollView>;
  scrollY: SharedValue<number>;
  /** Max scrollable offset (contentH − viewportH), mirrored by the host. */
  maxScrollY: SharedValue<number>;
};

const warnHaptic = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
// Dev-only: a refused lift must say WHY (which rows have no measured height).
const debugRefusal = (heights: (number | undefined)[], count: number) => {
  if (!__DEV__) return;
  Alert.alert('reorder refused (dev)', `measured heights (${count} rows): ${JSON.stringify(heights)}`);
};
const liftHaptic = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
const slotHaptic = () => Haptics.selectionAsync().catch(() => {});
const dropHaptic = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

// Move ids[from] to position `to` (plain JS, called on commit).
function moved(ids: string[], from: number, to: number): string[] {
  const out = ids.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

export function DraggableRows({ ids, enabled, denied, onDenied, deniedNote, renderRow, onCommit, scrollRef, scrollY, maxScrollY }: Props) {
  const { height: windowH } = useWindowDimensions();
  // Render GENERATION — the cross-thread seam closer. Every ids change bumps
  // it (computed during render); each row's style worklet captures the
  // generation it was rendered under and returns identity transforms when it
  // doesn't match the UI-side genSV. So the instant the reordered tree
  // renders, every stale shift/lift is inert IN THAT SAME FABRIC COMMIT —
  // no old-transform frame, no sibling springs replaying over the new
  // layout (the "two rows drift apart and back" glitch). The layout effect
  // then syncs genSV + resets the drag scalars on the UI thread.
  const idsKey = ids.join('|');
  const genRef = useRef({ key: idsKey, gen: 0 });
  if (genRef.current.key !== idsKey) genRef.current = { key: idsKey, gen: genRef.current.gen + 1 };
  const gen = genRef.current.gen;
  // Container-relative row geometry, written from each row's onLayout. Two
  // parallel scalar-array SVs (read-only in worklets — only JS writes them).
  const tops = useSharedValue<number[]>([]);
  const rowHs = useSharedValue<number[]>([]);
  const activeIdx = useSharedValue(-1);
  // Insertion slot the drag currently points at (equals activeIdx at rest).
  const target = useSharedValue(-1);
  const dragTrans = useSharedValue(0); // finger translation + auto-scroll delta
  const startScrollY = useSharedValue(0);
  const absY = useSharedValue(0); // finger absolute Y (auto-scroll zones)
  const dragging = useSharedValue(false);

  const genSV = useSharedValue(0);
  // Sync the UI-side generation + reset the drag scalars BEFORE paint on any
  // row-set change (commit re-render, poll reorder). runOnUI: these must land
  // on the thread the styles read (the JS-write propagation lesson).
  useLayoutEffect(() => {
    runOnUI((g: number) => {
      'worklet';
      genSV.value = g;
      activeIdx.value = -1;
      target.value = -1;
      dragTrans.value = 0;
      dragging.value = false;
    })(gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen]);

  // Slot-change tick (scalar reaction — fires once per target change).
  useAnimatedReaction(
    () => target.value,
    (t, prev) => {
      if (t !== -1 && prev !== null && prev !== -1 && t !== prev) runOnJS(slotHaptic)();
    },
  );

  // Auto-scroll loop — only does work mid-drag. scrollTo() moves the
  // container; the scroll delta feeds back into the drag position because
  // onUpdate recomputes dragTrans from (scrollY − startScrollY).
  useFrameCallback(() => {
    if (!dragging.value) return;
    const y = absY.value;
    let speed = 0;
    if (y < EDGE_ZONE) speed = -MAX_SPEED * Math.min(1, (EDGE_ZONE - y) / EDGE_ZONE);
    else if (y > windowH - EDGE_ZONE) speed = MAX_SPEED * Math.min(1, (y - (windowH - EDGE_ZONE)) / EDGE_ZONE);
    if (speed === 0) return;
    const next = Math.max(0, Math.min(maxScrollY.value, scrollY.value + speed));
    if (next !== scrollY.value) scrollTo(scrollRef, 0, next, false);
  });

  return (
    <View>
      {ids.map((id, i) => (
        <DragRow
          key={id}
          index={i}
          count={ids.length}
          ids={ids}
          gen={gen}
          genSV={genSV}
          enabled={enabled}
          denied={!!denied}
          onDenied={onDenied}
          deniedNote={deniedNote}
          tops={tops}
          rowHs={rowHs}
          activeIdx={activeIdx}
          target={target}
          dragTrans={dragTrans}
          startScrollY={startScrollY}
          absY={absY}
          dragging={dragging}
          scrollY={scrollY}
          onCommit={onCommit}
        >
          {renderRow(id, i)}
        </DragRow>
      ))}
    </View>
  );
}

const DragRow = memo(function DragRow({
  index, count, ids, gen, genSV, enabled, denied, onDenied, deniedNote, tops, rowHs, activeIdx, target, dragTrans, startScrollY, absY, dragging, scrollY, onCommit, children,
}: {
  index: number;
  count: number;
  ids: string[];
  gen: number;
  genSV: SharedValue<number>;
  enabled: boolean;
  denied: boolean;
  onDenied?: () => void;
  deniedNote?: string;
  tops: SharedValue<number[]>;
  rowHs: SharedValue<number[]>;
  activeIdx: SharedValue<number>;
  target: SharedValue<number>;
  dragTrans: SharedValue<number>;
  startScrollY: SharedValue<number>;
  absY: SharedValue<number>;
  dragging: SharedValue<boolean>;
  scrollY: SharedValue<number>;
  onCommit: (orderedIds: string[]) => void;
  children: React.ReactNode;
}) {
  // Denied-hold wiggle (per-row, horizontal) + the explainer popup shown AT
  // this row (Simon: the hint belongs on the item you tried to move).
  const shakeX = useSharedValue(0);
  const { theme } = useTheme();
  const [hintShown, setHintShown] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);
  const showHintJS = () => {
    setHintShown(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHintShown(false), 2400);
  };

  const commitMove = (from: number, to: number) => {
    if (from !== to) onCommit(moved(ids, from, to));
  };

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activateAfterLongPress(HOLD_MS)
    .onStart(() => {
      // Fail-safe: geometry must be fully measured or the slot math would
      // degenerate to the extremes ("lands somewhere random"). Refuse the
      // lift instead — visibly inert beats silently wrong.
      const h = rowHs.value;
      let ok = true;
      for (let j = 0; j < count; j++) {
        if (!((h[j] ?? 0) > 0)) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        runOnJS(warnHaptic)();
        runOnJS(debugRefusal)(h, count);
        return;
      }
      activeIdx.value = index;
      target.value = index;
      dragging.value = true;
      dragTrans.value = 0;
      startScrollY.value = scrollY.value;
      runOnJS(liftHaptic)();
    })
    .onUpdate((e) => {
      if (!dragging.value) return;
      absY.value = e.absoluteY;
      dragTrans.value = e.translationY + (scrollY.value - startScrollY.value);
      // Insertion slot = how many OTHER rows' natural midpoints sit above the
      // dragged row's current center. Natural geometry (onLayout) is stable
      // for the whole drag — siblings only ever TRANSLATE.
      const t = tops.value;
      const h = rowHs.value;
      const center = (t[index] ?? 0) + (h[index] ?? 0) / 2 + dragTrans.value;
      let slot = 0;
      for (let j = 0; j < count; j++) {
        if (j === index) continue;
        const mid = (t[j] ?? 0) + (h[j] ?? 0) / 2;
        if (mid < center) slot += 1;
      }
      if (slot !== target.value) target.value = slot;
    })
    .onEnd(() => {
      if (!dragging.value) return;
      // Spring the lifted row into the gap, then hand off to React: the
      // commit re-renders rows in the new order with identical geometry.
      const from = index;
      const to = target.value;
      const t = tops.value;
      const h = rowHs.value;
      // Final top of the active row in the CURRENT (pre-commit) geometry:
      // moving down → it lands at the bottom edge of the row now at `to`
      // minus its own height's worth of shift; moving up → at that row's top.
      let settle = 0;
      if (to > from) settle = (t[to] ?? 0) + (h[to] ?? 0) - (h[from] ?? 0) - (t[from] ?? 0);
      else if (to < from) settle = (t[to] ?? 0) - (t[from] ?? 0);
      dragging.value = false;
      runOnJS(dropHaptic)();
      // Softer + clamped: the set-down glides into the gap without bouncing
      // into the neighbours.
      dragTrans.value = withSpring(settle, { damping: 32, stiffness: 260, mass: 0.9, overshootClamping: true }, (done) => {
        if (!done) return;
        if (from === to) {
          // No reorder → no re-render coming: reset here (UI thread; shifts
          // are already 0 when the row went home).
          activeIdx.value = -1;
          target.value = -1;
          dragTrans.value = 0;
          return;
        }
        // Moved: leave every transform FROZEN at the dropped visual state.
        // The commit re-renders under a NEW generation — the style worklets'
        // generation check zeroes all transforms in the same Fabric commit
        // as the new layout, and the layout effect then syncs the scalars.
        runOnJS(commitMove)(from, to);
      });
    })
    .onFinalize(() => {
      // Cancelled (not via onEnd): snap everything home.
      if (dragging.value && activeIdx.value === index) {
        dragging.value = false;
        target.value = index;
        dragTrans.value = withSpring(0, SPRING, (done) => {
          if (done) activeIdx.value = -1;
        });
      }
    });

  // Hold answered with "not here" while a sort/search narrows the list:
  // error haptic + the iOS "nope" wiggle (the haptic alone went unnoticed).
  const deniedHold = Gesture.LongPress()
    .enabled(!enabled && denied)
    .minDuration(HOLD_MS)
    .onStart(() => {
      shakeX.value = withSequence(
        withTiming(7, { duration: 45 }),
        withTiming(-6, { duration: 45 }),
        withTiming(4, { duration: 40 }),
        withTiming(-2, { duration: 40 }),
        withTiming(0, { duration: 35 }),
      );
      runOnJS(warnHaptic)();
      runOnJS(showHintJS)();
      if (onDenied) runOnJS(onDenied)();
    });

  const style = useAnimatedStyle(() => {
    // Stale-generation transforms are inert THE FRAME the new order renders
    // (this worklet re-captures `gen` per render; genSV lags until the
    // layout effect) — the seam between UI-thread drag state and the React
    // re-render can never paint.
    if (genSV.value !== gen) {
      return { zIndex: 0, elevation: 0, transform: [{ translateY: 0 }, { translateX: 0 }, { scale: 1 }], shadowOpacity: 0 };
    }
    const a = activeIdx.value;
    if (a === index) {
      return {
        zIndex: 10,
        elevation: 8,
        transform: [{ translateY: dragTrans.value }, { translateX: shakeX.value }, { scale: withTiming(dragging.value ? LIFT_SCALE : 1, { duration: 140 }) }],
        shadowOpacity: withTiming(dragging.value ? 0.18 : 0, { duration: 140 }),
      };
    }
    // Sibling shift — a pure function of (my index, active, target): rows
    // between the lift origin and the insertion slot step one place toward
    // the origin, by exactly the lifted row's height (the vacated gap).
    let shift = 0;
    if (a !== -1) {
      const tg = target.value;
      const activeH = rowHs.value[a] ?? 0;
      if (index > a && index <= tg) shift = -activeH;
      else if (index < a && index >= tg) shift = activeH;
    }
    return {
      zIndex: 0,
      elevation: 0,
      transform: [{ translateY: withSpring(shift, SPRING) }, { translateX: shakeX.value }, { scale: 1 }],
      shadowOpacity: 0,
    };
  });

  return (
    <GestureDetector gesture={Gesture.Race(pan, deniedHold)}>
      <Reanimated.View
        onLayout={(e) => {
          // Container-relative natural geometry (y INCLUDES the in-row
          // separator, so gaps stay exact). Written ON the UI thread
          // (runOnUI): the worklets read the UI-side copy, and mutating
          // array SVs from JS relies on an async propagation hop that
          // proved unreliable here (device: siblings frozen / drags
          // refused because the UI copy stayed empty).
          const { y, height } = e.nativeEvent.layout;
          runOnUI((i: number, top: number, h: number) => {
            'worklet';
            const t = tops.value.slice();
            const hs = rowHs.value.slice();
            t[i] = top;
            hs[i] = h;
            tops.value = t;
            rowHs.value = hs;
          })(index, y, height);
        }}
        style={[
          // Lift shadow (iOS); Android uses the animated elevation.
          { shadowColor: '#000', shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
          style,
        ]}
      >
        {children}
        {hintShown && deniedNote ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: -14, left: 0, right: 0, alignItems: 'center', zIndex: 30 }}>
            <Reanimated.View
              entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(180).reduceMotion(ReduceMotion.System)}
              accessibilityLiveRegion="polite"
              style={{
                backgroundColor: theme.surface,
                borderWidth: 1,
                borderColor: theme.accentLine,
                borderRadius: radius.md,
                paddingHorizontal: 12,
                paddingVertical: 7,
                shadowColor: '#000',
                shadowOpacity: elevation.menu.ios.shadowOpacity,
                shadowRadius: elevation.menu.ios.shadowRadius,
                shadowOffset: { width: 0, height: elevation.menu.ios.shadowOffsetY },
                elevation: elevation.menu.android.elevation,
              }}
            >
              <VText variant="caption" color="ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {deniedNote}
              </VText>
            </Reanimated.View>
          </View>
        ) : null}
      </Reanimated.View>
    </GestureDetector>
  );
});
