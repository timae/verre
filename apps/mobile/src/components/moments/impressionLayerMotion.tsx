import * as Haptics from 'expo-haptics';
import { useMemo, type ReactNode } from 'react';
import { Gesture, State } from 'react-native-gesture-handler';
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { touchOnCanvas, type CanvasZone } from '@/components/scoring/aroma/canvasTouch';
import { springs } from '@/theme';

// The moment impression layer's motion (build 2, ADR-0011): COPIES of the
// opened post's container transform, reveal window and pull-down
// (app/(tabs)/feed/[id]/index.tsx: the ROW_* ramps ~:152-161, bgStyle /
// toneStyle / faceStyle / windowOuter / windowInner ~:688-731, contentStyle
// ~:785, RevealWindow ~:1218, DetailPage's pan ~:1686-1782). Ruled: "Don't
// touch the post. Copied hooks only"; moving the post onto these is a separate
// decision. What differs from the post, and why:
//   • the row geometry is SHARED VALUES (`rowOn`, `rowY`, `rowH`), not numbers
//     captured at mount: the layer opens from one row and closes into another
//     (paging), or into none (a search hides it: the fade). Still numbers only
//     in the worklets, never the row's face (a React element).
//   • the reveal window is ALWAYS mounted (identity transforms in fade mode):
//     the post renders it only for a row source, and switching it on mid-way
//     would remount every page under it.
//   • the pull-down's release goes to the layer (`onRelease`), which takes the
//     ONE transition guard and starts the close spring only once the edits are
//     stored (the post springs at once and unmounts on completion).
// ⚠️ Every worklet returns ONLY transform / opacity (the iOS sync-props
// allowlist, apps/mobile/CLAUDE.md); hit-testing stays React state.

// Finger travel that maps a pull-down to progress 1 → 0 (the post's).
export const DISMISS_DRAG = 340;
// The open spring's physical settle (reanimated duration springs settle ~1.5×).
export const OPEN_SETTLE_MS = springs.enter.duration * 1.5;
// The container transform's ramps over progress, the same both ways (the post's).
export const ROW_TONE_IN = 0.06;
export const ROW_FACE_OUT: [number, number] = [0.04, 0.3];
export const ROW_BG: [number, number] = [0.3, 0.8];

// A light tick the moment a pull-down will close on release (the post's).
export function closeHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export type LayerMotion = {
  // 0 = at the row (or faded out), 1 = fully open.
  progress: SharedValue<number>;
  // Running backward (a pull-down moving, a close): the fade's bg follows progress.
  dismissing: SharedValue<boolean>;
  // 1 = a row frame to grow from / fold into; 0 = the plain fade.
  rowOn: SharedValue<number>;
  rowY: SharedValue<number>;
  rowH: SharedValue<number>;
  // A close is running (a forced one included): a pull-down's cancel never
  // springs the layer back open under it.
  closing: SharedValue<boolean>;
};

// One stable object per layer (the pages' controls depend on it).
export function useLayerMotion(row: { y: number; height: number } | null): LayerMotion {
  const progress = useSharedValue(0);
  const dismissing = useSharedValue(false);
  const rowOn = useSharedValue(row ? 1 : 0);
  const rowY = useSharedValue(row?.y ?? 0);
  const rowH = useSharedValue(row?.height ?? 0);
  const closing = useSharedValue(false);
  return useMemo(() => ({ progress, dismissing, rowOn, rowY, rowH, closing }), [progress, dismissing, rowOn, rowY, rowH, closing]);
}

