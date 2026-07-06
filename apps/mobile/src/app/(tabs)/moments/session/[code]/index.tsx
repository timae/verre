import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Image, Linking, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import Reanimated, { clamp, Easing as ReEasing, interpolate, ReduceMotion, type SharedValue, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight, useAnimatedProps, useAnimatedRef, useAnimatedStyle, useScrollOffset, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

const MorphPath = Reanimated.createAnimatedComponent(Path);
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { VBar } from '@/components/VBar';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { GLASS_FILL, GUTTER, HERO_RATIO, HERO_SCRIM, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { fuzzyIncludes } from '@/lib/search';
import { alpha } from '@/theme/color';
import { StarScore } from '@/components/scoring/StarScore';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import {
  ApiError,
  hideAllWines,
  hideWine,
  reorderWines,
  revealAllWines,
  revealWine,
  type RatingsView,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { buildComparePeople, CompareBody, ComparePickerSheet, CompareToolbar, type CompareSort } from '@/components/moments/CompareBody';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { SheetSearchField } from '@/components/moments/CompareBody';
import { DraggableRows, type RowMoveActions } from '@/components/moments/DraggableRows';
import { AnchoredMenu, MenuItem, MenuSeparator } from '@/components/ui/AnchoredMenu';
import { SessionMenu, SessionMenuButton, useBlindForEveryoneToggle } from '@/components/moments/SessionMenu';
import { SessionTabs, type SessionTab } from '@/components/moments/SessionTabs';
import { DATE_LOCALE } from '@/lib/locale';
import { sessionWhen, wineTypeLabel } from '@/lib/momentFormat';
import { useIsOnline } from '@/lib/query';
import { lockState, useSessionPoll } from '@/lib/useSessionPoll';
import { motion, radius, useTheme } from '@/theme';

// HERO_RATIO/GUTTER now in lib/layout.ts (the cover hero is .hero-bleed-top, a
// full-bleed photo under the status bar; HERO_RATIO is now shared with — and
// equal to — the impression hero's, per Simon's ruling).
// The floating bar collapses (blur bg + title) when the on-photo title scrolls
// under it — a MEASURED threshold (titleBottom − BAR_H), computed in
// CoverHeroLineup, not a magic scroll constant (which mis-fired on a
// proportional-height hero). Mirrors the impression hero's collapse-by-measure.

type MetaView = SessionState['meta'];

// Blind reveal/hide surface (direct-manipulation redesign, Simon 2026-07-04 —
// ADR-0007, supersedes the two-state reveal MODE): the photo IS the control.
// Hidden → tap arms ("tap again to reveal", 2.5s auto-disarm), second tap
// reveals; revealed → the corner eye hides instantly (the damage-control
// direction stays fastest). Bulk actions + Blind-for-all live in the eye menu
// on the toolbar line under the tabs. Bundled so both layouts take one prop.
// Line-up sort (toolbar menu; mirrors the compare toolbar's model). Scores
// are the VIEWER'S own. Sorting never renumbers — .lu-idx keeps the wine's
// true line-up position via the indexById map.
type LuSort = 'lineup' | 'top' | 'bottom' | 'unrated';
// 'lineup' is the DEFAULT state, not a menu row: tapping the active sort
// again toggles it off, back to line-up order (Simon's ruling — same toggle
// in the compare sort menu).
const LU_SORTS: { key: Exclude<LuSort, 'lineup'>; label: string }[] = [
  { key: 'top', label: 'My highest rated' },
  { key: 'bottom', label: 'My lowest rated' },
  { key: 'unrated', label: 'Not rated first' },
];

// Same forgiving matcher + field set as Compare's impression search; a blind
// stub matches only its displayed "Impression N" label.
function luSearchHay(wine: WireWine, lineupIndex: number): string {
  if (wine._blind) return `Impression ${lineupIndex + 1}`;
  return [wine.name, wine.producer, wine.vintage, wine.grape, wine.type, wineTypeLabel(wine.type), wine.region, wine.country]
    .filter(Boolean)
    .join(' ');
}

type RevealProps = {
  hostRevealUi: boolean;
  revealBusy: boolean;
  total: number;
  hiddenCount: number;
  blindForEveryone: boolean;
  bfaBusy: boolean;
  /** Wine currently armed for reveal (first tap landed, awaiting confirm). */
  armedId: string | null;
  onThumbTap: (wineId: string) => void;
  onHideOne: (wineId: string) => void;
  onRevealAll: () => void;
  onHideAll: () => void;
  onToggleBlindForEveryone: (next: boolean) => void;
};

// Collapsed HeroTopBar's painted height = safe-area top + the control row +
// 6pt bottom pad. No bottom rule to account for (the collapsed bar is a flat
// opaque fill, no border — ADR-0003). The cover-hero sticky pin offset derives
// from this so the tabs/strip pin flush under the bar; overlays then pin at
// PIN_Y = this − 1 (1px overlap) against sub-pixel rounding. Shared with
// HeroTopBar so the two can't drift.
const heroBarHeight = (insetTop: number, controlSize: number) => insetTop + controlSize + 6;

// In-screen tab-swap motion (Simon's ask): the panes swap as one horizontal
// push — the incoming pane slides in from the side it lives on (Compare from
// the right, Line-up from the left) while the outgoing pane slides OUT toward
// its own side. Equal durations keep the seam between the two exactly at the
// screen edge mid-flight. Entering is gated on a "user actually switched" ref
// so the screen's first render doesn't slide. `exiting` fires on ANY unmount,
// not just tab swaps — accepted trade-off (Simon wants the push): on a screen
// pop the ghost plays inside the departing screen (invisible); the rare
// fatal/lock swaps get a stray slide-out that reads as content leaving.
// ReduceMotion.System: the OS accessibility setting collapses the slide to
// an instant swap (codex — no reduced-motion gate existed in the app).
const swapIn = (tab: SessionTab) => (tab === 'compare' ? SlideInRight : SlideInLeft).duration(motion.dur3).reduceMotion(ReduceMotion.System);
const swapOut = (tab: SessionTab) => (tab === 'compare' ? SlideOutRight : SlideOutLeft).duration(motion.dur3).reduceMotion(ReduceMotion.System);

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
  const { height: windowH } = useWindowDimensions();
  const router = useRouter();
  const online = useIsOnline();
  const queryClient = useQueryClient();

  // Visit → /state poll → per-section merge, shared with Compare (02d).
  const { meta, wines, ratings, state, fatal, removedKind, visited, retryVisit, myIdentityId, stateKey } =
    useSessionPoll(code);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [sessMenuTop, setSessMenuTop] = useState<number | null>(null); // ⋯ menu anchor

  // Line-up | Compare is an IN-SCREEN tab swap (Simon's ruling): everything
  // above the tab strip — bar or cover hero — stays put; only the content
  // below swaps. Switching to Compare exits reveal mode (its Done footer and
  // per-row pills are line-up furniture).
  const [tab, setTab] = useState<SessionTab>('lineup');
  // Flips true on the first user switch — the swap slide-in must not run on
  // the screen's initial mount (see swapIn).
  const tabSwapped = useRef(false);
  const selectTab = (t: SessionTab) => {
    tabSwapped.current = true;
    setTab(t);
  };

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
  const cmpRail = tab === 'compare' ? (
    <CompareToolbar
      people={cmpPeople}
      hidden={cmpHidden}
      onPick={() => setCmpPickerOpen(true)}
      sort={cmpSort}
      onSort={setCmpSort}
      query={cmpQuery}
      onQuery={setCmpQuery}
    />
  ) : null;

  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
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
  const showReconnecting = !online || (state.isError && (wines !== null || meta !== null));

  // 02b·10: a moment WITH a cover photo gets the full-bleed collapsing hero
  // (the photo runs under the status bar, no VBar). Without a cover the screen
  // keeps its plain VBar layout untouched. The hero shows on the normal AND
  // lock states once we're past loading and not in a fatal state.
  const hasCover = !!meta?.coverPhotoUrl;
  // Mirrors the spinner gate below (data-availability, not `visited`) — on a
  // warm-cache re-entry of the screen the hero must show immediately, not
  // flash the plain layout for the background re-visit's round-trip.
  const heroShown = hasCover && !fatal && !(wines === null && (!visited || state.isPending));
  // Only the .hero-topfix collapse (bar bg + title past 150px) needs to live
  // in React state — and it flips at most once per scroll direction, so the
  // child reports it as a boolean that we set ONLY on change (a raw scrollY in
  // state would re-render the whole screen every frame). The on-photo title
  // fade is a native-driven Animated.Value owned by the child — no re-render.
  const [heroCollapsed, setHeroCollapsed] = useState(false);

  // Shared OvcAbout — same props in both layouts.
  const ovc = meta ? (
    <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPeople={() => setPeopleOpen(true)} />
  ) : null;
  const openImpression = (wineId: string) =>
    router.push({ pathname: '/(tabs)/moments/session/[code]/impression/[wineId]', params: { code, wineId } });
  const openAdd = () => router.push({ pathname: '/(tabs)/moments/session/[code]/add', params: { code } });

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
    const myScore = (w: WireWine) => ratings?.[myIdentityId]?.ratings[w.id]?.score ?? 0;
    const idx = (w: WireWine) => luIndexById.get(w.id) ?? 0;
    const base = q ? all.filter((w) => fuzzyIncludes(luSearchHay(w, idx(w)), q)) : all;
    if (luSort === 'lineup') return base;
    const fns: Record<Exclude<LuSort, 'lineup'>, (a: WireWine, b: WireWine) => number> = {
      top: (a, b) => (myScore(b) || -1) - (myScore(a) || -1) || idx(a) - idx(b),
      bottom: (a, b) => (myScore(a) || 999) - (myScore(b) || 999) || idx(a) - idx(b),
      unrated: (a, b) => (myScore(a) > 0 ? 1 : 0) - (myScore(b) > 0 ? 1 : 0) || idx(a) - idx(b),
    };
    return [...base].sort(fns[luSort]);
  }, [wines, luQuery, luSort, ratings, myIdentityId, luIndexById]);
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
  };

  // Plain-layout scroll plumbing for drag-to-reorder: the rows need a live
  // offset + max-scroll for the auto-scroll loop (the hero measures its own).
  const plainRef = useAnimatedRef<Reanimated.ScrollView>();
  const plainScrollY = useScrollOffset(plainRef);
  const plainMaxScroll = useSharedValue(0);
  const plainContentH = useRef(0);
  const plainViewportH = useRef(0);
  const wineById = useMemo(() => new Map((wines ?? []).map((w) => [w.id, w] as const)), [wines]);

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
    {/* The hero variant runs the photo under the status bar, so its container
        drops the safe-area top padding (the floating bar re-applies it). */}
    <View style={{ flex: 1, paddingTop: heroShown ? 0 : insets.top + 8 }}>
      {/* Always mounted (expo-status-bar is last-mounted-wins and does NOT
          restore on unmount — a conditional bar would leave white glyphs stuck
          if the cover is removed mid-screen). White only over the hero photo
          pre-collapse; the theme default everywhere else. */}
      <StatusBar
        // Light glyphs only while the photo is actually under the status bar.
        // The reconnecting strip covers the notch with surfaceSunk, so glyphs
        // revert to the theme default (light glyphs would vanish on it).
        style={heroShown && !heroCollapsed && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark'}
      />
      {!heroShown ? (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar
            title={meta?.name ?? ''}
            right={
              meta ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
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
          onSettings={() => { setSessMenuTop(null); router.push({ pathname: '/(tabs)/moments/session/[code]/settings', params: { code } }); }}
        />
      ) : null}
      {meta && !fatal ? (
        <ComparePickerSheet
          open={cmpPickerOpen}
          onClose={() => setCmpPickerOpen(false)}
          people={cmpPeople}
          hidden={cmpHidden}
          myIdentityId={myIdentityId}
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
          onRetry={retryVisit} onBack={() => router.back()} />
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
          coverUrl={meta.coverPhotoUrl!}
          lock={lock}
          // Search/sort applied (counts in `reveal` stay full-list); indexById
          // keeps true line-up numbers under any order.
          wines={shownWines}
          indexById={luIndexById}
          luNarrowed={luNarrowed}
          toolbar={luToolbar}
          reorder={{ enabled: canReorder, denied: reorderDenied, deniedNote: reorderDeniedNote, onCommit: onReorder, onDenied: onReorderDenied }}
          ratings={ratings}
          myIdentityId={myIdentityId}
          canAdd={canAdd}
          windowH={windowH}
          ovc={ovc}
          reveal={reveal}
          tab={tab}
          onSelectTab={selectTab}
          compare={<CompareBody wines={wines} ratings={ratings} meta={meta} locked={!!lock} hidden={cmpHidden} sort={cmpSort} query={cmpQuery} />}
          compareRail={cmpRail}
          swapAnimated={tabSwapped.current}
          onCollapsedChange={setHeroCollapsed}
          onPressWine={openImpression}
          onAdd={openAdd}
        />
      ) : lock ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}>
          <LockCard revealAt={lock} />
          {ovc}
        </ScrollView>
      ) : (
        <>
          <View style={{ paddingHorizontal: GUTTER }}>
            <SessionTabs active={tab} onSelect={selectTab} />
          </View>
          {tab === 'compare' ? (
            // The toolbar is child 0 + stickyHeaderIndices so it pins under
            // the fixed tabs on scroll (the plain layout's native-sticky path
            // — same behaviour the reveal strip has on the line-up).
            <Reanimated.View key="pane-compare" style={{ flex: 1 }} entering={tabSwapped.current ? swapIn('compare') : undefined} exiting={swapOut('compare')}>
              <ScrollView
                style={{ flex: 1 }}
                stickyHeaderIndices={cmpRail ? [0] : undefined}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
              >
                {cmpRail ? <View style={{ backgroundColor: theme.bg }}>{cmpRail}</View> : null}
                <CompareBody wines={wines} ratings={ratings} meta={meta} locked={!!lock} hidden={cmpHidden} sort={cmpSort} query={cmpQuery} />
              </ScrollView>
            </Reanimated.View>
          ) : (
          <Reanimated.View key="pane-lineup" style={{ flex: 1 }} entering={tabSwapped.current ? swapIn('lineup') : undefined} exiting={swapOut('lineup')}>
          {/* The eye-menu toolbar sits right above the rows (the old strip's
              spot, below the ovc) and pins under the fixed tabs on scroll —
              now via ScrollView stickyHeaderIndices (the list left FlatList
              for drag-to-reorder: translated rows + virtualization don't mix,
              and a tasting's line-up doesn't need recycling). The sticky index
              counts RENDERED children, so it keys on `ovc` (null on a degraded
              meta poll — React.Children.toArray skips null). */}
          <Reanimated.ScrollView
            ref={plainRef}
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
            contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
          >
            {ovc}
            {/* Solid bg so rows scrolling under the pinned toolbar don't
                bleed through (content-width fill matches the rows' inset). */}
            <View style={{ backgroundColor: theme.bg }}>
              <LineupToolbar toolbar={luToolbar} />
            </View>
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
                        ratings={ratings}
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
          onBack={() => router.back()}
          onMenu={(top) => setSessMenuTop(top)}
        />
      ) : null}
    </View>
    </BottomSheetModalProvider>
  );
}

