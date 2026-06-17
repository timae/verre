import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, FlatList, Image, Linking, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import Reanimated, { clamp, useAnimatedRef, useAnimatedStyle, useScrollOffset, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { AnchoredMenu, MenuItem, MenuSeparator } from '@/components/ui/AnchoredMenu';
import { Avatar } from '@/components/ui/Avatar';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { VBar } from '@/components/VBar';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { GLASS_FILL, GUTTER, HERO_RATIO, HERO_SCRIM, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import {
  ApiError,
  getRemovedState,
  getSessionState,
  hideAllWines,
  hideWine,
  postVisit,
  revealAllWines,
  revealWine,
  updateMomentSettings,
  type RatingsView,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { DATE_LOCALE } from '@/lib/locale';
import { sessionWhen } from '@/lib/momentFormat';
import { useIsOnline } from '@/lib/query';
import { popRevealMode, pushRevealMode } from '@/lib/sheetVisibility';
import { motion, radius, useTheme } from '@/theme';

const POLL_MS = 5000;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);
// HERO_RATIO/GUTTER now in lib/layout.ts (the cover hero is .hero-bleed-top, a
// full-bleed photo under the status bar; HERO_RATIO is now shared with — and
// equal to — the impression hero's, per Simon's ruling).
// The floating bar collapses (blur bg + title) when the on-photo title scrolls
// under it — a MEASURED threshold (titleBottom − BAR_H), computed in
// CoverHeroLineup, not a magic scroll constant (which mis-fired on a
// proportional-height hero). Mirrors the impression hero's collapse-by-measure.

type MetaView = SessionState['meta'];

// Blind reveal/hide surface, bundled so the plain + cover-hero layouts each
// take one prop. `stripVariant` null ⟺ not a blind session (no strip).
type RevealProps = {
  stripVariant: 'guest' | 'host-resting' | 'host-mode' | null;
  revealMode: boolean;
  revealBusy: boolean;
  hostRevealUi: boolean;
  total: number;
  hiddenCount: number;
  blindForEveryone: boolean;
  onEnterMode: () => void;
  onRevealOne: (wineId: string) => void;
  onHideOne: (wineId: string) => void;
  onRevealAll: () => void;
  onHideAll: () => void;
};

// FlatList cell union for the PLAIN (no-cover) layout: a leading sticky
// reveal-strip sentinel, then wines. The sentinel + stickyHeaderIndices let the
// strip flow under the ovc and pin on scroll (the plain layout's tabs are a
// fixed View above the list). The cover-hero layout uses the Dynamic Overlay
// pattern instead (no cell sentinels) — see CoverHeroLineup.
const STRIP_CELL = { __strip: true } as const;
type LineupCell = typeof STRIP_CELL | WireWine;
function isStripCell(it: LineupCell): it is typeof STRIP_CELL {
  return (it as { __strip?: true }).__strip === true;
}

// Collapsed HeroTopBar's painted height = safe-area top + the 34pt control row +
// 6pt bottom pad. No bottom rule to account for (the collapsed bar is a flat
// opaque fill, no border — ADR-0003). The cover-hero sticky pin offset derives
// from this so the tabs/strip pin flush under the bar; overlays then pin at
// PIN_Y = this − 1 (1px overlap) against sub-pixel rounding. Shared with
// HeroTopBar so the two can't drift.
const heroBarHeight = (insetTop: number) => insetTop + 34 + 6;

// Renders the reveal strip for either layout (null when not blind). Pulls the
// matching RevealStrip variant from the bundle.
function RevealStripFor({ reveal }: { reveal: RevealProps }) {
  if (!reveal.stripVariant) return null;
  return (
    <RevealStrip
      variant={reveal.stripVariant}
      total={reveal.total}
      hiddenCount={reveal.hiddenCount}
      blindForEveryone={reveal.blindForEveryone}
      busy={reveal.revealBusy}
      onEnterMode={reveal.onEnterMode}
      onRevealAll={reveal.onRevealAll}
      onHideAll={reveal.onHideAll}
    />
  );
}

// 02b line-up to the vero-screens pixel spec: .sess-meta line, .ovc about
// block, .vtabs, .lurow anatomy, .lock-card with countdown cells, .tempty.
// Milestone 3: rows open the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the score chip. The ⋯ menu wires People + Share
// (sheets), a live Blind-for-all toggle, and Settings (02f, a pushed screen
// stack under settings/); the Compare tab still renders disabled (flagged).
export default function SessionLineup() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const router = useRouter();
  const online = useIsOnline();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Per-section graceful degradation (mirrors web SessionShell): a null
  // section from a partially-failed /state keeps the previous data.
  const lastRef = useRef<SessionState>({ meta: null, wines: null, ratings: null });

  // /state 401s for non-participants — the visit POST registers this user in
  // the session's identities map first. visitAttempt re-runs the effect for
  // retries; the effect also resets all per-session state on a code change.
  const [visited, setVisited] = useState(false);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [removedKind, setRemovedKind] = useState<'banned' | 'kicked' | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [sessMenuTop, setSessMenuTop] = useState<number | null>(null); // ⋯ menu anchor
  const [visitAttempt, setVisitAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setVisited(false);
    setFatal(null);
    setRemovedKind(null);
    lastRef.current = { meta: null, wines: null, ratings: null };
    postVisit(code)
      .then(() => {
        if (cancelled) return;
        setVisited(true);
        // Membership just registered — the Moments home pinning depends on it.
        queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
      })
      .catch((e) => { if (!cancelled) setFatal(e instanceof ApiError ? e : new ApiError('http', 0)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, visitAttempt]);

  // A kick is recoverable: rejoining by code clears the server-side kicked
  // marker, but this screen instance may still hold the stale removed state.
  // Re-run the visit whenever the screen regains focus in a recoverable
  // fatal state (never for plain network errors — those have a Try-again).
  const fatalRef = useRef<ApiError | null>(null);
  fatalRef.current = fatal;
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedOnce.current) {
        focusedOnce.current = true;
        return;
      }
      const f = fatalRef.current;
      if (f && (f.kind === 'removed' || f.kind === 'invalid')) setVisitAttempt((n) => n + 1);
    }, []),
  );

  // Banned vs kicked copy (web RemovedView parity).
  useEffect(() => {
    if (fatal?.kind !== 'removed') return;
    let cancelled = false;
    getRemovedState(code)
      .then((s) => { if (!cancelled && (s === 'banned' || s === 'kicked')) setRemovedKind(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fatal, code]);

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    enabled: visited && !fatal,
    refetchInterval: POLL_MS,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && FATAL_KINDS.has(error.kind)) && failureCount < 1,
  });

  useEffect(() => {
    if (state.error instanceof ApiError && FATAL_KINDS.has(state.error.kind)) setFatal(state.error);
  }, [state.error]);

  if (state.data) {
    lastRef.current = {
      meta: state.data.meta ?? lastRef.current.meta,
      wines: state.data.wines ?? lastRef.current.wines,
      ratings: state.data.ratings ?? lastRef.current.ratings,
    };
  }
  const { meta, wines, ratings } = lastRef.current;

  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const canAdd = isHostViewer || !!meta?.providerIds?.includes(myIdentityId);

  // Blind-for-all inline toggle (⋯ menu). Optimistically flip the cached meta
  // so the switch responds immediately, PATCH, then let the 5s poll reconcile;
  // roll back + alert on failure. blindForEveryone is NOT pro-gated server-side
  // (it composes on an already-blind session — root freemium note), so any
  // host/cohost on a blind session may flip it. The menu only renders the
  // toggle enabled when meta.blind is true.
  const [bfaBusy, setBfaBusy] = useState(false);
  const stateKey = ['session-state', code, myIdentityId];
  const toggleBlindForEveryone = useCallback(async (next: boolean) => {
    if (bfaBusy) return;
    setBfaBusy(true);
    const prev = queryClient.getQueryData<SessionState>(stateKey);
    if (prev?.meta) {
      queryClient.setQueryData<SessionState>(stateKey, { ...prev, meta: { ...prev.meta, blindForEveryone: next } });
    }
    try {
      await updateMomentSettings(code, { blindForEveryone: next });
      queryClient.invalidateQueries({ queryKey: ['session-state', code] });
    } catch (e) {
      if (prev) queryClient.setQueryData<SessionState>(stateKey, prev); // roll back
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      Alert.alert('Could not update', msg || 'Check your connection and try again.');
    } finally {
      setBfaBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bfaBusy, code, myIdentityId]);

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

  // Reveal MODE — the host taps the resting strip's Reveal to enter a manage
  // surface (sticky Hide all / Reveal all, per-row Reveal/Hide pills, a sticky
  // Done footer). It's screen state, so it also drives the OS-tab-bar hide via
  // the reveal-mode counter (the footer replaces the nav, design ruling).
  const [revealMode, setRevealMode] = useState(false);
  // Leaving the blind state (toggle off / session changes) must drop the mode
  // so the footer + hidden tab bar can't strand. Also pop the override on
  // unmount.
  useEffect(() => {
    if (!hostRevealUi && revealMode) setRevealMode(false);
  }, [hostRevealUi, revealMode]);
  useEffect(() => {
    if (!revealMode) return;
    pushRevealMode();
    return () => popRevealMode();
  }, [revealMode]);

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
  const heroShown = hasCover && !fatal && visited && !(state.isPending && wines === null);
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

  // Everything the line-up body needs to render the blind reveal/hide surface,
  // bundled so the two layouts (plain + cover-hero) take one prop. `strip` is
  // null on a non-blind session (no strip at all).
  const stripVariant: 'guest' | 'host-resting' | 'host-mode' | null = !isBlind
    ? null
    : !hostRevealUi
      ? 'guest'
      : revealMode
        ? 'host-mode'
        : 'host-resting';
  const reveal: RevealProps = {
    stripVariant,
    revealMode,
    revealBusy,
    hostRevealUi,
    total: wines?.length ?? 0,
    hiddenCount,
    blindForEveryone,
    onEnterMode: () => setRevealMode(true),
    onRevealOne,
    onHideOne,
    onRevealAll,
    onHideAll,
  };

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
                      here), left of the ⋯. Host/cohost/provider only. */}
                  {canAdd ? <LineupAddButton onPress={openAdd} /> : null}
                  <SessionMenuButton onOpen={(top) => setSessMenuTop(top)} />
                </View>
              ) : undefined
            }
          />
        </View>
      ) : null}
      {/* Session ⋯ menu (.sess-menu): Blind-for-all (live toggle), People,
          Share, Settings. Share intentionally lives in BOTH the menu and the
          Settings hub (Simon's ruling). */}
      <SessionMenu
        anchorTop={sessMenuTop}
        onClose={() => setSessMenuTop(null)}
        // Blind-for-all is a host/cohost control that only appears when the
        // session is ACTUALLY blind (design: the .sess-menu-mode row is absent
        // otherwise). A press-to-activate field, not a switch.
        showBlindForEveryone={isHostViewer && !!meta?.blind}
        blindForEveryone={!!meta?.blindForEveryone}
        bfaBusy={bfaBusy}
        onToggleBlindForEveryone={toggleBlindForEveryone}
        onPeople={() => { setSessMenuTop(null); setPeopleOpen(true); }}
        onShare={() => { setSessMenuTop(null); setInviteOpen(true); }}
        onSettings={() => { setSessMenuTop(null); router.push({ pathname: '/(tabs)/moments/session/[code]/settings', params: { code } }); }}
      />
      {meta ? (
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
        <FatalView fatal={fatal} removedKind={removedKind} sessionLabel={meta?.name ?? null}
          onRetry={() => setVisitAttempt((n) => n + 1)} onBack={() => router.back()} />
      ) : !visited || (state.isPending && wines === null) ? (
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
          wines={wines}
          ratings={ratings}
          myIdentityId={myIdentityId}
          canAdd={canAdd}
          windowH={windowH}
          ovc={ovc}
          reveal={reveal}
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
            <TabStrip />
          </View>
          {/* The reveal/hide strip is a STICKY list cell (design
              .reveal-strip-sticky): it sits inline above the line-up — below the
              ovc about block — and pins under the tabs once scrolled past
              (sticky top:0). Implemented as data item 0 + stickyHeaderIndices so
              the ovc (ListHeaderComponent) scrolls away while the strip pins. On
              a non-blind session there's no strip cell and nothing sticks.
              ⚠️ stickyHeaderIndices is OFFSET BY +1 when a ListHeaderComponent
              exists (RN: stickyOffset = header ? 1 : 0) — so [1] sticks data
              item 0 (the strip), NOT [0] (which would stick the ovc header). */}
          <FlatList<LineupCell>
            data={reveal.stripVariant ? [STRIP_CELL, ...(wines ?? [])] : (wines ?? [])}
            keyExtractor={(it) => (isStripCell(it) ? '__strip' : it.id)}
            ListHeaderComponent={ovc}
            stickyHeaderIndices={reveal.stripVariant ? [1] : undefined}
            // flexGrow:1 gives the empty state a flex slot; EmptyLineup freezes its
            // own height there so its centering doesn't jump when the tab bar hides.
            // In reveal mode the OS tab bar is hidden and the Done footer takes its
            // place — clear the footer (a bit more than the bar) instead.
            contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: insets.bottom + (revealMode ? 96 : TAB_BAR_CLEARANCE) }}
            // No separator below the strip cell — a sticky cell carries its
            // trailing separator while pinned, which would weld a hairline to
            // the floating strip's bottom edge. The strip has its own spacing.
            ItemSeparatorComponent={({ leadingItem }: { leadingItem: LineupCell }) =>
              isStripCell(leadingItem) ? null : <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />
            }
            renderItem={({ item, index }) =>
              isStripCell(item) ? (
                // Solid bg so rows scrolling under the pinned strip don't bleed
                // through. Rows share the same content width (both inset by the
                // contentContainer GUTTER), so nothing renders in the side
                // bands — a content-width opaque fill is enough.
                <View style={{ backgroundColor: theme.bg }}>
                  <RevealStripFor reveal={reveal} />
                </View>
              ) : (
                <LuRow
                  wine={item}
                  // Offset by the leading strip cell so the displayed index is
                  // the wine's true position, not its data-array slot.
                  index={reveal.stripVariant ? index - 1 : index}
                  myIdentityId={myIdentityId}
                  ratings={ratings}
                  onPress={() => openImpression(item.id)}
                  hostRevealUi={reveal.hostRevealUi}
                  revealMode={revealMode}
                  revealBusy={revealBusy}
                  onReveal={reveal.onRevealOne}
                  onHide={reveal.onHideOne}
                />
              )
            }
            // Footer: the empty state goes here when there are no wines but a
            // strip cell keeps the list non-empty (blind session — ListEmpty
            // wouldn't fire); otherwise the trailing .lu-add row (host/cohost/
            // provider, hidden in reveal mode). ListEmptyComponent still covers
            // the non-blind empty case (data is truly []).
            ListFooterComponent={
              (wines?.length ?? 0) === 0
                ? reveal.stripVariant
                  ? <EmptyLineup canAdd={canAdd} onAdd={openAdd} />
                  : null
                : canAdd && !revealMode
                  ? <AddImpressionRow onPress={openAdd} />
                  : null
            }
            ListEmptyComponent={<EmptyLineup canAdd={canAdd} onAdd={openAdd} />}
          />
        </>
      )}
      {/* .vfoot-rev — sticky Done footer that exits reveal mode (the OS tab bar
          is hidden while it's up). Sits above the list, below the hero bar. */}
      {revealMode ? <RevealFooter onDone={() => setRevealMode(false)} /> : null}
      {/* .hero-topfix — floats over the hero: transparent with glass back+⋯
          while the photo title is visible, then a solid theme bar carrying the
          moment name once scrolled past the collapse point. Sits last so it
          paints above the scroll content; below the SessionMenu (a Modal). */}
      {heroShown && meta ? (
        <HeroTopBar
          title={meta.name}
          collapsed={heroCollapsed}
          canAdd={canAdd}
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
  meta, coverUrl, lock, wines, ratings, myIdentityId, canAdd, windowH, ovc, reveal, onCollapsedChange, onPressWine, onAdd,
}: {
  meta: NonNullable<MetaView>;
  coverUrl: string;
  lock: number | null;
  wines: WireWine[] | null;
  ratings: RatingsView | null;
  myIdentityId: string;
  canAdd: boolean;
  windowH: number;
  ovc: React.ReactNode;
  reveal: RevealProps;
  onCollapsedChange: (collapsed: boolean) => void;
  onPressWine: (wineId: string) => void;
  onAdd: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [fullscreen, setFullscreen] = useState(false);
  const heroH = Math.round(windowH * HERO_RATIO);
  const BAR_H = heroBarHeight(insets.top);
  const rows = wines ?? [];
  const showStrip = !!reveal.stripVariant && !lock;

  // UI-thread scroll position for the overlay translates.
  const aref = useAnimatedRef<Reanimated.ScrollView>();
  const scrollY = useScrollOffset(aref);
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

  // Pin 1px UNDER the bar's bottom so the opaque bg tucks beneath the bar — a
  // flush pin can leave a sub-pixel hairline after rounding. (The bar paints on
  // top, zIndex 8 > 7, so the overlap is invisible.)
  const PIN_Y = BAR_H - 1;

  const onScrollJS = (y: number) => {
    // Collapse when the on-photo title has scrolled under the bar's bottom
    // (measured — matches the impression hero; robust to a proportional hero).
    const next = y >= titleBottom - BAR_H;
    if (next !== collapsedRef.current) {
      collapsedRef.current = next;
      onCollapsedChange(next);
    }
    // Each stuck flag flips at the same inequality its overlay clamps on, so the
    // opacity swap happens exactly where inline + overlay coincide (no jump).
    const ts = tabsTopJS > 0 && y >= tabsTopJS - PIN_Y;
    setTabsStuck((prev) => (prev === ts ? prev : ts));
    const stripFloor = PIN_Y + tabsHJS; // strip pins UNDER the pinned tabs
    const ss = stripTopJS > 0 && y >= stripTopJS - stripFloor;
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

  const Tabs = (
    <View style={{ backgroundColor: theme.bg, paddingHorizontal: GUTTER }}>
      <TabStrip />
    </View>
  );
  const Strip = showStrip ? (
    <View style={{ backgroundColor: theme.bg, paddingHorizontal: GUTTER }}>
      <RevealStripFor reveal={reveal} />
    </View>
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
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + (reveal.revealMode ? 96 : TAB_BAR_CLEARANCE) }}
      >
        {/* .hero-bleed-top: full-bleed photo at content-y 0 (bleeds under the
            status bar via the dead-end + never). Soft top corners while pulled. */}
        <View
          style={{
            height: heroH,
            overflow: 'hidden',
            borderTopLeftRadius: pulled ? radius.xl : 0,
            borderTopRightRadius: pulled ? radius.xl : 0,
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Open cover photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
            <Image source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          </Pressable>
          {/* Shared HERO_SCRIM (converged to the impression hero's gradient — was
              0.28/0.05/0.72, slightly lighter at the bottom). */}
          <LinearGradient
            pointerEvents="none"
            colors={HERO_SCRIM}
            locations={[0, 0.45, 1]}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          {/* Title: measure its bottom in content space (its parent is the photo
              View whose top is content-y 0, so y + height is content-Y). */}
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 18, right: 18, bottom: 14 }}
            onLayout={(e) => setTitleBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
          >
            <VText
              numberOfLines={2}
              style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, lineHeight: 30, letterSpacing: -0.5, color: '#fff' }}
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
        {/* about block (or lock card) — scrolls beneath the tabs */}
        {lock ? (
          <View style={{ paddingHorizontal: GUTTER }}>
            <LockCard revealAt={lock} />
            {ovc}
          </View>
        ) : (
          <View style={{ paddingHorizontal: GUTTER }}>{ovc}</View>
        )}
        {/* INLINE reveal strip — below the about block, above the rows. At-rest
            position + flow spacer. Direct scroll child → layout.y is content-Y. */}
        {Strip ? (
          <View
            onLayout={(e) => {
              const y = e.nativeEvent.layout.y;
              stripTop.value = y;
              setStripTopJS(y);
            }}
          >
            {Strip}
          </View>
        ) : null}
        {/* rows + footer */}
        {lock ? null : (
          <View>
            {rows.length === 0 ? (
              <View style={{ paddingHorizontal: GUTTER }}>
                <EmptyLineup canAdd={canAdd} onAdd={onAdd} />
              </View>
            ) : (
              rows.map((item, index) => (
                <View key={item.id} style={{ paddingHorizontal: GUTTER }}>
                  {index > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
                  <LuRow
                    wine={item}
                    index={index}
                    myIdentityId={myIdentityId}
                    ratings={ratings}
                    onPress={() => onPressWine(item.id)}
                    hostRevealUi={reveal.hostRevealUi}
                    revealMode={reveal.revealMode}
                    revealBusy={reveal.revealBusy}
                    onReveal={reveal.onRevealOne}
                    onHide={reveal.onHideOne}
                  />
                </View>
              ))
            )}
            {rows.length > 0 && canAdd && !reveal.revealMode ? (
              <View style={{ paddingHorizontal: GUTTER }}>
                <AddImpressionRow onPress={onAdd} />
              </View>
            ) : null}
          </View>
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
          style={[tabsOverlayStyle, { position: 'absolute', left: 0, right: 0, zIndex: 7, opacity: tabsStuck ? 1 : 0 }]}
        >
          {Tabs}
        </Reanimated.View>
      ) : null}
      {Strip ? (
        <Reanimated.View
          pointerEvents={stripStuck ? 'auto' : 'none'}
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
  title, collapsed, canAdd, onAdd, onBack, onMenu,
}: {
  title: string;
  collapsed: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onBack: () => void;
  onMenu: (anchorBottomY: number) => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const moreRef = useRef<View>(null);
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
  const circle = collapsed
    ? { width: 34, height: 34, alignItems: 'center' as const, justifyContent: 'center' as const }
    : { width: 34, height: 34, borderRadius: 17, backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const };
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
      {/* Layout = heroBarHeight(insets.top): paddingTop insets.top + 34 row + 6
          bottom (no border — opaque fill, ADR-0003). Keep in sync with
          heroBarHeight (the cover-hero sticky pin offset derives from it). */}
      <View style={{ paddingTop: insets.top, paddingHorizontal: 14, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 34 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}
            style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}>
            <Icon name="back" size={20} color={iconColor} />
          </Pressable>
          {/* Title appears only collapsed (fades in with a 4px rise). */}
          <Animated.View
            style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}
          >
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27, color: theme.ink }}>
              {title}
            </VText>
          </Animated.View>
          {/* Add (left of ⋯) — glass pill over the photo, collapsing to a bare
              + glyph once the bar goes solid (label drop mirrors the Crave
              button). Host/cohost/provider only. */}
          {canAdd ? <LineupAddButton onPress={onAdd} collapsed={collapsed} glass /> : null}
          <View ref={moreRef} collapsable={false} style={{ marginLeft: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Session menu"
              hitSlop={8}
              onPress={() => moreRef.current?.measureInWindow((_x, y, _w, h) => onMenu(y + h))}
              style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}
            >
              <Icon name="more" size={20} color={iconColor} />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function FatalView({
  fatal, removedKind, sessionLabel, onRetry, onBack,
}: {
  fatal: ApiError;
  removedKind: 'banned' | 'kicked' | null;
  sessionLabel: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  let title = 'Something went wrong';
  let body = 'Try again in a moment.';
  if (fatal.kind === 'not-found') {
    title = 'This moment has ended';
    body = 'The session is no longer live.';
  } else if (fatal.kind === 'removed') {
    if (removedKind === 'banned') {
      title = 'You have been banned from this session';
      body = `The host${sessionLabel ? ` of ${sessionLabel}` : ''} banned you. Your ratings and notes from this session have been removed.`;
    } else {
      title = 'You were removed';
      body = 'The host removed you from this moment. You can rejoin with the code.';
    }
  } else if (fatal.kind === 'invalid') {
    body = "We couldn't verify you in this moment. Try joining again with the code.";
    title = 'Not part of this moment';
  }
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, textAlign: 'center' }}>{title}</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 20, maxWidth: 260 }}>{body}</VText>
      {fatal.kind === 'http' ? <Button title="Try again" onPress={onRetry} style={{ marginTop: 10 }} /> : null}
      <Button title="Back to Moments" variant="secondary" onPress={onBack} style={{ marginTop: fatal.kind === 'http' ? 0 : 10 }} />
    </View>
  );
}

