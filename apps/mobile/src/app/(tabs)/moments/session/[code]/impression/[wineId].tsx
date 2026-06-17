import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { countryName, validateScore } from '@verre/core';
import { ScoreInput } from '@/components/scoring/ScoreInput';
import { AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import {
  ApiError,
  getBookmarkedWineIds,
  getSessionState,
  hideWine,
  rateWine,
  revealWine,
  setBookmark,
  type RatingMeta,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { FOOT_CLEARANCE_IR as FOOT_CLEARANCE, GLASS_FILL, HERO_RATIO, HERO_SCRIM, usePhoneMetrics } from '@/lib/layout';
import { useIsOnline } from '@/lib/query';
import { motion, radius, useTheme } from '@/theme';

const POLL_MS = 5000;
const GUTTER = 20; // 02e vbody runs 20px gutters (vs the line-up's 22) — deliberate override
// Direction of the last sibling-wine replace — read by the incoming screen
// to pick the replace animation (push for next, pop for previous).
let navDir: 'next' | 'prev' = 'next';

// 02e impression detail — info + the adaptive rating moment, to the
// vero-screens irScreen pixel spec. Photo variant = full-bleed hero with a
// glass floating header that hands the title in and goes solid as the
// on-screen name scrolls under it; no-photo variant (the norm) = in-flow
// bar, dark name block. Rate flow: wide slider + editable number
// (ScoreInput) + "Add tasting detail" disclosure.
//
// Flagged deviations (pixel-spec rule):
// - Fill-track flavour inputs are NOT here yet — gated on the flavour
//   colour palette (design brief pending). The detail panel ships with the
//   note field; existing flavour data from other surfaces passes through
//   saves untouched. The ⋯ "Edit/Delete impression" host items wait for the
//   host-CRUD milestone (menu carries Clear my rating only, via the native
//   action sheet per the native-chrome ruling).
// - Previous also saves pending edits (the mock leaves unsaved-edit
//   handling unspecified; silent discard would lose data and the web's
//   dirty-guard modal is a web pattern).
export default function ImpressionDetail() {
  const { code: rawCode, wineId: rawWineId } = useLocalSearchParams<{ code: string; wineId: string }>();
  const code = String(rawCode ?? '');
  const wineId = String(rawWineId ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Same query key as the line-up screen beneath this push — the cache is
  // warm on entry and both screens share the 5s poll.
  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    refetchInterval: POLL_MS,
  });
  const meta = state.data?.meta ?? null;
  const wines = state.data?.wines ?? null;
  const ratings = state.data?.ratings ?? null;
  const index = wines?.findIndex((w) => w.id === wineId) ?? -1;
  const wine = index >= 0 ? wines![index] : null;
  const total = wines?.length ?? 0;
  const existing: RatingMeta | undefined = ratings?.[myIdentityId]?.ratings[wineId];

  // Host on a blind session gets the bar's reveal/hide control (mirrors the
  // line-up). isHostByIdentity parity: original host, logged-in host fallback,
  // or any cohost. Providers can't reveal (server rejects) — no control.
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const hostRevealUi = !!meta?.blind && isHostViewer;

  // Reconnecting bar — same passive treatment as the line-up (shared 5s poll,
  // shared session-state cache). Show when offline, or errored while we still
  // have a wine to display (stale-but-usable). Overlaid on top of either layout.
  const online = useIsOnline();
  const showReconnecting = !online || (state.isError && wine !== null);

  // Local-until-commit (web Rate-pane parity): edits live here, the POST
  // fires on Save. Re-seed when the route param swaps to a sibling wine.
  const [score, setScore] = useState(0);
  const [notes, setNotes] = useState('');
  const [flavors, setFlavors] = useState<Record<string, number>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === wineId || ratings === null) return;
    seededFor.current = wineId;
    setScore(existing?.score ?? 0);
    setNotes(existing?.notes ?? '');
    // Flavour input is palette-gated — carry existing chip data through
    // saves untouched rather than wiping it.
    setFlavors(existing?.flavors ?? {});
    setDetailOpen(!!(existing?.notes || Object.keys(existing?.flavors ?? {}).length));
  }, [wineId, ratings, existing]);
  // An edit before the first ratings payload arrives (cold cache /
  // degraded /state section) claims the seed slot — a late seed must not
  // overwrite in-progress input.
  const editScore = (v: number) => {
    seededFor.current = wineId;
    setScore(v);
  };
  const editNotes = (s: string) => {
    seededFor.current = wineId;
    setNotes(s);
  };

  // Crave = wine bookmark (web WineModal parity, optimistic). The local
  // override is keyed on the wine id, so a sibling-wine swap ignores it at
  // render time — no reset effect, no stale-heart frame.
  const bookmarks = useQuery({ queryKey: ['bookmarks'], queryFn: getBookmarkedWineIds });
  const [craveLocal, setCraveLocal] = useState<{ wineId: string; on: boolean } | null>(null);
  const craved = craveLocal?.wineId === wineId ? craveLocal.on : bookmarks.data?.has(wineId) ?? false;
  const craveMut = useMutation({
    mutationFn: (vars: { wineId: string; on: boolean }) => setBookmark(code, vars.wineId, vars.on),
    onMutate: (vars) => setCraveLocal(vars),
    onError: (_e, vars) => setCraveLocal({ wineId: vars.wineId, on: !vars.on }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['bookmarks'] }),
  });

  const rateMut = useMutation({
    mutationFn: (body: { wineId: string; score: number; flavors: Record<string, number>; notes: string }) =>
      rateWine(code, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-state', code, myIdentityId] });
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });

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

  const [saveError, setSaveError] = useState<string | null>(null);
  const saveIfNeeded = async (): Promise<boolean> => {
    Keyboard.dismiss();
    setSaveError(null);
    const changed =
      score !== (existing?.score ?? 0) ||
      notes !== (existing?.notes ?? '') ||
      JSON.stringify(flavors) !== JSON.stringify(existing?.flavors ?? {});
    if (!changed) return true;
    const empty = score === 0 && notes.trim() === '' && Object.keys(flavors).length === 0;
    if (empty && !existing) return true; // nothing rated, nothing stored — no POST
    if (validateScore(score).error) {
      setSaveError('Scores go from 0 to 5 in quarter steps.');
      return false;
    }
    try {
      await rateMut.mutateAsync({ wineId, score, flavors, notes });
      // The local edit is now the server state; allow re-seed on next wine.
      seededFor.current = null;
      return true;
    } catch {
      setSaveError("Couldn't save your rating. Check your connection and try again.");
      return false;
    }
  };

  const goTo = (i: number) => {
    if (!wines || i < 0 || i >= wines.length) {
      router.back();
      return;
    }
    // Sibling replace animates as a push by default; Previous must read as
    // going back. navDir is module-scoped so the INCOMING screen instance
    // (same route, new params) picks it up in its Stack.Screen options.
    navDir = i < index ? 'prev' : 'next';
    seededFor.current = null;
    router.replace({
      pathname: '/(tabs)/moments/session/[code]/impression/[wineId]',
      params: { code, wineId: wines[i].id },
    });
  };
  const onPrevious = async () => {
    if (await saveIfNeeded()) goTo(index - 1);
  };
  const onNext = async () => {
    if (!(await saveIfNeeded())) return;
    if (index >= total - 1) router.back();
    else goTo(index + 1);
  };

  // ⋯ menu — the shared AnchoredMenu (.ir-menu dropdown; Simon's ruling: the
  // brand menu, not the native action sheet). Anchored to the measured ⋯ button.
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const clearRating = () => {
    seededFor.current = wineId; // an edit — a late seed must not undo it
    setScore(0);
    setNotes('');
    setFlavors({});
    setMenuAnchor(null);
  };

  // Collapsing header: the bar title (and the floathead's solid state) hand
  // in when the on-screen name scrolls under the header — mock measures
  // heroName.bottom <= header.bottom on every scroll tick.
  const [titleShown, setTitleShown] = useState(false);
  // Top-overscroll flag: while the hero detaches with the rubber band its
  // square top corners get a soft radius (flush full-bleed at rest).
  const [pulled, setPulled] = useState(false);
  const nameBottomRef = useRef(0);
  const headerBottomRef = useRef(0);
  const onScroll = (y: number) => {
    const show = y >= nameBottomRef.current - headerBottomRef.current;
    setTitleShown((prev) => (prev === show ? prev : show));
    const p = y < -1;
    setPulled((prev) => (prev === p ? prev : p));
  };

  if (!wine) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <IrBar
          title=""
          titleShown={false}
          craved={false}
          onCrave={() => {}}
          onMenu={() => {}}
          onBack={() => router.back()}
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23 }}>
            {state.isPending ? '' : 'This impression is gone'}
          </VText>
          {!state.isPending ? (
            <VText variant="small" color="inkSoft">It may have been removed from the line-up.</VText>
          ) : null}
        </View>
      </View>
    );
  }

  const blind = !!wine._blind;
  const hasPhoto = !blind && !!wine.imageUrl;
  const barTitle = blind ? `Impression ${index + 1} · Hidden` : wine.name + (wine.vintage ? ` - ${wine.vintage}` : '');
  const footVariant: 'first' | 'mid' | 'last' = index <= 0 ? 'first' : index >= total - 1 ? 'last' : 'mid';

  const body = (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: 18, paddingBottom: FOOT_CLEARANCE }}>
      {!blind ? <AboutBlock wine={wine} /> : null}
      <ScoreInput value={score} onChange={editScore} />
      {/* .ir-detail-toggle + panel — the adaptive "Add tasting detail" */}
      <Pressable
        onPress={() => setDetailOpen((o) => !o)}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16 }}
      >
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
          {detailOpen ? 'Tasting detail' : 'Add tasting detail'}
        </VText>
        <View style={{ transform: [{ rotate: detailOpen ? '180deg' : '0deg' }] }}>
          <Icon name="chevron-down" size={18} color={theme.inkSoft} />
        </View>
      </Pressable>
      {detailOpen ? (
        <View>
          {/* Fill-track flavour grid lands here once the palette is decided
              (design brief pending) — note field only until then. */}
          <NoteField value={notes} onChange={editNotes} />
        </View>
      ) : null}
      {saveError ? (
        <VText variant="small" style={{ marginTop: 14, color: theme.critical }}>{saveError}</VText>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Previous replaces with the pop animation so the slide reads as
          going back; next keeps push. */}
      <Stack.Screen options={{ animationTypeForReplace: navDir === 'prev' ? 'pop' : 'push' }} />
      {/* Always rendered: expo-status-bar doesn't restore on unmount, so a
          photo→no-photo sibling swap must explicitly reassert the theme
          style. Over the hero (pre-solid) the bar is white. */}
      <StatusBar
        // Light glyphs only over the photo; the reconnecting overlay covers the
        // notch with surfaceSunk, so glyphs revert to theme (light would vanish).
        style={hasPhoto && !titleShown && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark'}
      />
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
          <ScrollView
            onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
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
            {body}
          </ScrollView>
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
          <ScrollView
            onScroll={(e) => onScroll(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
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
        </View>
      )}
      <FootBar
        variant={footVariant}
        saving={rateMut.isPending}
        onPrevious={onPrevious}
        onNext={onNext}
      />
      {/* .ir-menu options dropdown (shared AnchoredMenu). Separator + danger
          rows (Edit / Delete impression) join with the host-CRUD milestone. */}
      <AnchoredMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)} right={16} minWidth={184}>
        <MenuItem icon="undo" label="Clear my rating" onPress={clearRating} />
      </AnchoredMenu>
    </View>
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
  const phone = usePhoneMetrics();
  const menuBtnRef = useRef<View>(null);
  const anim = useRef(new Animated.Value(titleShown ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: titleShown ? 1 : 0,
      duration: motion.dur2,
      easing: Easing.bezier(...motion.ease),
      useNativeDriver: true,
    }).start();
  }, [titleShown, anim]);

  const onGlass = glass && !solid;
  const iconColor = onGlass ? '#fff' : theme.ink;
  const glassSize = phone.lerp(34, 36);
  const plainSize = phone.lerp(30, 34);
  const titleSize = phone.lerp(18, 19);
  const pillHeight = phone.lerp(34, 36);
  const circle = onGlass
    ? { width: glassSize, height: glassSize, borderRadius: glassSize / 2, backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const }
    : { width: plainSize, height: plainSize, alignItems: 'center' as const, justifyContent: 'center' as const };

  return (
    // Base 36px row in both variants; scales slightly on roomier phones.
    <View style={{ flexDirection: 'row', alignItems: 'center', height: phone.lerp(36, 38), marginLeft: glass ? 0 : -6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}
        style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}>
        <Icon name="back" size={phone.lerp(22, 23)} color={iconColor} />
      </Pressable>
      {/* .ir-bartitle: 18/600, flex 1, fades in with a 4px rise */}
      <Animated.View
        style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}
      >
        <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: titleSize, lineHeight: phone.lerp(23, 24), letterSpacing: 0, color: onGlass ? '#fff' : theme.ink }}>
          {title}
        </VText>
      </Animated.View>
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
            gap: phone.lerp(6, 7),
            height: pillHeight,
            paddingHorizontal: onGlass ? phone.lerp(13, 14) : 4,
            borderRadius: onGlass ? pillHeight / 2 : 0,
            backgroundColor: onGlass ? GLASS_FILL : 'transparent',
            opacity: revealBusy ? 0.5 : pressed ? 0.6 : 1,
          })}
        >
          <Icon name={revealed ? 'eyeoff' : 'eye'} size={phone.lerp(18, 19)} color={iconColor} />
          {!titleShown ? (
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: phone.lerp(13, 14), lineHeight: phone.lerp(20, 21), color: onGlass ? '#fff' : theme.ink }}>
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
          gap: phone.lerp(6, 7),
          height: pillHeight,
          paddingHorizontal: onGlass ? phone.lerp(13, 14) : 4,
          borderRadius: onGlass ? pillHeight / 2 : 0,
          backgroundColor: onGlass ? GLASS_FILL : 'transparent',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={craved ? 'heart-fill' : 'heart'} size={phone.lerp(18, 19)} color={craved ? theme.critical : iconColor} />
        {!titleShown ? (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: phone.lerp(13, 14), lineHeight: phone.lerp(20, 21), color: craved ? theme.critical : onGlass ? '#fff' : theme.ink }}>
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
        <Icon name="more" size={phone.lerp(20, 21)} color={iconColor} />
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

