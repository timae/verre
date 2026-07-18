import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { ClampText } from '@/components/ui/ClampText';
import { AnchoredMenu, MenuItem, MenuSeparator, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { FeedGlassPanel } from '@/components/feed/FeedGlassPanel';
import { FullscreenGallery, type GalleryPage } from '@/components/feed/FullscreenGallery';
import { StarScore } from '@/components/scoring/StarScore';
import { StructureWheel } from '@/components/scoring/StructureWheel';
import { AromaReadChips } from '@/components/scoring/aroma/AromaReadChips';
import { buildWheelAxes } from '@/lib/flavourAxes';
import { Avatar } from '@/components/ui/Avatar';
import { FEED_KEY, deleteCheckin, feedQueryOptions, findFeedItem, detailFromItem, patchSessionRating, type FeedAuthor, type FeedItem, type FeedPage, type SessionFeedWine } from '@/lib/api/feed';
import { ApiError } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import * as Haptics from 'expo-haptics';
import { consumeFeedTransitionSource, requestFeedLanding } from '@/lib/feedTransition';
import { useEnterableMoment } from '@/lib/useEnterableMoment';
import { FEED_PANEL_SCRIM, FOOT_CLEARANCE_IR, GLASS_FILL, GUTTER, HERO_RATIO, HERO_SCRIM, usePhoneTokens } from '@/lib/layout';
import { timeAgo, wineTypeLabel } from '@/lib/momentFormat';
import { scoreWord } from '@/lib/scoreWords';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space, springs, useTheme } from '@/theme';
import { countryName } from '@verre/core';

// Full impression detail — a NEW read-only screen (proposal 08 §3; NOT 02e,
// which is a write interface). Reached from a feed card's glass panel. Pure
// client render off the ['feed'] cache — no fetch (findFeedItem/detailFromItem).
//
// Shape: a horizontal PAGER across the moment's impressions (a standalone is one
// page, no dots). Each page is a self-contained collapsing-hero screen (mirrors
// 02e's read surface: full-bleed photo under the status bar, a floating glass
// bar that hands the title in on scroll, tap-hero→FullscreenImage). The bar is
// SHARED chrome overlaid outside the pager; its collapsed/solid state tracks the
// ACTIVE page. One shared dot rail stays horizontally fixed across swipes,
// travels with the active page's content, then docks below the collapsed title.
//
// PRESENTATION (proposal 09): the route is a TRANSPARENT modal with no native
// animation — this screen draws its own shared-element open/close. One shared
// `progress` value (0 = at the feed card, 1 = fully open) drives every layer:
//   • a hero CLONE (expo-image, cover) interpolates from the tapped card's
//     measured photo frame (lib/feedTransition handoff) to the hero slot; the
//     real hero image renders transparent while the clone is mid-flight and
//     takes over at coincidence (progress === 1 — the Dynamic-Overlay opacity-
//     handoff discipline, see docs/design/patterns/).
//   • the settle background + content (bar, body) fade/rise in behind it.
//   • pull-DOWN on a page at scrollY 0 drives progress back down interactively
//     (hero shrinks toward the card, content sinks away); release past the
//     threshold finishes the dismiss and pops the route, else springs back.
// A no-photo source (NonPhotoHero, blind slide) or a cold deep link has no
// frame to share → kind 'fade' / null: same progress choreography, no clone.
// Dismissing after paging targets the ORIGINAL card frame (every carousel
// slide occupies the same frame), and LANDING SYNC (round 3) mirrors the
// active page into the card as you swipe — so the close shrinks the active
// photo into a card already showing that same slide, and the feed sits on the
// impression you dismissed, not the one you opened from.

// The title row's collision edge (used for collapse + scroll targets). A
// paged detail paints a taller bar below this edge to host its docked dots.
const BAR_ROW = 36;
function barHeight(insetTop: number) {
  return insetTop + BAR_ROW + 4;
}
const DOT_SIZE = 6;
const HERO_IDENTITY_SEAM_GAP = 28;
const BAR_DOT_TOP_PAD = 8;
const BAR_DOT_BOTTOM_PAD = 12;
const BAR_WITH_DOTS_BOTTOM_PAD = BAR_DOT_TOP_PAD + DOT_SIZE + BAR_DOT_BOTTOM_PAD;

// Pull-down commit haptic (Simon round 3): a light tick the moment the release
// commits the dismiss — same haptic language as the like/commit ticks.
function closeHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// Finger travel that maps a pull-down to progress 1→0. ~a third of a screen
// reads as "fully let go" (the FullscreenImage lib uses 200; the card is a
// bigger element, give it more room). Device-tune with Simon.
const DISMISS_DRAG = 340;
// EVERY presentation leg is a SPRING on the theme/motion.ts tokens — one
// motion physics both directions (the open joined after Simon device-validated
// the close feel, 2026-07-12; before that it was a motion.dur3 bezier timing).
// OPEN = `springs.enter` (no velocity, not gesture-driven); every CLOSE leg =
// `springs.release`, one duration tier quicker (Simon: dismissal should be the
// fastest motion here). The pan release passes its velocity (converted into
// progress units — progress = 1 − translationY/DISMISS_DRAG, so
// d(progress)/dt = −velocityY/DISMISS_DRAG), so the photo keeps moving at
// finger speed instead of restarting on a curve — the "handbrake at release"
// fix. Reanimated duration-springs settle at ~1.5× the configured perceptual
// duration — this belt matches the physical settle (used by the warm-stage
// fallback timer, see `warmLevel`).
const OPEN_SETTLE_MS = springs.enter.duration * 1.5;