// 02b·10 cover-hero body. The immersive design (full-bleed photo under the
// status bar + a floating bar that collapses to a solid title bar) is LOCKED;
// only the implementation differs from the mock.
//
// 📖 Full recipe + the dead ends that cost ~5 attempts + the library survey:
//    docs/design/patterns/collapsing-hero-sticky-subheaders.md
//    Opaque-bar rationale: docs/design/decisions/0003-collapsed-bars-opaque.md
//    (Read those before building a NEW hero screen, e.g. the feed cards.)
//
// Sticky tabs + strip use the community "Dynamic Overlay" pattern (verified by
// review + web best-practice over contentInset/native-sticky, which can't pin
// BELOW an absolute bar and diverge on Android/New-Arch):
//   - INLINE order (design .hero-sticky + tBlindHost): photo → TABS → about →
//     STRIP → rows, all in one ScrollView at their at-rest positions (no
//     contentInset/offset tricks). Tabs and strip sit at DIFFERENT positions
//     (tabs under the photo, strip below the about) — two independent sticky
//     elements, not one block. The inline copies are also the flow spacers.
//   - TWO absolute copies (Reanimated.View) track scrollY and CLAMP: tabs at the
//     bar bottom (PIN_Y); the strip STACKS under the pinned tabs (PIN_Y +
//     tabsH). Each is invisible/non-interactive until its inline copy reaches
//     its pin line (tabsStuck / stripStuck), then it's the pinned copy. Each
//     overlay is one rigid element ⇒ tabs and strip each can't tear internally.
//     UI-thread (reanimated) ⇒ smooth, iOS==Android.
//   - collapse is driven by a MEASURED threshold (the photo title's bottom vs
//     the bar bottom), like the impression hero — not a magic scroll constant,
//     so a proportional-height hero collapses at the right point with one title.
//
// react-native-screens defense (unchanged): the zero-size collapsable={false}
// dead-end first sibling stops RNSScreen's subviews[0] finder from flipping
// contentInsetAdjustmentBehavior never→automatic. Reanimated.ScrollView wraps a
// real ScrollView (still a UIScrollView), so the dead-end still applies.
function CoverHeroLineup({
  meta, coverUrl, lock, wines, indexById, luNarrowed, toolbar, reorder, ratings, myIdentityId, canAdd, windowH, ovc, reveal, tab, onSelectTab, compare, compareRail, swapAnimated, onCollapsedChange, onPressWine, onAdd,
}: {
  meta: NonNullable<MetaView>;
  coverUrl: string;
  lock: number | null;
  wines: WireWine[] | null;
  /** True line-up position per wine id (rows arrive search/sort-transformed). */
  indexById: Map<string, number>;
  /** A search query is narrowing the rows (drives the empty copy). */
  luNarrowed: boolean;
  toolbar: LuToolbarProps;
  reorder: { enabled: boolean; denied: boolean; deniedNote: string; onCommit: (orderedIds: string[]) => boolean; onDenied: () => void };
  ratings: RatingsView | null;
  myIdentityId: string;
  canAdd: boolean;
  windowH: number;
  ovc: React.ReactNode;
  reveal: RevealProps;
  tab: SessionTab;
  onSelectTab: (t: SessionTab) => void;
  /** The Compare tab's content — swaps in below the (sticky) tabs. */
  compare: React.ReactNode;
  /** The compare toolbar (People + sort + search) — rides the strip overlay slot so it pins under the pinned tabs like the reveal strip. */
  compareRail: React.ReactNode;
  /** True once the user has actually switched tabs — gates the swap slide-in (see swapIn). */
  swapAnimated: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onPressWine: (wineId: string) => void;
  onAdd: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const [fullscreen, setFullscreen] = useState(false);
  const heroH = Math.round(windowH * HERO_RATIO);
  // Scrim stops scaled to the VISIBLE region (the container runs radius.xl
  // past the seam) so the darkening behind the title is unchanged; past the
  // last stop the darkest colour continues into the underlap/notches.
  const scrimEnd = heroH / (heroH + radius.xl);
  const BAR_CONTROL = phone.size('heroAction');
  const BAR_H = heroBarHeight(insets.top, BAR_CONTROL);
  const rows = useMemo(() => wines ?? [], [wines]);
  const onCompare = tab === 'compare';
  // Strip (like the rows + add affordances) is line-up furniture only.
  const showToolbar = !lock && !onCompare;

  // UI-thread scroll position for the overlay translates.
  const aref = useAnimatedRef<Reanimated.ScrollView>();
  const scrollY = useScrollOffset(aref);
  // Max scrollable offset — the drag auto-scroll clamp.
  const heroMaxScroll = useSharedValue(0);
  const heroContentH = useRef(0);
  const heroViewportH = useRef(0);
  const rowById = useMemo(() => new Map(rows.map((w) => [w.id, w] as const)), [rows]);
  // Content-Y of the inline tabs and (separately) the reveal strip — they sit at
  // DIFFERENT positions (tabs right under the photo; strip below the about
  // block), so they're two independent sticky elements that STACK under the bar
  // when scrolled (tabs pin first, strip pins under the pinned tabs). Each is
  // measured via onLayout on a DIRECT child of the scroll content (layout.y is
  // content-space — no coordinate bug). Mirrored to JS for the stuck gates.
  const tabsTop = useSharedValue(0);
  const [tabsTopJS, setTabsTopJS] = useState(0);
  const tabsH = useSharedValue(0);
  const [tabsHJS, setTabsHJS] = useState(0);
  const stripTop = useSharedValue(0);
  const [stripTopJS, setStripTopJS] = useState(0);
  // Content-Y of the photo title's bottom — drives the measured collapse.
  const [titleBottom, setTitleBottom] = useState(heroH); // sane default pre-measure
  // Each overlay becomes the visible/interactive pinned copy once its inline
  // copy reaches its pin line; below that the inline copy owns taps.
  const [tabsStuck, setTabsStuck] = useState(false);
  const [stripStuck, setStripStuck] = useState(false);
  const collapsedRef = useRef(false);
  const [pulled, setPulled] = useState(false);
  const pulledRef = useRef(false);
  // Last known scroll offset — the stuck gates below normally recompute per
  // scroll event, but an IN-SCREEN tab switch swaps the strip-slot content
  // (reveal strip ⇄ people rail) with NO scroll event, so an effect re-runs
  // them from here (else the pinned copies strand: rail invisible when
  // switching on pinned tabs, or the other tab's strip pinned early).
  const lastYRef = useRef(0);

  // Pin 1px UNDER the bar's bottom so the opaque bg tucks beneath the bar — a
  // flush pin can leave a sub-pixel hairline after rounding. (The bar paints on
  // top, zIndex 8 > 7, so the overlap is invisible.)
  const PIN_Y = BAR_H - 1;

  // Strip measurement resets on a tab switch (the slot's new content re-fires
  // onLayout with its own y); until then the strip gate reads "not stuck".
  useEffect(() => {
    stripTop.value = 0;
    setStripTopJS(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // ⚠️ Plausibility floors in the stuck gates: a REAL tabs/strip rest
  // position is always far below its pin line (the hero photo alone puts it
  // hundreds of points down), so a measurement AT or ABOVE the floor is
  // garbage from a transient first-frame geometry — and once, on re-entry,
  // such a value stranded the pinned strip overlay over the STATUS BAR at
  // scroll 0 (device screenshot 2026-07-03; self-healed on remount).
  // Requiring top > floor makes that state unreachable while changing
  // nothing for legitimate measurements.
  useEffect(() => {
    const y = lastYRef.current;
    setTabsStuck(tabsTopJS > PIN_Y && y >= tabsTopJS - PIN_Y);
    setStripStuck(stripTopJS > PIN_Y + tabsHJS && y >= stripTopJS - (PIN_Y + tabsHJS));
  }, [tab, tabsTopJS, tabsHJS, stripTopJS, PIN_Y]);

  const onScrollJS = (y: number) => {
    lastYRef.current = y;
    // Collapse when the on-photo title has scrolled under the bar's bottom
    // (measured — matches the impression hero; robust to a proportional hero).
    const next = y >= titleBottom - BAR_H;
    if (next !== collapsedRef.current) {
      collapsedRef.current = next;
      onCollapsedChange(next);
    }
    // Each stuck flag flips at the same inequality its overlay clamps on, so the
    // opacity swap happens exactly where inline + overlay coincide (no jump).
    const ts = tabsTopJS > PIN_Y && y >= tabsTopJS - PIN_Y;
    setTabsStuck((prev) => (prev === ts ? prev : ts));
    const stripFloor = PIN_Y + tabsHJS; // strip pins UNDER the pinned tabs
    const ss = stripTopJS > stripFloor && y >= stripTopJS - stripFloor;
    setStripStuck((prev) => (prev === ss ? prev : ss));
    const p = y < -1;
    if (p !== pulledRef.current) {
      pulledRef.current = p;
      setPulled(p);
    }
  };

  // Tabs overlay: ride with the page, clamp at the bar bottom.
  const tabsOverlayStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: clamp(tabsTop.value - scrollY.value, PIN_Y, tabsTop.value || PIN_Y) }],
  }));
  // Strip overlay: clamp UNDER the pinned tabs (PIN_Y + tabsH).
  const stripOverlayStyle = useAnimatedStyle(() => {
    const floor = PIN_Y + tabsH.value;
    return { transform: [{ translateY: clamp(stripTop.value - scrollY.value, floor, stripTop.value || floor) }] };
  });

  // Top corners rounded on BOTH copies: inline, the tabs panel overlaps the
  // photo's underlap strip (the photo shows in the corner notches); the pinned
  // overlay keeps the identical shape so the inline↔overlay swap is seamless
  // (at the pin the photo still fills the notches, then slides away; past it
  // the notches sit over theme.bg content and read as nothing).
  const Tabs = (
    <View style={{ backgroundColor: theme.bg, paddingHorizontal: GUTTER, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}>
      <SessionTabs active={tab} onSelect={onSelectTab} />
    </View>
  );
  // The sticky "strip" slot is shared: line-up = the reveal strip, Compare =
  // the compare toolbar (both pin under the pinned tabs via the same overlay).
  // The toolbar owns its horizontal padding. Keyed animated wrappers: same
  // element type in the same ternary slot would reconcile without remounting,
  // and the swap slide-in only runs on a mount. Rendered twice (inline +
  // overlay) — both copies slide in sync; the search value is screen state, so
  // both TextInput copies stay in step (focus lives in whichever was tapped).
  const Strip = onCompare ? (
    compareRail ? (
      <Reanimated.View key="strip-rail" entering={swapAnimated ? swapIn('compare') : undefined} exiting={swapOut('compare')} style={{ backgroundColor: theme.bg }}>
        {compareRail}
      </Reanimated.View>
    ) : null
  ) : showToolbar ? (
    <Reanimated.View key="strip-reveal-toolbar" entering={swapAnimated ? swapIn('lineup') : undefined} exiting={swapOut('lineup')} style={{ backgroundColor: theme.bg, paddingHorizontal: GUTTER }}>
      <LineupToolbar toolbar={toolbar} />
    </Reanimated.View>
  ) : null;

  return (
    <>
      <View collapsable={false} style={{ width: 0, height: 0 }} />
      <Reanimated.ScrollView
        ref={aref}
        onScroll={(e) => onScrollJS(e.nativeEvent.contentOffset.y)}
        // 1 (not 16): the overlay translate reads scrollY every frame, so a
        // coarser throttle would let the inline↔overlay swap show a sub-pixel
        // seam on a fast fling. The JS onScroll work is cheap (equality-guarded
        // setState). Matches reanimated's own AnimatedScrollView default.
        scrollEventThrottle={1}
        contentInsetAdjustmentBehavior="never"
        // Compare's toolbar has a search field — card taps must land while the
        // keyboard is up (default would swallow the first tap to dismiss).
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onLayout={(e) => {
          heroViewportH.current = e.nativeEvent.layout.height;
          heroMaxScroll.value = Math.max(0, heroContentH.current - heroViewportH.current);
        }}
        onContentSizeChange={(w, h) => {
          heroContentH.current = h;
          heroMaxScroll.value = Math.max(0, h - heroViewportH.current);
        }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
      >
        {/* .hero-bleed-top: full-bleed photo at content-y 0 (bleeds under the
            status bar via the dead-end + never). Soft top corners while pulled. */}
        <View
          style={{
            // The photo runs radius.xl PAST the visual seam so the content
            // below (the tabs strip, or the lock panel — rounded top corners,
            // negative margin) overlaps it and the photo stays visible in the
            // corner notches. The panel is what's rounded, not the photo —
            // matching the impression hero.
            height: heroH + radius.xl,
            overflow: 'hidden',
            borderTopLeftRadius: pulled ? radius.xl : 0,
            borderTopRightRadius: pulled ? radius.xl : 0,
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Open cover photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
            <Image source={{ uri: coverUrl }} alt="" style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          </Pressable>
          {/* Shared HERO_SCRIM (converged to the impression hero's gradient — was
              0.28/0.05/0.72, slightly lighter at the bottom). */}
          <LinearGradient
            pointerEvents="none"
            colors={HERO_SCRIM}
            locations={[0, 0.45 * scrimEnd, scrimEnd]}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          {/* Title: measure its bottom in content space (its parent is the photo
              View whose top is content-y 0, so y + height is content-Y). */}
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 18, right: 18, bottom: 14 + radius.xl }}
            onLayout={(e) => setTitleBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
          >
            <VText
              numberOfLines={2}
              style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('title'), color: '#fff' }}
            >
              {meta.name}
            </VText>
          </View>
          <FullscreenImage uri={coverUrl} visible={fullscreen} label={meta.name} onClose={() => setFullscreen(false)} />
        </View>
        {/* INLINE tabs — right under the photo, ABOVE the about block (design
            .hero-sticky). At-rest position + flow spacer. Direct scroll child →
            layout.y is content-space; measure top + height (height feeds the
            strip's pin floor so it stacks under the pinned tabs). */}
        {!lock ? (
          <View
            style={{ marginTop: -radius.xl }}
            accessibilityElementsHidden={tabsStuck}
            importantForAccessibility={tabsStuck ? 'no-hide-descendants' : 'auto'}
            onLayout={(e) => {
              const { y, height } = e.nativeEvent.layout;
              tabsTop.value = y;
              setTabsTopJS(y);
              tabsH.value = height;
              setTabsHJS(height);
            }}
          >
            {Tabs}
          </View>
        ) : null}
        {/* about block (or lock card) — scrolls beneath the tabs. On the
            Compare tab everything below the tabs is the compare body (the mock
            02d screens carry no about block). */}
        {lock ? (
          // No tabs on a locked moment — the lock panel is what sits directly
          // under the photo, so IT carries the rounded overlap.
          <View style={{ paddingHorizontal: GUTTER, marginTop: -radius.xl, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, backgroundColor: theme.bg }}>
            <LockCard revealAt={lock} />
            {ovc}
          </View>
        ) : onCompare ? null : (
          <Reanimated.View entering={swapAnimated ? swapIn('lineup') : undefined} exiting={swapOut('lineup')} style={{ paddingHorizontal: GUTTER }}>{ovc}</Reanimated.View>
        )}
        {/* INLINE toolbar/rail strip — right ABOVE the rows (below the about
            block; Simon: the controls sit close to the content they act on):
            line-up = the eye-menu toolbar, compare = the people/sort/search
            rail. At-rest position + flow spacer; direct scroll child →
            layout.y is content-Y. Pins under the pinned tabs via the overlay. */}
        {Strip ? (
          <View
            accessibilityElementsHidden={stripStuck}
            importantForAccessibility={stripStuck ? 'no-hide-descendants' : 'auto'}
            onLayout={(e) => {
              const y = e.nativeEvent.layout.y;
              stripTop.value = y;
              setStripTopJS(y);
            }}
          >
            {Strip}
          </View>
        ) : null}
        {/* rows + footer (line-up) / compare body — keyed so the swap remounts
            (same-type reconcile would skip the slide-in) */}
        {lock ? null : onCompare ? (
          <Reanimated.View key="pane-compare" entering={swapAnimated ? swapIn('compare') : undefined} exiting={swapOut('compare')}>{compare}</Reanimated.View>
        ) : (
          <Reanimated.View key="pane-lineup" entering={swapAnimated ? swapIn('lineup') : undefined} exiting={swapOut('lineup')}>
            {rows.length === 0 ? (
              <View style={{ paddingHorizontal: GUTTER }}>
                {luNarrowed ? (
                  <VText variant="small" color="inkSoft" style={{ paddingTop: 16 }}>No impressions match.</VText>
                ) : (
                  <EmptyLineup canAdd={canAdd} onAdd={onAdd} />
                )}
              </View>
            ) : (
              <View style={{ paddingHorizontal: GUTTER }}>
                <DraggableRows
                  ids={rows.map((w) => w.id)}
                  enabled={reorder.enabled}
                  denied={reorder.denied}
                  deniedNote={reorder.deniedNote}
                  onDenied={reorder.onDenied}
                  scrollRef={aref}
                  scrollY={scrollY}
                  maxScrollY={heroMaxScroll}
                  onCommit={reorder.onCommit}
                  renderRow={(id, i, move) => {
                    const item = rowById.get(id);
                    if (!item) return null;
                    return (
                      <>
                        {i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
                        <LuRow
                          wine={item}
                          index={indexById.get(id) ?? 0}
                          myIdentityId={myIdentityId}
                          ratings={ratings}
                          onPress={() => onPressWine(id)}
                          reveal={reveal}
                          move={move}
                        />
                      </>
                    );
                  }}
                />
              </View>
            )}
            {rows.length > 0 && canAdd && !luNarrowed ? (
              <View style={{ paddingHorizontal: GUTTER }}>
                <AddImpressionRow onPress={onAdd} />
              </View>
            ) : null}
          </Reanimated.View>
        )}
      </Reanimated.ScrollView>
      {/* OVERLAYS — pinned copies of tabs (at the bar) + strip (stacked under the
          tabs), each shown only past its threshold. Both zIndex 7, UNDER the
          floating HeroTopBar (8); they pin at non-overlapping y (tabs at PIN_Y,
          strip at PIN_Y + tabsH) so the equal zIndex is harmless. No title in
          either. pointerEvents+opacity gate so the inline copies own taps at
          rest, the overlays when pinned. */}
      {!lock ? (
        <Reanimated.View
          pointerEvents={tabsStuck ? 'auto' : 'none'}
          // Exactly ONE copy in the accessibility tree at a time (codex): the
          // opacity/pointerEvents gate hides the duplicate visually and from
          // touch, but VoiceOver/TalkBack still walked both.
          accessibilityElementsHidden={!tabsStuck}
          importantForAccessibility={tabsStuck ? 'auto' : 'no-hide-descendants'}
          style={[tabsOverlayStyle, { position: 'absolute', left: 0, right: 0, zIndex: 7, opacity: tabsStuck ? 1 : 0 }]}
        >
          {Tabs}
        </Reanimated.View>
      ) : null}
      {Strip ? (
        <Reanimated.View
          pointerEvents={stripStuck ? 'auto' : 'none'}
          accessibilityElementsHidden={!stripStuck}
          importantForAccessibility={stripStuck ? 'auto' : 'no-hide-descendants'}
          style={[stripOverlayStyle, { position: 'absolute', left: 0, right: 0, zIndex: 7, opacity: stripStuck ? 1 : 0 }]}
        >
          {Strip}
        </Reanimated.View>
      ) : null}
    </>
  );
}

// .hero-topfix — the floating collapsing bar over the cover hero. Pre-collapse:
// transparent, glass back + ⋯ circles, white icons. Collapsed (once the on-photo
// title scrolls under it — measured, see CoverHeroLineup): SOLID opaque theme bg
// (no blur, no bottom rule — Simon's ruling), the moment name, ink icons. The ⋯
// anchors the shared SessionMenu via measureInWindow (same protocol as
// SessionMenuButton).
function HeroTopBar({
  title, collapsed, canAdd, showAdd, onAdd, onBack, onMenu,
}: {
  title: string;
  collapsed: boolean;
  canAdd: boolean;
  /** Tab-driven: Add is line-up furniture — false on Compare, where it morphs into the ⋯. */
  showAdd: boolean;
  onAdd: () => void;
  onBack: () => void;
  onMenu: (anchorBottomY: number) => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const moreRef = useRef<View>(null);
  // Add ⇄ ⋯ morph: pill fill + circle fill are ONE SVG path (capsule ∪
  // circle, single GLASS_FILL) — the union paints uniformly by definition,
  // so the intersection can't double into a dark crescent (two stacked
  // translucent fills always doubled it; a uniform counter-dim on the circle
  // just produced a two-tone circle — both device-rejected). The morph is
  // literally a blob absorption. `morph` is driven by CollapsingAdd (1 =
  // resting, 0 = merged); pill size arrives via onSize.
  const morph = useSharedValue(showAdd ? 1 : 0);
  const [pillSize, setPillSize] = useState<{ w: number; h: number } | null>(null);
  const anim = useRef(new Animated.Value(collapsed ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: collapsed ? 1 : 0,
      duration: motion.dur2,
      easing: Easing.bezier(...motion.ease),
      useNativeDriver: true,
    }).start();
  }, [collapsed, anim]);

  const iconColor = collapsed ? theme.ink : '#fff';
  const controlSize = phone.size('heroAction');
  const iconSize = phone.size('heroActionIcon');
  const titleText = phone.text('subhead');
  const circle = collapsed
    ? { width: controlSize, height: controlSize, alignItems: 'center' as const, justifyContent: 'center' as const }
    : { width: controlSize, height: controlSize, borderRadius: controlSize / 2, backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const };
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 8 }}
    >
      {/* Collapsed bar — a SOLID opaque theme fill (Simon's ruling: the
          collapsed title bar must not be transparent; deviates from the mock's
          86%-translucent blur). The whole layer fades in on collapse via
          `opacity: anim`; no BlurView — it's pointless (and a wasted render)
          behind an opaque fill, and an opaque bar also kills any seam shine-
          through with the pinned tabs below it. Pre-collapse the bar is fully
          transparent (this layer at opacity 0) so the photo shows through — that
          immersive state is unchanged. */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: anim }}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.bg }} />
      </Animated.View>
      {/* Layout = heroBarHeight(insets.top, controlSize): safe area + control row + 6
          bottom (no border — opaque fill, ADR-0003). Keep in sync with
          heroBarHeight (the cover-hero sticky pin offset derives from it). */}
      <View style={{ paddingTop: insets.top, paddingHorizontal: 14, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: controlSize }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}
            style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}>
            <Icon name="back" size={iconSize} color={iconColor} />
          </Pressable>
          {/* Title appears only collapsed (fades in with a 4px rise). */}
          <Animated.View
            style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}
          >
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...titleText, color: theme.ink }}>
              {title}
            </VText>
          </Animated.View>
          {/* Add (left of ⋯) — glass pill over the photo, collapsing to a bare
              + glyph once the bar goes solid (label drop mirrors the Crave
              button). Host/cohost/provider only; morphs into the ⋯ on Compare. */}
          <View collapsable={false} style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* THE UNION FILL — one path for pill capsule + ⋯ circle (see
                `morph` above). Glass state only: the collapsed bar's controls
                are fill-less (ADR-0003), and without Add the ⋯ keeps its own
                static circle fill below. */}
            {!collapsed && canAdd && pillSize ? (
              <MorphUnionFill morph={morph} pillW={pillSize.w} pillH={pillSize.h} circle={controlSize} reach={6 + controlSize / 2} />
            ) : null}
            {canAdd ? (
              // Center-vanish (Simon's spec) with the fill drawn by the union
              // SVG — the pill itself carries only content (noBg).
              <CollapsingAdd show={showAdd} reach={6 + controlSize / 2} progress={morph} onSize={(w, h) => setPillSize({ w, h })}>
                <LineupAddButton onPress={onAdd} collapsed={collapsed} glass noBg={!collapsed} />
              </CollapsingAdd>
            ) : null}
            <View ref={moreRef} collapsable={false} style={{ marginLeft: 6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Session menu"
                hitSlop={8}
                onPress={() => moreRef.current?.measureInWindow((_x, y, _w, h) => onMenu(y + h))}
                style={({ pressed }) => ({
                  ...circle,
                  // With Add present the union SVG paints the circle's fill.
                  backgroundColor: !collapsed && canAdd ? undefined : circle.backgroundColor,
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <Icon name="more" size={iconSize} color={iconColor} />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

// ── the line-up toolbar — [eye ⌄][sort ⌄][search────]: the eye menu (ADR-
// 0007: count + Reveal all / Hide all / Blind for all) on the very LEFT when
// the viewer is a blind host/cohost, search on the very RIGHT, sort between.
// Always rendered — no size threshold (Simon's calls, 2026-07-04).
type LuToolbarProps = {
  reveal: RevealProps;
  query: string;
  onQuery: (q: string) => void;
  sort: LuSort;
  onSort: (s: LuSort) => void;
  /** Bumps on every denied reorder-hold → note + accent flash. */
  deniedTick: number;
};
function LineupToolbar({ toolbar }: { toolbar: LuToolbarProps }) {
  const { reveal, query, onQuery, sort, onSort, deniedTick } = toolbar;
  const { theme } = useTheme();
  // Denied-reorder feedback: a short explainer line + an accent flash on the
  // control that blocks the drag (sort chip / search pill), ~2.6s.
  const [deniedShown, setDeniedShown] = useState(false);
  const deniedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (deniedTick === 0) return;
    setDeniedShown(true);
    if (deniedTimer.current) clearTimeout(deniedTimer.current);
    deniedTimer.current = setTimeout(() => setDeniedShown(false), 2600);
  }, [deniedTick]);
  useEffect(() => () => { if (deniedTimer.current) clearTimeout(deniedTimer.current); }, []);
  const phone = usePhoneTokens();
  const { width: screenW } = useWindowDimensions();
  const btnRef = useRef<View>(null);
  const sortBtnRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number } | null>(null);
  const [sortAnchor, setSortAnchor] = useState<{ top: number; bottom: number } | null>(null);
  const [menuRight, setMenuRight] = useState(16);
  const [sortMenuRight, setSortMenuRight] = useState(16);
  const sorted = sort !== 'lineup';
  const searching = query.trim() !== '';
  const sortLabel = LU_SORTS.find((o) => o.key === sort)?.label ?? 'Line-up order';
  const openSortMenu = () => {
    sortBtnRef.current?.measureInWindow((x, y, w, h) => {
      setSortMenuRight(Math.max(12, screenW - x - 224));
      setSortAnchor({ top: y, bottom: y + h });
    });
  };
  // Auto-close shortly after a Blind-for-all flip (same beat the ⋯ menu had)
  // so the row is seen going active before the menu leaves.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const openMenu = () => {
    btnRef.current?.measureInWindow((x, y, w, h) => {
      // AnchoredMenu is right-anchored; land the panel a panel-width right of
      // the button's left edge so it unfolds from the trigger (the compare
      // toolbar's sort-menu math).
      setMenuRight(Math.max(12, screenW - x - 224));
      setAnchor({ top: y, bottom: y + h });
    });
  };
  const countLabel = reveal.blindForEveryone
    ? (reveal.hiddenCount === 0 ? 'All revealed' : `${reveal.hiddenCount} of ${reveal.total} hidden from everyone`)
    : (reveal.hiddenCount === 0 ? 'All revealed to guests' : `${reveal.hiddenCount} of ${reveal.total} hidden from guests`);
  return (
    // Horizontal inset comes from the HOST (plain: the list's GUTTER content
    // padding; hero: the strip wrapper) — none here, or it would double up.
    <View style={{ paddingTop: 4, paddingBottom: 8, gap: 6 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {reveal.hostRevealUi ? (
      <Pressable
        ref={btnRef}
        accessibilityRole="button"
        accessibilityLabel={`Reveal controls — ${countLabel}`}
        onPress={openMenu}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, paddingHorizontal: 11,
          borderRadius: 999, borderWidth: 1, borderColor: theme.rule, backgroundColor: theme.surface,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={reveal.hiddenCount > 0 ? 'eyeoff' : 'eye'} size={16} color={reveal.hiddenCount > 0 ? theme.accent : theme.inkSoft} />
        {reveal.hiddenCount > 0 ? (
          <VText surface="badge" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), fontVariant: ['tabular-nums'] }}>
            {reveal.hiddenCount}
          </VText>
        ) : null}
        <Icon name="chevrondown" size={13} color={theme.inkSoft} />
      </Pressable>
      ) : null}
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={menuRight} minWidth={210}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 }}>
          <VText variant="caption" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{countLabel}</VText>
        </View>
        <MenuItem icon="eye" label="Reveal All" disabled={reveal.revealBusy} onPress={() => { setAnchor(null); reveal.onRevealAll(); }} />
        <MenuItem icon="eyeoff" label="Hide All" disabled={reveal.revealBusy} onPress={() => { setAnchor(null); reveal.onHideAll(); }} />
        <MenuSeparator />
        {/* .sess-menu-mode — moved here from the ⋯ menu (Simon 2026-07-04):
            reveal-scope controls live together. Press-to-activate field. */}
        <MenuItem
          icon="eyeoff"
          label="Blind for All"
          active={reveal.blindForEveryone}
          disabled={reveal.bfaBusy}
          accessibilityState={{ selected: reveal.blindForEveryone }}
          onPress={() => {
            reveal.onToggleBlindForEveryone(!reveal.blindForEveryone);
            if (closeTimer.current) clearTimeout(closeTimer.current);
            closeTimer.current = setTimeout(() => setAnchor(null), 300);
          }}
        />
      </AnchoredMenu>
      <Pressable
        ref={sortBtnRef}
        accessibilityRole="button"
        accessibilityLabel={`Sort impressions — ${sortLabel}`}
        onPress={openSortMenu}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 36, paddingHorizontal: 11,
          borderRadius: 999,
          borderWidth: deniedShown && sorted ? 1.5 : 1,
          borderColor: deniedShown && sorted ? theme.accent : theme.rule,
          backgroundColor: theme.surface,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name="sort" size={16} color={sorted ? theme.accent : theme.inkSoft} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <SheetSearchField value={query} onChangeText={onQuery} placeholder="Search impressions" highlight={deniedShown && searching} />
      </View>
      <AnchoredMenu anchor={sortAnchor} onClose={() => setSortAnchor(null)} right={sortMenuRight} minWidth={190}>
        {LU_SORTS.map((o) => (
          <MenuItem
            key={o.key}
            label={o.label}
            active={sort === o.key}
            accessibilityState={{ selected: sort === o.key }}
            // Tap the active sort again → OFF (line-up order).
            onPress={() => { onSort(sort === o.key ? 'lineup' : o.key); setSortAnchor(null); }}
          />
        ))}
      </AnchoredMenu>
    </View>
    </View>
  );
}