export function useLayerStyles(m: LayerMotion, windowH: number) {
  const { progress, dismissing, rowOn, rowY, rowH } = m;
  // Settle background: a row eases it in over the raised tone (ROW_BG); the
  // fade snaps it opaque on open and follows progress on the way out.
  const bgStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (rowOn.value) return { opacity: interpolate(p, ROW_BG, [0, 1], Extrapolation.CLAMP) };
    return { opacity: dismissing.value ? p : interpolate(p, [0, 0.12], [0, 1], Extrapolation.CLAMP) };
  });
  const toneStyle = useAnimatedStyle(() => ({
    opacity: rowOn.value ? interpolate(progress.value, [0, ROW_TONE_IN], [0, 1], Extrapolation.CLAMP) : 0,
  }));
  const faceStyle = useAnimatedStyle(() => {
    if (!rowOn.value) return { opacity: 0, transform: [{ translateY: 0 }] };
    const p = Math.min(1, Math.max(0, progress.value));
    return {
      opacity: interpolate(p, ROW_FACE_OUT, [1, 0], Extrapolation.CLAMP),
      transform: [{ translateY: rowY.value * (1 - p) - rowY.value }],
    };
  });
  // VERTICAL only (the post's ruling, 2026-11-13): full width throughout, the
  // band's top and bottom run from the row's to the screen's.
  const windowOuterStyle = useAnimatedStyle(() => {
    if (!rowOn.value) return { transform: [{ translateY: 0 }, { scaleY: 1 }] };
    const p = Math.min(1, Math.max(0, progress.value));
    const h = rowH.value + (windowH - rowH.value) * p;
    const y = rowY.value * (1 - p);
    return { transform: [{ translateY: y + h / 2 - windowH / 2 }, { scaleY: h / windowH }] };
  });
  const windowInnerStyle = useAnimatedStyle(() => {
    if (!rowOn.value) return { transform: [{ translateY: 0 }, { scaleY: 1 }] };
    const p = Math.min(1, Math.max(0, progress.value));
    const h = rowH.value + (windowH - rowH.value) * p;
    const y = rowY.value * (1 - p);
    const sy = h / windowH;
    return { transform: [{ translateY: (windowH / 2 - (y + h / 2)) / sy }, { scaleY: 1 / sy }] };
  });
  // The pages fade / rise in late and finish early (the post's ramps).
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 0.8], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0.35, 0.85], [36, 0], Extrapolation.CLAMP) }],
  }));
  return { bgStyle, toneStyle, faceStyle, windowOuterStyle, windowInnerStyle, contentStyle };
}

// The reveal window's clip: a screen-sized `overflow: hidden` view translated +
// Y-scaled onto the band, its content counter-transformed so only the clip
// moves. Always mounted; identity in fade mode and at rest.
export function RevealWindow({ width, height, outer, inner, children }: {
  width: number;
  height: number;
  outer: ReturnType<typeof useAnimatedStyle>;
  inner: ReturnType<typeof useAnimatedStyle>;
  children: ReactNode;
}) {
  return (
    <Reanimated.View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' }, outer]}>
      <Reanimated.View pointerEvents="box-none" style={[{ width, height }, inner]}>{children}</Reanimated.View>
    </Reanimated.View>
  );
}