export default function FeedImpression() {
  const { theme } = useTheme();
  const axisColor = useFlavourColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: windowH } = useWindowDimensions();
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  const feedItemId = Number(id);
  const startIndex = Math.max(0, Number(index ?? 0) || 0);

  // Read the feed cache (the list already delivered this). We attach to the
  // SAME query — shared feedQueryOptions, so the two screens can't drift apart
  // on key/options. refetchOnMount: false skips the pointless network round on
  // open; a cold deep-link (no cached data yet) still runs the INITIAL fetch —
  // refetchOnMount only suppresses refetching existing data — so the guard
  // below can resolve.
  const feed = useInfiniteQuery({ ...feedQueryOptions(), refetchOnMount: false });
  const pages = feed.data?.pages;
  const found = Number.isFinite(feedItemId) ? findFeedItem(pages, feedItemId) : null;
  // Pin the last-found item (the house lastRef pattern — cf. the session
  // screens' per-section poll merge). refetchOnMount:false only covers THIS
  // observer's mount: the list observer underneath (and this one, on
  // app-foreground focus) can still refetch the query in place, and a refetch
  // can drop a page-boundary item out of the loaded window. Once this screen
  // has SEEN its item it must never flip to "gone" mid-read — it keeps
  // rendering the pinned copy (a frozen read surface beats a vanishing one);
  // while the item remains in the cache, fresh copies keep flowing through.
  const pinnedRef = useRef<FeedItem | null>(null);
  if (found) pinnedRef.current = found;
  const item = found ?? pinnedRef.current;
  const detail = item ? detailFromItem(item) : null;
  const { code: momentCode, enter: enterMoment } = useEnterableMoment(detail?.sessionId);
  // Clamp seam for the pager index: `index` arrives via route params (a deep
  // link can carry garbage) and onPagerScroll can round past the end on an
  // overscroll bounce — both clamp against the real page count.
  const maxPage = detail ? Math.max(0, detail.wines.length - 1) : 0;

  const [active, setActive] = useState(startIndex);
  // Per-page collapse/title state, keyed by WINE ID (not page index): a
  // rating delete can shrink the wines array and shift indices while a page
  // stays active — index keys would pin a stale collapsed flag/title on
  // whichever wine slid into that slot. The bar reads the active wine's flag.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});

  // Fullscreen impression gallery (design gFull): hero tap opens ALL of the
  // moment's photo impressions as a swipeable fullscreen carousel; closing
  // LANDS the pager on the impression that was being viewed (the mock's
  // gLand). `galleryAt` = the wine index it opened from, null = closed.
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  const pagerRef = useRef<ScrollView>(null);
  // Mirror every active-page change into the feed card beneath (landing sync,
  // round 3): any close — pull-down, back button, Android back — then lands on
  // the slide being dismissed instead of the one the detail opened from. The
  // card is invisible under the opaque detail, so mid-read churn is unseen.
  const lastLandRef = useRef<number | null>(null);
  const landCard = useCallback(
    (i: number) => {
      if (lastLandRef.current === i || !Number.isFinite(feedItemId)) return;
      lastLandRef.current = i;
      requestFeedLanding(feedItemId, i);
    },
    [feedItemId],
  );
  const landPager = useCallback(
    (wineIndex: number) => {
      setGalleryAt(null);
      landCard(wineIndex);
      setActive((cur) => {
        if (cur === wineIndex) return cur;
        pagerRef.current?.scrollTo({ x: wineIndex * screenW, animated: false });
        return wineIndex;
      });
    },
    [screenW, landCard],
  );

  // ── Presentation (proposal 09) ────────────────────────────────────────────
  // The one-shot source the tapped card measured for us; null on a deep link.
  // Lazy useState, not a useRef initializer: consume() clears the store, and a
  // ref initializer's argument re-executes (and re-clears) on every render.
  const [source] = useState(() => consumeFeedTransitionSource());
  const sourceFrame = source?.kind === 'photo' ? source : null;
  // 0 = at the feed card, 1 = fully open. Seeds 0 only when a card handed us a
  // presentation to run; a cold mount renders open, exactly as before.
  const progress = useSharedValue(source ? 0 : 1);
  // Hit-testing is deliberately React-owned, not animated. `pointerEvents` is
  // outside Reanimated's iOS synchronous-props allowlist; combining it with
  // opacity/transform on these hot views demotes the whole per-view batch to
  // the shadow-tree path and caused a physical-device background-only flash
  // after the open settled. Four transitions keep the old ghost-tap guard:
  // blocked while opening → interactive at settle → blocked while dismissing
  // → interactive again when a pull-down is cancelled.
  const [presentationInteractive, setPresentationInteractive] = useState(!source);
  const presentationCloseCommittedRef = useRef(false);
  const presentationCloseCommitted = useSharedValue(false);
  const blockPresentationInteractions = useCallback(() => {
    setPresentationInteractive(false);
  }, []);
  const commitPresentationClose = useCallback(() => {
    presentationCloseCommittedRef.current = true;
    presentationCloseCommitted.value = true;
    setPresentationInteractive(false);
  }, [presentationCloseCommitted]);
  const restorePresentationInteractions = useCallback(() => {
    if (presentationCloseCommittedRef.current) return;
    setPresentationInteractive(true);
  }, []);
  // Whether the presentation is running BACKWARD (pull-down moving, or a
  // back-button/Android-back close) — flips the settle background from the
  // instant open veil to the progressive dismiss reveal (see bgStyle). Reset
  // on a spring-back so a cancelled pull restores the veil.
  const dismissing = useSharedValue(false);
  // Carousel-dots screen-Y (multi-impression only): the ACTIVE page publishes
  // its dots' current top in SCREEN space here on every scroll frame — rest =
  // just under the hero/identity (dots sit in content), scrolling clamps them
  // up to the bar's bottom edge (they "convert into the title bar", Simon's
  // fixes round). One parent overlay renders off this (no per-page copy, so
  // they never slide horizontally with the pager — Codex P2). Seed off-screen.
  const dotTop = useSharedValue(-999);
  const dotStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dotTop.value }] }));
  // the pager offsets hold. Mounting every DetailPage up front blocked the JS
  // thread before the open animation could even start. Content pointerEvents
  // are 'none' until fully open, so nothing can swipe to an unmounted page
  // mid-flight. Warming is STAGED (snappiness plan step 3 — mounting ALL
  // siblings in one commit at coincidence was a JS spike right when the user
  // starts interacting): 0 = entry page only (flight in progress) · 1 =
  // + the ACTIVE page's neighbours (from coincidence, following `page` as the
  // user swipes) · 2 = everything (on JS idle). Never downgrades; `mountedLo/
  // Hi` (below) keep every once-mounted page mounted as the window moves.
  const [warmLevel, setWarmLevel] = useState(source ? 0 : 2);
  const bumpWarm = useCallback((l: number) => setWarmLevel((cur) => Math.max(cur, l)), []);
  const settlePresentation = useCallback(() => {
    bumpWarm(1);
    if (!presentationCloseCommittedRef.current) setPresentationInteractive(true);
  }, [bumpWarm]);
  useEffect(() => {
    if (source) {
      progress.value = withSpring(1, springs.enter, (finished) => {
        if (finished) runOnJS(settlePresentation)();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Belt for an interrupted open (the spring callback fires finished=false
    // and would leave the siblings unmounted forever).
    if (warmLevel === 0) {
      const t = setTimeout(settlePresentation, OPEN_SETTLE_MS + 120);
      return () => clearTimeout(t);
    }
    // Remaining pages mount on JS idle — requestIdleCallback, NOT the
    // deprecated InteractionManager; the timeout floor guarantees a busy
    // thread still warms within a beat.
    if (warmLevel === 1) {
      const id = requestIdleCallback(() => bumpWarm(2), { timeout: 800 });
      return () => cancelIdleCallback(id);
    }
  }, [warmLevel, bumpWarm, settlePresentation]);

  // The clone always shows the ACTIVE page's photo: the entry page on open,
  // whatever page you're on at pull-down. A photoless active page (blind /
  // NonPhotoHero) has no clone → the dismiss is the plain fade.
  const clampedActive = detail ? Math.min(active, maxPage) : 0;
  const activeWine = detail ? detail.wines[clampedActive] : null;
  const activeUri = activeWine && !activeWine._blind && activeWine.imageUrl ? activeWine.imageUrl : null;
  const hasClone = !!(sourceFrame && activeUri);
  const heroCloneH = Math.round(windowH * HERO_RATIO) + radius.xl;
  // Natural aspect per photo uri — ⚠️ HEIGHT/WIDTH, the feed's house
  // convention (lib/feedAspect.ts; the first cut read it as width/height,
  // which shaped the layer as its own transpose — portrait photos flew with a
  // landscape crop, the "zoom then settle" Simon saw in BOTH directions).
  // Seeded from the card handoff for the
  // tapped photo, kept fresh by the clone image's own onLoad (covers a
  // dismissal from a swiped-to page, whose photo the handoff never saw; the
  // clone mounts that photo while the screen sits open, so the aspect is in
  // hand before any pull-down). Drives the intrinsic-aspect image layer
  // below: expo-image bakes its cover crop at LAYOUT bounds, so a bitmap
  // cropped at the hero box cannot recover the pixels a differently-shaped
  // card frame shows — the "photo zooms, then snaps to the card's crop at
  // rest" Simon saw on close (Codex P1). Unknown aspect falls back to the
  // hero-box crop (the pre-fix behavior) until onLoad reports the ratio.
  const [photoAspects, setPhotoAspects] = useState<Record<string, number>>(() =>
    source?.kind === 'photo' && source.aspect ? { [source.uri]: source.aspect } : {},
  );
  // ⚠️ FROZEN during the open flight (codex P2): an onLoad aspect landing
  // while progress < 1 would resize cloneImgW/H mid-animation — a visible
  // crop jump when the tapped card's image hadn't finished loading. The
  // fallback geometry holds for the whole flight; pending aspects flush at
  // warmLevel ≥ 1 (the open leg's finish callback), where the intrinsic
  // layer with the true aspect is pixel-identical to the fallback at the
  // final hero rect by construction — the swap is invisible, and the
  // pull-down that needs the aspect gets it correct.
  const warmRef = useRef(warmLevel);
  warmRef.current = warmLevel;
  const pendingAspects = useRef<Record<string, number>>({});
  const reportCloneAspect = useCallback((uri: string, hOverW: number) => {
    if (!Number.isFinite(hOverW) || hOverW <= 0) return;
    if (warmRef.current === 0) {
      if (!pendingAspects.current[uri]) pendingAspects.current[uri] = hOverW;
      return;
    }
    setPhotoAspects((prev) => (prev[uri] ? prev : { ...prev, [uri]: hOverW }));
  }, []);
  useEffect(() => {
    if (warmLevel === 0) return;
    const pend = pendingAspects.current;
    const uris = Object.keys(pend);
    if (!uris.length) return;
    pendingAspects.current = {};
    setPhotoAspects((prev) => {
      const next = { ...prev };
      for (const u of uris) if (!next[u]) next[u] = pend[u];
      return next;
    });
  }, [warmLevel]);
  const activeAspect = activeUri ? photoAspects[activeUri] : undefined;
  // The image layer's size = the FINAL hero box's cover fit for the real
  // aspect (h/w), rendered UNclipped (the outer overflow:hidden crops) —
  // identical pixels to contentFit="cover" at rest, but the counter-scale can
  // reveal the parts a differently-shaped mid-flight box needs.
  const cloneImgW = activeAspect ? Math.max(screenW, heroCloneH / activeAspect) : screenW;
  const cloneImgH = activeAspect ? cloneImgW * activeAspect : heroCloneH;
  // The glass-panel clone shows the ACTIVE wine — landing sync (round 3) keeps
  // the card beneath on the page being dismissed, so the panel clone must
  // match it or the [0→0.35] fade hands off onto a different panel.
  const entryIndex = detail ? Math.min(startIndex, maxPage) : 0;
  // Monotonic mounted BOUNDS for the level-1 window (Codex P2 + render-purity
  // note): every page the moving neighbour window has covered stays mounted
  // (no scroll-state loss / blank back-swipe). Expanded in an EFFECT — post-
  // commit, so render stays pure; a NEW target still mounts in the same
  // commit via the live `page` window in the render gate, the bounds only
  // remember where that window has been. Contiguous by construction (entry ±
  // the window's walk), so two bounds suffice over a set.
  const [mountedLo, setMountedLo] = useState(entryIndex);
  const [mountedHi, setMountedHi] = useState(entryIndex);
  useEffect(() => {
    if (warmLevel !== 1) return;
    setMountedLo((lo) => Math.min(lo, Math.max(0, clampedActive - 1)));
    setMountedHi((hi) => Math.max(hi, clampedActive + 1));
  }, [warmLevel, clampedActive]);

  // Plain pop. The visual close (reversing progress) happens before this; a
  // cold deep link has no feed beneath the modal, so fall back to the tab.
  // Idempotent — a bar-back close and a pan close can't double-pop.
  const closedRef = useRef(false);
  const closeDetail = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/feed');
  }, [router]);
  // The bar's back button: reverse the presentation, then pop. Without a
  // presentation (deep link) it's just the pop.
  const requestClose = useCallback(() => {
    if (!source) {
      closeDetail();
      return;
    }
    commitPresentationClose();
    dismissing.value = true; // bg follows progress on the way out (see bgStyle)
    // Plain self-write first: it cancels any running animation, so this spring
    // starts from rest. Without it a NEW spring ADDS the running one's velocity
    // (spring.ts onStart) — an Android back pressed during a spring-back would
    // inherit its upward velocity, cross the clamping bound and jump-cut to 0.
    progress.value = progress.value;
    progress.value = withSpring(0, springs.release, (finished) => {
      if (finished) runOnJS(closeDetail)();
    });
  }, [source, progress, dismissing, closeDetail, commitPresentationClose]);
  // Android hardware back must take the same reversed presentation — without
  // this it pops the transparent modal natively (instant vanish, no close
  // animation). Claiming the event (return true) suppresses the default pop;
  // requestClose pops after the animation. No-op on iOS.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (closedRef.current) return false;
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [requestClose]);

  // ── Header actions (overflow menu) ───────────────────────────────────────
  // Crave, Had it too, Share, and owner Edit ALL land in the deferred column
  // (08-feed §6/§7): Crave needs sourceRatingId + a non-membership endpoint +
  // a Cravings list (a coherent later pass — the legacy (user,wineId) bookmark
  // can't remember WHOSE impression you craved); Had it too needs the prefilled
  // ciSheet; Share needs a per-impression permalink (none exists yet). So the
  // menu is placeholders this pass — no live write from this screen.
  const meId = authClient.useSession().data?.user.id;
  const isOwner = !!meId && detail?.author.id === Number(meId);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  // Owner delete (Simon, 2026-07-18) — mirrors the feed list's ⋯ flow.
  // Standalone = DELETE the check-in; session = clear the ACTIVE impression's
  // rating (empty-PATCH reap). When the POST is gone the detail must not stay
  // up (it pins its copy by design), so it pops straight to the feed — no
  // reversed presentation: the card underneath is about to vanish, animating
  // into it would land on a hole.
  const queryClient = useQueryClient();
  const deleteBusy = useRef(false);
  const runDelete = useCallback(
    async (op: () => Promise<{ feedItemDeleted: boolean } | void>, applyToCache: (item: FeedItem) => FeedItem | null) => {
      if (deleteBusy.current) return;
      deleteBusy.current = true;
      try {
        const res = await op();
        const postGone = !res || res.feedItemDeleted;
        // Reflect the delete in the cache IMMEDIATELY (like-flow pattern) —
        // refetch alone leaves a window where the deleted target is still
        // actionable and a second delete 404s (Codex). Cancel first so an
        // in-flight refetch can't clobber the write.
        await queryClient.cancelQueries({ queryKey: FEED_KEY });
        queryClient.setQueryData<InfiniteData<FeedPage>>(FEED_KEY, (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((p) => ({ ...p, items: p.items.map(applyToCache).filter((it): it is FeedItem => it !== null) })),
              }
            : data,
        );
        if (postGone) closeDetail();
        await queryClient.refetchQueries({ queryKey: FEED_KEY });
      } catch (e) {
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        Alert.alert('Could not delete', msg || 'Check your connection and try again.');
      } finally {
        deleteBusy.current = false;
      }
    },
    [queryClient, closeDetail],
  );
  const confirmDelete = useCallback(() => {
    setMenuAnchor(null);
    // Destructive confirms always NAME what's being deleted (Simon,
    // 2026-07-18) — a blind wine's name arrives redacted-empty, so it gets
    // the card's own alias ("Wine N") instead.
    const name = activeWine ? (activeWine._blind ? `Wine ${clampedActive + 1}` : activeWine.name) : '';
    if (detail?.isSession && activeWine) {
      const wineId = activeWine.id;
      Alert.alert(
        name ? `Delete your rating of “${name}”?` : 'Delete your rating?',
        'This resets your rating for this impression. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
              runDelete(
                () => patchSessionRating(feedItemId, { wineId, score: 0, flavors: {}, aromas: [], notes: '' }),
                // Drop the cleared wine from the post; drop the whole post
                // when that was its last impression (the server reaps it).
                (it) => {
                  if (it.type !== 'session' || it.session.id !== feedItemId) return it;
                  const wines = it.session.wines.filter((w) => w.id !== wineId);
                  if (wines.length === 0) return null;
                  return { ...it, session: { ...it.session, wines } };
                },
              ),
          },
        ],
      );
      return;
    }
    Alert.alert(
      name ? `Delete “${name}”?` : 'Delete this check-in?',
      'This removes the post, its rating, and its photo. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            runDelete(
              () => deleteCheckin(feedItemId),
              (it) => (it.type === 'checkin' && it.checkin.id === feedItemId ? null : it),
            ),
        },
      ],
    );
  }, [detail?.isSession, activeWine, clampedActive, feedItemId, runDelete]);

  // Settle background — DIRECTION-AWARE (Simon, round 3e): on OPEN it snaps
  // opaque within the first ~12% of progress (1–2 frames), so the feed around
  // the post pops away instead of shining through the whole flight (the
  // shared elements — photo + panel clones — carry all the continuity). On
  // DISMISS (`dismissing` flips when a pull-down moves or the back button
  // closes) it follows progress linearly, so the feed grows back behind the
  // shrinking photo — the pull-down's whole point.
  const bgStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return { opacity: dismissing.value ? p : interpolate(p, [0, 0.12], [0, 1], Extrapolation.CLAMP) };
  });
  // The clone flies on TRANSFORM + OPACITY ONLY (snappiness plan step 4 — the
  // earlier left/top/width/height interpolation forced a native LAYOUT pass +
  // expo-image/gradient re-layout every frame, the dropped-frame source round
  // 3c measured). The view renders statically at the FINAL hero rect; the
  // worklet derives the same edge trajectories as before (lerped x/y/w/h) and
  // expresses them as center-translate + axis scales, so the flight path is
  // pixel-identical. ⚠️ ALLOWLIST CONSTRAINT (IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS,
  // see apps/mobile/package.json): reanimated's synchronous fast path is
  // all-or-nothing per view — this worklet must return ONLY `transform` and
  // `opacity` (colors/radii are also allowlisted; ANY other key, even a static
  // `left: 0`, silently demotes the whole view to the shadow-tree path).
  const cloneStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!sourceFrame) return { opacity: 0, transform: [{ scale: 1 }] };
    const w = interpolate(p, [0, 1], [sourceFrame.width, screenW]);
    const h = interpolate(p, [0, 1], [sourceFrame.height, heroCloneH]);
    const x = interpolate(p, [0, 1], [sourceFrame.x, 0]);
    const y = interpolate(p, [0, 1], [sourceFrame.y, 0]);
    return {
      // The real hero owns the pixels at rest — the clone exists mid-flight.
      opacity: p < 1 ? 1 : 0,
      transform: [
        { translateX: x + w / 2 - screenW / 2 },
        { translateY: y + h / 2 - heroCloneH / 2 },
        { scaleX: w / screenW },
        { scaleY: h / heroCloneH },
      ],
    };
  });
  // Counter-scale for the clone's intrinsic-aspect image layer: the outer
  // axis scales are non-uniform (card frame aspect ≠ hero aspect), which
  // would distort the photo — the old layout animation avoided that by
  // re-cover-cropping every frame. Per frame, u = the uniform cover scale of
  // the intrinsic layer for the CURRENT box; dividing out the outer axis
  // scales makes the image's net on-screen scale (u, u) — undistorted,
  // covering (outer overflow:hidden crops), and matching the real cover crop
  // at BOTH endpoints (u = 1 at the hero by construction of cloneImgW/H; at
  // the card it equals the card's own cover scale) — a continuous,
  // transform-only "cover".
  const cloneImgStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!sourceFrame) return { transform: [{ scale: 1 }] };
    const w = interpolate(p, [0, 1], [sourceFrame.width, screenW]);
    const h = interpolate(p, [0, 1], [sourceFrame.height, heroCloneH]);
    const u = Math.max(w / cloneImgW, h / cloneImgH);
    return { transform: [{ scaleX: (u * screenW) / w }, { scaleY: (u * heroCloneH) / h }] };
  });
  // Bar + pager fade/rise in behind the traveling photo (the "unfold") and
  // sink away on dismiss. Late START (0.35 — the card shows through early) but
  // EARLY FINISH (fully crisp by 0.8/0.85 progress): riding the ramps all the
  // way to 1.0 left the body translucent + drifting through the easing's
  // settle tail — the "info panel lags at the end" Simon's frame-by-frame
  // recording showed (round 3b). The photo alone does the final settle.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 0.8], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0.35, 0.85], [36, 0], Extrapolation.CLAMP) }],
  }));
  // The card's GLASS PANEL stays IN FRONT of the traveling photo (Simon: the
  // image slides BEHIND the panel — out from behind it on open, back behind
  // it on close). A pixel-matched panel clone sits pinned at the card frame
  // above the photo clone, fully there at the card and gone by 35% open; at
  // rest it hands off seamlessly to the real card panel beneath the modal.
  const panelCloneStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.35], [1, 0], Extrapolation.CLAMP),
  }));
  // Scrim crossfade inside the photo clone: the card photo carries
  // FEED_PANEL_SCRIM, the detail hero carries HERO_SCRIM — fade one into the
  // other with progress so BOTH endpoints are pixel-identical (no brightness
  // flash at either handoff).
  const cardScrimStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const heroScrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  // The hero TITLE overlay. The page's own hero chrome (scrim + name block)
  // hides while the clone is mid-flight — statically-positioned chrome over a
  // traveling photo reads as floating (and the pre-3d clone-over-content
  // order made the title POP at coincidence instead). This overlay fades the
  // title in near the settle. Deliberately a STATIC layer at the FINAL hero
  // rect, NOT a child of the animating clone: originally because the clone's
  // layout-prop animation re-shaped child text every frame (round 3c stutter);
  // still right now that the clone flies on transforms — a child would
  // inherit the non-uniform axis squash and distort. It only shows past 0.7, when the
  // clone sits within a few px of the final rect, so the fixed anchor reads
  // as the title gliding in with the settle; at coincidence it yields to the
  // page's identical real block.
  const cloneTitleStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return { opacity: p < 1 ? interpolate(p, [0.7, 1], [0, 1], Extrapolation.CLAMP) : 0 };
  });
  // The bar rides its own layer ABOVE the clone (chrome over the traveling
  // photo, no rise — see the layer comments in the render). `box-none` keeps
  // the wrapper from swallowing touches meant for the pages.
  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 0.8], [0, 1], Extrapolation.CLAMP),
  }));

  const onPagerScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.max(0, Math.min(maxPage, Math.round(e.nativeEvent.contentOffset.x / screenW)));
      landCard(i);
      setActive((cur) => (cur === i ? cur : i));
    },
    [screenW, maxPage, landCard],
  );

  const reportCollapse = useCallback((wineId: string, c: boolean) => {
    setCollapsed((prev) => (prev[wineId] === c ? prev : { ...prev, [wineId]: c }));
  }, []);
  const reportTitle = useCallback((wineId: string, t: string) => {
    setTitles((prev) => (prev[wineId] === t ? prev : { ...prev, [wineId]: t }));
  }, []);
  // Each mounted page registers its "scroll to About" imperative here; the
  // collapsed-bar title tap drives the ACTIVE page's (the wine-name tap in the
  // hero drives its own page directly). Keyed by page so a swipe targets the
  // right one.
  const scrollFns = useRef<Record<number, () => void>>({});
  const registerScrollToAbout = useCallback((page: number, fn: (() => void) | null) => {
    if (fn) scrollFns.current[page] = fn;
    else delete scrollFns.current[page];
  }, []);
  const scrollActiveToAbout = useCallback(() => {
    scrollFns.current[clampedActive]?.();
  }, [clampedActive]);

  if (!item || !detail) {
    // Post not in the cache (deep link before the feed loaded, or trimmed
    // out). Solid + un-animated — there's no source frame worth honoring.
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <FloatBar solid title="" onBack={closeDetail} insetTop={insets.top} pending={feed.isPending} />
        <CenteredMessage
          title="This impression is gone"
          body="It may have been removed, or the feed hasn't loaded it yet."
          pending={feed.isPending}
        />
      </View>
    );
  }

  const { wines, author, createdAt, place } = detail;
  const total = wines.length;
  // Read-side clamp: `active` seeds from the raw route param before wines are
  // known, so index the per-page maps through the clamped value.
  const page = clampedActive;
  const pageWineId = wines[page]?.id ?? '';
  const barSolid = !!collapsed[pageWineId];
  // Only photo-bearing impressions go fullscreen (a blind/photoless page has
  // nothing to show); wineIndex maps a gallery page back to its pager slot.
  const galleryPages: GalleryPage[] = wines
    .map((w, i) => ({ uri: !w._blind && w.imageUrl ? w.imageUrl : null, wine: w, wineIndex: i }))
    .filter((p): p is GalleryPage => p.uri !== null);

  return (
    // BottomSheetModalProvider in-screen (the app's per-screen pattern) —
    // hosts the aromas "+N more" read sheet.
    <BottomSheetModalProvider>
    {/* Transparent root — the feed shows through while the presentation runs.
        The settle bg below fades to opaque with progress. */}
    <View style={{ flex: 1 }}>
      {/* RNS dead-end — stops react-native-screens flipping the first
          descendant ScrollView's contentInsetAdjustmentBehavior never→automatic
          (which would top-inset the hero below the status bar). Load-bearing;
          see apps/mobile/CLAUDE.md "full-bleed scroll content vs RNS". */}
      <View collapsable={false} style={{ width: 0, height: 0 }} />

      {/* settle background — the screen's bg, faded by progress */}
      <Reanimated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }, bgStyle]}
      />

      {/* Layer order (bottom → top): settle bg · HERO CLONE (the traveling
          photo + scrim crossfade) · content (pager/body) · title overlay ·
          glass-panel clone · bar. The body panel rides ABOVE the traveling
          photo as ONE piece — rounded top + content sliding up uniformly, the
          photo disappearing behind its edge (Simon, round 3d; the earlier
          clone-over-content order occluded the panel's rounded top, and the
          detached seam-strip patch read as scissors). The page's own hero
          (image + scrim + title) renders transparent until coincidence, when
          the clone hands off pixel-identically. */}
      {hasClone ? (
        // Static FINAL hero rect — the flight is transform-only (cloneStyle).
        // The scrims stay direct children: the outer axis squash compresses
        // their proportional ramps exactly like the old per-frame re-layout.
        <Reanimated.View
          pointerEvents="none"
          style={[styles.clone, { width: screenW, height: heroCloneH }, cloneStyle]}
        >
          {/* intrinsic-aspect image layer, centered (its center coincides with
              the outer's, so the counter-scale stays center-anchored). onLoad
              feeds the aspect map for photos the handoff didn't cover. */}
          <Reanimated.View
            style={[
              {
                position: 'absolute',
                left: (screenW - cloneImgW) / 2,
                top: (heroCloneH - cloneImgH) / 2,
                width: cloneImgW,
                height: cloneImgH,
              },
              cloneImgStyle,
            ]}
          >
            <Image
              source={{ uri: activeUri! }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              onLoad={(e) => reportCloneAspect(activeUri!, e.source.height / e.source.width)}
              alt=""
            />
          </Reanimated.View>
          <Reanimated.View style={[StyleSheet.absoluteFill, cardScrimStyle]}>
            <LinearGradient colors={FEED_PANEL_SCRIM} style={StyleSheet.absoluteFill} />
          </Reanimated.View>
          <Reanimated.View style={[StyleSheet.absoluteFill, heroScrimStyle]}>
            <LinearGradient colors={HERO_SCRIM} style={StyleSheet.absoluteFill} />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}

      <Reanimated.View pointerEvents={presentationInteractive ? 'auto' : 'none'} style={[{ flex: 1 }, contentStyle]}>
        {total === 1 ? (
          <DetailPage
            wine={wines[0]}
            index={0}
            total={1}
            author={author}
            createdAt={createdAt}
            place={place}
            onPlacePress={momentCode ? enterMoment : undefined}
            onCollapse={(c) => reportCollapse(wines[0].id, c)}
            onTitle={(t) => reportTitle(wines[0].id, t)}
            onRegisterScrollToAbout={(fn) => registerScrollToAbout(0, fn)}
            insetTop={insets.top}
            bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
            progress={progress}
            dismissing={dismissing}
            isClonePage={hasClone}
            isActive
            dotTop={dotTop}
            onClosed={closeDetail}
            closeCommitted={presentationCloseCommitted}
            onDismissStart={blockPresentationInteractions}
            onDismissCommit={commitPresentationClose}
            onDismissCancel={restorePresentationInteractions}
            onOpenGallery={() => setGalleryAt(0)}
            deferBody={!!source}
          />
        ) : (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={onPagerScroll}
            scrollEventThrottle={16}
            contentOffset={{ x: Math.min(startIndex, maxPage) * screenW, y: 0 }}
            // flex:1 bounds the pager to the screen so each page's own vertical
            // ScrollView (DetailPage root) gets a real viewport height — without
            // it the height chain is unconstrained and vertical scrolling inside
            // a page can collapse. Page wrappers stretch to this height (a
            // horizontal SV's content row defaults to alignItems:stretch).
            style={{ flex: 1 }}
          >
            {wines.map((w, i) => {
              // Mount-cost gate: siblings stay empty slot views until their
              // warm stage — entry only in flight, the ACTIVE page's
              // neighbours from coincidence, the rest on idle (see
              // `warmLevel`). The window follows `page`, so a quick second
              // swipe finds its target mounting mid-swipe instead of blank
              // until the idle bump (Codex P2); the `mountedLo/Hi` bounds
              // keep every page the window has covered mounted (no scroll-
              // state loss / blank on a back-swipe as the window moves).
              const mount =
                warmLevel >= 2 ||
                i === entryIndex ||
                (warmLevel >= 1 && (Math.abs(i - page) <= 1 || (i >= mountedLo && i <= mountedHi)));
              return (
              <View key={w.id} style={{ width: screenW }}>
                {mount ? (
                  <DetailPage
                    wine={w}
                    index={i}
                    total={total}
                    author={author}
                    createdAt={createdAt}
                    place={place}
                    onPlacePress={momentCode ? enterMoment : undefined}
                    onCollapse={(c) => reportCollapse(w.id, c)}
                    onTitle={(t) => reportTitle(w.id, t)}
                    onRegisterScrollToAbout={(fn) => registerScrollToAbout(i, fn)}
                    insetTop={insets.top}
                    bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
                    progress={progress}
                    dismissing={dismissing}
                    isClonePage={hasClone && i === page}
                    isActive={i === page}
                    dotTop={dotTop}
                    onClosed={closeDetail}
                    closeCommitted={presentationCloseCommitted}
                    onDismissStart={blockPresentationInteractions}
                    onDismissCommit={commitPresentationClose}
                    onDismissCancel={restorePresentationInteractions}
                    onOpenGallery={() => setGalleryAt(i)}
                    deferBody={!!source && i === entryIndex}
                  />
                ) : null}
              </View>
              );
            })}
          </ScrollView>
        )}

      </Reanimated.View>

      {/* on-photo title overlay — static final-rect layout, opacity only (a
          sibling of the clone, NOT inside it — see cloneTitleStyle). */}
      {hasClone ? (
        <Reanimated.View
          pointerEvents="none"
          style={[{ position: 'absolute', left: 0, top: 0, width: screenW, height: heroCloneH }, cloneTitleStyle]}
        >
          <HeroTitle wine={activeWine!} index={clampedActive} />
        </Reanimated.View>
      ) : null}

      {/* glass-panel clone — the card's panel face, pinned at the card frame
          IN FRONT of the photo; the real panel beneath takes over at rest.
          Shows the ACTIVE wine (the landing-synced card mirrors it). */}
      {sourceFrame && activeWine ? (
        <Reanimated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: sourceFrame.x,
              top: sourceFrame.y,
              width: sourceFrame.width,
              height: sourceFrame.height,
            },
            panelCloneStyle,
          ]}
        >
          <FeedGlassPanel wine={activeWine} index={clampedActive} axisColor={axisColor} onPress={() => {}} />
        </Reanimated.View>
      ) : null}

      {/* Shared floating bar — over ALL pages (and over the clone), collapse
          tracks the active one. Fades with the presentation but does NOT rise
          with the body (it's chrome, not content). The collapsed title taps
          through to About (onTitlePress). */}
      <Reanimated.View
        pointerEvents={presentationInteractive ? 'box-none' : 'none'}
        style={[StyleSheet.absoluteFill, barStyle]}
      >
        <FloatBar
          solid={barSolid}
          title={barSolid ? titles[pageWineId] ?? '' : ''}
          onBack={requestClose}
          onTitlePress={scrollActiveToAbout}
          insetTop={insets.top}
          photoless={activeWine ? !!activeWine._blind || !activeWine.imageUrl : false}
          hasDots={total > 1}
          onMenu={setMenuAnchor}
        />
      </Reanimated.View>

      {/* Carousel dots — ONE parent overlay (never per-page, so they don't
          slide with the pager; Codex P2). The active page drives `dotTop`
          (rest under the hero → clamped up to the bar as you scroll: they keep
          their place in content, then convert into the title bar — Simon's
          fixes round). Uses the same accent/ink-faint colors as the feed's
          carousel indicator. Fades with the presentation like the bar. */}
      {total > 1 ? (
        <Reanimated.View
          pointerEvents="none"
          style={[{ position: 'absolute', left: 0, right: 0, top: 0, alignItems: 'center' }, dotStyle, barStyle]}
        >
          <DotRow total={total} index={page} />
        </Reanimated.View>
      ) : null}


      {/* Overflow menu — the shared .ir-menu dropdown (AnchoredMenu). Crave,
          Had it too (standalone), Share, and owner Edit are all DISABLED
          placeholders this pass (each renders a "Soon" tag via MenuItem):
          Crave/Share/Had-it-too are deferred coherent passes (08-feed §6/§7),
          and no standalone impression editor exists. */}
      <AnchoredMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)} right={16} minWidth={220}>
        <MenuItem icon="heart" label="Crave" disabled />
        {detail.isSession === false ? <MenuItem icon="plus" label="Had It Too" disabled /> : null}
        <MenuItem icon="share" label="Share" disabled />
        {isOwner ? <MenuSeparator /> : null}
        {isOwner ? (
          <MenuItem
            icon="edit"
            label="Edit"
            accessibilityLabel="Edit Impression"
            onPress={() => {
              setMenuAnchor(null);
              router.push({
                pathname: '/feed/edit/[id]',
                params: detail.isSession && activeWine
                  ? { id: String(feedItemId), wine: activeWine.id }
                  : { id: String(feedItemId) },
              });
            }}
          />
        ) : null}
        {isOwner ? (
          <MenuItem
            icon="trash"
            label={detail.isSession ? 'Delete Rating' : 'Delete'}
            tone="danger"
            accessibilityLabel={detail.isSession ? 'Delete Rating' : 'Delete Check-In'}
            onPress={confirmDelete}
          />
        ) : null}
      </AnchoredMenu>

      {/* fullscreen gallery — a Modal, so its place in this tree is chrome-
          independent. Closing lands the pager on the viewed impression. */}
      <FullscreenGallery
        pages={galleryPages}
        startWineIndex={galleryAt ?? 0}
        visible={galleryAt != null}
        onClose={landPager}
      />
    </View>
    </BottomSheetModalProvider>
  );
}

