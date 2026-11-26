import { useBottomSheetModal } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Keyboard, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { ImpressionPage, type PageControls, type PageHandle } from '@/components/moments/ImpressionPage';
import { OPEN_SETTLE_MS, RevealWindow, useLayerMotion, useLayerStyles } from '@/components/moments/impressionLayerMotion';
import type { SessionState, WireWine } from '@/lib/api/sessions';
import { createTransitionGuard } from '@/lib/impressionAutosaveCore';
import {
  createEdgeRuns,
  createLayerTransitions,
  createPullClose,
  EDGE_ACTIVATE,
  EDGE_FAIL_Y,
  EDGE_STRIP,
  edgeOffset,
  neighbourId,
  pagerWindow,
  releaseTarget,
  restX,
  slideOutcome,
  type EdgeGrant,
  type EdgeRelease,
  type PageReservation,
  type RowFrame,
} from '@/lib/impressionLayerCore';
import { springs, useTheme } from '@/theme';

// A row frame (window coordinates) and a static copy of the row: the layer
// grows out of it and folds back into it (feedTransition kind 'row', copied).
export type RowLanding = RowFrame & { face: ReactNode };

// Closing never waits long for its landing frame (a measure has its own 120 ms
// belt; the scroll it may need is instant, under the opaque layer).
const CLOSE_BELT_MS = 900;
// THE MOMENT IMPRESSION AS A LAYER inside the line-up (build 2, ruled
// 2026-11-25, ADR-0011): no route. The line-up holds the open wine and renders
// this as its LAST child, outside the in-place edit's touch handlers; Edit
// Impression and View Profile (Brought By's preview) stay ordinary pushes on
// the stack that hosts the line-up, so Back returns here.
//
// • Open = like an impression opens from the profile's Impressions list: a
//   CONTAINER TRANSFORM out of the tapped row (the row's face on the raised
//   tone, the reveal window; copied from the post, impressionLayerMotion.tsx);
//   no frame (missing, clipped, late) = the plain fade, bounded.
// • Pages: the open impression and its line-up neighbours, LIVE (±1, keyed by
//   wine id, one translated row; lib/impressionLayerCore.ts), each with its own
//   autosave hook and `active` flag. Inactive pages are inert for touch,
//   VoiceOver and new writes.
// • Edge swipe (15 pt strips) pages with the neighbour following the finger;
//   first / last: nothing (a rubber band only). The row moves only for the
//   swipe the layer GRANTED (createEdgeRuns); a slide commits only when its
//   own spring finished. Previous · Next run the same slide; Finish closes
//   like the close button.
// • Pull-down closes from anywhere at a page's top (not from the aroma
//   canvas's hex stage: it fails before it activates there).
// • Closing lands on the current row: the line-up scrolls to it under the
//   layer and the layer folds into it; a row a search hides, or one that
//   can't be measured whole, takes the fade.
// • ONE transition guard (build 1's) shared by paging, Finish and every close:
//   capture first, move only once the edits are stored on the phone; a
//   storage failure keeps a page change on the page, a close still leaves.
//   While it is held the outgoing page takes no touch and no VoiceOver action
//   (its edits would be dropped), and a page change RESERVES its source and
//   destination (a poll can't swap the page under the slide). Every departure
//   first joins the page's ONE text capture (its fields report their native
//   edit's end); a 'stay' or a cancel keeps the guard until the row is back at
//   rest (one tokenized return).
// • The AppState listener and the blur capture live here while the layer is
//   open AND the line-up focused; Android Back dismisses the top sheet first.
export function ImpressionLayer({
  code, meta, wines, myIdentityId, removed, showReconnecting, startWineId, source, landing, onClosed, onStatusBar,
}: {
  code: string;
  meta: SessionState['meta'];
  wines: SessionState['wines'];
  myIdentityId: string;
  // A confirmed removal (kicked / banned): the line-up's own view follows.
  removed: boolean;
  showReconnecting: boolean;
  startWineId: string;
  // The tapped row, null = the fade.
  source: RowLanding | null;
  // The line-up: scroll a wine's row into view and measure it (null = fade).
  landing: (wineId: string) => Promise<RowLanding | null>;
  onClosed: () => void;
  // The active page's status-bar style while fully open, else null.
  onStatusBar: (style: 'light' | 'dark' | null) => void;
}) {
  const { theme } = useTheme();
  const { width, height: windowH } = useWindowDimensions();
  const focused = useIsFocused();
  const motion = useLayerMotion(source);
  const look = useLayerStyles(motion, windowH);
  const { dismiss: dismissTopSheet } = useBottomSheetModal();

  const [face, setFace] = useState<RowLanding | null>(source);
  const [active, setActive] = useState({ id: startWineId, slot: 0 });
  const activeRef = useRef(active);
  activeRef.current = active;
  // Touches reach the pages only while open and settled (React state, never an
  // animated prop: pointerEvents is off the sync-props allowlist).
  const [interactive, setInteractive] = useState(false);
  // The open has settled: the edges work, the status bar is the page's.
  const [settled, setSettled] = useState(false);
  // The neighbours mount one frame after the page turned interactive (not in
  // the same commit: the first touch after the open lands on a light tree).
  const [neighbours, setNeighbours] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const ids = useMemo(() => (wines ?? []).map((w) => w.id), [wines]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const byId = useMemo(() => new Map((wines ?? []).map((w) => [w.id, w] as const)), [wines]);
  // The active wine as last seen: a bottle that left the line-up keeps its page
  // for the terminal transition (and a cold degraded poll can't blank it).
  const activeSeen = useRef<{ wine: WireWine; index: number; total: number } | null>(null);
  const liveActive = byId.get(active.id);
  if (liveActive) activeSeen.current = { wine: liveActive, index: ids.indexOf(active.id), total: ids.length };
  const gone = wines !== null && !liveActive;

  // ── the guard and the transitions ──────────────────────────────────────
  const [frozen, setFrozen] = useState(false);
  const guard = useMemo(() => createTransitionGuard(), []);
  const busy = useSharedValue(0); // the guard, mirrored for the worklets
  const pageHandles = useRef(new Map<string, PageHandle>());
  const tx = useMemo(
    () =>
      createLayerTransitions({
        guard,
        activeId: () => activeRef.current.id,
        drain: (id) => pageHandles.current.get(id)?.drain() ?? Promise.resolve(true),
        live: () => mountedRef.current && focusedRef.current,
        destValid: (dest, from) => dest.kind === 'close' || neighbourId(idsRef.current, from, dest.dir) === dest.wineId,
        onHeld: (held) => {
          busy.value = held ? 1 : 0;
          // The outgoing page's controls and their VoiceOver actions are gated
          // for as long as the guard is held (until the destination is active,
          // or the page restored on a stay): Codex review 2026-11-26.
          setFrozen(held);
        },
      }),
    [guard, busy],
  );
  const drainActive = useCallback(() => pageHandles.current.get(activeRef.current.id)?.drain() ?? Promise.resolve(true), []);

  // ── open ───────────────────────────────────────────────────────────────
  const settleOpen = useCallback(() => {
    if (!mountedRef.current || closingRef.current) return;
    setSettled(true);
    setInteractive(true);
  }, []);
  useEffect(() => {
    if (!settled || neighbours) return;
    const id = requestAnimationFrame(() => {
      if (mountedRef.current) setNeighbours(true);
    });
    return () => cancelAnimationFrame(id);
  }, [settled, neighbours]);
  useEffect(() => {
    motion.progress.value = withSpring(1, springs.enter, (finished) => {
      if (finished) runOnJS(settleOpen)();
    });
    // Belt for an interrupted open (the callback would fire finished=false).
    const t = setTimeout(settleOpen, OPEN_SETTLE_MS + 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── landing ────────────────────────────────────────────────────────────
  // The line-up scrolls the CURRENT row into view while the layer covers it
  // (once open, and after every page change), so a close finds it in place.
  const landingSeq = useRef(0);
  const landingP = useRef<Promise<RowLanding | null> | null>(null);
  const prepareLanding = useCallback(() => {
    const seq = ++landingSeq.current;
    const id = activeRef.current.id;
    const p = landing(id)
      .catch(() => null)
      // A newer request, another page or an unmount since: no frame.
      .then((l) => (seq === landingSeq.current && mountedRef.current && activeRef.current.id === id ? l : null));
    landingP.current = p;
    return p;
  }, [landing]);
  useEffect(() => {
    if (settled && !closingRef.current) void prepareLanding();
  }, [settled, active.id, prepareLanding]);
  const applyLanding = useCallback((l: RowLanding | null) => {
    if (l) {
      motion.rowY.value = l.y;
      motion.rowH.value = l.height;
      motion.rowOn.value = 1;
    } else {
      motion.rowOn.value = 0;
    }
    setFace(l);
  }, [motion]);

  // ── the pager row (declared before every departure that may revoke it) ──
  const pagerX = useSharedValue(0);
  const rest = useSharedValue(0);
  const canPrevSV = useSharedValue(0);
  const canNextSV = useSharedValue(0);
  // Each edge recognizer's own swipe in progress (its id, 0 = none) and the
  // swipe that OWNS the row (granted by JS, 0 = none): a worklet writes the row
  // only while its own id is the owner (Codex review 2026-11-26: a refused
  // swipe writes nothing; recheck: a second finger on the opposite edge can't
  // erase the granted swipe's id).
  const edgeSeq = useSharedValue(0);
  const edgeRunL = useSharedValue(0);
  const edgeRunR = useSharedValue(0);
  const edgeOwner = useSharedValue(0);
  const edgeFree = useSharedValue(false);
  const edgeRuns = useMemo(() => createEdgeRuns(), []);
  const sliding = useRef(false);
  // Every slide / return spring carries a token: only the latest one's
  // completion counts.
  const slideTok = useRef(0);
  // A page change in flight RESERVES its source and destination (the pager
  // window follows it, not the poll); the destination as last seen keeps its
  // page if a poll removes it mid-slide (the completion cancels back).
  const [reserved, setReserved] = useState<PageReservation | null>(null);
  const reservedRef = useRef<PageReservation | null>(null);
  const reservedSeen = useRef<{ wine: WireWine; index: number; total: number } | null>(null);
  if (reserved) {
    const w = byId.get(reserved.to);
    if (w) reservedSeen.current = { wine: w, index: ids.indexOf(reserved.to), total: ids.length };
  }
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  // The page is displaced by a pull-down (not VISIBLE, hidden from VoiceOver)
  // until it closes or has sprung back open.
  const [displaced, setDisplaced] = useState(false);
  const reserve = useCallback((to: string, dir: -1 | 1) => {
    const w = byIdRef.current.get(to);
    reservedSeen.current = w ? { wine: w, index: idsRef.current.indexOf(to), total: idsRef.current.length } : null;
    reservedRef.current = { to, dir };
    setReserved(reservedRef.current);
  }, []);
  const unreserve = useCallback(() => {
    if (!reservedRef.current) return;
    reservedRef.current = null;
    setReserved(null);
  }, []);
  const springRest = useCallback(() => {
    pagerX.value = withSpring(rest.value, springs.release);
  }, [pagerX, rest]);
  // Another transition takes the row: the current swipe stops writing it, its
  // grant and release are void. (JS writes reach the UI thread in order, so the
  // owner is cleared before any spring that follows.)
  const revokeEdge = useCallback(() => {
    edgeOwner.value = 0;
    edgeRuns.revoke();
  }, [edgeOwner, edgeRuns]);
  // Back at rest after a page change that did not go (a 'stay', a cancelled
  // or interrupted swipe, a slide that did not land): the reservation, the
  // input freeze and the visibility gate are released only then, with the
  // guard (Codex recheck 2026-11-26: never while the row still moves).
  const onReturnEnd = useCallback((tok: number, finished: boolean) => {
    if (tok !== slideTok.current) return;
    sliding.current = false;
    if (!finished) pagerX.value = rest.value;
    unreserve();
    tx.abandon();
  }, [pagerX, rest, unreserve, tx]);
  // The ONE way back to the source: a tokenized spring (instant at rest).
  const returnToSource = useCallback(() => {
    const tok = ++slideTok.current;
    sliding.current = true;
    pagerX.value = withSpring(rest.value, springs.release, (f) => {
      runOnJS(onReturnEnd)(tok, !!f);
    });
  }, [pagerX, rest, onReturnEnd]);
  // Begin a page change: the guard (the capture), then the reservation.
  const beginPage = useCallback((to: string, dir: -1 | 1) => {
    if (!tx.begin({ kind: 'page', wineId: to, dir })) return false;
    reserve(to, dir);
    return true;
  }, [tx, reserve]);
  // Every departure JOINS the active page's one text capture: the keyboard
  // goes, then it waits for the page's fields to report their native edit's end
  // (ImpressionPage, lib/fieldCapture.ts), bounded.
  const captureActive = useCallback(() => {
    Keyboard.dismiss();
    return pageHandles.current.get(activeRef.current.id)?.capture() ?? Promise.resolve();
  }, []);

  // ── close ──────────────────────────────────────────────────────────────
  const finishClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClosed();
  }, [onClosed]);
  const runClose = useCallback(async (velocity: number) => {
    closingRef.current = true;
    motion.closing.value = true;
    setClosing(true);
    setInteractive(false);
    const l = await (landingP.current ?? prepareLanding());
    if (!mountedRef.current) return;
    applyLanding(l);
    motion.dismissing.value = true;
    // A plain self-write cancels a running animation so the spring starts from
    // rest at the current value (the post's note: a new spring ADDS the
    // running one's velocity).
    motion.progress.value = motion.progress.value;
    motion.progress.value = withSpring(0, { ...springs.release, velocity: Math.min(0, velocity) }, (finished) => {
      if (finished) runOnJS(finishClose)();
    });
    setTimeout(() => {
      if (mountedRef.current) finishClose();
    }, CLOSE_BELT_MS);
  }, [applyLanding, finishClose, motion, prepareLanding]);
  // The close button, Finish, Android Back (after the sheet): the same guard,
  // after the text capture.
  const requestClose = useCallback(async (opts?: { haptic?: boolean }) => {
    if (closingRef.current || tx.busy) return;
    await captureActive();
    if (!mountedRef.current || closingRef.current || !tx.begin({ kind: 'close' })) return;
    revokeEdge();
    void prepareLanding();
    const outcome = await tx.end(true);
    if (!mountedRef.current) return;
    if (outcome !== 'go') {
      // Nothing moved (the layer blurred meanwhile): the guard back at once.
      tx.abandon();
      return;
    }
    if (opts?.haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    void runClose(0);
  }, [tx, captureActive, revokeEdge, prepareLanding, runClose]);
  // A CONFIRMED terminal outcome (the bottle gone from a present line-up, a
  // successful Delete Impression): no capture, no wait; the fade (no row).
  const forceClose = useCallback(() => {
    if (closingRef.current) return;
    tx.force();
    revokeEdge();
    landingSeq.current++;
    landingP.current = Promise.resolve(null);
    void runClose(0);
  }, [tx, revokeEdge, runClose]);
  useEffect(() => {
    if (gone) forceClose();
  }, [gone, forceClose]);

  // ── pull-down (the active page's pan reports here) ─────────────────────
  // It activates with its touches blocked and the page displaced; once the
  // text capture is in, the guarded drain starts DURING the drag
  // (createPullClose); a cancel keeps the guard, the freeze and the
  // displacement until the spring back has landed.
  const pullDenied = useSharedValue(false);
  const pullClose = useMemo(
    () => createPullClose({ tx, capture: captureActive, closing: () => closingRef.current, onBegun: revokeEdge }),
    [tx, captureActive, revokeEdge],
  );
  const pullSettled = useCallback(() => {
    pullClose.settled();
    if (closingRef.current || !mountedRef.current) return;
    setInteractive(true);
    setDisplaced(false);
  }, [pullClose]);
  const springOpen = useCallback(() => {
    motion.progress.value = withSpring(1, springs.release, (finished) => {
      if (finished) motion.dismissing.value = false;
      runOnJS(pullSettled)();
    });
  }, [motion, pullSettled]);
  const onPullActivate = useCallback(() => {
    // A close already runs (a forced one included), or another transition is
    // in flight (a slide, a drain, a return): the pull does nothing.
    if (!pullClose.activate()) {
      pullDenied.value = true;
      if (!closingRef.current) {
        motion.progress.value = withSpring(1, springs.release, (finished) => {
          if (finished) motion.dismissing.value = false;
        });
      }
      return;
    }
    setInteractive(false);
    setDisplaced(true);
    // The fold's frame, as soon as it is known (the band shrinks toward it).
    void prepareLanding().then((l) => {
      if (mountedRef.current && !closingRef.current && pullClose.active) applyLanding(l);
    });
  }, [pullClose, pullDenied, motion, prepareLanding, applyLanding]);
  const onPullRelease = useCallback(async (velocity: number) => {
    const out = await pullClose.release();
    if (!mountedRef.current) return;
    if (out === 'close') void runClose(velocity);
    else if (out === 'open') springOpen();
  }, [pullClose, runClose, springOpen]);
  const onPullCancel = useCallback(() => {
    pullClose.cancel();
  }, [pullClose]);

  // ── paging ─────────────────────────────────────────────────────────────
  const at = ids.indexOf(active.id);
  const canPrev = at > 0;
  const canNext = at >= 0 && at < ids.length - 1;
  useEffect(() => {
    canPrevSV.value = canPrev ? 1 : 0;
    canNextSV.value = canNext ? 1 : 0;
  }, [canPrev, canNext, canPrevSV, canNextSV]);
  useEffect(() => {
    const r = restX(active.slot, width);
    rest.value = r;
    if (!sliding.current) pagerX.value = r;
  }, [active.slot, width, rest, pagerX]);
  // A slide's completion, for ITS token only: commits the destination only
  // when the spring FINISHED, the destination is still in the line-up and the
  // layer still live (slideOutcome), else returns to the source. A commit makes
  // the destination the active page (the row already sits at its rest, so no
  // mounted page moves in this commit), then gives the guard back.
  const onSlideEnd = useCallback((tok: number, wineId: string, slot: number, finished: boolean) => {
    if (tok !== slideTok.current) return;
    if (!mountedRef.current || tx.forced) {
      sliding.current = false;
      return;
    }
    if (slideOutcome(idsRef.current, wineId, focusedRef.current, finished) === 'commit') {
      sliding.current = false;
      reservedRef.current = null;
      setReserved(null);
      setActive({ id: wineId, slot });
      tx.settle();
      return;
    }
    returnToSource();
  }, [tx, returnToSource]);
  const slide = useCallback((dir: -1 | 1, vx: number) => {
    const dest = tx.current();
    if (!dest || dest.kind !== 'page') return;
    const slot = activeRef.current.slot + dir;
    const tok = ++slideTok.current;
    sliding.current = true;
    const target = restX(slot, width);
    // Velocity toward the target only (a clamped spring stops dead on an
    // away-velocity); none for a button.
    const config = vx ? { ...springs.release, velocity: dir === 1 ? Math.min(0, vx) : Math.max(0, vx) } : springs.enter;
    const wineId = dest.wineId;
    pagerX.value = withSpring(target, config, (finished) => {
      runOnJS(onSlideEnd)(tok, wineId, slot, !!finished);
    });
  }, [tx, width, pagerX, onSlideEnd]);
  // Previous · Next (Finish is requestClose): the text capture, then the guard
  // and the reservation.
  const goPage = useCallback(async (dir: -1 | 1, opts?: { haptic?: boolean }) => {
    if (closingRef.current || tx.busy || !neighbourId(idsRef.current, activeRef.current.id, dir)) return;
    await captureActive();
    const dest = neighbourId(idsRef.current, activeRef.current.id, dir);
    if (!dest || !mountedRef.current || closingRef.current || !beginPage(dest, dir)) return;
    revokeEdge();
    const outcome = await tx.end(true);
    if (!mountedRef.current) return;
    if (outcome !== 'go') {
      returnToSource();
      return;
    }
    if (opts?.haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    slide(dir, 0);
  }, [tx, captureActive, beginPage, revokeEdge, returnToSource, slide]);
  // A granted swipe's release (or a release that came before its grant).
  const finishEdge = useCallback(async (grant: Exclude<EdgeGrant, 'refused'>, dir: -1 | 1, r: EdgeRelease) => {
    edgeOwner.value = 0;
    if (grant === 'band') {
      springRest();
      return;
    }
    if (r.target === 0) {
      // Short of the line: the guard stays held until the row is back.
      void tx.end(false);
      returnToSource();
      return;
    }
    // Held where the finger left it until the edits are stored.
    const outcome = await tx.end(true);
    if (!mountedRef.current) return;
    if (outcome === 'go') slide(dir, r.vx);
    else returnToSource();
  }, [edgeOwner, springRest, tx, returnToSource, slide]);
  // An edge swipe ACTIVATED (its worklet writes nothing until this grants it):
  // a neighbour → the text capture, then the guard and the reservation
  // ('page'); first / last with nothing in flight → the rubber band ('band');
  // anything else (another swipe holds the row included) → refused.
  const onEdgeStart = useCallback(async (id: number, dir: -1 | 1, can: boolean) => {
    if (!edgeRuns.start(id, dir)) return;
    let grant: EdgeGrant = 'refused';
    if (mountedRef.current && !closingRef.current && !tx.busy) {
      if (!can) {
        Keyboard.dismiss();
        grant = 'band';
      } else {
        await captureActive();
        const dest = neighbourId(idsRef.current, activeRef.current.id, dir);
        if (edgeRuns.dirOf(id) === dir && dest && mountedRef.current && !closingRef.current && beginPage(dest, dir)) grant = 'page';
      }
    }
    const r = edgeRuns.grant(id, grant);
    if (!r) {
      // Another transition revoked the swipe meanwhile.
      if (grant === 'page') {
        void tx.end(false);
        returnToSource();
      }
      return;
    }
    if (grant === 'refused') return;
    edgeFree.value = grant === 'page';
    edgeOwner.value = id;
    if (r.released) void finishEdge(grant, dir, r.released);
  }, [edgeRuns, tx, captureActive, beginPage, returnToSource, edgeFree, edgeOwner, finishEdge]);
  const onEdgeRelease = useCallback((id: number, target: -1 | 0 | 1, vx: number) => {
    const r = edgeRuns.release(id, { target, vx });
    if (r === 'deferred' || r === null) return;
    void finishEdge(r.grant, r.dir, { target, vx });
  }, [edgeRuns, finishEdge]);
  const edgeEnabled = settled && !closing;
  const edge = (dir: -1 | 1) => {
    // This recognizer's OWN run id: it begins, writes and finalizes only it.
    const myRun = dir === -1 ? edgeRunL : edgeRunR;
    return Gesture.Pan()
      // The strips sit on the viewport's left / right edge; a tap or a
      // vertical move there still reaches the page's controls.
      .hitSlop(dir === -1 ? { left: 0, width: EDGE_STRIP } : { right: 0, width: EDGE_STRIP })
      .activeOffsetX(dir === -1 ? EDGE_ACTIVATE : -EDGE_ACTIVATE)
      .failOffsetX(dir === -1 ? -EDGE_ACTIVATE : EDGE_ACTIVATE)
      .failOffsetY([-EDGE_FAIL_Y, EDGE_FAIL_Y])
      .enabled(edgeEnabled)
      .onBegin(() => {
        myRun.value = 0;
      })
      .onStart(() => {
        // A transition in flight (a slide, a close, a drain, a return): the
        // swipe stays idle (JS would refuse it too; this saves the round trip).
        if (busy.value) return;
        edgeSeq.value += 1;
        myRun.value = edgeSeq.value;
        const can = dir === -1 ? canPrevSV.value : canNextSV.value;
        runOnJS(onEdgeStart)(edgeSeq.value, dir, can === 1);
      })
      .onUpdate((e) => {
        if (myRun.value === 0 || edgeOwner.value !== myRun.value) return;
        pagerX.value = rest.value + edgeOffset(e.translationX, width, dir, edgeFree.value);
      })
      .onEnd((e, success) => {
        if (!success || myRun.value === 0) return;
        const id = myRun.value;
        myRun.value = 0;
        runOnJS(onEdgeRelease)(id, releaseTarget(e.translationX, e.velocityX, width, dir, true), e.velocityX);
      })
      .onFinalize((_e, success) => {
        if (success || myRun.value === 0) return;
        const id = myRun.value;
        myRun.value = 0;
        runOnJS(onEdgeRelease)(id, 0, 0);
      });
  };
  const edges = Gesture.Race(edge(-1), edge(1));
  const pagerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pagerX.value }] }));

  // ── status bar ─────────────────────────────────────────────────────────
  const [activeStyle, setActiveStyle] = useState<'light' | 'dark' | null>(null);
  const reportStyle = useCallback((wineId: string, style: 'light' | 'dark') => {
    if (wineId === activeRef.current.id) setActiveStyle(style);
  }, []);
  useEffect(() => {
    onStatusBar(settled && !closing ? activeStyle : null);
  }, [settled, closing, activeStyle, onStatusBar]);
  useEffect(() => () => onStatusBar(null), [onStatusBar]);

  // ── focus, background, Android Back ────────────────────────────────────
  // ONE AppState listener while open AND focused (removed on blur, also when
  // the layer stays mounted under Edit Impression or a profile): `background`
  // captures the active page at once, `inactive` is ignored, returning to
  // `active` ends that departure's join window. The blur captures in the
  // STABLE cleanup (expo-router re-runs a cleanup whenever its callback changes).
  useFocusEffect(
    useCallback(() => {
      let departed = false;
      const sub = AppState.addEventListener('change', (st) => {
        if (st === 'background' && !departed) {
          departed = true;
          void drainActive();
        } else if (st === 'active') departed = false;
      });
      return () => {
        sub.remove();
        if (!departed) void drainActive();
      };
    }, [drainActive]),
  );
  // Android Back, focus-scoped (the post's pattern), beneath the line-up's
  // BottomSheetModalProvider: the top sheet first (gorhom's dismiss() answers
  // whether there was one: the aroma selection, Brought By's preview), else
  // the close. AnchoredMenu keeps its own native onRequestClose.
  const backRef = useRef({ dismissTopSheet, requestClose });
  backRef.current = { dismissTopSheet, requestClose };
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (closedRef.current) return false;
        if (backRef.current.dismissTopSheet()) return true;
        void backRef.current.requestClose();
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  // ── pages ──────────────────────────────────────────────────────────────
  const register = useCallback((wineId: string, page: PageHandle) => {
    pageHandles.current.set(wineId, page);
    return () => {
      if (pageHandles.current.get(wineId) === page) pageHandles.current.delete(wineId);
    };
  }, []);
  const impl = useRef({ requestClose, goPage, forceClose, onPullActivate, onPullRelease, onPullCancel, pullSettled });
  impl.current = { requestClose, goPage, forceClose, onPullActivate, onPullRelease, onPullCancel, pullSettled };
  const controls = useMemo<PageControls>(
    () => ({
      guard,
      motion,
      pullDenied,
      register,
      reportStyle,
      requestClose: (opts) => void impl.current.requestClose(opts),
      goPage: (dir, opts) => void impl.current.goPage(dir, opts),
      forceClose: () => impl.current.forceClose(),
      onPullActivate: () => impl.current.onPullActivate(),
      onPullRelease: (v) => void impl.current.onPullRelease(v),
      onPullCancel: () => impl.current.onPullCancel(),
      onPullRestored: () => impl.current.pullSettled(),
    }),
    [guard, motion, pullDenied, register, reportStyle],
  );
  // Neighbours mount a frame after the open has settled (the open flight
  // mounts only the tapped page), then follow the active page; a page change
  // in flight shows exactly its reserved source and destination.
  const pages = pagerWindow(ids, active.id, active.slot, neighbours, reserved);
  // VISIBLE (the outbox's after-leave alert rule) ends when a close starts,
  // and for the outgoing page while a page change moves it or a pull-down
  // displaces it (Codex review / recheck 2026-11-26: a definitive failure then
  // goes to the one-shot alert, not to a footer sliding or fading away; back at
  // rest it shows in the footer again).
  const pageFocused = focused && !closing;

  return (
    // The covered line-up is hidden from touch and VoiceOver by the screen
    // while this is open; iOS keeps VoiceOver inside the layer.
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <RevealWindow width={width} height={windowH} outer={look.windowOuterStyle} inner={look.windowInnerStyle}>
        {/* the container's raised tone (a row), under the settle bg */}
        <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.surface }, look.toneStyle]} />
        <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }, look.bgStyle]} />
        <Reanimated.View pointerEvents={interactive ? 'auto' : 'none'} style={[{ flex: 1 }, look.contentStyle]}>
          <GestureDetector gesture={edges}>
            <View collapsable={false} style={{ flex: 1 }}>
              <Reanimated.View style={[StyleSheet.absoluteFill, pagerStyle]}>
                {pages.map((p) => {
                  // A page's OWN wine only (as last seen when it left the
                  // line-up): never another wine under its key.
                  const seen = p.active ? activeSeen.current : reserved && p.id === reserved.to ? reservedSeen.current : null;
                  const wine = byId.get(p.id) ?? (seen && seen.wine.id === p.id ? seen.wine : null);
                  if (!wine) return null;
                  const index = p.index >= 0 ? p.index : seen?.index ?? 0;
                  const total = p.index >= 0 ? ids.length : seen?.total ?? ids.length;
                  // The outgoing page is gated while the guard is held and
                  // while a pull-down displaces it.
                  const live = p.active && !frozen && !displaced;
                  return (
                    <View
                      key={p.id}
                      style={{ position: 'absolute', top: 0, bottom: 0, left: p.slot * width, width }}
                      pointerEvents={live ? 'auto' : 'none'}
                      accessibilityElementsHidden={!live}
                      importantForAccessibility={live ? 'auto' : 'no-hide-descendants'}
                    >
                      <ImpressionPage
                        code={code}
                        wine={wine}
                        index={index}
                        total={total}
                        meta={meta}
                        myIdentityId={myIdentityId}
                        active={p.active}
                        focused={pageFocused && !(p.active && (reserved || displaced))}
                        gone={p.active && gone}
                        removed={removed}
                        showReconnecting={showReconnecting}
                        controls={controls}
                      />
                    </View>
                  );
                })}
              </Reanimated.View>
            </View>
          </GestureDetector>
        </Reanimated.View>
        {/* the row's face (a row): a static copy of the row at its place,
            riding the container's top edge while it fades */}
        {face?.face ? (
          <Reanimated.View
            pointerEvents="none"
            style={[{ position: 'absolute', left: face.x, top: face.y, width: face.width }, look.faceStyle]}
          >
            {face.face}
          </Reanimated.View>
        ) : null}
      </RevealWindow>
      {/* Reconnecting (the line-up's poll): over the open layer, as the old
          screen had it. */}
      {showReconnecting && settled && !closing ? <ReconnectingBar /> : null}
    </View>
  );
}
