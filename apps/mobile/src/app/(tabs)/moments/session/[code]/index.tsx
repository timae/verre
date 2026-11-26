import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMomentVisibility, momentVisibilityKey } from '@/lib/api/moments';
import { getVisibility, VISIBILITY_KEY } from '@/lib/api/settings';
import { StatusBar } from 'expo-status-bar';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, useWindowDimensions, View } from 'react-native';
import Reanimated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { VBar } from '@/components/VBar';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { PersonPreviewProvider } from '@/components/moments/PersonPreviewSheet';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { fuzzyIncludes } from '@/lib/search';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import { ApiError, hideAllWines, hideWine, reorderWines, revealAllWines, revealWine, type SessionState, type WireWine } from '@/lib/api/sessions';
import { buildComparePeople, CompareBody, ComparePickerSheet, CompareToolbar, type CompareSort } from '@/components/moments/CompareBody';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { DraggableRows } from '@/components/moments/DraggableRows';
import { SessionMenu, SessionMenuButton, useBlindForEveryoneToggle } from '@/components/moments/SessionMenu';
import { SessionTabs, type SessionTab } from '@/components/moments/SessionTabs';
import { MomentBarName, MomentEditBar, useMomentEdit, type MomentEditApi } from '@/components/moments/MomentEdit';
import { markNoShake } from '@/components/ui/InPlaceEdit';
import { useIsOnline } from '@/lib/query';
import { lockState, useSessionPoll } from '@/lib/useSessionPoll';
import { useOwnRatingsOverlay } from '@/lib/rateOutbox';
import { sessionHref, tabHomeHref, useSessionTab } from '@/lib/sessionStack';
import { momentStatusLine } from '@/lib/momentVisibilityCopy';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { useTheme } from '@/theme';

import { type LuSort, luSearchHay, type RevealProps, swapIn, swapOut, useTabTransition, CoverHeroLineup, HeroTopBar, type LuToolbarProps, LineupToolbar, OvcAbout, LockCard, EmptyLineup, AddImpressionRow, LuRow, CollapsingAdd, LineupAddButton } from '@/components/moments/LineupParts';