// The on-photo impression identity at the hero's bottom-left: wine
// name/vintage, then producer/style. Attribution belongs to the IG-style
// caption in the body. Shared with the traveling clone so the title handoff is
// pixel-identical at rest.
function HeroTitle({ wine, index, onNamePress }: { wine: SessionFeedWine; index: number; onNamePress?: () => void }) {
  const blind = !!wine._blind;
  const name = blind ? `Wine ${index + 1}` : wine.name;
  const sub = !blind ? [wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ') : '';
  // `box-none` when interactive (the page hero): the name Pressable takes its
  // own taps (→ scroll to About) while every other touch falls through to the
  // photo's gallery Pressable below. The traveling CLONE passes no onNamePress
  // and stays fully non-interactive (decorative).
  const nameTitle = (
    <VText numberOfLines={1} style={[styles.heroName, { color: '#fff' }]}>
      {name}
      {!blind && wine.vintage ? (
        <VText style={[styles.heroVintage, { color: 'rgba(255,255,255,0.7)' }]}>{` - ${wine.vintage}`}</VText>
      ) : null}
    </VText>
  );
  return (
    <View pointerEvents={onNamePress ? 'box-none' : 'none'} style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: HERO_IDENTITY_SEAM_GAP + radius.xl }}>
      {onNamePress ? (
        <Pressable onPress={onNamePress} accessibilityRole="button" accessibilityLabel={`${name} — about this impression`}>
          {nameTitle}
        </Pressable>
      ) : (
        nameTitle
      )}
      {sub ? (
        <VText numberOfLines={1} style={styles.heroSub}>
          {sub}
        </VText>
      ) : null}
    </View>
  );
}