// .vtabs — Line-up | Compare. Compare arrives in a later milestone; the tab
// renders per spec but disabled.
function TabStrip() {
  const { theme } = useTheme();
  const tab = (label: string, on: boolean, disabled?: boolean) => (
    <View
      key={label}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 2,
        borderBottomColor: on ? theme.accent : 'transparent',
        marginBottom: -1,
      }}
    >
      <VText
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}
        color={on ? 'ink' : disabled ? 'inkFaint' : 'inkSoft'}
      >
        {label}
      </VText>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 2, borderBottomWidth: 1, borderBottomColor: theme.rule, marginBottom: 4 }}>
      {tab('Line-up', true)}
      {tab('Compare', false, true)}
    </View>
  );
}

// .rs-btn — accent-filled pill in the reveal strip (Reveal / Reveal all / Hide
// all). Always carries a leading eye/eye-off glyph.
function RsButton({
  icon, label, onPress, disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  // .rs-btn[disabled]: surface-sunk fill + ink-soft text/glyph + 0.4 opacity
  // (NOT a dimmed-gold pill) per the design.
  const fg = disabled ? theme.inkSoft : theme.accentInk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingVertical: 7, paddingHorizontal: 15, borderRadius: radius.pill,
        backgroundColor: disabled ? theme.surfaceSunk : theme.accent,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={15} color={fg} />
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16, color: fg }}>
        {label}
      </VText>
    </Pressable>
  );
}