// 02b line-up to the vero-screens pixel spec: .sess-meta line, .ovc about
// block, .vtabs, .lurow anatomy, .lock-card with countdown cells, .tempty.
// Milestone 3: rows open the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the score chip. The ⋯ menu wires People + Share
// (sheets), a live Blind-for-all toggle, and Settings (02f, a pushed screen
// stack under settings/); the Compare tab is an IN-SCREEN swap (CompareBody
// below the shared SessionTabs — no route, everything above the tabs stays).
export default function SessionLineup() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowH, width: windowW } = useWindowDimensions();
  const router = useRouter();
  const sessionTab = useSessionTab();
  const navigation = useNavigation();
  const online = useIsOnline();
  const queryClient = useQueryClient();

  // Visit → /state poll → per-section merge, shared with Compare (02d).
  const { meta, wines, ratings, state, fatal, removedKind, visited, retryVisit, myIdentityId, stateKey } =
    useSessionPoll(code);
  // YOUR rows and the sort by your score read your ratings as stored on the
  // phone (the rating outbox: waiting saves + the server's answers), so an
  // offline Finish never leaves them looking unrated. Compare (`ratings`) and
  // what other tasters see keep the server's state until the phone syncs.
  const ownRatings = useOwnRatingsOverlay(code, ratings, myIdentityId);
  // Moment Privacy's read starts here, once the visit has landed (the read is
  // a participant's): the settings hub shows its row only once that read has
  // answered, and started there it drew a round trip after the other rows
  // (device pass 2026-11-25). A 404 (the feature off) simply stays no row.
  const hasMeta = !!meta;
  useEffect(() => {
    if (!visited || !hasMeta) return;
    void queryClient.prefetchQuery({ queryKey: momentVisibilityKey(code), queryFn: () => getMomentVisibility(code), retry: false });
    // Its "Outside This Moment" row reads your own privacy (R15), signed in only.
    if (myIdentityId.startsWith('u:')) void queryClient.prefetchQuery({ queryKey: VISIBILITY_KEY, queryFn: getVisibility, staleTime: 60_000 });
  }, [visited, hasMeta, code, myIdentityId, queryClient]);
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));

  // The moment's top edited in place by its hosts (components/moments/MomentEdit.tsx).
  // Each layout installs its own scroll for keeping the focused field above
  // the keyboard. A cover picked from Add Fields shows (the hero) before Done.
  const scrollByRef = useRef<((dy: number) => void) | null>(null);
  const momentEdit = useMomentEdit({ code, meta, stateKey, canEdit: isHostViewer && !fatal, scrollBy: scrollByRef });
  const edit: MomentEditApi | undefined = isHostViewer && !fatal ? momentEdit : undefined;
  const editing = !!edit?.draft;
  const draftCover = edit?.draft?.cover?.previewUri ?? null;

  // 02b·10: a moment WITH a cover photo gets the full-bleed collapsing hero
  // (the photo runs under the status bar, no VBar). Computed HERE (before the
  // transition hook) so it can be passed in synchronously — the paired-slot
  // two-phase machine is used only by the cover-hero renderer; the plain layout
  // drives its own swap and must settle immediately (a post-effect `paired`
  // would mis-treat a first-frame cover tap as plain). Mirrors the spinner gate
  // below (data-availability, not `visited`) so a warm-cache re-entry shows the
  // hero immediately rather than flashing the plain layout.
  const hasCover = !!meta?.coverPhotoUrl || !!draftCover;
  const heroShown = hasCover && !fatal && !(wines === null && (!visited || state.isPending));

  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [sessMenuTop, setSessMenuTop] = useState<number | null>(null); // ⋯ menu anchor

  // Line-up | Compare is an IN-SCREEN tab swap (Simon's ruling): everything
  // above the tab strip — bar or cover hero — stays put; only the content
  // below swaps. Switching to Compare exits reveal mode (its Done footer and
  // per-row pills are line-up furniture). The cover-hero layout drives the
  // swap through the paired-slot transition (see useTabTransition); the plain
  // (no-cover) layout keeps its own native-sticky swap and only reads `tab`.
  const transition = useTabTransition(windowW, heroShown);
  const tab = transition.tab;
  // No tab switch while the moment is edited in place (the details are
  // Line-up furniture: Compare would unmount their fields mid-edit).
  const selectTab = (t: SessionTab) => {
    if (!editing) transition.select(t);
  };
  // During a transition BOTH tabs are on screen, so the Compare furniture (its
  // toolbar) must exist even while `tab` is momentarily line-up on a reversal.
  const compareMounted = tab === 'compare' || transition.active !== null;

  // 02d people-selector — ONE hidden set drives every compare view (picker
  // sheet rows/presets, person rows, cards). The sticky slot under the bar
  // holds the CompareToolbar (People + sort + search on one line — Simon's
  // 2026-07-03 spec, superseding the avatar-chip rail): plain layout via
  // ScrollView stickyHeaderIndices, cover-hero via the strip overlay slot.
  const [cmpHiddenRaw, setCmpHidden] = useState<Set<string>>(new Set());
  const [cmpPickerOpen, setCmpPickerOpen] = useState(false);
  const [cmpSort, setCmpSort] = useState<CompareSort>('lineup');
  const [cmpQuery, setCmpQuery] = useState('');
  const cmpPeople = useMemo(() => buildComparePeople(ratings, meta), [ratings, meta]);
  // Prune ghosts: someone hidden and THEN kicked/banned leaves the roster —
  // their stale id must not keep the All chip dim / the picker counts wrong.
  const cmpHidden = useMemo(() => {
    const ids = new Set(cmpPeople.map((p) => p.id));
    const pruned = new Set([...cmpHiddenRaw].filter((id) => ids.has(id)));
    return pruned.size === cmpHiddenRaw.size ? cmpHiddenRaw : pruned;
  }, [cmpHiddenRaw, cmpPeople]);
  const toggleCmpPerson = useCallback((id: string) => {
    setCmpHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const showAllCmp = useCallback(() => setCmpHidden(new Set()), []);
  // A roster of one renders no rail/picker — a surviving hidden entry would
  // strand "Nobody selected" with no in-screen recovery. One person needs no
  // selection: clear it.
  useEffect(() => {
    if (cmpPeople.length <= 1 && cmpHiddenRaw.size > 0) setCmpHidden(new Set());
  }, [cmpPeople, cmpHiddenRaw]);
  // The toolbar is useful even on a one-rater roster (sort + search) — it
  // hides only the People button there, so it renders whenever Compare shows.
  // Provisioned whenever Compare is mounted (which, on the cover-hero layout,
  // includes an in-flight transition where `tab` may momentarily be line-up —
  // the paired-slot machine owns when the slot leaves the tree, not `tab`).
  const cmpRail = compareMounted ? (
    <CompareToolbar
      people={cmpPeople}
      hidden={cmpHidden}
      onPick={() => setCmpPickerOpen(true)}
      sort={cmpSort}
      onSort={setCmpSort}
      query={cmpQuery}
      onQuery={setCmpQuery}
      menusSuppressed={transition.active !== null}
    />
  ) : null;

  const canAdd = isHostViewer || !!meta?.providerIds?.includes(myIdentityId);

  // Blind-for-all inline toggle (⋯ menu) — shared mutation, see SessionMenu.tsx.
  const { busy: bfaBusy, toggle: toggleBlindForEveryone } = useBlindForEveryoneToggle(code, myIdentityId);

  // ── Blind reveal/hide (02b) ──────────────────────────────────────────────
  // On a blind session a wine is "revealed to guests" iff it carries a
  // revealedAt. The host sees the real value even when blindForEveryone masks
  // the wine FROM them (redactWine returns the full wine — incl. revealedAt —
  // the moment it's revealed; an unrevealed wine under blindForEveryone comes
  // back _blind with no revealedAt). So !!wine.revealedAt is the single
  // source of truth across both the normal-blind and blind-for-all host views.
  const isBlind = !!meta?.blind;
  const blindForEveryone = !!meta?.blindForEveryone;
  // The host's per-row control surface only exists on a blind session for
  // host/cohost. Providers can't reveal (server rejects), so they get the
  // taster's quiet strip like everyone else.
  const hostRevealUi = isBlind && isHostViewer;
  const hiddenCount = hostRevealUi && wines ? wines.filter((w) => !w.revealedAt).length : 0;

  // Arm-to-reveal (ADR-0007): revealing leaks the identity to guests within a
  // poll tick and can't be truly undone, so the FIRST tap on a hidden photo
  // only ARMS it (accent state + "tap again" hint, auto-disarm after 2.5s);
  // the second tap fires. Hiding has no such guard — it's the undo path and
  // must stay the fastest tap in the room.
  const [armedId, setArmedId] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useCallback(() => {
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedId(null);
  }, []);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  useEffect(() => {
    if (!hostRevealUi) disarm();
  }, [hostRevealUi, disarm]);

  // Optimistic reveal/hide: stamp/clear revealedAt in the cached wines so the
  // row + strip respond immediately, fire the request, let the 5s poll
  // reconcile. `cancelQueries` first so an in-flight poll can't resolve AFTER
  // the optimistic write and clobber it (the classic TanStack race). On error
  // we refetch the server truth rather than restoring a snapshot that a poll
  // may have advanced past mid-flight.
  const [revealBusy, setRevealBusy] = useState(false);
  const runReveal = useCallback(
    async (label: string, optimistic: (wines: WireWine[]) => WireWine[], call: () => Promise<void>) => {
      if (revealBusy) return;
      setRevealBusy(true);
      await queryClient.cancelQueries({ queryKey: stateKey });
      const prev = queryClient.getQueryData<SessionState>(stateKey);
      if (prev?.wines) {
        queryClient.setQueryData<SessionState>(stateKey, { ...prev, wines: optimistic(prev.wines) });
      }
      try {
        await call();
        queryClient.invalidateQueries({ queryKey: ['session-state', code] });
      } catch (e) {
        queryClient.invalidateQueries({ queryKey: ['session-state', code] }); // refetch truth
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        Alert.alert(label, msg || 'Check your connection and try again.');
      } finally {
        setRevealBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revealBusy, code, myIdentityId],
  );
  // A reveal returns the real wine on the next poll; optimistically we only
  // know it's no longer hidden — stamp a placeholder revealedAt (truthy) so the
  // predicate flips. blindForEveryone wines stay _blind locally until the poll
  // brings the un-redacted row, which is fine (the strip count is what reads).
  const onRevealOne = (wineId: string) =>
    runReveal(
      'Could not reveal',
      (ws) => ws.map((w) => (w.id === wineId ? { ...w, revealedAt: new Date().toISOString() } : w)),
      () => revealWine(code, wineId),
    );
  const onHideOne = (wineId: string) =>
    runReveal(
      'Could not hide',
      (ws) => ws.map((w) => (w.id === wineId ? { ...w, revealedAt: null } : w)),
      () => hideWine(code, wineId),
    );
  const onRevealAll = () =>
    runReveal(
      'Could not reveal all',
      (ws) => ws.map((w) => (w.revealedAt ? w : { ...w, revealedAt: new Date().toISOString() })),
      () => revealAllWines(code),
    );
  const onHideAll = () =>
    runReveal(
      'Could not hide all',
      (ws) => ws.map((w) => ({ ...w, revealedAt: null })),
      () => hideAllWines(code),
    );

  // Hosts/cohosts are exempt from the hide-lineup gate (the server returns
  // their wines) — only treat it as locked for non-host viewers whose list
  // came back empty.
  const lock = !isHostViewer && wines !== null && wines.length === 0 ? lockState(meta) : null;
  // Passive reconnecting strip (this screen polls every 5s and recovers on its
  // own). Covers both !online (device) and isError-with-stale-data (server).
  // Never over a fatal view: the poll has stopped, and a gone moment still
  // holds its last data (lastRef), which would claim a reconnect.
  const showReconnecting = !fatal && (!online || (state.isError && (wines !== null || meta !== null)));
  // Every back control on this screen (bar chevron, cover-hero back, the fatal
  // view's Back). With nothing below the moment on its own stack (a cold link
  // opened it as the Moments tab's first screen) router.back() falls through
  // to the tab navigator, whose default goes to the FIRST tab (Feed): land on
  // this tab's home instead.
  const goBack = () => {
    if ((navigation.getState()?.index ?? 0) > 0) router.back();
    else router.replace(tabHomeHref(sessionTab.tab));
  };

  // heroShown + hasCover are computed above (before the transition hook, so
  // `paired` flows into it synchronously).
  // Only the .hero-topfix collapse (bar bg + title past 150px) needs to live
  // in React state — and it flips at most once per scroll direction, so the
  // child reports it as a boolean that we set ONLY on change (a raw scrollY in
  // state would re-render the whole screen every frame). The on-photo title
  // fade is a native-driven Animated.Value owned by the child — no re-render.
  const [heroCollapsed, setHeroCollapsed] = useState(false);

  // D1 (Moment Defaults): while YOU are Incognito or hidden from feeds here,
  // whatever set it, a line under the date says so with "Change" (Moment
  // Privacy). From Moment Privacy's read (prefetched above; this observer only
  // keeps it current). Not on the look-in, not while a host edits in place.
  const privacyRead = useQuery({ queryKey: momentVisibilityKey(code), queryFn: () => getMomentVisibility(code), enabled: visited && hasMeta, retry: false });
  const statusLine = momentStatusLine(privacyRead.data?.me);
  const status = statusLine ? { line: statusLine, onChange: () => router.push(sessionHref(sessionTab, 'settings/visibility', { code }), { dangerouslySingular: true }) } : null;
  // Shared OvcAbout — same props in both layouts.
  const ovc = meta ? (
    <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPeople={() => setPeopleOpen(true)} edit={edit} status={status} />
  ) : null;
  const openImpression = (wineId: string) =>
    router.push(sessionHref(sessionTab, 'impression/[wineId]', { code, wineId }), { dangerouslySingular: true });
  const openAdd = () => router.push(sessionHref(sessionTab, 'add', { code }));

  // First tap arms; the second (while armed) fires the reveal.
  const onThumbTap = (wineId: string) => {
    if (armedId === wineId) {
      disarm();
      onRevealOne(wineId);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedId(wineId);
    armTimer.current = setTimeout(() => setArmedId(null), 2500);
  };
  const reveal: RevealProps = {
    hostRevealUi,
    revealBusy,
    total: wines?.length ?? 0,
    hiddenCount,
    blindForEveryone,
    bfaBusy,
    armedId,
    onThumbTap,
    onHideOne,
    onRevealAll,
    onHideAll,
    onToggleBlindForEveryone: toggleBlindForEveryone,
  };

  // ── line-up search + sort (toolbar; counts/reveal stay on the FULL list) ──
  const [luQuery, setLuQuery] = useState('');
  const [luSort, setLuSort] = useState<LuSort>('lineup');
  // The wine's true position — .lu-idx and "Impression N" never renumber
  // under a different sort or a search that hides rows.
  const luIndexById = useMemo(() => new Map((wines ?? []).map((w, i) => [w.id, i] as const)), [wines]);
  const shownWines = useMemo(() => {
    const all = wines ?? [];
    const q = luQuery.trim();
    const myScore = (w: WireWine) => ownRatings?.[myIdentityId]?.ratings[w.id]?.score ?? 0;
    const idx = (w: WireWine) => luIndexById.get(w.id) ?? 0;
    const base = q ? all.filter((w) => fuzzyIncludes(luSearchHay(w, idx(w)), q)) : all;
    if (luSort === 'lineup') return base;
    const fns: Record<Exclude<LuSort, 'lineup'>, (a: WireWine, b: WireWine) => number> = {
      top: (a, b) => (myScore(b) || -1) - (myScore(a) || -1) || idx(a) - idx(b),
      bottom: (a, b) => (myScore(a) || 999) - (myScore(b) || 999) || idx(a) - idx(b),
      unrated: (a, b) => (myScore(a) > 0 ? 1 : 0) - (myScore(b) > 0 ? 1 : 0) || idx(a) - idx(b),
    };
    return [...base].sort(fns[luSort]);
  }, [wines, luQuery, luSort, ownRatings, myIdentityId, luIndexById]);
  const luNarrowed = luQuery.trim() !== '';
  // Denied-hold signal → the toolbar explains itself (note + accent flash on
  // the control that blocks reordering).
  const [deniedTick, setDeniedTick] = useState(0);
  const onReorderDenied = useCallback(() => setDeniedTick((t) => t + 1), []);
  const reorderDeniedNote =
    luSort !== 'lineup' && luNarrowed
      ? 'Clear the search and sorting to reorder'
      : luSort !== 'lineup'
        ? 'Turn off sorting to reorder'
        : 'Clear the search to reorder';
  // ── drag-to-reorder (host tier; web parity — allowed on blind too, the
  // renumbering of guests' "Impression N" is the host's call). Drag needs the
  // TRUE order on screen: an active sort or search disables it (denied hold =
  // warning haptic) — reordering a projection would silently move rows you
  // can't see between.
  // !revealBusy: runReveal (the shared optimistic-mutation runner) silently
  // drops calls while one is in flight — a drop that lands during a busy
  // window would freeze mid-handoff (codex P2). The boolean return below
  // covers the race where busy flips between lift and drop.
  const canReorder = isHostViewer && !lock && !revealBusy && luSort === 'lineup' && !luNarrowed && (wines?.length ?? 0) > 1;
  const reorderDenied = isHostViewer && !lock && (luSort !== 'lineup' || luNarrowed);
  const onReorder = (orderedIds: string[]): boolean => {
    if (revealBusy) return false; // refused — the drag resets itself
    void runReveal(
      'Could not reorder',
      (ws) => {
        const byId = new Map(ws.map((w) => [w.id, w]));
        const next = orderedIds.map((id) => byId.get(id)).filter(Boolean) as WireWine[];
        // A permutation must not drop rows (a poll may have added a wine
        // mid-drag) — anything missing from orderedIds keeps its tail spot.
        for (const w of ws) if (!next.includes(w)) next.push(w);
        return next;
      },
      () => reorderWines(code, orderedIds),
    );
    return true;
  };
  // No size threshold (Simon): the toolbar always renders on the line-up.
  const luToolbar: LuToolbarProps = {
    reveal,
    query: luQuery,
    onQuery: setLuQuery,
    sort: luSort,
    onSort: setLuSort,
    deniedTick,
    menusSuppressed: transition.active !== null,
  };

  // Plain-layout scroll plumbing for drag-to-reorder: the rows need a live
  // offset + max-scroll for the auto-scroll loop (the hero measures its own).
  const plainRef = useAnimatedRef<Reanimated.ScrollView>();
  // This parent also renders the cover-hero branch, where plainRef has no
  // scroll view. An explicit handler keeps the shared offset without asking
  // useScrollOffset to attach to an intentionally unmounted ref.
  const plainScrollY = useSharedValue(0);
  const onPlainScroll = useAnimatedScrollHandler((event) => {
    plainScrollY.value = event.contentOffset.y;
  });
  const plainMaxScroll = useSharedValue(0);
  const plainContentH = useRef(0);
  const plainViewportH = useRef(0);
  // The plain layout's scroll for the in-place edit (the hero installs its own).
  useEffect(() => {
    if (heroShown) return;
    scrollByRef.current = (dy) => plainRef.current?.scrollTo({ y: plainScrollY.value + dy, animated: true });
  }, [heroShown, plainRef, plainScrollY]);
  // While editing: the pill is hidden and the list clears the keyboard + bar.
  const listBottom = Math.max(TAB_BAR_CLEARANCE, edit?.bottomInset ?? 0);
  // Everything but the fields dims and goes inert IN PLACE while editing (a
  // tap there shakes the edit bar); never a remount (no wrapper that comes and goes).
  const inertProps = {
    pointerEvents: editing ? ('none' as const) : ('auto' as const),
    accessibilityElementsHidden: editing,
    importantForAccessibility: editing ? ('no-hide-descendants' as const) : ('auto' as const),
  };
  const dim = { opacity: editing ? 0.35 : 1 };
  const wineById = useMemo(() => new Map((wines ?? []).map((w) => [w.id, w] as const)), [wines]);
  // Light glyphs only while the photo is actually under the status bar. The
  // reconnecting strip covers the notch with surfaceSunk, so glyphs revert to
  // the theme default (light glyphs would vanish on it).
  const statusBarStyle = heroShown && !heroCollapsed && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark';
  // On an opened post's stack the screen option below is never consulted
  // (the post is a modal): forward it to the root (lib/forwardedStatusBar).
  useForwardStatusBarStyle(statusBarStyle);

  // Prototype order (tListEmpty/tHiddenCountdown): vbar → tabs → scroll body
  // (ovc → rows). Tabs sit OUTSIDE the scroll area; the lock variant has none.
  // The cover-hero variant (02b·10) replaces the vbar with a full-bleed photo
  // header + a collapsing top bar, with the tabs + body inside one scroll view.
  return (
    // BottomSheetModalProvider lives INSIDE the screen (not the root _layout):
    // with expo-router/react-native-screens a root provider's gorhom host gets
    // zero height across the Stack boundary and sheets never present (gorhom
    // #1884/#2035). Hosting it in this screen's flex:1 View gives the sheets a
    // sized provider + portal host.
    <BottomSheetModalProvider>
    {/* A person tapped anywhere on this screen (People, Compare's Show All,
        Aroma Details): one preview sheet, closed on a fatal state. */}
    <PersonPreviewProvider code={code} meta={fatal ? null : meta} myIdentityId={myIdentityId}>
    {/* The hero variant runs the photo under the status bar, so its container
        drops the safe-area top padding (the floating bar re-applies it). */}
    {/* While a host edits in place, a tap outside the fields, the edit bar
        and Back shakes the bar (spread ALWAYS: editTouchHandlers). */}
    <View style={{ flex: 1, paddingTop: heroShown ? 0 : insets.top + 8 }} {...momentEdit.touchHandlers}>
      {/* iOS reads the screen option (root _layout: screen traits are the only
          status-bar channel there; the deepest screen with one set wins over
          the root's themed default). Android goes through expo-status-bar,
          kept always mounted: it is last-mounted-wins and does NOT restore on
          unmount, so a conditional bar would leave white glyphs stuck if the
          cover is removed mid-screen. */}
      <Stack.Screen options={{ statusBarStyle }} />
      <StatusBar style={statusBarStyle} />
      {!heroShown ? (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar
            title={meta?.name ?? ''}
            titleSlot={edit && meta ? <MomentBarName name={meta.name} edit={edit} /> : undefined}
            onBack={goBack}
            backCapture={markNoShake}
            right={
              meta && !fatal ? (
                <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, dim]} {...inertProps}>
                  {/* Plain bar: the full accent "+ Add" pill (no scroll-collapse
                      here), left of the ⋯. Host/cohost/provider only — and
                      line-up furniture (morphs into the ⋯ on the Compare tab). */}
                  {canAdd ? (
                    <CollapsingAdd show={tab === 'lineup'}>
                      <LineupAddButton onPress={openAdd} />
                    </CollapsingAdd>
                  ) : null}
                  <SessionMenuButton onOpen={(top) => setSessMenuTop(top)} />
                </View>
              ) : undefined
            }
          />
        </View>
      ) : null}
      {/* Session ⋯ menu (.sess-menu): Blind-for-all (live toggle), People,
          Share, Settings. Share intentionally lives in BOTH the menu and the
          Settings hub (Simon's ruling). Menu + sheets unmount on a fatal
          (removed/gone) — a kicked user must not keep stale session overlays
          over the terminal view. */}
      {!fatal ? (
        <SessionMenu
          anchorTop={sessMenuTop}
          onClose={() => setSessMenuTop(null)}
          onPeople={() => { setSessMenuTop(null); setPeopleOpen(true); }}
          onShare={() => { setSessMenuTop(null); setInviteOpen(true); }}
          onSettings={() => { setSessMenuTop(null); router.push(sessionHref(sessionTab, 'settings', { code })); }}
        />
      ) : null}
      {meta && !fatal ? (
        <ComparePickerSheet
          open={cmpPickerOpen}
          onClose={() => setCmpPickerOpen(false)}
          people={cmpPeople}
          hidden={cmpHidden}
          myIdentityId={myIdentityId}
          blocksOut={meta.viewerBlocksOut}
          blocksIn={meta.viewerBlocksIn}
          onToggle={toggleCmpPerson}
          onAll={showAllCmp}
          onJustMe={() => setCmpHidden(new Set(cmpPeople.filter((p) => p.id !== myIdentityId).map((p) => p.id)))}
          onMeAndFriends={(friendIds) =>
            setCmpHidden(new Set(cmpPeople.filter((p) => p.id !== myIdentityId && !friendIds.has(p.id)).map((p) => p.id)))
          }
        />
      ) : null}
      {meta && !fatal ? (
        <>
          <InviteSheet
            open={inviteOpen}
            onClose={() => setInviteOpen(false)}
            code={code}
            momentName={meta.name}
            // Block-scrub before deriving "Joined": meta.participants ships the
            // FULL list; per-viewer block filtering is client-side via
            // viewerBlocksOut/In (mirrors web SessionPanel). Without this, a
            // blocked friend could light up as "Joined" — a block-boundary leak.
            participantIds={
              new Set(
                (meta.participants ?? [])
                  .filter((p) => !meta.viewerBlocksOut.includes(p.id) && !meta.viewerBlocksIn.includes(p.id))
                  .map((p) => p.id),
              )
            }
          />
          <PeopleSheet
            open={peopleOpen}
            onClose={() => setPeopleOpen(false)}
            code={code}
            meta={meta}
            myIdentityId={myIdentityId}
            onInvite={() => setInviteOpen(true)}
          />
        </>
      ) : null}
      {/* Reconnecting bar (passive — this screen auto-retries; copy names the
          problem AND that it's retrying so the user knows without acting).
          Overlaid on top; on the cover-hero it briefly sits over the floating
          back/⋯ buttons during the blip — accepted for a transient state. */}
      {showReconnecting ? <ReconnectingBar /> : null}
      {fatal ? (
        <SessionFatalView fatal={fatal} removedKind={removedKind} sessionLabel={meta?.name ?? null}
          onRetry={retryVisit} onBack={goBack} />
      ) : wines === null && (!visited || state.isPending) ? (
        // Spinner only when there's nothing to render — re-entering the
        // screen finds the shared query cache warm, and the re-visit runs in
        // the background. (Tab flips are in-screen and never remount the
        // poll hook.)
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : heroShown && meta ? (
        // 02b·10 — cover-hero layout. The photo, tabs, ovc + rows live in ONE
        // scroll view (small wine lists, like the impression screen); the
        // collapsing bar floats above it.
        <CoverHeroLineup
          meta={meta}
          coverUrl={draftCover ?? meta.coverPhotoUrl!}
          edit={edit}
          scrollByRef={scrollByRef}
          bottomPad={listBottom}
          lock={lock}
          // Search/sort applied (counts in `reveal` stay full-list); indexById
          // keeps true line-up numbers under any order.
          wines={shownWines}
          indexById={luIndexById}
          luNarrowed={luNarrowed}
          toolbar={luToolbar}
          reorder={{ enabled: canReorder, denied: reorderDenied, deniedNote: reorderDeniedNote, onCommit: onReorder, onDenied: onReorderDenied }}
          ratings={ownRatings}
          myIdentityId={myIdentityId}
          canAdd={canAdd}
          windowH={windowH}
          windowW={windowW}
          ovc={ovc}
          reveal={reveal}
          transition={transition}
          onSelectTab={selectTab}
          compare={<CompareBody wines={wines} ratings={ratings} meta={meta} locked={!!lock} hidden={cmpHidden} sort={cmpSort} query={cmpQuery} />}
          compareRail={cmpRail}
          onCollapsedChange={setHeroCollapsed}
          onPressWine={openImpression}
          onAdd={openAdd}
        />
      ) : lock ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}>
          <LockCard revealAt={lock} />
          {ovc}
        </ScrollView>
      ) : (
        <>
          <View style={[{ paddingHorizontal: GUTTER }, dim]} {...inertProps}>
            <SessionTabs active={tab} onSelect={selectTab} />
          </View>
          {tab === 'compare' ? (
            // The toolbar is child 0 + stickyHeaderIndices so it pins under
            // the fixed tabs on scroll (the plain layout's native-sticky path
            // — same behaviour the reveal strip has on the line-up).
            <Reanimated.View key="pane-compare" style={[{ flex: 1 }, dim]} {...inertProps} entering={transition.everSwapped ? swapIn('compare') : undefined} exiting={swapOut('compare')}>
              <ScrollView
                style={{ flex: 1 }}
                stickyHeaderIndices={cmpRail ? [0] : undefined}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{ flexGrow: 1, paddingBottom: TAB_BAR_CLEARANCE }}
              >
                {cmpRail ? <View style={{ backgroundColor: theme.bg }}>{cmpRail}</View> : null}
                <CompareBody wines={wines} ratings={ratings} meta={meta} locked={!!lock} hidden={cmpHidden} sort={cmpSort} query={cmpQuery} />
              </ScrollView>
            </Reanimated.View>
          ) : (
          <Reanimated.View key="pane-lineup" style={{ flex: 1 }} entering={transition.everSwapped ? swapIn('lineup') : undefined} exiting={swapOut('lineup')}>
          {/* The eye-menu toolbar sits right above the rows (the old strip's
              spot, below the ovc) and pins under the fixed tabs on scroll —
              now via ScrollView stickyHeaderIndices (the list left FlatList
              for drag-to-reorder: translated rows + virtualization don't mix,
              and a tasting's line-up doesn't need recycling). The sticky index
              counts RENDERED children, so it keys on `ovc` (null on a degraded
              meta poll — React.Children.toArray skips null). */}
          <Reanimated.ScrollView
            ref={plainRef}
            onScroll={onPlainScroll}
            style={{ flex: 1 }}
            stickyHeaderIndices={[ovc ? 1 : 0]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onLayout={(e) => {
              plainViewportH.current = e.nativeEvent.layout.height;
              plainMaxScroll.value = Math.max(0, plainContentH.current - plainViewportH.current);
            }}
            onContentSizeChange={(w, h) => {
              plainContentH.current = h;
              plainMaxScroll.value = Math.max(0, h - plainViewportH.current);
            }}
            contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: listBottom }}
          >
            {ovc}
            {/* Solid bg so rows scrolling under the pinned toolbar don't
                bleed through (content-width fill matches the rows' inset). */}
            <View style={{ backgroundColor: theme.bg }} {...inertProps}>
              <View style={dim}>
                <LineupToolbar toolbar={luToolbar} />
              </View>
            </View>
            {/* The rows: dimmed + inert in place while the moment is edited. */}
            <View style={dim} {...inertProps}>
            {shownWines.length === 0 ? (
              luNarrowed ? (
                <VText variant="small" color="inkSoft" style={{ paddingTop: 16 }}>No impressions match.</VText>
              ) : (
                <EmptyLineup canAdd={canAdd} onAdd={openAdd} />
              )
            ) : (
              <DraggableRows
                ids={shownWines.map((w) => w.id)}
                enabled={canReorder}
                denied={reorderDenied}
                deniedNote={reorderDeniedNote}
                onDenied={onReorderDenied}
                scrollRef={plainRef}
                scrollY={plainScrollY}
                maxScrollY={plainMaxScroll}
                onCommit={onReorder}
                renderRow={(id, i, move) => {
                  const item = wineById.get(id);
                  if (!item) return null;
                  return (
                    <>
                      {i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
                      <LuRow
                        wine={item}
                        // The wine's TRUE line-up position — search/sort must
                        // never renumber rows.
                        index={luIndexById.get(id) ?? 0}
                        myIdentityId={myIdentityId}
                        ratings={ownRatings}
                        onPress={() => openImpression(id)}
                        reveal={reveal}
                        move={move}
                      />
                    </>
                  );
                }}
              />
            )}
            {shownWines.length > 0 && canAdd && !luNarrowed ? <AddImpressionRow onPress={openAdd} /> : null}
            </View>
          </Reanimated.ScrollView>
          </Reanimated.View>
          )}
        </>
      )}
      {/* .hero-topfix — floats over the hero: transparent with glass back+⋯
          while the photo title is visible, then a solid theme bar carrying the
          moment name once scrolled past the collapse point. Sits last so it
          paints above the scroll content; below the SessionMenu (a Modal). */}
      {heroShown && meta ? (
        <HeroTopBar
          title={meta.name}
          collapsed={heroCollapsed}
          // The Add pill is line-up furniture (Simon's ruling) — on Compare it
          // morphs into the ⋯ (CollapsingAdd inside the bar).
          canAdd={canAdd}
          showAdd={tab === 'lineup'}
          onAdd={openAdd}
          onBack={goBack}
          onMenu={(top) => setSessMenuTop(top)}
          inert={editing}
        />
      ) : null}
      {/* The in-place edit's bar (rides the keyboard) + its date sheet. */}
      {edit && meta ? <MomentEditBar edit={edit} hasCover={hasCover} lineup={tab === 'lineup'} /> : null}
    </View>
    </PersonPreviewProvider>
    </BottomSheetModalProvider>
  );
}