// The floating→solid bar. Overlaid, absolute at top. Two chrome modes:
//   • over a PHOTO hero → transparent bar + dark-glass control pills + white
//     icons, until collapse hands the ink title in (solid bg).
//   • a PHOTOLESS impression → in-flow INK chrome from the start (transparent
//     bg, no glass pills, ink icons) — matching 02e's photoless bar, since
//     there's no photo to read glass against (Codex P2).
// Actions: back · fading title (taps → About) · ⋯ overflow. The carousel dots
// are NOT here — they're a parent overlay that glides up and clamps at the
// bar's bottom edge (see the dotTop overlay in the parent).
function FloatBar({
  solid,
  title,
  onBack,
  onTitlePress,
  insetTop,
  pending,
  photoless,
  hasDots,
  onMenu,
}: {
  solid: boolean;
  title: string;
  onBack: () => void;
  onTitlePress?: () => void;
  insetTop: number;
  pending?: boolean;
  photoless?: boolean;
  hasDots?: boolean;
  onMenu?: (anchor: MenuAnchor) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const menuBtnRef = useRef<View>(null);
  // Glass chrome only over a photo before collapse; photoless + collapsed = ink.
  const onGlass = !solid && !photoless;
  const iconColor = onGlass ? '#fff' : theme.ink;
  const titleText = phone.text('subhead');
  // Same responsive control geometry as Moment impression detail's IrBar:
  // back and ⋯ always share one circle in both glass and plain modes.
  const glassSize = phone.size('heroAction');
  const plainSize = phone.size('compactAction');
  const circle = onGlass
    ? { width: glassSize, height: glassSize, borderRadius: glassSize / 2, backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const }
    : { width: plainSize, height: plainSize, alignItems: 'center' as const, justifyContent: 'center' as const };
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 8,
        paddingTop: insetTop,
        paddingHorizontal: 16,
        paddingBottom: hasDots ? BAR_WITH_DOTS_BOTTOM_PAD : 4,
        // Opaque when collapsed; transparent over the photo AND on a photoless
        // page (its own bg shows through — an in-flow bar, ADR-0003).
        backgroundColor: solid ? theme.bg : 'transparent',
      }}
    >
      <View style={styles.barRow}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}
        >
          <Icon name="back" size={phone.size('topBarBackIcon')} color={iconColor} />
        </Pressable>
        {solid && !pending ? (
          // Collapsed title taps through to About (scroll-to-section).
          <Pressable
            onPress={onTitlePress}
            accessibilityRole="button"
            style={{ flex: 1, minWidth: 0, paddingHorizontal: 10 }}
          >
            <VText numberOfLines={1} style={[styles.barTitle, titleText, { color: theme.ink }]}>
              {title}
            </VText>
          </Pressable>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable
          ref={menuBtnRef}
          onPress={() => menuBtnRef.current?.measureInWindow((_x, y, _w, h) => onMenu?.({ top: y, bottom: y + h }))}
          accessibilityRole="button"
          accessibilityLabel="More"
          hitSlop={8}
          style={({ pressed }) => ({ ...circle, marginLeft: 2, opacity: pressed ? 0.5 : 1 })}
        >
          <Icon name="more" size={phone.size('compactActionIcon')} color={iconColor} />
        </Pressable>
      </View>
    </View>
  );
}