// .reveal-strip — the blind line-up's host control strip + the taster's quiet
// notice. Three shapes, all per vero-screens (tBlindHost / tReveal / tBlindAll
// / tBlindViewer):
//  - guest (non-host on a blind session): quiet "Blind tasting · host reveals".
//  - host resting: "N of M hidden from guests" (or "Hidden from everyone" when
//    blind-for-all; "All revealed…" when nothing is hidden) + a Reveal button
//    that enters reveal mode. The Reveal button is ALWAYS present — even when
//    all revealed — so Done never traps the host out of the controls.
//  - host reveal mode: sticky count chip on the left, Hide all + Reveal all on
//    the right (the per-row pills live on the rows themselves).
function RevealStrip({
  variant, total, hiddenCount, blindForEveryone, busy, onEnterMode, onRevealAll, onHideAll,
}: {
  variant: 'guest' | 'host-resting' | 'host-mode';
  total: number;
  hiddenCount: number;
  blindForEveryone: boolean;
  busy: boolean;
  onEnterMode: () => void;
  onRevealAll: () => void;
  onHideAll: () => void;
}) {
  const { theme } = useTheme();
  const noticeText = (children: React.ReactNode) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, minWidth: 0 }}>
      <Icon name="eyeoff" size={16} color={theme.inkSoft} />
      <VText variant="small" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', flexShrink: 1 }} color="inkSoft">
        {children}
      </VText>
    </View>
  );

  if (variant === 'guest') {
    // .reveal-strip.is-quiet
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 6, paddingBottom: 10 }}>
        {noticeText('Blind tasting · host reveals')}
      </View>
    );
  }

  if (variant === 'host-mode') {
    // Manage strip: .rv-count + .rv-allrow (Hide all · Reveal all). BOTH
    // buttons stay live regardless of state — "reveal all" doesn't mean you're
    // finished or that the controls go away; the host keeps full control until
    // they tap Done. Only the transient in-flight `busy` disables them.
    return (
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          flexWrap: 'wrap', paddingTop: 10, paddingBottom: 10, backgroundColor: theme.bg,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="eyeoff" size={15} color={theme.inkSoft} />
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16, fontVariant: ['tabular-nums'] }} color="inkSoft">
            {hiddenCount}
          </VText>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
          <RsButton icon="eyeoff" label="Hide all" onPress={onHideAll} disabled={busy} />
          <RsButton icon="eye" label="Reveal all" onPress={onRevealAll} disabled={busy} />
        </View>
      </View>
    );
  }

  // host-resting — the Reveal button (enters manage mode) is ALWAYS present so
  // the host can re-open the controls even after revealing everything. The
  // notice text just reflects the current count.
  const nothingHidden = hiddenCount === 0;
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        flexWrap: 'wrap', paddingTop: 6, paddingBottom: 10,
      }}
    >
      {blindForEveryone
        ? noticeText(nothingHidden ? 'All revealed' : 'Hidden from everyone')
        : noticeText(nothingHidden ? 'All revealed to guests' : `${hiddenCount} of ${total} hidden from guests`)}
      <RsButton icon="eye" label="Reveal" onPress={onEnterMode} disabled={busy} />
    </View>
  );
}