// .ovc — the session about block: location + Map pill, when, event link,
// clamped description, avatar-stack foot.
function OvcAbout({ meta, isHostViewer, myIdentityId, onPeople }: { meta: MetaView; isHostViewer: boolean; myIdentityId: string; onPeople: () => void }) {
  const { theme } = useTheme();
  const [descOpen, setDescOpen] = useState(false);
  // Character count of the first three laid-out lines (from the invisible
  // measurer), or null when the description fits unclamped.
  const [clampLen, setClampLen] = useState<number | null>(null);
  if (!meta) return null;

  // Word-boundary truncation: slice the original string at the 3-line break,
  // walk back to a word end (freeing room for "… more" on the same line),
  // append the ellipsis. " more" then flows inline — never mid-word, never
  // its own line.
  let truncated: string | null = null;
  if (clampLen !== null && meta.description) {
    let txt = meta.description.slice(0, clampLen).replace(/\s+$/, '');
    let cut = txt.lastIndexOf(' ');
    while (cut > 0 && txt.length - cut < 9) cut = txt.lastIndexOf(' ', cut - 1);
    if (cut > 0) txt = txt.slice(0, cut);
    truncated = txt.replace(/[\s,.;:]+$/, '') + ' …';
  }
  const when = sessionWhen(meta.dateFrom, meta.dateTo);
  const hasAny = meta.address || when || meta.link || meta.description || meta.participants.length > 0;
  if (!hasAny) return null;
  // Foot-only block (no about lines): the foot's 14px separation margin would
  // stack on the container's paddingTop and read top-heavy against the 14px
  // below (Simon's centering call) — drop it; the paddings carry the spacing.
  const footOnly = !meta.address && !when && !meta.link && !meta.description;

  const line = (children: React.ReactNode, key: string, onPress?: () => void) => (
    <Pressable
      key={key}
      disabled={!onPress}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}
    >
      {children}
    </Pressable>
  );

  return (
    <View style={{ paddingTop: 12, paddingBottom: 14, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: theme.rule, gap: 0 }}>
      {meta.address
        ? line(
            <>
              <Icon name="pin" size={16} color={theme.inkSoft} />
              <VText variant="small" numberOfLines={1} style={{ flexShrink: 1 }}>{meta.address}</VText>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6,
                  // Tuned against the mock with Simon (2026-06-12): tight
                  // 14px label line box + spec 3px v-padding (~20px pill),
                  // seated 2px low. The rendered mock, not the CSS literal,
                  // was the tiebreaker here.
                  marginTop: 2,
                  paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: theme.accentTint,
                }}
              >
                <Icon name="pin" size={11} color={theme.accent} />
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, lineHeight: 14 }} color="accent">Map</VText>
              </View>
            </>,
            'loc',
            () => Linking.openURL(`https://maps.apple.com/?q=${encodeURIComponent(meta.address!)}`).catch(() => {}),
          )
        : null}
      {when
        ? line(
            <>
              <Icon name="clock" size={16} color={theme.inkSoft} />
              <VText variant="small">{when}</VText>
            </>,
            'when',
          )
        : null}
      {meta.link
        ? line(
            <>
              {/* .ovc-line svg is ink-soft even on the accent line — only
                  the label text carries accent. */}
              <Icon name="link" size={16} color={theme.inkSoft} />
              <VText variant="small" color="accent">Event Link</VText>
            </>,
            'link',
            // In-app browser — keep the user inside the moment (the Map
            // line above stays Linking: it should open the Maps app).
            () => WebBrowser.openBrowserAsync(meta.link!).catch(() => {}),
          )
        : null}
      {meta.description ? (
        <Pressable onPress={() => setDescOpen((o) => !o)} disabled={truncated === null && !descOpen}>
          {/* Invisible un-clamped twin: reports the laid-out lines so the
              visible text can be cut at the real 3-line break. */}
          <VText
            variant="small"
            pointerEvents="none"
            onTextLayout={(e) => {
              const lines = e.nativeEvent.lines;
              setClampLen(
                lines.length > 3 ? lines.slice(0, 3).reduce((n, l) => n + l.text.length, 0) : null,
              );
            }}
            style={{ position: 'absolute', left: 0, right: 0, opacity: 0 }}
          >
            {meta.description}
          </VText>
          {descOpen ? (
            // Expanded: "less" flows inline at the end of the last line.
            <VText variant="small" color="inkSoft" style={{ marginTop: 10 }}>
              {meta.description}
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color="accent">
                {'  less'}
              </VText>
            </VText>
          ) : (
            <VText variant="small" color="inkSoft" numberOfLines={3} style={{ marginTop: 10 }}>
              {truncated ?? meta.description}
              {truncated !== null ? (
                <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color="accent">
                  {' more'}
                </VText>
              ) : null}
            </VText>
          )}
        </Pressable>
      ) : null}
      <AvatarFoot meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPress={onPeople} first={footOnly} />
    </View>
  );
}