// The carousel dot row — reuses the feed's 6px dot / 5px gap, accent / ink-faint
// colors, and 1.15 active scale.
function DotRow({ total, index }: { total: number; index: number }) {
  const { theme } = useTheme();
  return (
    <View style={styles.dots}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[styles.dot, { backgroundColor: i === index ? theme.accent : theme.inkFaint }, i === index && styles.dotOn]}
        />
      ))}
    </View>
  );
}

// Instagram-style attribution: avatar beside the first two caption lines,
// then long copy returns to the full content width below it. Yoga has no CSS
// float, so an invisible, identically-styled measure pass finds the second
// line's word boundary; the visible copy is split there. With no note, the
// author + metadata still occupy the avatar's two-line block.
function CaptionByline({
  author,
  note,
  place,
  createdAt,
  onPlacePress,
}: {
  author: FeedAuthor;
  note: string | null;
  place: string | null;
  createdAt: string;
  onPlacePress?: () => void;
}) {
  const cleanNote = note?.trim() ?? '';
  const full = cleanNote ? `${author.name} ${cleanNote}` : author.name;
  const [layout, setLayout] = useState<{ lines: number; splitAt: number | null }>({ lines: 0, splitAt: null });
  const headEnd = layout.splitAt ?? full.length;
  const tail = layout.splitAt === null ? '' : full.slice(layout.splitAt).trimStart();
  const tailStart = tail ? full.length - tail.length : null;
  const stamp = timeAgo(createdAt);
  const metaInside = !cleanNote || layout.lines === 1;
  const copySlice = (start: number, end: number) => (
    <>
      {start < author.name.length ? (
        <VText style={styles.captionAuthor}>{full.slice(start, Math.min(end, author.name.length))}</VText>
      ) : null}
      {end > author.name.length ? full.slice(Math.max(start, author.name.length), end) : null}
    </>
  );
  const meta = place || stamp ? (
    <VText variant="caption" color="inkSoft" numberOfLines={1} style={styles.captionMeta}>
      {place ? (
        <VText
          variant="caption"
          color={onPlacePress ? 'accent' : 'inkSoft'}
          onPress={onPlacePress}
          style={onPlacePress ? styles.captionMetaLink : undefined}
        >
          {place}
        </VText>
      ) : null}
      {place && stamp ? ' · ' : ''}
      {stamp}
    </VText>
  ) : null;

  return (
    <View style={styles.captionByline}>
      <View style={styles.captionAvatar}>
        <Avatar imageUrl={author.imageUrl} name={author.name} size={38} />
      </View>
      {/* Measure at the avatar-constrained width, with the real nested weight. */}
      <VText
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        onTextLayout={(e) => {
          const lines = e.nativeEvent.lines;
          const splitAt = lines.length > 2
            ? lines.slice(0, 2).reduce((length, line) => length + line.text.length, 0)
            : null;
          setLayout((prev) => (prev.lines === lines.length && prev.splitAt === splitAt ? prev : { lines: lines.length, splitAt }));
        }}
        style={[styles.captionText, styles.captionMeasure]}
      >
        <VText style={styles.captionAuthor}>{author.name}</VText>
        {cleanNote ? ` ${cleanNote}` : ''}
      </VText>

      <View style={styles.captionLead}>
        <VText style={styles.captionText}>{copySlice(0, headEnd)}</VText>
        {metaInside ? meta : null}
      </View>
      {tailStart !== null ? <VText style={styles.captionText}>{copySlice(tailStart, full.length)}</VText> : null}
      {!metaInside ? meta : null}
    </View>
  );
}