// .vfoot-rev — the sticky "Done" footer that exits reveal mode (replaces the
// nav while managing). Solid bg bar (not the create gradient — pushed-screen
// idiom, but here it's an in-screen mode so a solid bar reads cleanest over the
// list) with a single full-width button.
function RevealFooter({ onDone }: { onDone: () => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 7,
        backgroundColor: theme.bg, borderTopWidth: 1, borderTopColor: theme.rule,
        paddingTop: 12, paddingHorizontal: 14, paddingBottom: insets.bottom + 12,
      }}
    >
      <Button title="Done" bar block onPress={onDone} />
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
              <VText variant="small" color="accent">Event link</VText>
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
            style={{ position: 'absolute', left: 0, right: 0, opacity: 0, lineHeight: 20 }}
          >
            {meta.description}
          </VText>
          {descOpen ? (
            // Expanded: "less" flows inline at the end of the last line.
            <VText variant="small" color="inkSoft" style={{ marginTop: 10, lineHeight: 20 }}>
              {meta.description}
              <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
                {'  less'}
              </VText>
            </VText>
          ) : (
            <VText variant="small" color="inkSoft" numberOfLines={3} style={{ marginTop: 10, lineHeight: 20 }}>
              {truncated ?? meta.description}
              {truncated !== null ? (
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
                  {' more'}
                </VText>
              ) : null}
            </VText>
          )}
        </Pressable>
      ) : null}
      <AvatarFoot meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPress={onPeople} />
    </View>
  );
}

