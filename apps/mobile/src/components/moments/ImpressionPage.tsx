import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, Alert, Pressable, View, type ScrollViewInstance, type ViewInstance } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedRef, useScrollOffset, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { CanvasTouchContext, useCanvasZone } from '@/components/scoring/aroma/canvasTouch';
import { RatingSection } from '@/components/scoring/RatingSection';
import { AnchoredMenu, MenuItem, MenuSeparator, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { NoTopEdgeFade } from '@/components/ui/NoTopEdgeFade';
import { VText } from '@/components/ui/VText';
import { BarTitle, useBarTitleProgress } from '@/components/VBar';
import { AboutBlock, Hero, NameBlock } from '@/components/moments/ImpressionParts';
import { usePullDownClose, type LayerMotion } from '@/components/moments/impressionLayerMotion';
import { ApiError, deleteWine, hideWine, revealWine, setBookmark, type SessionState, type WireWine } from '@/lib/api/sessions';
import { blockLook } from '@/lib/blockLook';
import { errorText } from '@/lib/errorCopy';
import { FieldCaptureContext } from '@/lib/fieldCapture';
import { markProfileHeaderStale } from '@/lib/feedCache';
import { type SavedState, type TransitionGuard } from '@/lib/impressionAutosaveCore';
import { CAPTURE_BELT_MS, createInputCapture } from '@/lib/impressionLayerCore';
import { FOOT_CLEARANCE_IR as FOOT_CLEARANCE, GLASS_FILL, usePhoneTokens } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { sessionHref, useSessionTab } from '@/lib/sessionStack';
import { useImpressionAutosave } from '@/lib/useImpressionAutosave';
import { radius, useTheme } from '@/theme';

const GUTTER = 20; // 02e vbody runs 20px gutters (vs the line-up's 22) — deliberate override
// The room the content keeps above the footer bar: FOOT_CLEARANCE_IR (130)
// over the old 114 pt bar at default text.
const FOOT_BREATHING = 16;

// What one page hands the layer: its departure capture.
// `capture`: resolves once the page's text fields finished their native edit
// (lib/impressionLayerCore.ts `createInputCapture`); `drain`: the outbox capture.
export type PageHandle = { capture: () => Promise<void>; drain: () => Promise<boolean> };

// The layer's side of a page (components/moments/ImpressionLayer.tsx): the ONE
// transition guard, the shared presentation values the pull-down drives, and
// the controlled departures, which the layer runs through that guard.
export type PageControls = {
  guard: TransitionGuard;
  motion: LayerMotion;
  pullDenied: SharedValue<boolean>;
  register: (wineId: string, page: PageHandle) => () => void;
  reportStyle: (wineId: string, style: 'light' | 'dark') => void;
  requestClose: (opts?: { haptic?: boolean }) => void;
  goPage: (dir: -1 | 1, opts?: { haptic?: boolean }) => void;
  forceClose: () => void;
  onPullActivate: () => void;
  onPullRelease: (velocity: number) => void;
  onPullCancel: () => void;
  onPullRestored: () => void;
};

// 02e impression detail, ONE page of the impression layer (build 2, ADR-0011;
// it was the route `session/[code]/impression/[wineId]` until then): info +
// the rating, to the vero-screens irScreen pixel spec. Photo variant =
// full-bleed hero with a glass floating header that hands the title in and
// goes solid as the on-screen name scrolls under it; no-photo variant (the
// norm) = in-flow bar, dark name block. Rate flow: the shared RatingSection.
//
// AUTO-SAVE (tasting-feedback build 1, ruled 2026-11-25): the rating saves
// itself about 1 s after the input settles and on every leave, as MERGE saves
// of the changed fields only, through the outbox (lib/useImpressionAutosave.ts
// → lib/rateOutbox.ts). EVERY page mounts its own hook with the layer's guard
// and its `active` flag: an inactive page (a neighbour) is inert for touch,
// VoiceOver and NEW writes (a captured departure still finishes); on
// activation each clean field seeds from the entry, then the own-rating
// snapshot (the hook's per-field rule). ONLY "Clear My Rating" deletes (after a
// confirm). "Saved" sits in the footer bar.
//
// The page's data is the line-up's own poll (meta / wines through the layer):
// no second poll, no second per-section merge. Memoized: the layer re-renders
// on every gesture state change, a page only when its own props move (the
// poll's structural sharing keeps `wine` / `meta`, the layer's `controls` is
// stable).
export const ImpressionPage = memo(function ImpressionPage({
  code, wine, index, total, meta, myIdentityId, active, focused, gone, removed, showReconnecting, controls,
}: {
  code: string;
  wine: WireWine;
  // The wine's TRUE line-up position (-1 once it left the line-up).
  index: number;
  total: number;
  meta: SessionState['meta'];
  myIdentityId: string;
  active: boolean;
  focused: boolean;
  // The bottle left a PRESENT line-up (deleted, or hidden from you).
  gone: boolean;
  // A confirmed removal (kicked / banned).
  removed: boolean;
  showReconnecting: boolean;
  controls: PageControls;
}) {
  const wineId = wine.id;
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessionTab = useSessionTab();
  const queryClient = useQueryClient();
  const at = Math.max(0, index);

  // Read in callbacks that outlive a render (the menu's onClosed, a drain).
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const activeRef = useRef(active);
  activeRef.current = active;
  const wineIdRef = useRef(wineId);
  wineIdRef.current = wineId;

  // Host on a blind session gets the bar's reveal/hide control (mirrors the
  // line-up). isHostByIdentity parity: original host, logged-in host fallback,
  // or any cohost. Providers can't reveal (server rejects) — no control.
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const isOwnProvider = !!meta && (meta.providerIds ?? []).includes(myIdentityId) && !!wine.isMine;
  const canEditImpression = !wine._blind && (isHostViewer || isOwnProvider);
  const hostRevealUi = !!meta?.blind && isHostViewer;

  // The rating draft, auto-saved (see the header), with the LAYER's guard.
  const wineLabel = wine._blind || !wine.name ? `Impression ${at + 1}` : wine.name;
  const autosave = useImpressionAutosave({ code, wineId, kind: wine, active, focused, guard: controls.guard, label: wineLabel });
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const { draft } = autosave;
  // The page's text fields report their edits here (FieldCaptureContext), so a
  // departure waits for the last keystrokes and the end-editing commit
  // (Codex recheck 2026-11-26).
  const inputCapture = useMemo(() => createInputCapture({ beltMs: CAPTURE_BELT_MS }), []);
  // The layer captures the ACTIVE page through this (its departures).
  const { register } = controls;
  useEffect(
    () => register(wineId, { capture: () => inputCapture.capture(), drain: () => autosaveRef.current.drain() }),
    [register, wineId, inputCapture],
  );

  // Crave = save the bottle (optimistic). It reads the row's own `saved`
  // (catalogue model change step 5): on a bottle hidden for you that is your
  // save of THAT bottle, never whether you crave the wine elsewhere. The local
  // override is keyed on the wine id and dropped once the line-up has re-read;
  // a refusal springs the heart back and says why (ADR-0009: "Too many saves.
  // Try again in …").
  const meIdForLists = useMeId();
  const [craveLocal, setCraveLocal] = useState<{ wineId: string; on: boolean } | null>(null);
  const craved = craveLocal?.wineId === wineId ? craveLocal.on : !!wine.saved;
  const craveMut = useMutation({
    mutationFn: (vars: { wineId: string; on: boolean }) => setBookmark(code, vars.wineId, vars.on),
    onMutate: (vars) => setCraveLocal(vars),
    onSuccess: (r, vars) => setCraveLocal((cur) => (cur?.wineId === vars.wineId ? { wineId: vars.wineId, on: r.saved } : cur)),
    onError: (e, vars) => {
      // Only this bottle's override springs back (review r1: a sibling's save
      // in flight must not lose its own).
      setCraveLocal((cur) => (cur?.wineId === vars.wineId ? null : cur));
      Alert.alert(vars.on ? 'Couldn’t Save' : 'Couldn’t Remove', errorText(e));
    },
    onSettled: () => {
      // Your Cravings tile follows (lists plan D12) when you next look at it.
      void markProfileHeaderStale(queryClient, meIdForLists);
      void queryClient.invalidateQueries({ queryKey: ['session-state', code] });
    },
  });
  // The override goes once the line-up row agrees (a refetch that failed keeps it).
  const rowSaved = !!wine.saved;
  useEffect(() => {
    if (craveLocal && craveLocal.wineId === wineId && craveLocal.on === rowSaved && !craveMut.isPending) setCraveLocal(null);
  }, [craveLocal, wineId, rowSaved, craveMut.isPending]);

  // Host reveal/hide of THIS impression (blind session). Optimistically
  // stamps/clears revealedAt in the shared session-state cache so the bar
  // control + (on a normal blind session) the hero flip immediately; the 5s
  // poll reconciles. revealedToGuests is the single source of truth — a
  // revealed wine always carries revealedAt, even under blind-for-all where an
  // unrevealed wine comes back _blind with none.
  const stateKey = ['session-state', code, myIdentityId];
  const revealedToGuests = !!wine.revealedAt;
  const [revealBusy, setRevealBusy] = useState(false);
  const toggleReveal = async () => {
    if (revealBusy) return;
    const next = !revealedToGuests;
    setRevealBusy(true);
    // Cancel an in-flight poll so it can't resolve after the optimistic write
    // and clobber it; refetch the server truth on error (a frozen snapshot
    // could be stale by then). Mirrors the line-up's runReveal.
    await queryClient.cancelQueries({ queryKey: stateKey });
    const prev = queryClient.getQueryData<SessionState>(stateKey);
    if (prev?.wines) {
      queryClient.setQueryData<SessionState>(stateKey, {
        ...prev,
        wines: prev.wines.map((w) =>
          w.id === wineId ? { ...w, revealedAt: next ? new Date().toISOString() : null } : w,
        ),
      });
    }
    try {
      if (next) await revealWine(code, wineId);
      else await hideWine(code, wineId);
      queryClient.invalidateQueries({ queryKey: ['session-state', code] });
    } catch (e) {
      queryClient.invalidateQueries({ queryKey: ['session-state', code] }); // refetch truth
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      Alert.alert(next ? 'Could not reveal' : 'Could not hide', msg || 'Check your connection and try again.');
    } finally {
      setRevealBusy(false);
    }
  };

  // ⋯ menu — the shared AnchoredMenu (.ir-menu dropdown; Simon's ruling: the
  // brand menu, not the native action sheet). Anchored to the measured ⋯ button.
  // A row that asks first records ONE single-use intent before the menu closes;
  // `onClosed` (every dismissal, once the Modal is gone) consumes it and shows
  // the alert only while the same wine is still the ACTIVE, focused page.
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const menuIntent = useRef<{ kind: 'clear' | 'delete'; wineId: string } | null>(null);
  const confirmClearRating = () => {
    // Destructive confirms always NAME what's being deleted (Simon,
    // 2026-07-18): masked wines get their line-up alias, same as the bar.
    // Only on a KNOWN baseline (Codex P1): before the rating loads there is
    // nothing the person saw to delete. The baseline on screen NOW, taken as
    // the confirm OPENS: Delete clears what the person saw (a poll or a rebase
    // since → asked again); never clearRating() without the token.
    if (!autosaveRef.current.baselineReady) return;
    const token = autosaveRef.current.clearBaseline();
    Alert.alert(`Delete your rating of “${wineLabel}”?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void autosaveRef.current.clearRating(token) },
    ]);
  };
  const intentRunners = useRef({ clear: confirmClearRating, delete: () => {} });
  intentRunners.current.clear = confirmClearRating;
  const onMenuClosed = useCallback(() => {
    const intent = menuIntent.current;
    menuIntent.current = null;
    if (!intent || intent.wineId !== wineIdRef.current || !focusedRef.current || !activeRef.current) return;
    intentRunners.current[intent.kind]();
  }, []);
  const askThenClose = (kind: 'clear' | 'delete') => {
    menuIntent.current = { kind, wineId };
    setMenuAnchor(null);
  };
  // A Clear the server found STALE (a newer rating from elsewhere) is never
  // rebased: the ACTIVE page shows the newer rating and asks again.
  useEffect(() => {
    if (active && focused && autosave.takeClearAsk()) confirmClearRating();
  });
  // Edit Impression stays an ordinary push on this stack (ruled): Back
  // returns to this page, the layer still open under it.
  const editImpression = () => {
    setMenuAnchor(null);
    router.push(sessionHref(sessionTab, 'edit-impression/[wineId]', { code, wineId }));
  };
  const deleteMut = useMutation({
    mutationFn: () => deleteWine(code, wineId),
    onSuccess: () => {
      // The one CONFIRMED terminal outcome: the rating's unsent work goes with
      // it at once (`confirmed`), and the layer closes (the row is gone: the fade).
      autosaveRef.current.discardPending({ confirmed: true });
      // Only while this is still the open page (a page change meanwhile: the
      // line-up drops the row and the layer stays where you are).
      if (activeRef.current) controls.forceClose();
      queryClient.invalidateQueries({ queryKey: ['session-state', code] });
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      Alert.alert('Could not delete', msg || 'Check your connection and try again.');
    },
  });
  const confirmDeleteImpression = () => {
    // Destructive confirms always NAME what's being deleted (Simon,
    // 2026-07-18) — masked wines get their line-up alias, same as the bar.
    const label = wine._blind ? `Impression ${at + 1}` : wine.name;
    Alert.alert(
      label ? `Delete “${label}”?` : 'Delete this impression?',
      'This removes it from the line-up and clears ratings for it. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (!deleteMut.isPending) deleteMut.mutate();
          },
        },
      ],
    );
  };
  intentRunners.current.delete = confirmDeleteImpression;

  // A terminal outcome ends the page's work: a PRESENT line-up without this
  // bottle (deleted, or hidden from you) and a confirmed removal (kicked /
  // banned). Bare `discardPending()` (build 1): the unsettled draft is staged
  // and the stored entry KEPT; the server's 404 / 403 / removed answer drops it.
  // Only Delete Impression's success deletes at once (`confirmed`, above). A
  // gone moment, a 429, a failed or degraded poll close the layer the same way.
  useEffect(() => {
    if (active && (gone || removed)) autosaveRef.current.discardPending();
  }, [active, gone, removed]);

  // ── scroll: the bar title, the pull-down, the keyboard fit ──────────────
  // Collapsing header: the bar title (and the floathead's solid state) hand
  // in when the on-screen name scrolls under the header — mock measures
  // heroName.bottom <= header.bottom on every scroll tick.
  const [titleShown, setTitleShown] = useState(false);
  // Top-overscroll flag: while the hero detaches with the rubber band its
  // square top corners get a soft radius (flush full-bleed at rest).
  const [pulled, setPulled] = useState(false);
  // At the top the rubber band is OFF so a pull-down feeds the close (the
  // post's rule; the bottom keeps its bounce once the page scrolls).
  const [atTop, setAtTop] = useState(true);
  const nameBottomRef = useRef(0);
  const headerBottomRef = useRef(0);
  // The scroll offset as a SHARED value (the pull-down arms on it, on the UI
  // thread) plus the JS mirror the title / keyboard fit read.
  const scrollRef = useAnimatedRef<Reanimated.ScrollView>();
  const scrollY = useScrollOffset(scrollRef);
  const scrollYRef = useRef(0);
  const onScroll = (y: number) => {
    scrollYRef.current = y;
    const show = y >= nameBottomRef.current - headerBottomRef.current;
    setTitleShown((prev) => (prev === show ? prev : show));
    const p = y < -1;
    setPulled((prev) => (prev === p ? prev : p));
    const top = y <= 1;
    setAtTop((prev) => (prev === top ? prev : top));
  };
  // A page that stops being the active one rests at its top again (the post's
  // ruling, 2026-07-18: swiping back to a mid-scrolled page reads as stale).
  // The scroll-derived values reset explicitly: a programmatic scrollTo isn't
  // guaranteed to emit onScroll, and a stale `scrollY` would leave the
  // pull-down dead on that page until its first manual scroll.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      scrollY.value = 0;
      scrollYRef.current = 0;
      setTitleShown(false);
      setAtTop(true);
    }
    wasActive.current = active;
  }, [active, scrollRef, scrollY]);
  // Aroma search focus → the minimal shift that fits the search block above
  // the keyboard — the SHARED screen-side hook (one implementation with the
  // check-in rate stage). The content clears the footer bar by its MEASURED
  // height (it grows with Dynamic Type and carries the save-status line).
  const [footH, setFootH] = useState(0);
  const footClearance = footH > 0 ? footH + FOOT_BREATHING : FOOT_CLEARANCE;
  // The hook takes a plain scroll ref; the animated ref reads through.
  const scrollHandle = useMemo<RefObject<ScrollViewInstance | null>>(
    () => ({ get current() { return scrollRef.current as unknown as ScrollViewInstance | null; } }),
    [scrollRef],
  );
  const scrollAromaSearchTo = useAromaSearchScroll(scrollHandle, scrollYRef, footClearance);
  // The pull-down (from ANYWHERE at the top, except the aroma canvas's stage).
  const canvas = useCanvasZone();
  const { pan, native } = usePullDownClose({
    scrollY,
    // Not gated on the layer's open / close: a changed `enabled` would cancel
    // a running pan; the layer blocks touches by pointerEvents instead.
    enabled: active,
    motion: controls.motion,
    denied: controls.pullDenied,
    canvas,
    onActivate: controls.onPullActivate,
    onRelease: controls.onPullRelease,
    onCancel: controls.onPullCancel,
    onRestored: controls.onPullRestored,
  });

  const blind = !!wine._blind;
  const hasPhoto = !blind && !!wine.imageUrl;
  // iOS reads the screen option, Android expo-status-bar (both set by the
  // line-up from what the ACTIVE page reports). Light glyphs only over the
  // photo; the reconnecting overlay covers the notch with surfaceSunk.
  const statusBarStyle = hasPhoto && !titleShown && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark';
  const { reportStyle } = controls;
  useEffect(() => {
    if (active) reportStyle(wineId, statusBarStyle);
  }, [active, reportStyle, wineId, statusBarStyle]);

  const barTitle = blind ? `Impression ${at + 1} · Hidden` : wine.name + (wine.vintage ? ` - ${wine.vintage}` : '');
  const onBack = () => controls.requestClose();
  const onCrave = () => craveMut.mutate({ wineId, on: !craved });
  const isFirst = index <= 0;
  const isLast = index >= total - 1;
  // Short "acknowledged" tick on Next / Finish (Simon, 2026-07-10): the M3
  // commit convention (light impact), once the move goes ahead.
  const onPrevious = () => {
    if (!isFirst) controls.goPage(-1);
  };
  const onNext = () => (isLast ? controls.requestClose({ haptic: true }) : controls.goPage(1, { haptic: true }));

  // Brought-by (provider) resolution — mirrors the web WineInfoPane callout.
  // `addedByDisplayName` is server-resolved (live identities → kicked-user
  // name → snapshot). `addedByUserId` is the adder's public userId for
  // LOGGED-IN adders ONLY — null for anonymous adders AND pre-feature wines
  // (wineToWire). So an adder is anonymous iff there's a name but no userId
  // (a pre-feature wine has no name and renders no callout at all); this
  // mirrors PeopleSheet's `a:`-prefix anon test. Anon adders get the
  // user-glyph avatar + regular-weight name + "Unregistered" tag, same as
  // the People list; they never carry a profile avatar.
  const adderId = wine.addedByUserId != null ? `u:${wine.addedByUserId}` : null;
  // 🔒 An adder who blocked you reads as a guest too (lib/blockLook.ts, the
  // People sheet's look), never as a registered person.
  const broughtByAnon = wine.addedByDisplayName != null &&
    (adderId === null || blockLook(adderId, myIdentityId, meta?.viewerBlocksOut, meta?.viewerBlocksIn) === 'guest');
  // Avatar only for a logged-in adder whose profile the server exposed
  // (meta.participants is block/tier gated in buildMetaView).
  const adderImageUrl = adderId ? meta?.participants.find((p) => p.id === adderId)?.imageUrl ?? null : null;

  const body = (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: 18, paddingBottom: footClearance }}>
      {!blind ? (
        <AboutBlock
          wine={wine}
          broughtBy={wine.addedByDisplayName}
          broughtBySelf={!!wine.isMine}
          broughtByAnon={broughtByAnon}
          broughtByImageUrl={adderImageUrl}
          broughtById={adderId}
        />
      ) : null}
      {/* THE shared rating block (score · note · structure · aromas) —
          one component with the standalone check-in rate stage. Structure is
          shown on blind wines too: `type` (the STYLE) is NOT masked by
          redaction (mirrors web RatingPane + wineRedaction). The canvas zone
          keeps a drag that starts on the aroma canvas out of the pull-down. */}
      <CanvasTouchContext.Provider value={canvas}>
        <FieldCaptureContext.Provider value={inputCapture}>
          <RatingSection
            kind={wine}
            score={draft.score}
            onScore={autosave.setScore}
            onScoreStep={autosave.stepScore}
            scoreNow={autosave.scoreNow}
            notes={draft.notes}
            onNotes={autosave.setNotes}
            onNotesFocus={autosave.setNoteFocused}
            flavors={draft.flavors}
            onFlavors={autosave.setFlavors}
            aromas={draft.aromas}
            onAromas={autosave.setAromas}
            onRequestAromaScroll={scrollAromaSearchTo}
          />
        </FieldCaptureContext.Provider>
      </CanvasTouchContext.Provider>
    </View>
  );

  // The scroll view: its native gesture right on it, the pull-down pan on the
  // PAGE ROOT (below), declared simultaneous with it (the post's wiring), so a
  // pull may also start on the bar or the footer ("from ANYWHERE while the page
  // is at its top"; Back, ⋯ and the buttons still tap: the pan needs 8 pt).
  // NoTopEdgeFade outside the detector (the marker takes the scroll view as its
  // one native child; a builder-API GestureDetector adds no view). No RNS
  // dead-end any more: the page's scroll view is not in the screen's
  // first-descendant chain (the layer is the line-up screen's LAST child), so
  // react-native-screens never flips its `contentInsetAdjustmentBehavior`.
  const scroll = (children: ReactNode) => (
    <NoTopEdgeFade style={{ flex: 1 }}>
      <GestureDetector gesture={native}>
        <Reanimated.ScrollView
          ref={scrollRef}
          onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={!atTop}
          style={{ flex: 1 }}
        >
          {children}
        </Reanimated.ScrollView>
      </GestureDetector>
    </NoTopEdgeFade>
  );

  return (
    <GestureDetector gesture={pan}>
    <View collapsable={false} style={{ flex: 1 }}>
      {hasPhoto ? (
        // Photo variant: hero runs under the status bar; floating header.
        <>
          {scroll(
            <>
              <Hero
                wine={wine}
                index={at}
                total={total}
                pulled={pulled}
                onNameBottom={(y) => {
                  nameBottomRef.current = y;
                }}
              />
              {/* Content panel: rounded top corners overlapping the photo's
                  underlap strip — the photo shows in the corner notches. */}
              <View
                style={{
                  marginTop: -radius.xl,
                  borderTopLeftRadius: radius.xl,
                  borderTopRightRadius: radius.xl,
                  backgroundColor: theme.bg,
                }}
              >
                {body}
              </View>
            </>,
          )}
          <FloatHead
            title={barTitle}
            titleShown={titleShown}
            craved={craved}
            onCrave={onCrave}
            onMenu={setMenuAnchor}
            onBack={onBack}
            onHeaderBottom={(y) => {
              headerBottomRef.current = y;
            }}
            showReveal={hostRevealUi}
            revealed={revealedToGuests}
            revealBusy={revealBusy}
            onReveal={toggleReveal}
          />
        </>
      ) : (
        // No-photo variant (the norm): in-flow bar + dark name block. Same
        // OS-boundary header seat as the photo variant.
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View
            style={{ paddingHorizontal: 16 }}
            onLayout={() => {
              // In-flow bar sits ABOVE the scroll viewport — the name passes
              // under it exactly when it scrolls out at y = nameBottom. A
              // photo variant may have left a float-head height in the ref.
              headerBottomRef.current = 0;
            }}
          >
            <IrBar
              title={barTitle}
              titleShown={titleShown}
              craved={craved}
              onCrave={onCrave}
              onMenu={setMenuAnchor}
              onBack={onBack}
              showReveal={hostRevealUi}
              revealed={revealedToGuests}
              revealBusy={revealBusy}
              onReveal={toggleReveal}
            />
          </View>
          {scroll(
            <>
              <NameBlock
                wine={wine}
                blind={blind}
                hostBlind={hostRevealUi}
                revealing={blind && revealedToGuests}
                index={at}
                total={total}
                onNameBottom={(y) => {
                  nameBottomRef.current = y;
                }}
              />
              {body}
            </>,
          )}
        </View>
      )}
      <FootBar
        isFirst={isFirst}
        isLast={isLast}
        saved={autosave.savedState}
        error={autosave.error}
        announce={active}
        onPrevious={onPrevious}
        onNext={onNext}
        onHeight={setFootH}
      />
      {/* .ir-menu options dropdown (shared AnchoredMenu). Host/cohost/provider
          CRUD rows follow the design's separator + danger-row grouping. */}
      <AnchoredMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)} onClosed={onMenuClosed} right={16} minWidth={184}>
        <MenuItem icon="undo" label="Clear My Rating" disabled={!autosave.baselineReady} soon={false} onPress={() => askThenClose('clear')} />
        {canEditImpression ? (
          <>
            <MenuSeparator />
            <MenuItem icon="edit" label="Edit" accessibilityLabel="Edit Impression" onPress={editImpression} />
            <MenuItem icon="trash" label="Delete" accessibilityLabel="Delete Impression" tone="danger" onPress={() => askThenClose('delete')} />
          </>
        ) : null}
      </AnchoredMenu>
    </View>
    </GestureDetector>
  );
});

// ─── header ────────────────────────────────────────────

// Shared bar anatomy (.ir-screen .vbar): back · fading bartitle · [Reveal] ·
// Crave · ⋯. The bartitle fades/slides in over dur-2 like .ir-bartitle.show;
// the Crave (and host Reveal) labels collapse to icon-only once the title is in.
function IrBar({
  title, titleShown, craved, onCrave, onMenu, onBack, glass, solid,
  showReveal = false, revealed = false, revealBusy = false, onReveal,
}: {
  title: string;
  titleShown: boolean;
  craved: boolean;
  onCrave: () => void;
  // Receives the ⋯ button's {top, bottom} in window coords — the AnchoredMenu anchor.
  onMenu: (anchor: MenuAnchor) => void;
  onBack: () => void;
  glass?: boolean;
  solid?: boolean;
  // Host-only reveal/hide control (blind session). eye/"Reveal" when hidden,
  // eye-off/"Hide" when revealed; label collapses with the title like Crave.
  showReveal?: boolean;
  revealed?: boolean;
  revealBusy?: boolean;
  onReveal?: () => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const menuBtnRef = useRef<ViewInstance>(null);
  const anim = useBarTitleProgress(titleShown);

  const onGlass = glass && !solid;
  const iconColor = onGlass ? '#fff' : theme.ink;
  const glassSize = phone.size('heroAction');
  const plainSize = phone.size('compactAction');
  const pillHeight = phone.size('actionPillHeight');
  const circle = onGlass
    ? { width: glassSize, height: glassSize, borderRadius: glassSize / 2, backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const }
    : { width: plainSize, height: plainSize, alignItems: 'center' as const, justifyContent: 'center' as const };

  return (
    // Base 36px row in both variants; scales slightly on roomier phones.
    <View
      pointerEvents={onGlass ? 'box-none' : 'auto'}
      style={{ flexDirection: 'row', alignItems: 'center', height: phone.size('topBar'), marginLeft: glass ? 0 : -6 }}
    >
      {/* The post's close control (Simon, 2026-11-26): its DOWN chevron, the
          back glyph rotated as in the opened post's bar (same stroke and
          size), labelled "Close"; the layer closes by pull-down, the pager
          owns left / right. */}
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onBack} hitSlop={8}
        style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}>
        <View style={{ transform: [{ rotate: '-90deg' }] }}>
          <Icon name="back" size={phone.size('topBarBackIcon')} color={iconColor} />
        </View>
      </Pressable>
      {/* .ir-bartitle: the shared BarTitle (18/600, fades in with a 4pt rise) */}
      <BarTitle title={title} progress={anim} inset={10} onGlass={onGlass} />
      {/* .ir-reveal — host reveal/hide (blind session). Same glass/borderless
          treatment as Crave; label drops once the title hands in. */}
      {showReveal ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? 'Hide from guests' : 'Reveal to guests'}
          accessibilityState={{ disabled: revealBusy }}
          disabled={revealBusy}
          onPress={onReveal}
          hitSlop={6}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: phone.lerp(6, 8),
            height: pillHeight,
            paddingHorizontal: onGlass ? phone.lerp(13, 16) : 4,
            borderRadius: onGlass ? pillHeight / 2 : 0,
            backgroundColor: onGlass ? GLASS_FILL : 'transparent',
            opacity: revealBusy ? 0.5 : pressed ? 0.6 : 1,
          })}
        >
          <Icon name={revealed ? 'eyeoff' : 'eye'} size={phone.size('actionIcon')} color={iconColor} />
          {!titleShown ? (
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: onGlass ? '#fff' : theme.ink }}>
              {revealed ? 'Hide' : 'Reveal'}
            </VText>
          ) : null}
        </Pressable>
      ) : null}
      {/* .ir-crave — heart + label; label collapses once the title shows */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={craved ? 'Remove from cravings' : 'Crave'}
        onPress={onCrave}
        hitSlop={6}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: phone.lerp(6, 8),
          height: pillHeight,
          paddingHorizontal: onGlass ? phone.lerp(13, 16) : 4,
          borderRadius: onGlass ? pillHeight / 2 : 0,
          backgroundColor: onGlass ? GLASS_FILL : 'transparent',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={craved ? 'heart-fill' : 'heart'} size={phone.size('actionIcon')} color={craved ? theme.critical : iconColor} />
        {!titleShown ? (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: craved ? theme.critical : onGlass ? '#fff' : theme.ink }}>
            {craved ? 'Crave!' : 'Crave?'}
          </VText>
        ) : null}
      </Pressable>
      <Pressable
        ref={menuBtnRef}
        accessibilityRole="button"
        accessibilityLabel="More"
        onPress={() =>
          menuBtnRef.current?.measureInWindow((_x, y, _w, h) => onMenu({ top: y, bottom: y + h }))
        }
        hitSlop={8}
        style={({ pressed }) => ({ ...circle, marginLeft: 6, opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="more" size={phone.size('compactActionIcon')} color={iconColor} />
      </Pressable>
    </View>
  );
}

// .ir-floathead — absolute over the hero; transparent + glass controls until
// the title hands in, then solid bg + rule + ink icons.
function FloatHead({
  title, titleShown, craved, onCrave, onMenu, onBack, onHeaderBottom,
  showReveal, revealed, revealBusy, onReveal,
}: {
  title: string;
  titleShown: boolean;
  craved: boolean;
  onCrave: () => void;
  onMenu: (anchor: MenuAnchor) => void;
  onBack: () => void;
  onHeaderBottom: (bottom: number) => void;
  showReveal?: boolean;
  revealed?: boolean;
  revealBusy?: boolean;
  onReveal?: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      onLayout={(e) => onHeaderBottom(e.nativeEvent.layout.height)}
      // Over the photo (transparent) touches between the controls reach the
      // hero and the page's pull-down; once solid it takes them as a bar.
      pointerEvents={titleShown ? 'auto' : 'box-none'}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 8,
        // Seat the bar exactly at the OS-reported safe boundary — the only
        // real "safe to place" signal the phone gives (there is no public
        // dynamic-island frame API; anything above insets.top is per-device
        // guesswork). The mock's hug comes from the slim 36px row, not from
        // encroaching into the status region.
        paddingTop: insets.top,
        paddingHorizontal: 16,
        paddingBottom: 4,
        // Solid opaque when collapsed (no bottom rule); fully transparent over
        // the photo at rest. Rationale: docs/design/decisions/0003-collapsed-bars-opaque.md
        backgroundColor: titleShown ? theme.bg : 'transparent',
      }}
    >
      <IrBar
        title={title}
        titleShown={titleShown}
        craved={craved}
        onCrave={onCrave}
        onMenu={onMenu}
        onBack={onBack}
        glass
        solid={titleShown}
        showReveal={showReveal}
        revealed={revealed}
        revealBusy={revealBusy}
        onReveal={onReveal}
      />
    </View>
  );
}

// ─── footer ────────────────────────────────────────────

const SAVED_COPY: Record<Exclude<SavedState, 'error' | null>, string> = {
  saved: 'Saved',
  local: 'Saved on this phone',
  'cleared-local': 'Cleared on this phone',
};

// .ir-foot — sticky bottom action bar replacing the nav while rating:
// Previous (flex 1) · Next / Finish (flex 1.4), from INDEPENDENT first / last
// (a one-bottle moment: Previous disabled AND Finish). Above them the save
// status slot ("Saved", "Saved on this phone", "Cleared on this phone", an
// error). The bar sits behind the keyboard (ruled 2026-11-25: it doesn't
// move), so "Saved" STAYS until the next change and an error until the next
// good save: either is there when the keyboard closes. The slot keeps its
// line when empty, so the bar never changes height; the content clears its
// MEASURED height (`onHeight`), which follows Dynamic Type. One bar per page:
// it slides with its page (the old screen's replace slid the whole screen).
function FootBar({
  isFirst, isLast, saved, error, announce, onPrevious, onNext, onHeight,
}: {
  isFirst: boolean;
  isLast: boolean;
  saved: SavedState;
  error: string | null;
  // Only the active page speaks an error (a neighbour is off screen).
  announce: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onHeight: (h: number) => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const text = saved === 'error' ? error : saved ? SAVED_COPY[saved] : null;
  useEffect(() => {
    if (announce && saved === 'error' && error) AccessibilityInfo.announceForAccessibility(error);
  }, [announce, saved, error]);
  return (
    // Solid opaque action bar (not transparent; deviates from the mock's
    // blur+wash). A flat theme fill — no BlurView. Rationale:
    // docs/design/decisions/0003-collapsed-bars-opaque.md
    <View
      onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height))}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6, backgroundColor: theme.bg }}
    >
      <VText
        variant="caption"
        color={saved === 'error' ? 'critical' : 'inkSoft'}
        numberOfLines={1}
        style={{ textAlign: 'center', paddingTop: 6, paddingHorizontal: 16 }}
      >
        {text ?? ' '}
      </VText>
      <View style={{ flexDirection: 'row', gap: 10, paddingTop: 4, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}>
        <View style={{ flex: 1 }}>
          <Button title="Previous" variant="secondary" bar block disabled={isFirst} onPress={onPrevious} />
        </View>
        <View style={{ flex: 1.4 }}>
          <Button title={isLast ? 'Finish' : 'Next'} bar block onPress={onNext} />
        </View>
      </View>
    </View>
  );
}