// The pull-down close of ONE page (the post's DetailPage pan, its scroll
// wiring included): a native scroll gesture composed with the pan, eligible
// only when the touch went down at the scroll top, except a drag that starts on
// the aroma canvas's hex stage (`canvas`, components/scoring/aroma/canvasTouch.tsx),
// which stays the canvas's (Simon, 2026-11-25). The page's scroll view turns
// its top bounce off while at the top (`bounces={!atTop}`), so a pull-down at
// rest feeds this pan instead of a rubber band.
// The layer owns what happens: `onActivate` the moment the pan moves the layer
// (it blocks touches, displaces the page and, once the text capture is in,
// takes the transition guard and drains during the drag; refused → it sets
// `denied`), `onRelease(velocity)` past the commit line (the layer holds the
// position until the edits are stored, then closes; refused → it springs back),
// `onCancel` for a release short of it (the spring back runs here, then
// `onRestored`).
export function usePullDownClose({
  scrollY, enabled, motion, denied, canvas, onActivate, onRelease, onCancel, onRestored,
}: {
  scrollY: SharedValue<number>;
  enabled: boolean;
  motion: LayerMotion;
  denied: SharedValue<boolean>;
  canvas: CanvasZone;
  onActivate: () => void;
  onRelease: (velocity: number) => void;
  onCancel: () => void;
  onRestored: () => void;
}) {
  const { progress, dismissing, closing } = motion;
  // Declaration order is load-bearing: every value a worklet captures exists
  // before the builders run (the PillTabBar crash class).
  const armed = useSharedValue(false);
  const moving = useSharedValue(false);
  const buzzed = useSharedValue(false);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const native = Gesture.Native();
  // 🔒 MANUAL activation (Codex review 2026-11-26): a pull that may not close
  // (the touch went down on the hex stage, or the page isn't at its top) FAILS
  // before it activates, so it never claims the touch from the scroll view or
  // the canvas. Eligible: one finger, down at the scroll top, not on the stage;
  // it activates after 8 pt downward and fails on 8 pt upward or 16 pt
  // sideways first.
  const pan = Gesture.Pan()
    .manualActivation(true)
    .simultaneousWithExternalGesture(native)
    .enabled(enabled)
    .onTouchesDown((e, manager) => {
      if (e.state === State.ACTIVE) return; // a second finger on a running pull
      const t = e.changedTouches[0];
      if (e.numberOfTouches > 1 || !t) {
        manager.fail();
        return;
      }
      startX.value = t.absoluteX;
      startY.value = t.absoluteY;
      armed.value = scrollY.value <= 1 && !closing.value && !touchOnCanvas(canvas, t.absoluteY);
      if (!armed.value) manager.fail();
    })
    .onTouchesMove((e, manager) => {
      if (e.state !== State.BEGAN) return; // decided once, before activation
      const t = e.allTouches[0];
      if (!t || e.numberOfTouches > 1) {
        manager.fail();
        return;
      }
      const dx = t.absoluteX - startX.value;
      const dy = t.absoluteY - startY.value;
      if (!armed.value || closing.value || scrollY.value > 1 || dy < -8 || Math.abs(dx) > 16) {
        armed.value = false;
        manager.fail();
        return;
      }
      if (dy > 8) manager.activate();
    })
    .onBegin(() => {
      buzzed.value = false;
      moving.value = false;
      denied.value = false;
    })
    .onUpdate((e) => {
      if (!armed.value || denied.value || closing.value || scrollY.value > 1) return;
      if (!moving.value) {
        moving.value = true;
        runOnJS(onActivate)();
      }
      dismissing.value = true;
      progress.value = 1 - Math.min(1, Math.max(0, e.translationY) / DISMISS_DRAG);
      const inCommitZone = progress.value < 0.6;
      if (inCommitZone && !buzzed.value) {
        buzzed.value = true;
        runOnJS(closeHaptic)();
      } else if (!inCommitZone && buzzed.value) {
        buzzed.value = false;
      }
    })
    .onEnd((e, success) => {
      // A cancelled / stolen touch is onFinalize's (both fire; never two springs).
      if (!success || !moving.value || denied.value) return;
      moving.value = false;
      const close = progress.value < 0.6 || (e.velocityY > 900 && progress.value < 0.98);
      // Velocity in progress units, DIRECTION-GATED toward the target (a
      // clamped spring terminates on an away-velocity: a jump cut).
      const toward = -e.velocityY / DISMISS_DRAG;
      if (close) {
        if (!buzzed.value) runOnJS(closeHaptic)();
        runOnJS(onRelease)(Math.min(0, toward));
        return;
      }
      runOnJS(onCancel)();
      if (closing.value) return; // a forced close took over: never spring back open
      // `onRestored` on every end of the spring back (a cut one too): the
      // layer gives the pull's guard back only then, and a close that cut it
      // keeps its own.
      progress.value = withSpring(1, { ...springs.release, velocity: Math.max(0, toward) }, (finished) => {
        if (finished) dismissing.value = false;
        runOnJS(onRestored)();
      });
    })
    .onFinalize((_e, success) => {
      if (success || !moving.value || denied.value) return;
      moving.value = false;
      runOnJS(onCancel)();
      if (closing.value) return;
      progress.value = withSpring(1, springs.release, (finished) => {
        if (finished) dismissing.value = false;
        runOnJS(onRestored)();
      });
    });
  return { pan, native };
}