// .ovc-foot + .ovc-chip: 28px initials circles, -8 overlap, host = accent,
// overflow chip = accent tint, "Hosted by <b>…</b>".
function AvatarFoot({ meta, isHostViewer, myIdentityId, onPress }: { meta: NonNullable<MetaView>; isHostViewer: boolean; myIdentityId: string; onPress: () => void }) {
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
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, opacity: pressed ? 0.6 : 1 })}
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
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }} color="accent">+{extra}</VText>
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
function lockState(meta: MetaView): number | null {
  if (!meta?.hideLineup || !meta.dateFrom) return null;
  const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60_000;
  return Date.now() < revealAt ? revealAt : null;
}

// .lock-card + .cd countdown cells + .lock-start.
function LockCard({ revealAt }: { revealAt: number }) {
  const { theme } = useTheme();
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
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
        Something good awaits you
      </VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 20, maxWidth: 250, marginTop: 8, marginBottom: 22 }}>
        The host has kept the line-up under wraps. It opens when the reveal time arrives.
      </VText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {cells.map(([label, v]) => (
          <View key={label} style={{ width: 58, backgroundColor: theme.surfaceSunk, borderRadius: radius.md, paddingTop: 10, paddingBottom: 7, alignItems: 'center' }}>
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, letterSpacing: -0.5, lineHeight: 28 }}>
              {String(v).padStart(2, '0')}
            </VText>
            <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', marginTop: 5 }}>
              {label}
            </VText>
          </View>
        ))}
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, marginTop: 18 }} color="accent">
        Line-up reveals {when}
      </VText>
    </View>
  );
}

