import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, FlatList, Image, Linking, Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import {
  ApiError,
  getRemovedState,
  getSessionState,
  postVisit,
  updateMomentSettings,
  type RatingsView,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { initials } from '@/lib/initials';
import { DATE_LOCALE } from '@/lib/locale';
import { sessionWhen } from '@/lib/momentFormat';
import { useIsOnline } from '@/lib/query';
import { motion, radius, useTheme } from '@/theme';

const POLL_MS = 5000;
const GUTTER = 22;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);
// 02b·10 cover hero (Vero - Screens.html .hero-bleed-top): full-bleed photo
// that scrolls under the status bar, with a collapsing top bar. The mock's
// 248px bleed is measured in its 800px phone-screen frame (≈31%); a flat
// 248pt reads short on real devices, so the hero scales with the window like
// the impression hero does.
const HERO_RATIO = 248 / 800;
// .hero-topfix collapse: the floating bar gets its blur bg + title once scrolled
// past this point (the on-photo title isn't faded — it scrolls off with the
// photo and the bar title snaps in, mirroring the impression hero's feel).
const HERO_COLLAPSE_Y = 150;

type MetaView = SessionState['meta'];

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
            right={meta ? <SessionMenuButton onOpen={(top) => setSessMenuTop(top)} /> : undefined}
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
          onCollapsedChange={setHeroCollapsed}
          onPressWine={openImpression}
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
          <FlatList
            data={wines ?? []}
            keyExtractor={(w) => w.id}
            ListHeaderComponent={ovc}
            // flexGrow:1 gives the empty state a flex slot; EmptyLineup freezes its
            // own height there so its centering doesn't jump when the tab bar hides.
            contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
            renderItem={({ item, index }) => (
              <LuRow
                wine={item}
                index={index}
                myIdentityId={myIdentityId}
                ratings={ratings}
                onPress={() => openImpression(item.id)}
              />
            )}
            ListEmptyComponent={<EmptyLineup canAdd={canAdd} />}
          />
        </>
      )}
      {/* .hero-topfix — floats over the hero: transparent with glass back+⋯
          while the photo title is visible, then a blurred theme bar carrying
          the moment name once scrolled past the collapse point. Sits last so
          it paints above the scroll content; below the SessionMenu Modal. */}
      {heroShown && meta ? (
        <HeroTopBar
          title={meta.name}
          collapsed={heroCollapsed}
          onBack={() => router.back()}
          onMenu={(top) => setSessMenuTop(top)}
        />
      ) : null}
    </View>
    </BottomSheetModalProvider>
  );
}