// .ovc-foot + .ovc-chip: 28px initials circles, -8 overlap, host = accent,
// overflow chip = accent tint, "Hosted by <b>…</b>".
function AvatarFoot({ meta, isHostViewer, myIdentityId, onPress, first }: { meta: NonNullable<MetaView>; isHostViewer: boolean; myIdentityId: string; onPress: () => void; first?: boolean }) {
  const { theme } = useTheme();
  if (meta.participants.length === 0) return null;
  const hostId = meta.hostIdentityId ?? (meta.hostUserId !== null ? `u:${meta.hostUserId}` : null);
  const ordered = [...meta.participants].sort((a, b) => (a.id === hostId ? -1 : b.id === hostId ? 1 : 0));
  const shown = ordered.slice(0, 3);
  const extra = ordered.length - shown.length;
  const isSelfHost = hostId === myIdentityId && isHostViewer;
  // Prefer the roster entry (kept fresh by rename propagation) over the
  // create-time meta.host snapshot.
  const hostName = ordered.find((p) => p.id === hostId)?.displayName ?? meta.host;

  const chip = (p: { id: string; displayName: string; imageUrl: string | null }, i: number) => (
    // The overlapping avatar-stack chip: shared Avatar with the `ring` treatment
    // (2px theme.bg border + image inset), host-tinted, in a negative-margin wrap.
    <View key={p.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
      <Avatar imageUrl={p.imageUrl} name={p.displayName} size={30} ring host={p.id === hostId} initialsSize={12} />
    </View>
  );

  return (
    // Tapping the avatar stack opens People (design behaviour).
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="View people"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: first ? 0 : 14, opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {shown.map(chip)}
        {extra > 0 ? (
          <View
            style={{
              width: 30, height: 30, borderRadius: 15, marginLeft: -8,
              borderWidth: 2, borderColor: theme.bg, backgroundColor: theme.accentTint,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color="accent">+{extra}</VText>
          </View>
        ) : null}
      </View>
      <VText variant="small" color="inkSoft">
        Hosted by <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{isSelfHost ? 'you' : hostName}</VText>
      </VText>
    </Pressable>
  );
}

// Pre-tasting hide-lineup gate: the server returns an empty wine list until
// revealAt (lib/sessionState.ts buildWinesView).
// .lock-card + .cd countdown cells + .lock-start.
function LockCard({ revealAt }: { revealAt: number }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, revealAt - Date.now());
  const s = Math.floor(remaining / 1000);
  const cells: Array<[string, number]> = [
    ['days', Math.floor(s / 86400)],
    ['hrs', Math.floor((s % 86400) / 3600)],
    ['min', Math.floor((s % 3600) / 60)],
    ['sec', s % 60],
  ];
  // DATE_LOCALE → English words, region's date order + 12/24h (see
  // lib/locale.ts). Date + time joined with a space (no comma/dot between them,
  // matching the "when" line), so format the two parts separately rather than
  // letting toLocaleString insert a locale comma.
  const revealDate = new Date(revealAt);
  const when =
    revealDate.toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) +
    ' ' +
    revealDate.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  return (
    <View style={{ alignItems: 'center', paddingTop: 30, paddingBottom: 34, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="eyeoff" size={24} color={theme.inkSoft} />
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead') }}>
        Something good awaits you
      </VText>
      <VText color="inkSoft" style={{ textAlign: 'center', ...phone.text('small'), maxWidth: 280, marginTop: 8, marginBottom: 22 }}>
        The host has kept the line-up under wraps. It opens when the reveal time arrives.
      </VText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {cells.map(([label, v]) => (
          <View key={label} style={{ width: phone.lerp(58, 64), backgroundColor: theme.surfaceSunk, borderRadius: radius.md, paddingTop: 10, paddingBottom: 7, alignItems: 'center' }}>
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('title') }}>
              {String(v).padStart(2, '0')}
            </VText>
            <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', marginTop: 5 }}>
              {label}
            </VText>
          </View>
        ))}
      </View>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 18 }} color="accent">
        Line-up reveals {when}
      </VText>
    </View>
  );
}