// ─── name blocks ───────────────────────────────────────

function posLabel(index: number, total: number) {
  return `#${index + 1} of ${total}`;
}

// .ir-hero — full-bleed photo, scrim, caption (pos · name · maker). On top
// overscroll the image rides down with the rubber band (Simon prefers the
// detach motion over a stretchy-pinned hero); while detached its top
// corners take a soft radius so the exposed edge doesn't read razor-sharp
// (the real device corner radius has no public API — this is a token, not
// a device match). Flush full-bleed again at rest.
function Hero({
  wine, index, total, pulled, onNameBottom,
}: {
  wine: WireWine;
  index: number;
  total: number;
  pulled: boolean;
  onNameBottom: (bottom: number) => void;
}) {
  const { height: windowH } = useWindowDimensions();
  const [fullscreen, setFullscreen] = useState(false);
  const heroH = Math.round(windowH * HERO_RATIO);
  return (
    <View
      style={{
        height: heroH,
        overflow: 'hidden',
        borderTopLeftRadius: pulled ? radius.xl : 0,
        borderTopRightRadius: pulled ? radius.xl : 0,
      }}
      onLayout={(e) => onNameBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height - 16)}
    >
      <Pressable accessibilityRole="button" accessibilityLabel="Open photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
        <Image source={{ uri: wine.imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      </Pressable>
      <LinearGradient
        pointerEvents="none"
        colors={HERO_SCRIM}
        locations={[0, 0.45, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: 20, right: 20, bottom: 16 }}>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, lineHeight: 11, letterSpacing: 1.54, textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)' }}>
          {posLabel(index, total)}
        </VText>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 30, lineHeight: 33, letterSpacing: -0.75, color: '#fff', marginTop: 4 }}>
          {wine.name}
          {wine.vintage ? (
            <>
              {' - '}
              <VText style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 30, lineHeight: 33, color: 'rgba(255,255,255,0.7)' }}>{wine.vintage}</VText>
            </>
          ) : null}
        </VText>
        {wine.producer || wine.type ? (
          <VText style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 13, lineHeight: 20, color: 'rgba(255,255,255,0.82)', marginTop: 2 }}>
            {[wine.producer, wine.type].filter(Boolean).join(' · ')}
          </VText>
        ) : null}
      </View>
      <FullscreenImage uri={wine.imageUrl} visible={fullscreen} label={wine.name} onClose={() => setFullscreen(false)} />
    </View>
  );
}

