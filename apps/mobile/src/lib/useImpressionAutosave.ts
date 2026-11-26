// Rating auto-save for ONE impression page (tasting-feedback build 1 § 1, the
// hook contract). A thin React wrapper over the pure controller
// (lib/impressionAutosaveCore.ts) and the outbox owner (lib/rateOutbox.ts):
// no router or route params inside, so build 2 (the impression layer) mounts
// one per pager page.
//
// in:  code, wineId, the wine's kind (structure axes), `active` (build 1:
//      always true; build 2: the pager's active page), `focused` (navigation
//      focus, for the after-leave alert's VISIBLE rule), the screen's
//      transition guard (edits wait while it is held), the alert label.
//      The snapshot and `baselineReady` come from the owner, never the screen.
// out: the draft + its setters, drain(), clearRating() + clearPending,
//      discardPending(), savedState, error.

import type { AromaSelection, AxisKind } from '@verre/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createAutosaveController, EMPTY_DRAFT, type AutosaveController, type ClearToken, type SavedState, type TransitionGuard } from './impressionAutosaveCore';
import { useMeId } from './meId';
import { rateOutbox, useRateOutboxVersion } from './rateOutbox';

let mountSeq = 0;
const noopSubscribe = () => () => {};
const zero = () => 0;
const TIMERS = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export type ImpressionAutosave = {
  draft: { score: number; notes: string; flavors: Record<string, number>; aromas: AromaSelection[] };
  setScore: (v: number) => void;
  stepScore: (v: number) => void;
  setNotes: (v: string) => void;
  setNoteFocused: (focused: boolean) => void;
  setFlavors: (v: Record<string, number>) => void;
  setAromas: (v: ImpressionAutosave['draft']['aromas']) => void;
  drain: () => Promise<boolean>;
  // Take the token when the Clear confirm OPENS; pass it to clearRating on Delete.
  clearBaseline: () => ClearToken | null;
  clearRating: (token?: ClearToken | null) => Promise<boolean>;
  clearPending: boolean;
  discardPending: () => void;
  savedState: SavedState;
  error: string | null;
  baselineReady: boolean;
  editable: boolean;
  // The stale-Clear "ask again" for this page (consumed once).
  takeClearAsk: () => boolean;
};

const noop = () => {};
const resolvedFalse = () => Promise.resolve(false);

export function useImpressionAutosave({
  code, wineId, kind, active = true, focused = true, guard, label,
}: {
  code: string;
  wineId: string;
  kind: AxisKind;
  active?: boolean;
  focused?: boolean;
  guard?: TransitionGuard;
  label?: string | null;
}): ImpressionAutosave {
  const viewer = useMeId();
  const ctrl: AutosaveController | null = useMemo(
    () => (viewer && code && wineId ? createAutosaveController(rateOutbox, { viewer, code, wineId, kind, timers: TIMERS }) : null),
    // `kind` is pushed in below (it can arrive after the first render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, code, wineId],
  );
  ctrl?.setKind(kind);
  ctrl?.setSuspended(() => guard?.held ?? false);
  useRateOutboxVersion();
  useSyncExternalStore(ctrl ? ctrl.subscribe : noopSubscribe, ctrl ? ctrl.version : zero);
  useEffect(() => {
    ctrl?.setActive(active);
  }, [ctrl, active]);
  useEffect(() => {
    ctrl?.revive();
    return () => ctrl?.dispose();
  }, [ctrl]);
  // VISIBLE = mounted, active and navigation-focused (the app's foreground is
  // the owner's): a visible page shows a drop in its footer, else an alert.
  useEffect(() => {
    if (!viewer || !code || !wineId) return;
    const mount = ++mountSeq;
    rateOutbox.setVisible(viewer, code, wineId, mount, active && focused);
    return () => rateOutbox.setVisible(viewer, code, wineId, mount, false);
  }, [viewer, code, wineId, active, focused]);
  useEffect(() => {
    if (viewer && code && wineId) rateOutbox.setLabel(viewer, code, wineId, label ?? null);
  }, [viewer, code, wineId, label]);

  if (!ctrl || !viewer) {
    return {
      draft: EMPTY_DRAFT, setScore: noop, stepScore: noop, setNotes: noop, setNoteFocused: noop, setFlavors: noop, setAromas: noop,
      drain: () => Promise.resolve(true), clearBaseline: () => null, clearRating: resolvedFalse, clearPending: false, discardPending: noop,
      savedState: null, error: null, baselineReady: false, editable: false, takeClearAsk: () => false,
    };
  }
  return {
    draft: ctrl.draft(),
    setScore: ctrl.setScore,
    stepScore: ctrl.stepScore,
    setNotes: ctrl.setNotes,
    setNoteFocused: ctrl.setNoteFocused,
    setFlavors: ctrl.setFlavors,
    setAromas: ctrl.setAromas,
    drain: ctrl.drain,
    clearBaseline: ctrl.clearBaseline,
    clearRating: (token) => ctrl.clearRating(token ?? undefined),
    clearPending: ctrl.clearPending(),
    discardPending: ctrl.discardPending,
    savedState: ctrl.savedState(),
    error: ctrl.error(),
    baselineReady: ctrl.baselineReady(),
    editable: ctrl.editable(),
    takeClearAsk: () => rateOutbox.takeClearAsk(viewer, code, wineId),
  };
}