// .tempty — role-aware: only viewers with add-rights get the "add the first
// thing" invitation (guest copy is unspecced in the handoff; flagged).
function EmptyLineup({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  // The empty state lives in a flex:1 slot. When the tab bar hides for a sheet,
  // that slot grows (the freed bar space), and center-justified content would
  // shift down by half the delta — then back on close: the "jump". Fix: freeze
  // this view's FIRST measured height (bar present) and pin it as a FIXED height.
  // A fixed-height block doesn't grow with the slot, so the centering holds.
  const [h, setH] = useState(0);
  return (
    <View
      onLayout={(e) => { const m = e.nativeEvent.layout.height; if (h === 0 && m > 0) setH(m); }}
      style={[h > 0 ? { height: h } : { flex: 1 }, { alignItems: 'center', justifyContent: 'center', paddingVertical: 32 }]}
    >
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="glass" size={30} color={theme.inkSoft} />
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead') }}>Nothing in the line-up yet</VText>
      <VText color="inkSoft" style={{ textAlign: 'center', ...phone.text('small'), maxWidth: 260, marginTop: 6 }}>
        {canAdd
          ? "Add the first thing you're tasting — a bottle, a cup, a plate."
          : 'The host is still putting the line-up together.'}
      </VText>
      {canAdd ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAdd}
          style={({ pressed }) => ({
            flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 20,
            paddingVertical: 11, paddingHorizontal: 18, borderRadius: radius.pill,
            backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1,
          })}
        >
          <Icon name="plus" size={17} color={theme.accentInk} />
          <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color={theme.accentInk}>
            Add Impression
          </VText>
        </Pressable>
      ) : null}
    </View>
  );
}