// .ir-noimg — the no-photo norm: pos label, big dark name, maker line.
// A masked (blind) impression is only seen by a guest, or by a host on a
// blind-for-all session (the host opted into being blind too) — `hostBlind`
// picks the host's "reveal to show it" wording over the guest's wait copy.
// `revealing` = a blind-for-all host just tapped reveal (optimistic revealedAt)
// but the un-redacted wine hasn't arrived yet — show a transitional line so the
// body doesn't say "reveal to show it" while the bar already says "Hide".
function NameBlock({
  wine, blind, hostBlind, revealing, index, total, onNameBottom,
}: {
  wine: WireWine;
  blind: boolean;
  hostBlind?: boolean;
  revealing?: boolean;
  index: number;
  total: number;
  onNameBottom: (bottom: number) => void;
}) {
  return (
    <View
      style={{ paddingTop: 4, paddingHorizontal: GUTTER, paddingBottom: 8 }}
      onLayout={(e) => onNameBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
    >
      <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, lineHeight: 11, letterSpacing: 1.54, textTransform: 'uppercase', marginBottom: 6 }}>
        {posLabel(index, total)}
      </VText>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 30, lineHeight: 33, letterSpacing: -0.75 }}>
        {blind ? `Impression ${index + 1}` : wine.name}
        {!blind && wine.vintage ? (
          <>
            {' - '}
            <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 30, lineHeight: 33 }}>{wine.vintage}</VText>
          </>
        ) : null}
      </VText>
      <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>
        {blind
          ? revealing
            ? 'Revealing…'
            : hostBlind
              ? 'Hidden from guests — reveal to show it'
              : 'Revealed when the host or co-host reveals it'
          : [wine.producer, wine.type].filter(Boolean).join(' · ')}
      </VText>
    </View>
  );
}

