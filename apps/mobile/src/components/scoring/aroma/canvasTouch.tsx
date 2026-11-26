import { createContext, useContext, useEffect, useMemo, type ReactElement } from 'react';
import Reanimated, { measure, useAnimatedRef, useSharedValue, type AnimatedRef, type SharedValue } from 'react-native-reanimated';

// "A drag that starts on the aroma canvas stays the canvas's" (Simon,
// 2026-11-25, the moment impression layer's pull-down, ADR-0011). The page
// provides a zone; this wrapper (around the HEX STAGE only, CanvasPicker: the
// crumbs and the refine row stay pull-eligible) hands the page the stage's
// view, and the page's pull-down FAILS at touch-down when the touch is on it
// (components/moments/impressionLayerMotion.tsx `usePullDownClose`). Decided
// by POSITION on the UI thread at touch-down (Codex review 2026-11-26): a
// marker gesture's own touch events race the canvas's pan, which cancels it.
// Vertical only: the stage spans the page's width, and a horizontal transform
// (the pager row) never moves it on the page. Without a provider (the check-in
// rate stage, Filter for Aromas) it renders its child as it is.
export type CanvasZone = { ref: AnimatedRef<Reanimated.View>; on: SharedValue<boolean> };
export const CanvasTouchContext = createContext<CanvasZone | null>(null);

export function useCanvasZone(): CanvasZone {
  const ref = useAnimatedRef<Reanimated.View>();
  const on = useSharedValue(false);
  return useMemo(() => ({ ref, on }), [ref, on]);
}

// Whether a touch at this window Y lands on the zone's stage (UI thread).
export function touchOnCanvas(zone: CanvasZone, absoluteY: number): boolean {
  'worklet';
  if (!zone.on.value) return false;
  const m = measure(zone.ref);
  return !!m && absoluteY >= m.pageY && absoluteY <= m.pageY + m.height;
}

export function CanvasTouchZone({ children }: { children: ReactElement }) {
  const zone = useContext(CanvasTouchContext);
  if (!zone) return children;
  return <Marked zone={zone}>{children}</Marked>;
}

function Marked({ zone, children }: { zone: CanvasZone; children: ReactElement }) {
  // `on` gates the measure (a measure of an unmounted view only warns).
  useEffect(() => {
    zone.on.value = true;
    return () => {
      zone.on.value = false;
    };
  }, [zone]);
  return (
    <Reanimated.View ref={zone.ref} collapsable={false}>
      {children}
    </Reanimated.View>
  );
}