// .lu-add — full-width dashed-accent "Add impression" row that trails a
// populated line-up (host/cohost/provider only). The empty state uses a filled
// accent pill instead (above); this dashed variant matches the design's
// in-list affordance.
function AddImpressionRow({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add Impression"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        marginTop: 8, paddingVertical: 14, borderRadius: radius.md,
        borderWidth: 1, borderStyle: 'dashed', borderColor: theme.accentLine,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="plus" size={17} color={theme.accent} />
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color="accent">
        Add Impression
      </VText>
    </Pressable>
  );
}

// .lurow: idx · thumb · name/vintage + maker + style · score/rated column.
// The whole row opens the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the one-star score chip.
//
// Blind variants (host on a blind session — `reveal.hostRevealUi`), per the
// ADR-0007 direct-manipulation model:
//  - hidden (host sees the real wine, guests don't): a translucent eye-off
//    overlay covers the photo; tapping the photo ARMS (accent overlay + the
//    hint line flips to "tap again"), tapping again reveals.
//  - revealed: the photo is clear except a corner eye badge — tapping the
//    badge hides again INSTANTLY (the damage-control path).
//  - masked (_blind, blind-for-all): the mystery placeholder is the same
//    tap target.
// Guests' masked rows carry their own hint line (the old quiet strip died).
function LuRow({
  wine, index, myIdentityId, ratings, onPress, reveal, move,
}: {
  wine: WireWine;
  index: number;
  myIdentityId: string;
  ratings: RatingsView | null;
  onPress: () => void;
  reveal: RevealProps;
  /** Accessible reorder (PR #65): VoiceOver rotor actions mirroring the
   *  drag gesture. Null when reordering is unavailable. */
  move?: RowMoveActions | null;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const compact = phone.surface('compactList');
  const badge = phone.surface('badge');
  const myScore = ratings?.[myIdentityId]?.ratings[wine.id]?.score ?? 0;
  const { hostRevealUi, revealBusy } = reveal;
  const armed = reveal.armedId === wine.id;
  const revealedToGuests = !!wine.revealedAt;
  // A _blind wine is the SERVER'S redaction stub (name "Wine N", blank fields) —
  // render the mystery placeholder while it's _blind, FULL STOP. Do NOT un-mask
  // on an optimistic revealedAt: under blind-for-all the host's reveal stamps
  // revealedAt locally but the real fields only arrive on the next poll (which
  // also clears _blind), so un-masking early would surface the literal "Wine N"
  // stub as if it were the wine's name. The pill label uses revealedToGuests, so
  // a just-revealed stub correctly shows a "Hide" pill on the placeholder until
  // the poll brings the real row. (Normal blind never hits this — the host's
  // wines come back _blind:false with real data, so masked is always false.)
  const masked = !!wine._blind;
  // Host sees the real wine but it's still hidden from guests (normal blind,
  // unrevealed). Drives the eye-off thumb badge + the resting "Hidden from
  // guests" tag. A revealed wine, or a masked one, is not this.
  const hostSeesHidden = hostRevealUi && !masked && !revealedToGuests;

  // The whole row always opens the impression; the photo (host, blind) is an
  // INNER Pressable that claims its own taps for arm/reveal — same nesting
  // pattern as the IrBar sibling controls.
  const thumbSize = phone.size('recentThumb');
  const moveActions = [
    ...(move?.up ? [{ name: 'moveUp', label: 'Move up in the line-up' }] : []),
    ...(move?.down ? [{ name: 'moveDown', label: 'Move down in the line-up' }] : []),
  ];
  return (
    <Pressable
      onPress={onPress}
      accessibilityActions={moveActions.length > 0 ? moveActions : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'moveUp') move?.up?.();
        else if (e.nativeEvent.actionName === 'moveDown') move?.down?.();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: phone.lerp(12, 16),
        paddingVertical: compact.paddingY(phone.lerp(12, 16)),
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/* .lu-idx: 18w, 13/600, ink-faint, tabular */}
      <VText
        surface="badge"
        color="inkFaint"
        style={{ width: phone.lerp(18, 22), textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), fontVariant: ['tabular-nums'] }}
      >
        {index + 1}
      </VText>
      {masked ? (
        // .lu-masked: sunk bg, dashed rule border, eye-off. For the host under
        // blind-for-all the placeholder is ALSO the reveal trigger (same
        // arm→confirm as a photo; armed = accent). A just-revealed stub shows
        // the corner eye while the poll fetches the real row.
        hostRevealUi ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              revealedToGuests ? `Hide impression ${index + 1} from guests`
              : armed ? `Tap again to reveal impression ${index + 1}`
              : `Reveal impression ${index + 1} — tap twice`
            }
            disabled={revealBusy}
            onPress={() => (revealedToGuests ? reveal.onHideOne(wine.id) : reveal.onThumbTap(wine.id))}
            style={{
              width: thumbSize, height: thumbSize, borderRadius: radius.sm,
              backgroundColor: armed ? theme.accentTint : theme.surfaceSunk,
              borderWidth: 1, borderStyle: armed ? 'solid' : 'dashed', borderColor: armed ? theme.accentLine : theme.rule,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon name={armed || revealedToGuests ? 'eye' : 'eyeoff'} size={phone.size('pushChevron')} color={armed ? theme.accent : theme.inkFaint} />
          </Pressable>
        ) : (
          <View
            style={{
              width: thumbSize, height: thumbSize, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk,
              borderWidth: 1, borderStyle: 'dashed', borderColor: theme.rule,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon name="eyeoff" size={phone.size('pushChevron')} color={theme.inkFaint} />
          </View>
        )
      ) : (
        // .lu-thumbwrap — on a blind session the photo IS the host's reveal
        // control (ADR-0007).
        <View style={{ width: thumbSize, height: thumbSize }}>
          <Thumb uri={wine.imageUrl} size={thumbSize} />
          {hostSeesHidden ? (
            // Hidden: translucent glass over the WHOLE photo (sanctioned
            // over-photo fill) + centred glyph; armed flips it accent. Tap =
            // arm, tap again = reveal.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={armed ? `Tap again to reveal ${wine.name}` : `Reveal ${wine.name} — tap twice`}
              disabled={revealBusy}
              onPress={() => reveal.onThumbTap(wine.id)}
              style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.sm,
                backgroundColor: armed ? alpha(theme.accent, 0.55) : GLASS_FILL,
                borderWidth: armed ? 1.5 : 0, borderColor: theme.accent,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon name={armed ? 'eye' : 'eyeoff'} size={phone.size('pushChevron')} color="#fff" />
            </Pressable>
          ) : hostRevealUi && revealedToGuests ? (
            // Revealed: the WHOLE photo is the hide trigger (Simon — not just
            // the badge); the corner eye badge (.lu-hidebadge geometry) is the
            // visual cue riding inside the transparent overlay.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Hide ${wine.name} from guests`}
              disabled={revealBusy}
              onPress={() => reveal.onHideOne(wine.id)}
              style={{ position: 'absolute', top: 0, left: 0, right: -4, bottom: -4 }}
            >
              <View
                style={{
                  position: 'absolute', right: 0, bottom: 0, width: 22, height: 22, borderRadius: 11,
                  backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon name="eye" size={13} color={theme.inkSoft} />
              </View>
            </Pressable>
          ) : null}
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {masked ? (
          <>
            <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
              Impression {index + 1}
            </VText>
            {/* The old quiet strip's context, moved onto the thing itself:
                guests learn WHY it's masked right on the row (Simon's call). */}
            <VText surface="compactList" color="inkSoft" style={{ ...phone.text('small'), marginTop: 1 }}>
              {hostRevealUi ? 'Hidden from everyone' : 'Hidden until the host reveals it'}
            </VText>
            {hostRevealUi && !revealedToGuests ? (
              <VText surface="compactList" variant="caption" numberOfLines={1} style={{ marginTop: 1 }} color={armed ? 'accent' : 'inkFaint'}>
                {armed ? 'Tap once more to reveal' : 'Double-tap the box to reveal'}
              </VText>
            ) : null}
          </>
        ) : (
          <>
            {/* .lu-name: "Oslavje - 2018" — the dash stays in the name
                colour; only the year itself is ink-soft regular. The host's
                hidden-from-guests tag rides the name line (resting only). */}
            <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
              {wine.name}
              {wine.vintage ? (
                <>
                  {' - '}
                  <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('body') }}>{wine.vintage}</VText>
                </>
              ) : null}
            </VText>
            {hostSeesHidden ? (
              <>
                <VText surface="compactList" variant="caption" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 1 }} color="inkSoft">
                  Hidden from guests
                </VText>
                <VText surface="compactList" variant="caption" numberOfLines={1} style={{ marginTop: 1 }} color={armed ? 'accent' : 'inkFaint'}>
                  {armed ? 'Tap once more to reveal' : 'Double-tap the photo to reveal'}
                </VText>
              </>
            ) : wine.producer ? (
              <VText surface="compactList" color="inkSoft" numberOfLines={1} style={{ ...phone.text('small'), marginTop: 1 }}>{wine.producer}</VText>
            ) : null}
            {hostRevealUi && revealedToGuests ? (
              // The hide direction needs its own hint (Simon) — it takes the
              // caption slot (grape/type still lives on the impression detail)
              // so revealed rows keep the 3-line rhythm: name / producer / hint.
              <VText surface="compactList" variant="caption" color="inkFaint" numberOfLines={1} style={{ marginTop: 1 }}>
                Tap the photo to hide
              </VText>
            ) : null}
            {/* Normal (non-blind) rows drop the grape/type caption entirely —
                the row sizes to name + producer centered against the thumb.
                Blind/host rows keep their 3 lines. Grape/type still lives on
                the impression detail. (Simon) */}
          </>
        )}
      </View>
      {(
        // .lu-right2: score chip when rated, .lu-rate pill when not
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          {myScore > 0 ? (
            <StarScore value={myScore} size={18} />
          ) : (
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.accentLine,
                borderRadius: radius.pill,
                paddingVertical: badge.paddingY(phone.lerp(5, 7)),
                paddingHorizontal: phone.lerp(13, 16),
              }}
            >
              <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }} color="accent">
                Rate
              </VText>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}


// Add ⇄ ⋯ hand-off (Simon's ask): on Compare the Add control slides INTO the
// ⋯ beside it and grows back out of it on Line-up, instead of popping.
// Mechanics: the outer window's layout width animates to 0 (the bar's
// flexible title absorbs the freed space, so the window — and the
// left-anchored pill riding in it — moves right); opacity holds ~solid and
// fades only at the tail (a linear fade on the fast-start ease read as "just
// disappears" on device). Duration matches the pane push (dur3).
// `reach` (hero bar): the clip window overhangs the layout footprint by
// `reach` (`width + reach`, `marginRight: -reach`), and the pill gets the
// same extra translateX travel — so it slides toward the ⋯ and vanishes at
// the window's right edge. The hero passes reach=6 (the gap): the vanish
// line is the ⋯ circle's LEFT edge — clipping at its CENTER doubled the two
// translucent glass fills wherever they overlapped, unfixable by fading.
// reach=0 (plain bar) clips at the window edge; that bar's borderless
// controls have no fill to stack.
function CollapsingAdd({ show, reach = 0, progress, onSize, children }: { show: boolean; reach?: number; progress?: SharedValue<number>; onSize?: (w: number, h: number) => void; children: React.ReactNode }) {
  const [w, setW] = useState(0);
  // Optionally driven through a caller-owned shared value so a sibling (the
  // hero ⋯) can animate off the SAME morph progress (its counter-dim).
  const internal = useSharedValue(show ? 1 : 0);
  const anim = progress ?? internal;
  useEffect(() => {
    // Directional easing: the shared fast-start curve made the collapse read
    // much quicker than the expand (most travel + the tail fade landed in the
    // first third; the expand stayed visible for the full duration — Simon's
    // device call). Exit accelerates (slow → swallowed at the end), entrance
    // decelerates (out fast → settle) — perceived duration now matches.
    anim.value = withTiming(show ? 1 : 0, {
      duration: motion.dur3,
      easing: ReEasing.bezier(...(show ? motion.easeOut : motion.easeIn)),
      reduceMotion: ReduceMotion.System,
    });
  }, [show, anim]);
  const style = useAnimatedStyle(() =>
    w > 0
      ? {
          width: w * anim.value + reach,
          marginRight: -reach,
          // Solid slide, tail fade only: with the clip at the ⋯'s LEFT edge
          // (zero fill overlap — see the call site) the pill can stay solid
          // for the whole travel and just soften at the vanish point.
          opacity: interpolate(anim.value, [0, 0.25, 1], [0, 1, 1]),
        }
      : { opacity: anim.value, marginRight: 0, ...(show ? null : { width: 0 }) },
  );
  const pill = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - anim.value) * reach }],
  }));
  return (
    <Reanimated.View
      pointerEvents={show ? 'auto' : 'none'}
      // pointerEvents blocks touch only — keep the collapsed (or mid-collapse)
      // control out of the accessibility tree too, on both platforms.
      accessibilityElementsHidden={!show}
      importantForAccessibility={show ? 'auto' : 'no-hide-descendants'}
      style={[{ overflow: 'hidden', flexDirection: 'row' }, style]}
    >
      <Reanimated.View
        style={[{ flexShrink: 0 }, pill]}
        onLayout={(e) => {
          setW(e.nativeEvent.layout.width);
          onSize?.(e.nativeEvent.layout.width, e.nativeEvent.layout.height);
        }}
      >
        {children}
      </Reanimated.View>
    </Reanimated.View>
  );
}