// ─── about ─────────────────────────────────────────────

// .ir-clamp — line-clamped text with an inline more/less toggle, reusing the
// invisible-measurer + word-boundary cut from the line-up description.
function ClampText({ text, lines, medium }: { text: string; lines: number; medium?: boolean }) {
  const [open, setOpen] = useState(false);
  const [clampLen, setClampLen] = useState<number | null>(null);
  // .ir-ival values are 500-weight in the spec; .ir-desc body stays 400.
  const family = medium ? 'InstrumentSans_500Medium' : undefined;
  let truncated: string | null = null;
  if (clampLen !== null) {
    let txt = text.slice(0, clampLen).replace(/\s+$/, '');
    let cut = txt.lastIndexOf(' ');
    while (cut > 0 && txt.length - cut < 9) cut = txt.lastIndexOf(' ', cut - 1);
    if (cut > 0) txt = txt.slice(0, cut);
    truncated = txt.replace(/[\s,.;:]+$/, '') + ' …';
  }
  return (
    <Pressable onPress={() => setOpen((o) => !o)} disabled={truncated === null && !open}>
      <VText
        variant="small"
        pointerEvents="none"
        onTextLayout={(e) => {
          const laid = e.nativeEvent.lines;
          setClampLen(
            laid.length > lines ? laid.slice(0, lines).reduce((n, l) => n + l.text.length, 0) : null,
          );
        }}
        style={{ position: 'absolute', left: 0, right: 0, opacity: 0, lineHeight: 20, fontFamily: family }}
      >
        {text}
      </VText>
      <VText
        variant="small"
        color={medium ? 'ink' : 'inkSoft'}
        numberOfLines={open ? undefined : lines}
        style={{ lineHeight: 20, fontFamily: family }}
      >
        {open ? text : truncated ?? text}
        {truncated !== null ? (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
            {open ? '  less' : ' more'}
          </VText>
        ) : null}
      </VText>
    </Pressable>
  );
}