// One impression's full read screen: a collapsing hero (photo under the status
// bar) + the rating body below. Reports its collapse + on-photo title up so the
// shared bar can track it. Owns its slice of the presentation: the pull-down
// dismiss pan (arms only at scrollY 0, writes the SHARED progress) and the
// hero-image opacity handoff with the parent's clone.
function DetailPage({
  wine,
  index,
  total,
  author,
  createdAt,
  place,
  onPlacePress,
  onCollapse,
  onTitle,
  insetTop,
  bottomPad,
  progress,
  dismissing,
  isClonePage,
  isActive,
  dotTop,
  onClosed,
  closeCommitted,
  onDismissStart,
  onDismissCommit,
  onDismissCancel,
  onOpenGallery,
  onRegisterScrollToAbout,
  deferBody,
}: {
  wine: SessionFeedWine;
  index: number;
  total: number;
  author: FeedAuthor;
  createdAt: string;
  place: string | null;
  onPlacePress?: () => void;
  onCollapse: (collapsed: boolean) => void;
  onTitle: (title: string) => void;
  // Register this page's "scroll to About" imperative up to the parent (so the
  // collapsed-bar title can drive the active page). null on unmount.
  onRegisterScrollToAbout: (fn: (() => void) | null) => void;
  insetTop: number;
  bottomPad: number;
  // Shared presentation progress (see the header comment): the pan writes it,
  // the hero image keys its clone handoff on it.
  progress: SharedValue<number>;
  // Direction flag for the settle background (parent's bgStyle): the pan
  // flips it true while pulling down, and back to false on a spring-back.
  dismissing: SharedValue<boolean>;
  // True when the parent's hero clone represents THIS page — the real hero
  // image stays transparent while the clone is mid-flight.
  isClonePage: boolean;
  // True when THIS page is the active pager slot — only the active page drives
  // the shared carousel-dots Y (a swiped-away page must not fight it).
  isActive: boolean;
  // Parent-owned dots screen-Y (multi-impression): this page writes its dots'
  // current top (rest content-Y minus scroll, clamped to the bar) while active.
  dotTop: SharedValue<number>;
  // Pop the route (called after the dismiss animation lands at 0).
  onClosed: () => void;
  // Shared with the parent close path so a system-cancelled gesture cannot
  // override an already committed programmatic dismissal.
  closeCommitted: SharedValue<boolean>;
  // React-owned hit-test gate. Animated pointerEvents would demote this hot
  // view from Reanimated's iOS synchronous-props path.
  onDismissStart: () => void;
  onDismissCommit: () => void;
  onDismissCancel: () => void;
  // Hero tap → the fullscreen impression gallery (parent-owned; the gallery
  // spans ALL the moment's photo impressions, not just this page's).
  onOpenGallery: () => void;
  // Entry page during a presentation only (snappiness plan step 2): first
  // commit renders hero + shell so the open animation can start immediately;
  // the heavy body (wheel SVG, chips, about) mounts one frame later — on the
  // JS thread, concurrently with the UI-thread flight, normally committed
  // before the content fade (progress ≥ 0.35, a few frames in on the
  // front-loaded spring) makes it visible.
  deferBody?: boolean;
}) {
  const { theme } = useTheme();
  const { width: screenW, height: windowH } = useWindowDimensions();
  const axisColor = useFlavourColors();
  const blind = !!wine._blind;
  const heroH = Math.round(windowH * HERO_RATIO);
  const BAR_H = barHeight(insetTop);
  // Docked dots get their own compact second line, tucked just below the 44pt
  // title-row frame. The painted bar leaves another 12pt below.
  const BAR_DOT_DOCK = insetTop + BAR_ROW + BAR_DOT_TOP_PAD;

  // Collapse is MEASURED: flip solid when the on-photo name's bottom scrolls
  // under the bar (never a magic constant — the hero is proportional height).
  // atTop mirrors "scroll offset is at rest (≤ 1)" into state to flip
  // `bounces`: with the top rubber-band off, a pull-down at rest feeds the
  // dismiss pan instead of fighting it with a second motion (the bottom
  // overscroll keeps its bounce the moment the list scrolls).
  const nameBottom = useRef(0);
  const [atTop, setAtTop] = useState(true);
  // Deferred heavy body (see the deferBody prop): shell commits first, the
  // rating sections mount on the next frame while the flight runs.
  const [bodyReady, setBodyReady] = useState(!deferBody);
  useEffect(() => {
    if (bodyReady) return;
    const id = requestAnimationFrame(() => setBodyReady(true));
    return () => cancelAnimationFrame(id);
  }, [bodyReady]);
  // The dots' rest screen-Y minus scroll = their live screen-Y, clamped so
  // they never rise above the bar's bottom edge (there they've "converted into
  // the title bar"). Rest position:
  //   • photo → centered BETWEEN the measured identity bottom and the card
  //     edge (heroH), matching the approved mockup's midpoint rule.
  //   • photoless → just under the in-flow identity block.
  const hasHeroPhoto = !blind && !!wine.imageUrl;
  const dotRestY = useCallback(() => {
    if (!hasHeroPhoto) return nameBottom.current + space.sm;
    const identityBottom = nameBottom.current || heroH - HERO_IDENTITY_SEAM_GAP;
    return Math.round((identityBottom + heroH - DOT_SIZE) / 2);
  }, [hasHeroPhoto, heroH]);
  const writeDotTop = useCallback(
    (y: number) => {
      if (total <= 1 || !isActive) return;
      dotTop.value = Math.max(BAR_DOT_DOCK, dotRestY() - y);
    },
    [total, isActive, dotTop, dotRestY, BAR_DOT_DOCK],
  );
  // Seed / re-seed the dots when this page becomes active (or mounts) so a
  // swipe lands them at the right rest spot before the first scroll frame.
  useEffect(() => {
    if (isActive) writeDotTop(0);
  }, [isActive, writeDotTop]);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    onCollapse(y >= nameBottom.current - BAR_H);
    writeDotTop(y);
    // Same inequality as the pan's arm check (≤ 1) — a fractional iOS rest
    // offset must not leave bounce on while the dismiss arms.
    setAtTop((prev) => {
      const v = y <= 1;
      return prev === v ? prev : v;
    });
  };

  // ── Pull-down dismiss (proposal 09) ──────────────────────────────────────
  // Declaration order is load-bearing: every value a gesture worklet captures
  // must exist before the builder runs (the PillTabBar crash class).
  const scrollRef = useAnimatedRef<Reanimated.ScrollView>();
  const scrollY = useScrollOffset(scrollRef);
  // About-section content-Y (measured onLayout) + the imperative that scrolls
  // to it — driven by a wine-name tap (this page) or the collapsed-bar title
  // (parent, via the registered fn). Offset up by the bar so the heading
  // clears it.
  const aboutY = useRef(0);
  const bodyY = useRef(0); // the body View's content-space top (hero-dependent)
  const scrollToAbout = useCallback(() => {
    scrollRef.current?.scrollTo({ y: Math.max(0, aboutY.current - BAR_H - 8), animated: true });
  }, [scrollRef, BAR_H]);
  useEffect(() => {
    onRegisterScrollToAbout(scrollToAbout);
    return () => onRegisterScrollToAbout(null);
  }, [onRegisterScrollToAbout, scrollToAbout]);
  // A swiped-away page resets to the top (Simon, 2026-07-18): swiping back to
  // a mid-scrolled impression reads as stale state. Reset on the
  // active→inactive transition so the page already rests at the top when it
  // swipes back in. The three scroll-derived values (collapse flag, at-top
  // dismiss arm, the shared scrollY the pull-down gesture gates on) reset
  // explicitly — a programmatic scrollTo isn't guaranteed to emit onScroll,
  // and a partial reset would leave the pull-down dismiss dead on the
  // returned page until the first manual scroll.
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (wasActive.current && !isActive) {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      scrollY.value = 0;
      onCollapse(false);
      setAtTop(true);
    }
    wasActive.current = isActive;
  }, [isActive, onCollapse, scrollRef, scrollY]);
  // Armed = the touch went down while the page sat at the top. Without it, a
  // drag that starts mid-list and scrolls to 0 would jump-start a dismiss with
  // the accumulated translation.
  const dismissArmed = useSharedValue(false);
  const dismissInteractionsBlocked = useSharedValue(false);
  // One tick per gesture, fired the moment the drag CROSSES the commit
  // threshold ("release now and it closes") — Simon: the release-time haptic
  // came too late. Re-crossing back out re-arms silently; a fast flick that
  // commits from above the threshold gets the tick at release instead.
  const dismissBuzzed = useSharedValue(false);
  const nativeScroll = Gesture.Native();
  const dismissPan = Gesture.Pan()
    // Vertical pull-down only: an upward intent fails into the scroll, a
    // horizontal one fails into the pager. 8px pickup (was 12 — the dead zone
    // before the photo starts tracking is felt on every dismiss; the arm-at-
    // top + bounce-off guards already disambiguate from the scroll).
    .activeOffsetY(8)
    .failOffsetY(-8)
    .failOffsetX([-16, 16])
    .simultaneousWithExternalGesture(nativeScroll)
    .onBegin(() => {
      dismissArmed.value = scrollY.value <= 1;
      dismissBuzzed.value = false;
      dismissInteractionsBlocked.value = false;
    })
    .onUpdate((e) => {
      if (!dismissArmed.value || scrollY.value > 1) return;
      if (!dismissInteractionsBlocked.value) {
        dismissInteractionsBlocked.value = true;
        runOnJS(onDismissStart)();
      }
      dismissing.value = true; // settle bg follows progress from here (bgStyle)
      progress.value = 1 - Math.min(1, Math.max(0, e.translationY) / DISMISS_DRAG);
      const inCommitZone = progress.value < 0.6;
      if (inCommitZone && !dismissBuzzed.value) {
        dismissBuzzed.value = true;
        runOnJS(closeHaptic)();
      } else if (!inCommitZone && dismissBuzzed.value) {
        dismissBuzzed.value = false;
      }
    })
    .onEnd((e, success) => {
      // RNGH dispatches BOTH onEnd(success=false) and onFinalize(false) when
      // an ACTIVE gesture is cancelled/stolen. Leave that path entirely to
      // onFinalize so the two callbacks cannot start opposing springs.
      if (!success) return;
      if (!dismissArmed.value || progress.value >= 1) {
        // A pull can activate, block React-owned hit-testing, then travel back
        // above its origin before release. `progress` is already 1, so there
        // is no spring-back callback to re-arm the screen; restore explicitly.
        if (dismissInteractionsBlocked.value) {
          dismissInteractionsBlocked.value = false;
          dismissing.value = false;
          runOnJS(onDismissCancel)();
        }
        return;
      }
      const close = progress.value < 0.6 || (e.velocityY > 900 && progress.value < 0.98);
      // Release continues at finger speed: the spring inherits the gesture
      // velocity converted into progress units (see the CLOSE-legs comment at
      // the top of the file). DIRECTION-GATED to the leg's target: reanimated's
      // `overshootClamping` TERMINATES the spring the moment the value leaves
      // the [release-point, target] interval and snaps to the target
      // (springUtils.ts) — an away-pointing velocity (cancel while still
      // moving down, or an upward flick released under the 0.6 line) crosses
      // the release-point bound on the first frame and reads as a jump cut.
      const towardTarget = -e.velocityY / DISMISS_DRAG;
      const velocity = close ? Math.min(0, towardTarget) : Math.max(0, towardTarget);
      if (close) {
        closeCommitted.value = true;
        runOnJS(onDismissCommit)();
        if (!dismissBuzzed.value) runOnJS(closeHaptic)(); // flick-commit, never crossed
        progress.value = withSpring(0, { ...springs.release, velocity }, (finished) => {
          if (finished) runOnJS(onClosed)();
        });
      } else {
        progress.value = withSpring(1, { ...springs.release, velocity }, (finished) => {
          if (finished) {
            dismissing.value = false; // veil restored (see bgStyle)
            dismissInteractionsBlocked.value = false;
            runOnJS(onDismissCancel)();
          }
        });
      }
    })
    .onFinalize((_e, success) => {
      // RNGH calls this immediately after onEnd(success=false) when iOS
      // cancels/steals an ACTIVE touch. onEnd deliberately leaves that path
      // untouched; return the page to rest, then re-arm hit-testing.
      // Successful releases already chose their close/cancel path above.
      if (success || closeCommitted.value || !dismissInteractionsBlocked.value) return;
      progress.value = withSpring(1, springs.release, (finished) => {
        if (finished) {
          dismissing.value = false;
          dismissInteractionsBlocked.value = false;
          runOnJS(onDismissCancel)();
        }
      });
    });

  // The clone↔hero opacity handoff: while the parent's clone travels
  // (progress < 1) this page's real hero image yields the pixels; at
  // coincidence it takes over in the same frame the clone hides.
  const heroImgStyle = useAnimatedStyle(() => ({
    opacity: isClonePage && progress.value < 1 ? 0 : 1,
  }));

  // Identity is masked for a blind wine ("Wine N"); the subjective rating
  // (score + wheel + note) stays — same contract as the feed cards.
  const name = blind ? `Wine ${index + 1}` : wine.name;
  const hasScore = wine.score != null && wine.score > 0;
  const axes = buildWheelAxes(wine.flavors, wine.type, axisColor);
  const hasPhoto = hasHeroPhoto;
  // Report the bar title up AFTER commit (never call a parent setState during
  // render). Re-runs if the name changes.
  useEffect(() => {
    onTitle(name);
  }, [name, onTitle]);

  return (
    // Pan OUTSIDE the scroll's native gesture, declared simultaneous — the pan
    // reads scrollY to arm only at the top; useScrollOffset + the plain JS
    // onScroll coexist (the collapsing-hero pattern doc).
    <GestureDetector gesture={dismissPan}>
      <GestureDetector gesture={nativeScroll}>
        <Reanimated.ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          bounces={!atTop}
          contentContainerStyle={{ paddingBottom: bottomPad }}
        >
      {/* HERO — photo impressions keep the full-bleed photo under the status
          bar with the rounded body overlapping it (Simon: rounded overlap on
          photo only). Photoless/masked impressions are a CONTINUOUS page (02e
          structure): the identity flows in-body, no tinted stage, no overlap. */}
      {hasPhoto ? (
        <View
          style={{ height: heroH + radius.xl, overflow: 'hidden' }}
          onLayout={(e) => {
            // Name-bottom in content space matches HeroTitle's seam inset.
            nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height - HERO_IDENTITY_SEAM_GAP - radius.xl;
            if (isActive) writeDotTop(0); // seat the dots now the rest-Y is known
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open photo fullscreen"
            onPress={onOpenGallery}
            style={{ width: '100%', height: '100%' }}
          >
            {/* transparent while the parent's clone is mid-flight (handoff) */}
            <Reanimated.View style={[{ width: '100%', height: '100%' }, heroImgStyle]}>
              <Image source={{ uri: wine.imageUrl! }} style={{ width: '100%', height: '100%' }} contentFit="cover" alt={name} />
            </Reanimated.View>
          </Pressable>
          {/* Scrim + identity hide WITH the image: the clone travels BENEATH the
              content layer, and a statically-positioned scrim/title over a
              traveling photo reads as floating chrome. The clone carries the
              scrim crossfade; the parent's title overlay fades the identity in
              near settle. All hand off at coincidence. `box-none` so only the
              name Pressable inside HeroTitle catches taps (→ scroll to About);
              every other touch falls through to the photo's gallery Pressable.
              The gradient stays pointerEvents none. */}
          <Reanimated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, heroImgStyle]}>
            <LinearGradient pointerEvents="none" colors={HERO_SCRIM} style={StyleSheet.absoluteFill} />
            <HeroTitle wine={wine} index={index} onNamePress={scrollToAbout} />
          </Reanimated.View>
        </View>
      ) : null}

      {/* BODY — for a photo impression a rounded panel overlapping the hero;
          for a photoless one a continuous page (flat, no overlap, no radius).
          Its content-space top feeds the About scroll-target math. */}
      <View
        onLayout={(e) => (bodyY.current = e.nativeEvent.layout.y)}
        style={
          hasPhoto
            ? {
                marginTop: -radius.xl,
                backgroundColor: theme.bg,
                borderTopLeftRadius: radius.xl,
                borderTopRightRadius: radius.xl,
                paddingHorizontal: GUTTER,
                paddingTop: space.lg,
              }
            : { backgroundColor: theme.bg, paddingHorizontal: GUTTER, paddingTop: insetTop + BAR_ROW + 12 }
        }
      >
        {/* Photoless impression identity in-flow. Attribution now lives in the
            IG-style caption below, just like the photo version. The body is
            the FIRST scroll child (no hero), so this block's body-relative y
            IS its content-space y — measured here for bar collapse. */}
        {!hasPhoto ? (
          <View
            style={{ marginBottom: space.md }}
            onLayout={(e) => {
              nameBottom.current = bodyY.current + e.nativeEvent.layout.y + e.nativeEvent.layout.height;
              if (isActive) writeDotTop(0);
            }}
          >
            {/* name taps → scroll to About (only when there's an About, i.e.
                non-blind) */}
            <Pressable onPress={blind ? undefined : scrollToAbout} disabled={blind} accessibilityRole={blind ? undefined : 'button'}>
              <VText numberOfLines={1} style={[styles.heroName, { color: theme.ink }]}>
                {name}
                {!blind && wine.vintage ? (
                  <VText color="inkSoft" style={styles.heroVintageDark}>{` - ${wine.vintage}`}</VText>
                ) : null}
              </VText>
            </Pressable>
            {blind ? (
              <VText variant="small" color="inkSoft" style={{ marginTop: 2 }}>
                Hidden until the host reveals it
              </VText>
            ) : (wine.producer || wine.type) ? (
              <VText numberOfLines={1} variant="small" color="inkSoft" style={{ marginTop: 2 }}>
                {[wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ')}
              </VText>
            ) : null}
          </View>
        ) : null}

        {/* Photoless dots rest below the in-flow identity and need explicit
            clearance. Photo dots live wholly above the card seam, so adding
            this spacer there only pushes the score unnecessarily far down. */}
        {total > 1 && !hasPhoto ? <View style={{ height: space.md }} /> : null}

        {/* Everything below is the DEFERRED body — the wheel SVG is the mount
            cost the shell-first commit keeps off the tap path. IG-caption
            order: enlarged score · avatar-led author/note · divider · wheel
            (centered) · aromas (centered) · About. */}
        {bodyReady ? (
          <>
        {/* Enlarged score + word — the IG-caption version's lead. */}
        {hasScore ? (
          <View style={styles.captionScore}>
            <StarScore value={wine.score!} size={27} />
            <VText variant="body" color="inkSoft" style={{ marginLeft: 9 }}>
              {scoreWord(wine.score!)}
            </VText>
          </View>
        ) : null}

        {/* Attribution never disappears: without a note this still renders the
            avatar, author, place, and time. Long notes wrap under the avatar. */}
        <CaptionByline
          author={author}
          note={wine.notes}
          place={place}
          createdAt={createdAt}
          onPlacePress={onPlacePress}
        />

        {/* divider before the structure/aroma profile */}
        {axes.length > 0 || wine.aromas?.length ? (
          <View style={[styles.ratingRule, { borderTopColor: theme.rule }]} />
        ) : null}

        {/* centered structure wheel (no heading). Sized to 232 to MATCH the
            Compare wheel — a bigger wheel makes the fixed 14px label gap read
            proportionally tighter (Simon's insight, 2026-07-13), no shared
            LABEL_OFFSET change. maxWidth scales it down on narrow phones. */}
        {axes.length > 0 ? (
          <View style={styles.wheelWrap}>
            <StructureWheel axes={axes} size={232} labels maxWidth={screenW - GUTTER * 2} />
          </View>
        ) : null}

        {/* centered aroma badges (no heading). Read-only, two-line overflow +
            sheet via AromaReadChips collapse; shown for blind too (aromas are
            the taster's own perception, never wine identity, §7). */}
        {wine.aromas?.length ? (
          <View style={{ marginTop: axes.length > 0 ? space.md : 0, alignItems: 'center' }}>
            <AromaReadChips aromas={wine.aromas} collapse />
          </View>
        ) : null}

        {/* About this impression — identity metadata; hidden entirely for blind
            (it's all identity) and when the wine carries none. Its content-Y
            (bodyY + this block's body-relative y) drives the name-tap scroll. */}
        {!blind ? (
          <View onLayout={(e) => (aboutY.current = bodyY.current + e.nativeEvent.layout.y)}>
            <AboutBlock wine={wine} />
          </View>
        ) : null}
          </>
        ) : null}
          </View>
        </Reanimated.ScrollView>
      </GestureDetector>
    </GestureDetector>
  );
}

// About this impression — the repeated wine identity (name/vintage + producer)
// then its description + metadata rows (Origin · Variety · Process) +
// "Where to buy". Renders the identity always (the block is the wine's own
// record); the metadata rows/description drop when the wine carries none.
// Only rendered for non-blind impressions (identity is real). Read-only.
function AboutBlock({ wine }: { wine: SessionFeedWine }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const country = wine.country ? countryName(wine.country) || wine.country : '';
  const origin = [wine.region, country].filter(Boolean).join(' · ');
  // Values render via ClampText (grape/vinification can be long) — same as 02e:
  // origin is a short join (plain), grape/vinification clamp to 2 lines.
  const rows: Array<[string, React.ReactNode]> = [];
  if (origin) rows.push(['Origin', <VText key="v" style={{ fontFamily: 'InstrumentSans_500Medium', ...phone.text('small') }}>{origin}</VText>]);
  if (wine.grape) rows.push(['Variety', <ClampText key="v" text={wine.grape} lines={2} medium />]);
  if (wine.vinification) rows.push(['Process', <ClampText key="v" text={wine.vinification} lines={2} medium />]);
  const producerLine = [wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ');
  return (
    // Separator rule ABOVE the section (Simon's fixes round) — a full-width
    // hairline between the rating profile and About.
    <View style={[styles.about, { borderTopColor: theme.rule }]}>
      <VText variant="label" color="inkSoft" style={styles.sectionLabel}>
        About this impression
      </VText>
      {/* repeated identity: name/vintage + producer/style (heading-scale, for
          parity with 02e's `phone.text('title')`/small) */}
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('heading') }}>
        {wine.name}
        {wine.vintage ? <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('heading') }}>{` - ${wine.vintage}`}</VText> : null}
      </VText>
      {producerLine ? (
        <VText color="inkSoft" style={{ marginTop: 3, ...phone.text('small') }}>
          {producerLine}
        </VText>
      ) : null}
      {/* description follows the identity — clamped to 3 lines w/ more/less */}
      {wine.description ? (
        <View style={{ marginTop: 12 }}>
          <ClampText text={wine.description} lines={3} />
        </View>
      ) : null}
      {/* then the metadata rows */}
      {rows.map(([label, value], i) => {
        // Last row drops its divider when nothing (the buy link) follows it.
        const lastRow = !wine.purchaseUrl && i === rows.length - 1;
        return (
          <View key={label} style={[styles.aboutRow, i === 0 && rows.length ? { marginTop: 4 } : null, { borderBottomColor: theme.ruleSoft, borderBottomWidth: lastRow ? 0 : 1 }]}>
            <VText color="inkSoft" style={[styles.aboutKey, phone.text('small')]}>
              {label}
            </VText>
            <View style={{ flex: 1 }}>{value}</View>
          </View>
        );
      })}
      {wine.purchaseUrl ? (
        <Pressable
          onPress={() => WebBrowser.openBrowserAsync(wine.purchaseUrl!).catch(() => {})}
          style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Icon name="link" size={15} color={theme.accent} />
          <VText color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>
            Where to buy
          </VText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 44pt frame (negative margins keep the painted bar at the 36pt row) so the
  // back button's touch target isn't clipped short: RN clips hitSlop to the
  // PARENT's frame — a 44pt target needs a ≥44pt parent, not more slop
  // (apps/mobile CLAUDE.md gotcha).
  barRow: { height: 44, marginVertical: (BAR_ROW - 44) / 2, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barTitle: { fontFamily: 'InstrumentSans_600SemiBold' },
  clone: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  // Hero identity title: 26/600. Vintage trails in the muted weight; the dark
  // variant is for the photoless (ink-on-page) identity.
  heroName: { fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, lineHeight: 31 },
  heroVintage: { fontFamily: 'InstrumentSans_400Regular', fontSize: 26, lineHeight: 31 },
  heroVintageDark: { fontFamily: 'InstrumentSans_400Regular', fontSize: 26, lineHeight: 31 },
  heroSub: { fontFamily: 'InstrumentSans_400Regular', fontSize: 14, color: 'rgba(255,255,255,0.82)', marginTop: 2 },
  // Dot row — feed dims/spacing/colors (DotRow, the gliding parent overlay).
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5 },
  dot: { width: DOT_SIZE, height: DOT_SIZE, borderRadius: 999 },
  dotOn: { transform: [{ scale: 1.15 }] },
  captionScore: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  captionByline: { position: 'relative', width: '100%' },
  captionAvatar: { position: 'absolute', top: 1, left: 0 },
  captionLead: { marginLeft: 48, minHeight: 38 },
  captionText: { fontFamily: 'InstrumentSans_400Regular' },
  captionAuthor: { fontFamily: 'InstrumentSans_600SemiBold' },
  captionMeta: { marginTop: 3 },
  captionMetaLink: { fontFamily: 'InstrumentSans_600SemiBold' },
  captionMeasure: { position: 'absolute', left: 48, right: 0, opacity: 0 },
  wheelWrap: { alignItems: 'center', marginTop: space.xs },
  // Divider between the note and the structure/aroma profile.
  ratingRule: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1 },
  // About block — SEPARATOR above (full-width hairline), then padding.
  about: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1 },
  // Section-title label (About block).
  sectionLabel: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 },
  aboutRow: { flexDirection: 'row', gap: 14, paddingVertical: 9 },
  aboutKey: { width: 78 },
});