// The Add ⇄ ⋯ morph's single fill: pill capsule ∪ ⋯ circle in ONE nonzero
// path, so overlapping subpaths paint once (uniform — no dark crescent at
// the intersection, structurally). Geometry mirrors CollapsingAdd's window
// math in the cluster's coordinate space: visible capsule = [ (1-t)·reach,
// min((1-t)·reach + w, w·t + reach) ]; circle at [w·t + 6, +C]. The capsule
// subpath is dropped once its width falls under a hair's breadth.
function MorphUnionFill({ morph, pillW, pillH, circle, reach }: { morph: SharedValue<number>; pillW: number; pillH: number; circle: number; reach: number }) {
  // 2px bleed on every side: the control sizes are comfort-lerped
  // (fractional), and shapes drawn flush to the canvas edge get their bottom
  // arc shaved by sub-pixel rounding (Simon's "cut at the bottom" nit).
  const PAD = 2;
  const H = Math.max(pillH, circle) + PAD * 2;
  const W = pillW + reach + 6 + circle + PAD * 2;
  const props = useAnimatedProps(() => {
    'worklet';
    const t = morph.value;
    const cx = PAD + pillW * t + 6 + circle / 2;
    const cy = H / 2;
    const r = circle / 2;
    // ⚠️ Same winding as the capsule (both sweep=1 / clockwise): under the
    // NONZERO fill rule, opposite windings cancel — the overlap would render
    // as a HOLE instead of a union.
    const circlePath = `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
    const x0 = PAD + (1 - t) * reach;
    const x1 = PAD + Math.min((1 - t) * reach + pillW, pillW * t + reach);
    const w = x1 - x0;
    if (w < 1) return { d: circlePath };
    const pr = Math.min(pillH / 2, w / 2);
    const py = cy - pillH / 2;
    const capsule = `M ${x0 + pr} ${py} L ${x1 - pr} ${py} A ${pr} ${pr} 0 0 1 ${x1 - pr} ${py + pillH} L ${x0 + pr} ${py + pillH} A ${pr} ${pr} 0 0 1 ${x0 + pr} ${py} Z`;
    return { d: capsule + ' ' + circlePath };
  });
  return (
    <Svg pointerEvents="none" width={W} height={H} style={{ position: 'absolute', left: -PAD, top: '50%', marginTop: -H / 2 }}>
      <MorphPath animatedProps={props} fill={GLASS_FILL} fillRule="nonzero" />
    </Svg>
  );
}

// Header "Add" control (.hv-add) — sits left of the ⋯ for host/cohost/provider.
// Collapses label→glyph exactly like the impression Crave button: when
// `collapsed`, the label is dropped and only the + glyph remains (no width
// animation — the row just reflows, same as IrBar's crave). Visual modes:
//  - plain bar (no cover): BORDERLESS bare-ink + glyph + "Add", NO background
//    fill and NO accent — it sits beside the borderless ink back/⋯ on that bar,
//    so it reads as one of that bar's controls (Simon's call).
//  - cover-hero bar: a GLASS pill pre-collapse (white + glyph + "Add" on the dark
//    scrim — the fill IS needed there for legibility over the photo), collapsing
//    to a bare ink + glyph once the bar goes solid, matching the back/⋯ circles.
function LineupAddButton({
  onPress, collapsed, glass, noBg,
}: {
  onPress: () => void;
  // cover-hero only: drop the label, leave the + glyph (mirrors crave's titleShown)
  collapsed?: boolean;
  // cover-hero only: glass pill treatment over the photo (pre-collapse)
  glass?: boolean;
  /** Hero morph: the capsule FILL is drawn by the union SVG behind (one shape
   * with the ⋯ circle — two stacked translucent fills double their
   * intersection as a dark crescent); this keeps only content + paddings. */
  noBg?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  const onGlass = glass && !collapsed;
  // Plain bar + collapsed cover: bare ink (like the back/⋯). Only the over-photo
  // glass variant is white.
  const iconColor = onGlass ? '#fff' : theme.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add Impression"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: phone.lerp(6, 8), minHeight: surface.height(phone.size('actionPillHeight')),
        // Only the over-photo glass variant carries a fill + rounded pill; the
        // plain-bar and collapsed variants are borderless.
        paddingHorizontal: onGlass ? phone.lerp(13, 16) : 4,
        borderRadius: onGlass ? phone.lerp(17, 19) : 0,
        backgroundColor: onGlass && !noBg ? GLASS_FILL : 'transparent',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/* Base 17px glyph in every state — matches the .hv-add spec; we borrow
          the Crave button's collapse mechanism, not its icon size. */}
      <Icon name="plus" size={phone.size('actionIcon')} color={iconColor} />
      {!collapsed ? (
        <VText surface="button" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: iconColor }}>
          Add
        </VText>
      ) : null}
    </Pressable>
  );
}