// .ir-about — Origin · Variety · Process rows + clamped description +
// "Where to buy". Renders only the rows the wine actually carries; the
// whole block drops away when there's no metadata at all.
function AboutBlock({ wine }: { wine: WireWine }) {
  const { theme } = useTheme();
  // wine.country is an ISO 3166-1 alpha-2 code ("IT"); show the full English
  // name ("Italy"), falling back to the raw code for anything off-list —
  // mirrors the web WineInfoPane's `countryName(country) || country`.
  const country = wine.country ? countryName(wine.country) || wine.country : '';
  const origin = [wine.region, country].filter(Boolean).join(' · ');
  const rows: Array<[string, React.ReactNode]> = [];
  if (origin) rows.push(['Origin', <VText key="v" variant="small" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{origin}</VText>]);
  if (wine.grape) rows.push(['Variety', <ClampText key="v" text={wine.grape} lines={2} medium />]);
  if (wine.vinification) rows.push(['Process', <ClampText key="v" text={wine.vinification} lines={2} medium />]);
  if (rows.length === 0 && !wine.description && !wine.purchaseUrl) return null;
  // Separator rule: a section's bottom edge draws the line between
  // sections; a row divider must never sit directly on that edge. So the
  // last row drops its divider when nothing (description / buy link)
  // follows it inside the block — otherwise the soft row line + the block
  // edge render as a double line above the score section.
  const rowsHaveTrailer = !!wine.description || !!wine.purchaseUrl;
  return (
    <View style={{ marginTop: 2, marginBottom: 4, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
      {rows.map(([label, value], i) => {
        const lastRow = !rowsHaveTrailer && i === rows.length - 1;
        return (
          <View
            key={label}
            style={{
              flexDirection: 'row',
              gap: 14,
              paddingVertical: 9,
              borderBottomWidth: lastRow ? 0 : 1,
              borderBottomColor: theme.ruleSoft,
            }}
          >
            <VText variant="small" color="inkSoft" style={{ width: 72 }}>{label}</VText>
            <View style={{ flex: 1 }}>{value}</View>
          </View>
        );
      })}
      {wine.description ? (
        <View style={{ paddingTop: 12 }}>
          <ClampText text={wine.description} lines={3} />
        </View>
      ) : null}
      {wine.purchaseUrl ? (
        <Pressable
          accessibilityRole="link"
          // In-app browser (not Safari hand-off) — the user stays in the
          // tasting context; sheet dismisses back to the impression.
          onPress={() => WebBrowser.openBrowserAsync(wine.purchaseUrl!).catch(() => {})}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}
        >
          <Icon name="link" size={15} color={theme.accent} />
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
            Where to buy
          </VText>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── detail panel + footer ─────────────────────────────

// .field-group — "Your note" label + 2-row textarea (.field focus = accent
// border thickened inside the bounds, TextField's convention).
function NoteField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 7, marginTop: 8 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }}>Your note</VText>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        placeholder="What stood out?"
        placeholderTextColor={theme.inkFaint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          minHeight: 64,
          fontFamily: 'InstrumentSans_400Regular',
          fontSize: 15,
          lineHeight: 21,
          color: theme.ink,
          backgroundColor: theme.surface,
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? theme.accent : theme.rule,
          borderRadius: radius.sm,
          paddingHorizontal: focused ? 13 : 14,
          paddingTop: focused ? 9 : 10,
          paddingBottom: 10,
          textAlignVertical: 'top',
        }}
      />
    </View>
  );
}

// .ir-foot — sticky bottom action bar replacing the nav while rating:
// Previous (flex 1) · Save & next / Save & finish (flex 1.4).
function FootBar({
  variant, saving, onPrevious, onNext,
}: {
  variant: 'first' | 'mid' | 'last';
  saving: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    // Solid opaque action bar (not transparent; deviates from the mock's
    // blur+wash). A flat theme fill — no BlurView. Rationale:
    // docs/design/decisions/0003-collapsed-bars-opaque.md
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', gap: 10, paddingTop: 14, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}>
        <View style={{ flex: 1 }}>
          <Button title="Previous" variant="secondary" bar block disabled={variant === 'first' || saving} onPress={onPrevious} />
        </View>
        <View style={{ flex: 1.4 }}>
          <Button
            title={variant === 'last' ? 'Save & finish' : 'Save & next'}
            loadingTitle="Saving…"
            bar
            block
            loading={saving}
            onPress={onNext}
          />
        </View>
      </View>
    </View>
  );
}