// 02b·10 cover-hero body. One ScrollView so the photo scrolls away under the
// content; the Line-up/Compare tabs are the sticky header (index 1). Mirrors
// the impression hero's react-native-screens defenses: a zero-size
// collapsable={false} dead-end as the first sibling stops RNSScreen's
// subviews[0] finder from force-flipping contentInsetAdjustmentBehavior
// never→automatic (which would top-inset the photo below the status bar).
function CoverHeroLineup({
  meta, coverUrl, lock, wines, ratings, myIdentityId, canAdd, windowH, ovc, onCollapsedChange, onPressWine,
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
  onCollapsedChange: (collapsed: boolean) => void;
  onPressWine: (wineId: string) => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const heroH = Math.round(windowH * HERO_RATIO);
  // Mirror the collapse boolean locally so the parent setter fires only when it
  // actually flips (a real flip re-renders the whole screen — a raw scrollY in
  // parent state would do that every frame).
  const collapsedRef = useRef(false);
  // Top-overscroll flag (mirrors the impression hero): while the photo rides
  // down with the rubber band its sharp top corners get a soft radius so the
  // exposed edge doesn't read razor-sharp; flush full-bleed again at rest. Only
  // flips at the overscroll boundary, so the local re-render is cheap.
  const [pulled, setPulled] = useState(false);
  const pulledRef = useRef(false);
  const rows = wines ?? [];
  return (
    <>
      <View collapsable={false} style={{ width: 0, height: 0 }} />
      <ScrollView
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          const next = y > HERO_COLLAPSE_Y;
          if (next !== collapsedRef.current) {
            collapsedRef.current = next;
            onCollapsedChange(next);
          }
          const p = y < -1;
          if (p !== pulledRef.current) {
            pulledRef.current = p;
            setPulled(p);
          }
        }}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
      >
        {/* index 0 — .hero-bleed-top: full-bleed photo, scrim, white title.
            Soft top corners only while pulled (overscroll); flush at rest. */}
        <View
          style={{
            height: heroH,
            overflow: 'hidden',
            borderTopLeftRadius: pulled ? radius.xl : 0,
            borderTopRightRadius: pulled ? radius.xl : 0,
          }}
        >
          <Image source={{ uri: coverUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          {/* .hero-bleed-scrim — top tint keeps the white status-bar glyphs +
              glass controls legible; the stronger bottom carries the title. */}
          <LinearGradient
            colors={['rgba(15,12,10,0.28)', 'rgba(15,12,10,0.05)', 'rgba(15,12,10,0.72)']}
            locations={[0, 0.45, 1]}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          {/* .hero-bleed-title — white moment name, bottom-left. Like the
              impression hero, it does NOT fade: it just scrolls off with the
              photo, and the bar title snaps in at the collapse point. The
              earlier opacity fade read mushy; the static title is snappier. */}
          <View style={{ position: 'absolute', left: 18, right: 18, bottom: 14 }}>
            <VText
              numberOfLines={2}
              style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, lineHeight: 30, letterSpacing: -0.5, color: '#fff' }}
            >
              {meta.name}
            </VText>
          </View>
        </View>
        {/* Tabs. FLAGGED DEVIATION from the mock's `.hero-sticky` (sticky
            top:0): a sticky row under a full-bleed hero would park behind the
            floating collapse bar (sticky always pins to scroll-offset 0, which
            sits under the absolute bar), and the contentInset workaround can't
            be verified from the sandbox. Tabs scroll with the about block for
            now — near-zero functional cost while Compare is disabled. Revisit
            for sticky once testable on device. */}
        <View style={{ backgroundColor: theme.bg, paddingHorizontal: GUTTER }}>
          <TabStrip />
        </View>
        {/* body — Lock card replaces the rows when the line-up is still under
            wraps (a hidden line-up keeps its cover). */}
        {lock ? (
          <View style={{ paddingHorizontal: GUTTER }}>
            <LockCard revealAt={lock} />
            {ovc}
          </View>
        ) : (
          <View style={{ paddingHorizontal: GUTTER }}>
            {ovc}
            {rows.length === 0 ? (
              <EmptyLineup canAdd={canAdd} />
            ) : (
              rows.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
                  <LuRow
                    wine={item}
                    index={index}
                    myIdentityId={myIdentityId}
                    ratings={ratings}
                    onPress={() => onPressWine(item.id)}
                  />
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

// .hero-topfix — the floating collapsing bar over the cover hero. Pre-collapse:
// transparent, glass back + ⋯ circles, white icons. Collapsed (past 150px):
// blurred theme bg, rule underline, the moment name, ink icons. The ⋯ anchors
// the shared SessionMenu via measureInWindow (same protocol as SessionMenuButton).
function HeroTopBar({
  title, collapsed, onBack, onMenu,
}: {
  title: string;
  collapsed: boolean;
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
    : { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(20,18,15,0.5)', alignItems: 'center' as const, justifyContent: 'center' as const };
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 8 }}
    >
      {/* Blurred theme bar — its whole opacity fades in on collapse (the blur
          runs at constant intensity; the fade is what reads, so the blur pop
          stays hidden behind it). */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: anim }}>
        <BlurView
          intensity={24}
          tint={theme.scheme === 'dark' ? 'dark' : 'light'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.bg + 'DB', borderBottomWidth: 1, borderBottomColor: theme.rule }} />
      </Animated.View>
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
          <View ref={moreRef} collapsable={false}>
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

  const chip = (p: { id: string; displayName: string; imageUrl: string | null }, i: number) => {
    const isHost = p.id === hostId;
    return (
      <View
        key={p.id}
        style={{
          width: 30, height: 30, borderRadius: 15,
          marginLeft: i === 0 ? 0 : -8,
          borderWidth: 2, borderColor: theme.bg,
          backgroundColor: isHost ? theme.accent : theme.surfaceSunk,
          alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}
      >
        {p.imageUrl ? (
          <Image source={{ uri: p.imageUrl }} style={{ width: 26, height: 26, borderRadius: 13 }} />
        ) : (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }} color={isHost ? theme.accentInk : 'inkSoft'}>
            {initials(p.displayName)}
          </VText>
        )}
      </View>
    );
  };

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
function EmptyLineup({ canAdd }: { canAdd: boolean }) {
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
    </View>
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
function LuRow({
  wine, index, myIdentityId, ratings, onPress,
}: {
  wine: WireWine;
  index: number;
  myIdentityId: string;
  ratings: RatingsView | null;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const myScore = ratings?.[myIdentityId]?.ratings[wine.id]?.score ?? 0;
  const raters = ratersFor(wine.id, ratings);
  const blind = !!wine._blind;

  return (
    <Pressable
      onPress={onPress}
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
      {blind ? (
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
      ) : wine.imageUrl ? (
        <Image source={{ uri: wine.imageUrl }} style={{ width: 46, height: 46, borderRadius: radius.sm }} />
      ) : (
        <View style={{ width: 46, height: 46, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="glass" size={19} color={theme.inkFaint} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {blind ? (
          <>
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              Impression {index + 1}
            </VText>
            <VText variant="small" color="inkSoft" style={{ marginTop: 1 }}>To be revealed</VText>
          </>
        ) : (
          <>
            {/* .lu-name: "Oslavje - 2018" — the dash stays in the name
                colour; only the year itself is ink-soft regular */}
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              {wine.name}
              {wine.vintage ? (
                <>
                  {' - '}
                  <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 15, lineHeight: 23 }}>{wine.vintage}</VText>
                </>
              ) : null}
            </VText>
            {wine.producer ? (
              <VText variant="small" color="inkSoft" numberOfLines={1} style={{ marginTop: 1 }}>{wine.producer}</VText>
            ) : null}
            {wine.grape || wine.type ? (
              <VText variant="caption" color="inkFaint" numberOfLines={1} style={{ marginTop: 1 }}>
                {wine.grape || wine.type}
              </VText>
            ) : null}
          </>
        )}
      </View>
      {/* .lu-right2: score chip when rated, .lu-rate pill when not */}
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
  const { theme } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  const lastTop = useRef(0);
  if (anchorTop !== null) lastTop.current = anchorTop;
  useEffect(() => {
    if (anchorTop === null) { anim.setValue(0); return; }
    Animated.timing(anim, { toValue: 1, duration: motion.dur1, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start();
  }, [anchorTop, anim]);
  // Auto-dismiss the menu shortly after a Blind-for-all toggle so the user
  // sees the row flip to active, then it closes itself. Cleared on unmount /
  // manual close so the timer can't fire late.
  const bfaCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (anchorTop === null && bfaCloseTimer.current) {
      clearTimeout(bfaCloseTimer.current);
      bfaCloseTimer.current = null;
    }
  }, [anchorTop]);
  useEffect(() => () => { if (bfaCloseTimer.current) clearTimeout(bfaCloseTimer.current); }, []);
  const Item = ({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress?: () => void; disabled?: boolean }) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed && !disabled ? theme.surfaceSunk : 'transparent' })}
    >
      {/* .sess-menu-item svg is ink-soft; only the label carries full ink. */}
      <Icon name={icon} size={18} color={disabled ? theme.inkFaint : theme.inkSoft} />
      <VText style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 15, flex: 1 }} color={disabled ? 'inkFaint' : 'ink'}>{label}</VText>
      {disabled ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
    </Pressable>
  );
  // .sess-menu-mode — Blind-for-all is a press-to-activate field (NOT a switch):
  // tapping flips blindForEveryone, and the ACTIVE state styles the whole row
  // accent (accent text + accent-tint bg + semibold + accent icon). Inactive =
  // muted ink-soft. The parent only renders this on a blind session.
  const BlindForAllItem = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: blindForEveryone }}
      disabled={bfaBusy}
      onPress={() => {
        onToggleBlindForEveryone(!blindForEveryone);
        if (bfaCloseTimer.current) clearTimeout(bfaCloseTimer.current);
        bfaCloseTimer.current = setTimeout(onClose, 300);
      }}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 12,
        backgroundColor: blindForEveryone ? theme.accentTint : pressed ? theme.surfaceSunk : 'transparent',
      })}
    >
      <Icon name="eyeoff" size={18} color={blindForEveryone ? theme.accent : theme.inkSoft} />
      <VText
        style={{ fontFamily: blindForEveryone ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium', fontSize: 15, flex: 1 }}
        color={blindForEveryone ? 'accent' : 'inkSoft'}
      >
        Blind for all
      </VText>
    </Pressable>
  );
  return (
    <Modal transparent visible={anchorTop !== null} animationType="none" onRequestClose={onClose} presentationStyle="overFullScreen" statusBarTranslucent>
      <Pressable style={{ flex: 1 }} accessibilityLabel="Close menu" onPress={onClose}>
        <Animated.View
          style={{
            position: 'absolute', top: lastTop.current + 6, right: GUTTER, minWidth: 200,
            backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, padding: 6,
            opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
            shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8,
          }}
        >
          {showBlindForEveryone ? (
            <>
              <BlindForAllItem />
              <View style={{ height: 1, backgroundColor: theme.ruleSoft, marginVertical: 4 }} />
            </>
          ) : null}
          <Item icon="user" label="People" onPress={onPeople} />
          <Item icon="share" label="Share invite" onPress={onShare} />
          <Item icon="settings" label="Settings" onPress={onSettings} />
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