// .tempty — role-aware: only viewers with add-rights get the "add the first
// thing" invitation (guest copy is unspecced in the handoff; flagged).
function EmptyLineup({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
  const { theme } = useTheme();
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
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23 }}>Nothing in the line-up yet</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', maxWidth: 230, lineHeight: 20, marginTop: 6 }}>
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
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 14, lineHeight: 18 }} color={theme.accentInk}>
            Add impression
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
      accessibilityLabel="Add impression"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        marginTop: 8, paddingVertical: 14, borderRadius: radius.md,
        borderWidth: 1, borderStyle: 'dashed', borderColor: theme.accentLine,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="plus" size={17} color={theme.accent} />
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16 }} color="accent">
        Add impression
      </VText>
    </Pressable>
  );
}

function ratersFor(wineId: string, ratings: RatingsView | null): number {
  if (!ratings) return 0;
  let n = 0;
  for (const entry of Object.values(ratings)) {
    const r = entry.ratings[wineId];
    if (r && r.score > 0) n += 1;
  }
  return n;
}

// .lurow: idx · thumb · name/vintage + maker + style · score/rated column.
// The whole row opens the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the one-star score chip.
//
// Blind variants (host on a blind session — `hostRevealUi`):
//  - host-sees + hidden-from-guests: the host sees the real wine (server
//    bypass on a normal blind session), with a small eye-off badge on the
//    thumb and (resting only) a "Hidden from guests" tag.
//  - masked (_blind): the wine is concealed even from the host (blind-for-all,
//    not yet revealed) — the mystery placeholder.
//  - reveal mode: the score/rate slot swaps to a Reveal/Hide pill.
function LuRow({
  wine, index, myIdentityId, ratings, onPress,
  hostRevealUi = false, revealMode = false, revealBusy = false, onReveal, onHide,
}: {
  wine: WireWine;
  index: number;
  myIdentityId: string;
  ratings: RatingsView | null;
  onPress: () => void;
  // Host on a blind session: enables the hidden-from-guests badge + the
  // reveal/hide pill in reveal mode.
  hostRevealUi?: boolean;
  revealMode?: boolean;
  revealBusy?: boolean;
  onReveal?: (wineId: string) => void;
  onHide?: (wineId: string) => void;
}) {
  const { theme } = useTheme();
  const myScore = ratings?.[myIdentityId]?.ratings[wine.id]?.score ?? 0;
  const raters = ratersFor(wine.id, ratings);
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

  // In reveal mode the row is a manage target (the pill), NOT a way into the
  // impression detail — disable the whole-row press so a tap on the row (incl. a
  // busy/disabled pill, which doesn't claim the responder) can't navigate away
  // mid-reveal. Outside reveal mode the row opens the detail as normal.
  return (
    <Pressable
      onPress={revealMode ? undefined : onPress}
      disabled={revealMode}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/* .lu-idx: 18w, 13/600, ink-faint, tabular */}
      <VText
        color="inkFaint"
        style={{ width: 18, textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, fontVariant: ['tabular-nums'] }}
      >
        {index + 1}
      </VText>
      {masked ? (
        // .lu-masked: sunk bg, dashed rule border, eye-off
        <View
          style={{
            width: 46, height: 46, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk,
            borderWidth: 1, borderStyle: 'dashed', borderColor: theme.rule,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="eyeoff" size={18} color={theme.inkFaint} />
        </View>
      ) : (
        // .lu-thumbwrap — the host's hidden-from-guests wine carries a small
        // eye-off badge pinned to the thumb's bottom-right corner.
        <View style={{ width: 46, height: 46 }}>
          <Thumb uri={wine.imageUrl} size={46} />
          {hostSeesHidden ? (
            // .lu-hidebadge: 20px surface circle, ink-soft eye-off, overhanging
            // the thumb corner.
            <View
              style={{
                position: 'absolute', right: -4, bottom: -4, width: 20, height: 20, borderRadius: 10,
                backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon name="eyeoff" size={12} color={theme.inkSoft} />
            </View>
          ) : null}
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {masked ? (
          <>
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              Impression {index + 1}
            </VText>
            <VText variant="small" color="inkSoft" style={{ marginTop: 1 }}>To be revealed</VText>
          </>
        ) : (
          <>
            {/* .lu-name: "Oslavje - 2018" — the dash stays in the name
                colour; only the year itself is ink-soft regular. The host's
                hidden-from-guests tag rides the name line (resting only). */}
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              {wine.name}
              {wine.vintage ? (
                <>
                  {' - '}
                  <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 15, lineHeight: 23 }}>{wine.vintage}</VText>
                </>
              ) : null}
            </VText>
            {hostSeesHidden && !revealMode ? (
              <VText variant="caption" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 1 }} color="inkSoft">
                Hidden from guests
              </VText>
            ) : wine.producer ? (
              <VText variant="small" color="inkSoft" numberOfLines={1} style={{ marginTop: 1 }}>{wine.producer}</VText>
            ) : null}
            {!hostSeesHidden && (wine.grape || wine.type) ? (
              <VText variant="caption" color="inkFaint" numberOfLines={1} style={{ marginTop: 1 }}>
                {wine.grape || wine.type}
              </VText>
            ) : null}
          </>
        )}
      </View>
      {revealMode ? (
        // .lu-pill — reveal/hide control replacing the score slot. Reveal =
        // accent fill; Hide = outline ink-soft (per .lu-pill-reveal /
        // .lu-pill-hide).
        revealedToGuests ? (
          <LuPill icon="eyeoff" label="Hide" busy={revealBusy} onPress={() => onHide?.(wine.id)} />
        ) : (
          <LuPill icon="eye" label="Reveal" filled busy={revealBusy} onPress={() => onReveal?.(wine.id)} />
        )
      ) : (
        // .lu-right2: score chip when rated, .lu-rate pill when not
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          {myScore > 0 ? (
            <StarScore value={myScore} />
          ) : (
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.accentLine,
                borderRadius: radius.pill,
                paddingVertical: 5,
                paddingHorizontal: 13,
              }}
            >
              <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16 }} color="accent">
                Rate
              </VText>
            </View>
          )}
          {raters > 0 ? (
            <VText variant="caption" color="inkFaint">{`Rated by ${raters}`}</VText>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

// .lu-pill — per-row reveal/hide control in reveal mode. `filled` = accent
// background (Reveal); otherwise an outline ink-soft pill (Hide). Its own
// Pressable so a tap on the pill doesn't also open the impression detail
// (a child Pressable captures the touch before the row's).
function LuPill({
  icon, label, filled, busy, onPress,
}: {
  icon: IconName;
  label: string;
  filled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 13,
        borderRadius: radius.pill,
        backgroundColor: filled ? theme.accent : 'transparent',
        borderWidth: filled ? 0 : 1,
        borderColor: theme.rule,
        opacity: busy ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={15} color={filled ? theme.accentInk : theme.inkSoft} />
      <VText
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16, color: filled ? theme.accentInk : theme.inkSoft }}
      >
        {label}
      </VText>
    </Pressable>
  );
}

// VBar ⋯ button — measures its position so the menu anchors under it.
function SessionMenuButton({ onOpen }: { onOpen: (anchorBottomY: number) => void }) {
  const { theme } = useTheme();
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Session menu"
        hitSlop={8}
        onPress={() => ref.current?.measureInWindow((_x, y, _w, h) => onOpen(y + h))}
        style={({ pressed }) => ({ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="more" size={20} color={theme.ink} />
      </Pressable>
    </View>
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
  onPress, collapsed, glass,
}: {
  onPress: () => void;
  // cover-hero only: drop the label, leave the + glyph (mirrors crave's titleShown)
  collapsed?: boolean;
  // cover-hero only: glass pill treatment over the photo (pre-collapse)
  glass?: boolean;
}) {
  const { theme } = useTheme();
  const onGlass = glass && !collapsed;
  // Plain bar + collapsed cover: bare ink (like the back/⋯). Only the over-photo
  // glass variant is white.
  const iconColor = onGlass ? '#fff' : theme.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add impression"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 34,
        // Only the over-photo glass variant carries a fill + rounded pill; the
        // plain-bar and collapsed variants are borderless.
        paddingHorizontal: onGlass ? 13 : 4,
        borderRadius: onGlass ? 17 : 0,
        backgroundColor: onGlass ? GLASS_FILL : 'transparent',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/* 17px glyph in every state — matches the .hv-add spec; we borrow the
          Crave button's collapse mechanism, not its icon size. */}
      <Icon name="plus" size={17} color={iconColor} />
      {!collapsed ? (
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20, color: iconColor }}>
          Add
        </VText>
      ) : null}
    </Pressable>
  );
}

