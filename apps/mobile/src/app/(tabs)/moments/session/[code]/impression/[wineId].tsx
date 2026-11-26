import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, AppState, Pressable, ScrollView, View, type ViewInstance, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { RatingSection } from '@/components/scoring/RatingSection';
import { AnchoredMenu, MenuItem, MenuSeparator, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { blockLook } from '@/lib/blockLook';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { BarTitle, useBarTitleProgress, VBar } from '@/components/VBar';
import { CenteredMessage, ReconnectingBar } from '@/components/ui/ConnectionState';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { PersonPreviewProvider } from '@/components/moments/PersonPreviewSheet';
import { ApiError, deleteWine, getSessionState, hideWine, revealWine, setBookmark, type SessionState } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { sessionHref, useSessionTab } from '@/lib/sessionStack';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { FOOT_CLEARANCE_IR as FOOT_CLEARANCE, GLASS_FILL, usePhoneTokens } from '@/lib/layout';
import { useIsOnline } from '@/lib/query';
import { radius, useTheme } from '@/theme';
import { markProfileHeaderStale } from '@/lib/feedCache';
import { errorText } from '@/lib/errorCopy';
import { useMeId } from '@/lib/meId';
import { useImpressionAutosave } from '@/lib/useImpressionAutosave';
import { createTransitionGuard, type SavedState } from '@/lib/impressionAutosaveCore';
import { AboutBlock, Hero, NameBlock } from '@/components/moments/ImpressionParts';
import { NoTopEdgeFade } from '@/components/ui/NoTopEdgeFade';

const POLL_MS = 5000;
const isGone = (e: unknown): e is ApiError => e instanceof ApiError && e.kind === 'not-found';
// A spent wrong-code budget (the server's entrance gate, a non-member only):
// the shared fatal view with a working Try Again (a refetch), never latched.
const isLimited = (e: unknown): e is ApiError => e instanceof ApiError && e.kind === 'rate-limited';
const GUTTER = 20; // 02e vbody runs 20px gutters (vs the line-up's 22) — deliberate override
// The room the content keeps above the footer bar: FOOT_CLEARANCE_IR (130)
// over the old 114 pt bar at default text.
const FOOT_BREATHING = 16;
// Direction of the last sibling-wine replace — read by the incoming screen
// to pick the replace animation (push for next, pop for previous).
let navDir: 'next' | 'prev' = 'next';

// 02e impression detail — info + the adaptive rating moment, to the
// vero-screens irScreen pixel spec. Photo variant = full-bleed hero with a
// glass floating header that hands the title in and goes solid as the
// on-screen name scrolls under it; no-photo variant (the norm) = in-flow
// bar, dark name block. Rate flow: the shared RatingSection.
//
// AUTO-SAVE (tasting-feedback build 1, ruled 2026-11-25): the rating saves
// itself about 1 s after the input settles and on every leave (Back,
// swipe-back, a tab switch, the app to the background), as MERGE saves of the
// changed fields only, through the outbox (lib/useImpressionAutosave.ts →
// lib/rateOutbox.ts): offline they wait on the phone ("Saved on this phone")
// and go out by themselves, also after the app was closed. Previous / Next /
// Finish move on AT ONCE once the edits are stored on the phone (they stay
// only when storing fails); a definitive failure after leaving is an alert.
// ONLY "Clear My Rating" deletes (after a confirm): emptying every field by
// hand keeps the stored rating. "Saved" sits in the footer bar.
export default function ImpressionDetail() {
  const { code: rawCode, wineId: rawWineId } = useLocalSearchParams<{ code: string; wineId: string }>();
  const code = String(rawCode ?? '');
  const wineId = String(rawWineId ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessionTab = useSessionTab();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Same query key as the line-up screen beneath this push — the cache is
  // warm on entry and both screens share the 5s poll. Same navigation-focus
  // gate as useSessionPoll (this file still carries the pre-hook copy of the
  // poll — migrate when next touched): paused while this screen isn't
  // focused, resubscribe-and-refetch on return.
  const [screenFocused, setScreenFocused] = useState(true);
  // The departure check reads focus from this ref, set IN the focus effect and
  // its cleanup (state would lag the blur by one render).
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setScreenFocused(true);
      return () => {
        focusedRef.current = false;
        setScreenFocused(false);
      };
    }, []),
  );
  // A gone moment (404) is terminal, as on the line-up: LATCHED (keyed on
  // code) and the query disabled, so no poll, focus or reconnect refetch can
  // swap the 404 for a network error and bring the stale impression back.
  const [goneLatch, setGoneLatch] = useState<{ code: string; error: ApiError } | null>(null);
  const latched = goneLatch?.code === code ? goneLatch.error : null;
  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    enabled: latched === null,
    subscribed: screenFocused,
    refetchInterval: POLL_MS,
    // The app default (retry 1, lib/query.tsx) minus the 404, like useSessionPoll.
    retry: (failureCount, error) => !isGone(error) && !isLimited(error) && failureCount < 1,
  });
  useEffect(() => {
    if (isGone(state.error)) setGoneLatch({ code, error: state.error });
  }, [state.error, code]);
  // Per-section graceful degradation (the line-up's lastRef merge): /state
  // isolates a failed section to null + 200, so a degraded poll is a SUCCESS
  // with a hole in it. Reading state.data directly turned that hole into the
  // terminal "This impression is gone" flash (and bounced goTo's Next/Prev to
  // router.back()) for a wine that still exists — keep the last good section
  // and only trust a PRESENT section's content. Keyed on code so a different
  // session can't inherit stale data (route params can swap in place).
  const lastRef = useRef<{ code: string; data: SessionState }>({
    code,
    data: { meta: null, wines: null, ratings: null },
  });
  if (lastRef.current.code !== code) {
    lastRef.current = { code, data: { meta: null, wines: null, ratings: null } };
  }
  if (state.data) {
    lastRef.current.data = {
      meta: state.data.meta ?? lastRef.current.data.meta,
      wines: state.data.wines ?? lastRef.current.data.wines,
      ratings: state.data.ratings ?? lastRef.current.data.ratings,
    };
  }
  const { meta, wines, ratings } = lastRef.current.data;
  const index = wines?.findIndex((w) => w.id === wineId) ?? -1;
  const wine = index >= 0 ? wines![index] : null;
  const total = wines?.length ?? 0;

  // Host on a blind session gets the bar's reveal/hide control (mirrors the
  // line-up). isHostByIdentity parity: original host, logged-in host fallback,
  // or any cohost. Providers can't reveal (server rejects) — no control.
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const isOwnProvider = !!meta && (meta.providerIds ?? []).includes(myIdentityId) && !!wine?.isMine;
  const canEditImpression = !!wine && !wine._blind && (isHostViewer || isOwnProvider);
  const hostRevealUi = !!meta?.blind && isHostViewer;

  // Reconnecting bar — same passive treatment as the line-up (shared 5s poll,
  // shared session-state cache). Show when offline, or errored while we still
  // have a wine to display (stale-but-usable). Overlaid on top of either layout.
  const online = useIsOnline();
  // A gone moment renders the shared fatal view (below), never the stale
  // impression under a reconnecting bar: lastRef still holds the wine, so the
  // bar would claim a reconnect forever. Removed / invalid (kick, ban) still
  // fall through to the stale view: their banned-vs-kicked copy lives in
  // useSessionPoll, which this screen's pre-hook poll has yet to adopt.
  const goneError = latched ?? (isGone(state.error) ? state.error : null);
  const limitedError = goneError === null && isLimited(state.error) ? state.error : null;
  const gone = goneError !== null;
  const showReconnecting = !gone && (!online || (state.isError && wine !== null));

  // The rating draft, auto-saved (see the header). ONE transition guard for
  // the controlled departures (Previous, Next, Finish): edits wait while it is
  // held. The snapshot the draft seeds from comes from the outbox owner.
  const guard = useMemo(() => createTransitionGuard(), []);
  const wineLabel = wine ? (wine._blind || !wine.name ? `Impression ${index + 1}` : wine.name) : null;
  const autosave = useImpressionAutosave({ code, wineId, kind: wine ?? null, active: true, focused: screenFocused, guard, label: wineLabel });
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const { draft } = autosave;

  // Crave = save the bottle (optimistic). It reads the row's own `saved`
  // (catalogue model change step 5): on a bottle hidden for you that is your
  // save of THAT bottle, never whether you crave the wine elsewhere. The local
  // override is keyed on the wine id (a sibling swap ignores it) and dropped
  // once the line-up has re-read; a refusal springs the heart back and says
  // why (ADR-0009: "Too many saves. Try again in …").
  const meIdForLists = useMeId();
  const [craveLocal, setCraveLocal] = useState<{ wineId: string; on: boolean } | null>(null);
  const craved = craveLocal?.wineId === wineId ? craveLocal.on : !!wine?.saved;
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
  const rowSaved = !!wine?.saved;
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
  const revealedToGuests = !!wine?.revealedAt;
  const [revealBusy, setRevealBusy] = useState(false);
  const toggleReveal = async () => {
    if (revealBusy || !wine) return;
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

  // Departures. A CONTROLLED one (Previous, Next, Finish) takes the guard,
  // captures the draft and moves on as soon as the edits are PERSISTED on the
  // phone (never waiting for the server); a storage failure keeps the page
  // (the footer says so) and gives the guard back. A navigation blur or
  // removal captures in the focus cleanup below (best effort, like the OS
  // suspending the app).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // A sibling replace mounts a new screen; should the route ever swap its
  // params in place, the next wine starts with the guard free.
  useEffect(() => guard.release(), [wineId, guard]);
  const depart = (go: () => void) => {
    if (!guard.acquire()) return; // one transition per waiter
    const leaving = wineId;
    void autosaveRef.current.drain().then((ok) => {
      if (!mountedRef.current) return;
      // Still this wine AND still focused (Next then Back: the line-up is in
      // front now, and a replace would hit it): else nothing moves.
      if (ok && leaving === wineIdRef.current && focusedRef.current) go(); // the guard stays held: this page is going away
      else guard.release();
    });
  };
  const wineIdRef = useRef(wineId);
  wineIdRef.current = wineId;
  const goTo = (i: number) => {
    if (!wines || i < 0 || i >= wines.length) {
      router.back();
      return;
    }
    // Sibling replace animates as a push by default; Previous must read as
    // going back. navDir is module-scoped so the INCOMING screen instance
    // (same route, new params) picks it up in its Stack.Screen options.
    navDir = i < index ? 'prev' : 'next';
    router.replace(sessionHref(sessionTab, 'impression/[wineId]', { code, wineId: wines[i].id }));
  };
  const isFirst = index <= 0;
  const isLast = index >= total - 1;
  const onPrevious = () => {
    if (!isFirst) depart(() => goTo(index - 1));
  };
  const onNext = () =>
    depart(() => {
      // Short "acknowledged" tick on Next / Finish (Simon, 2026-07-10): the M3
      // commit convention (light impact, no-op in the Simulator).
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (isLast) router.back();
      else goTo(index + 1);
    });

  // Save on leave: the focus cleanup (a STABLE callback reading the draft
  // through refs; expo-router re-runs a cleanup whenever its callback
  // changes) captures on a navigation blur or removal. It doesn't run on
  // backgrounding, so ONE AppState listener lives only while focused:
  // `background` captures at once, `inactive` is ignored; a background and a
  // blur before the app is active again share one departure.
  useFocusEffect(
    useCallback(() => {
      let departed = false;
      const sub = AppState.addEventListener('change', (st) => {
        if (st === 'background' && !departed) {
          departed = true;
          void autosaveRef.current.drain();
        } else if (st === 'active') departed = false;
      });
      return () => {
        sub.remove();
        if (!departed) void autosaveRef.current.drain();
      };
    }, []),
  );

  // ⋯ menu — the shared AnchoredMenu (.ir-menu dropdown; Simon's ruling: the
  // brand menu, not the native action sheet). Anchored to the measured ⋯ button.
  // A row that asks first records ONE single-use intent before the menu closes;
  // `onClosed` (every dismissal, once the Modal is gone) consumes it and shows
  // the alert only while the same wine is still focused.
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const menuIntent = useRef<{ kind: 'clear' | 'delete'; wineId: string } | null>(null);
  const confirmClearRating = () => {
    // Destructive confirms always NAME what's being deleted (Simon,
    // 2026-07-18): masked wines get their line-up alias, same as the bar.
    if (!wineLabel) return;
    // Only on a KNOWN baseline (Codex P1): before the rating loads there is
    // nothing the person saw to delete. The baseline on screen NOW: Delete
    // clears what the person saw (a poll or a rebase since → asked again).
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
    if (!intent || intent.wineId !== wineIdRef.current || !focusedRef.current) return;
    intentRunners.current[intent.kind]();
  }, []);
  const askThenClose = (kind: 'clear' | 'delete') => {
    menuIntent.current = { kind, wineId };
    setMenuAnchor(null);
  };
  // A Clear the server found STALE (a newer rating from elsewhere) is never
  // rebased: the page shows the newer rating and asks again.
  useEffect(() => {
    if (screenFocused && autosave.takeClearAsk()) confirmClearRating();
  });
  const editImpression = () => {
    setMenuAnchor(null);
    router.push(sessionHref(sessionTab, 'edit-impression/[wineId]', { code, wineId }));
  };
  const deleteMut = useMutation({
    mutationFn: () => deleteWine(code, wineId),
    onSuccess: () => {
      // A confirmed terminal outcome: the rating's unsent work goes with it.
      autosaveRef.current.discardPending();
      router.back();
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
    const label = wine ? (wine._blind ? `Impression ${index + 1}` : wine.name) : '';
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

  // ONLY a confirmed terminal outcome discards the unsent rating: a PRESENT
  // line-up without this bottle (deleted, or hidden from you) and a confirmed
  // removal (kicked / banned). A gone moment, a 429, a failed or degraded poll
  // replace the page but KEEP the entry for the outbox (a 404 from /rate itself
  // drops it there).
  const wineGone = wines !== null && index < 0;
  const removedNow = state.error instanceof ApiError && state.error.kind === 'removed';
  useEffect(() => {
    if (wineGone || removedNow) autosaveRef.current.discardPending();
  }, [wineGone, removedNow]);

  // Collapsing header: the bar title (and the floathead's solid state) hand
  // in when the on-screen name scrolls under the header — mock measures
  // heroName.bottom <= header.bottom on every scroll tick.
  const [titleShown, setTitleShown] = useState(false);
  // Same value as the screen option below; forwarded to the root while this
  // screen sits on an opened post's stack, where its own option is never asked
  // (lib/forwardedStatusBar). Computed here: a hook can't follow the early
  // return.
  useForwardStatusBarStyle(
    wine && !gone && !wine._blind && !!wine.imageUrl && !titleShown && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark',
  );
  // Top-overscroll flag: while the hero detaches with the rubber band its
  // square top corners get a soft radius (flush full-bleed at rest).
  const [pulled, setPulled] = useState(false);
  const nameBottomRef = useRef(0);
  const headerBottomRef = useRef(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollYRef = useRef(0);
  const onScroll = (y: number) => {
    scrollYRef.current = y;
    const show = y >= nameBottomRef.current - headerBottomRef.current;
    setTitleShown((prev) => (prev === show ? prev : show));
    const p = y < -1;
    setPulled((prev) => (prev === p ? prev : p));
  };
  // Aroma search focus → the minimal shift that fits the search block above
  // the keyboard — the SHARED screen-side hook (one implementation with the
  // check-in rate stage; see useAromaSearchScroll). blockBelow is AromaInput's
  // MEASURED rendered height (onLayout), not a constant — see the prop doc.
  // The content clears the footer bar by its MEASURED height (it grows with
  // Dynamic Type and carries the save-status line), with the breathing room
  // the constant had over the old bar; the constant until it is measured.
  const [footH, setFootH] = useState(0);
  const footClearance = footH > 0 ? footH + FOOT_BREATHING : FOOT_CLEARANCE;
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, footClearance);

  const fatalError = goneError ?? limitedError;
  if (fatalError) {
    const glyphs = theme.scheme === 'dark' ? 'light' : 'dark';
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
        <Stack.Screen options={{ statusBarStyle: glyphs }} />
        <StatusBar style={glyphs} />
        <VBar title="" />
        {/* No Try Again on a 404; a 429 retries the poll. */}
        <SessionFatalView fatal={fatalError} removedKind={null} sessionLabel={null}
          onRetry={() => { void state.refetch(); }} onBack={() => router.back()} />
      </View>
    );
  }

  if (!wine) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
        <Stack.Screen options={{ statusBarStyle: theme.scheme === 'dark' ? 'light' : 'dark' }} />
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <IrBar
          title=""
          titleShown={false}
          craved={false}
          onCrave={() => {}}
          onMenu={() => {}}
          onBack={() => router.back()}
        />
        {/* "Gone" needs a REAL wine list that lacks this wine. wines === null
            covers both first-load pending AND a cold degraded poll (wines
            section null on every poll so far) — neither may claim deletion.
            (A present-but-EMPTY list also lands here via hide-lineup's [] for
            guests pre-start — "removed from the line-up" is the honest copy
            for that too.) */}
        <CenteredMessage
          title="This impression is gone"
          body="It may have been removed from the line-up."
          pending={wines === null}
        />
        {/* Branch-local reconnecting condition: showReconnecting's error arm
            requires wine !== null, which is never true here — without this,
            a cold hard error / offline entry is a silent blank dead end.
            The third arm covers the cold DEGRADED case: /state degrades a
            failed section to null + 200, so isError never trips — settled
            (!isPending) with wines still null means the wines section keeps
            failing and the blank pending copy would otherwise sit signal-less
            forever. First-load pending shows no bar (normal loading). The 5s
            poll IS the retry, so the bar's "reconnecting" framing holds. */}
        {!online || state.isError || (wines === null && !state.isPending) ? <ReconnectingBar /> : null}
      </View>
    );
  }

  const blind = !!wine._blind;
  const hasPhoto = !blind && !!wine.imageUrl;
  const barTitle = blind ? `Impression ${index + 1} · Hidden` : wine.name + (wine.vintage ? ` - ${wine.vintage}` : '');

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
          redaction (mirrors web RatingPane + wineRedaction). */}
      <RatingSection
        kind={wine}
        score={draft.score}
        onScore={autosave.setScore}
        onScoreStep={autosave.stepScore}
        notes={draft.notes}
        onNotes={autosave.setNotes}
        onNotesFocus={autosave.setNoteFocused}
        flavors={draft.flavors}
        onFlavors={autosave.setFlavors}
        aromas={draft.aromas}
        onAromas={autosave.setAromas}
        onRequestAromaScroll={scrollAromaSearchTo}
      />
    </View>
  );

  const statusBarStyle = hasPhoto && !titleShown && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark';
  return (
    // BottomSheetModalProvider INSIDE the screen (the app's per-screen
    // pattern, see create.tsx / session index) — the AromaInput sheets
    // (selection + browse) need a sized provider/portal host; without one
    // the gorhom modal throws 'BottomSheetModalInternalContext cannot be null'.
    <BottomSheetModalProvider>
    {/* Brought By opens the person's preview (ruled 2026-11-15). */}
    <PersonPreviewProvider code={code} meta={meta} myIdentityId={myIdentityId}>
    <View style={{ flex: 1 }}>
      {/* Previous replaces with the pop animation so the slide reads as
          going back; next keeps push. gestureResponseDistance narrows the iOS
          edge-back zone to the true left edge (15pt) — the structure-profile
          fill-tracks start ~20pt in and a leftward drag on the left column kept
          triggering an accidental back-pop (the OS default edge zone is wider).
          Back-swipe from the very edge still works. iOS-only option. */}
      <Stack.Screen
        options={{
          animationTypeForReplace: navDir === 'prev' ? 'pop' : 'push',
          gestureResponseDistance: { start: 15 },
          // iOS status bar: the screen trait is the only channel there (root
          // _layout), and the deepest screen with one set wins. Light glyphs
          // only over the photo; the reconnecting overlay covers the notch
          // with surfaceSunk, so glyphs revert to theme (light would vanish).
          statusBarStyle,
        }}
      />
      {/* Android path (expo-status-bar). Always rendered: it doesn't restore
          on unmount, so a photo→no-photo sibling swap must explicitly reassert
          the theme style. Over the hero (pre-solid) the bar is white. */}
      <StatusBar style={statusBarStyle} />
      {/* Reconnecting bar — overlaid on top of either layout (briefly over the
          floating back/⋯ buttons on the photo variant during the blip). */}
      {showReconnecting ? <ReconnectingBar /> : null}
      {hasPhoto ? (
        // Photo variant: hero runs under the status bar; floating header.
        <>
          {/* Dead-end for react-native-screens' scroll-view finder. The
              pushed RNSScreen inherits the tab host's override flag (on by
              default) and walks subviews[0] down to the first UIScrollView,
              force-flipping contentInsetAdjustmentBehavior never→automatic
              (RNSScreen.mm overrideScrollViewBehaviorInFirstDescendantChain,
              RNSScrollViewHelper.mm) — iOS then re-insets the content and
              the hero starts below the status bar. A zero-size first child
              ends the subviews[0] chain before the ScrollView, so the
              `never` below survives and the hero stays full-bleed. Verified
              against react-native-screens 4.25 sources.
              collapsable={false} is load-bearing: Fabric flattens layout-only
              views out of the native hierarchy, and a flattened dead-end
              never exists for the finder to hit. */}
          <View collapsable={false} style={{ width: 0, height: 0 }} />
          <NoTopEdgeFade style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
          >
            <Hero
              wine={wine}
              index={index}
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
          </ScrollView>
          </NoTopEdgeFade>
          <FloatHead
            title={barTitle}
            titleShown={titleShown}
            craved={craved}
            onCrave={() => craveMut.mutate({ wineId, on: !craved })}
            onMenu={setMenuAnchor}
            onBack={() => router.back()}
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
              // photo sibling may have left a float-head height in the ref.
              headerBottomRef.current = 0;
            }}
          >
            <IrBar
              title={barTitle}
              titleShown={titleShown}
              craved={craved}
              onCrave={() => craveMut.mutate({ wineId, on: !craved })}
              onMenu={setMenuAnchor}
              onBack={() => router.back()}
              showReveal={hostRevealUi}
              revealed={revealedToGuests}
              revealBusy={revealBusy}
              onReveal={toggleReveal}
            />
          </View>
          <NoTopEdgeFade style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
          >
            <NameBlock
              wine={wine}
              blind={blind}
              hostBlind={hostRevealUi}
              revealing={blind && revealedToGuests}
              index={index}
              total={total}
              onNameBottom={(y) => {
                nameBottomRef.current = y;
              }}
            />
            {body}
          </ScrollView>
          </NoTopEdgeFade>
        </View>
      )}
      <FootBar
        isFirst={isFirst}
        isLast={isLast}
        saved={autosave.savedState}
        error={autosave.error}
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
    </PersonPreviewProvider>
    </BottomSheetModalProvider>
  );
}


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
    <View style={{ flexDirection: 'row', alignItems: 'center', height: phone.size('topBar'), marginLeft: glass ? 0 : -6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}
        style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}>
        <Icon name="back" size={phone.size('topBarBackIcon')} color={iconColor} />
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

// ─── detail panel + footer ─────────────────────────────

// (The private NoteField was replaced by the shared momentForm NotesField —
// the catalog's pending extraction — when the note moved under the score.)

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
// MEASURED height (`onHeight`), which follows Dynamic Type.
function FootBar({
  isFirst, isLast, saved, error, onPrevious, onNext, onHeight,
}: {
  isFirst: boolean;
  isLast: boolean;
  saved: SavedState;
  error: string | null;
  onPrevious: () => void;
  onNext: () => void;
  onHeight: (h: number) => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const text = saved === 'error' ? error : saved ? SAVED_COPY[saved] : null;
  useEffect(() => {
    if (saved === 'error' && error) AccessibilityInfo.announceForAccessibility(error);
  }, [saved, error]);
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