// Session ⋯ menu (.sess-menu): Blind-for-all is a press-to-activate mode row
// (.sess-menu-mode) shown only on a blind session for hosts/cohosts; People +
// Share invite + Settings are active. Anchored dropdown (the 02e .ir-menu pattern).
function SessionMenu({
  anchorTop, onClose, onPeople, onShare, onSettings,
  showBlindForEveryone, blindForEveryone, bfaBusy, onToggleBlindForEveryone,
}: {
  anchorTop: number | null;
  onClose: () => void;
  onPeople: () => void;
  onShare: () => void;
  onSettings: () => void;
  showBlindForEveryone: boolean;
  blindForEveryone: boolean;
  bfaBusy: boolean;
  onToggleBlindForEveryone: (next: boolean) => void;
}) {
  // Auto-dismiss the menu shortly after a Blind-for-all toggle so the user sees
  // the row flip to active, then it closes itself. Cleared on close/unmount.
  const bfaCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (anchorTop === null && bfaCloseTimer.current) {
      clearTimeout(bfaCloseTimer.current);
      bfaCloseTimer.current = null;
    }
  }, [anchorTop]);
  useEffect(() => () => { if (bfaCloseTimer.current) clearTimeout(bfaCloseTimer.current); }, []);
  return (
    // anchorTop is the ⋯ button's bottom edge; pass it as both top+bottom (the
    // menu sits at the top of the screen and never flips). right=GUTTER/minWidth
    // 200 keep the line-up menu's prior metrics.
    <AnchoredMenu
      anchor={anchorTop !== null ? { top: anchorTop, bottom: anchorTop } : null}
      onClose={onClose}
      right={GUTTER}
      minWidth={200}
    >
      {/* .sess-menu-mode — Blind-for-all is a press-to-activate field: tapping
          flips it, ACTIVE styles the whole row accent. Only on a blind session. */}
      {showBlindForEveryone ? (
        <>
          <MenuItem
            icon="eyeoff"
            label="Blind for all"
            active={blindForEveryone}
            disabled={bfaBusy}
            accessibilityState={{ selected: blindForEveryone }}
            onPress={() => {
              onToggleBlindForEveryone(!blindForEveryone);
              if (bfaCloseTimer.current) clearTimeout(bfaCloseTimer.current);
              bfaCloseTimer.current = setTimeout(onClose, 300);
            }}
          />
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem icon="user" label="People" onPress={onPeople} />
      <MenuItem icon="share" label="Share invite" onPress={onShare} />
      <MenuItem icon="settings" label="Settings" onPress={onSettings} />
    </AnchoredMenu>
  );
}
