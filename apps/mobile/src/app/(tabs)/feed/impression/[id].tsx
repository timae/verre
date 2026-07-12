import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
  useAnimatedProps,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { FeedGlassPanel } from '@/components/feed/FeedGlassPanel';
import { FullscreenGallery, type GalleryPage } from '@/components/feed/FullscreenGallery';
import { StarScore } from '@/components/scoring/StarScore';
import { StructureWheel } from '@/components/scoring/StructureWheel';
import { AromaReadChips } from '@/components/scoring/aroma/AromaReadChips';
import { TastesLike } from '@/components/feed/TastesLike';
import { buildWheelAxes, topFlavours } from '@/lib/flavourAxes';
import { Avatar } from '@/components/ui/Avatar';
import { feedQueryOptions, findFeedItem, detailFromItem, type FeedAuthor, type FeedItem, type SessionFeedWine } from '@/lib/api/feed';
import * as Haptics from 'expo-haptics';
import { consumeFeedTransitionSource, requestFeedLanding } from '@/lib/feedTransition';
import { useEnterableMoment } from '@/lib/useEnterableMoment';
import { FEED_PANEL_SCRIM, FOOT_CLEARANCE_IR, GLASS_FILL, GUTTER, HERO_RATIO, HERO_SCRIM } from '@/lib/layout';
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
// ACTIVE page. Dots live IN-CONTENT under each hero (Simon), so there's no
// "where do dots go when collapsed" problem — they just scroll away.
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

// The bar's true painted height = safe inset + the 36px row + paddings.
const BAR_ROW = 36;
function barHeight(insetTop: number) {
  return insetTop + BAR_ROW + 4;
}

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
  // Clamp seam for the pager index: `index` arrives via route params (a deep
  // link can carry garbage) and onPagerScroll can round past the end on an
  // overscroll bounce — both clamp against the real page count.
  const maxPage = detail ? Math.max(0, detail.wines.length - 1) : 0;

  const [active, setActive] = useState(startIndex);
  // Per-page collapse state, indexed by page. The bar reads active's flag.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [titles, setTitles] = useState<Record<number, string>>({});

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
  // Whether the presentation is running BACKWARD (pull-down moving, or a
  // back-button/Android-back close) — flips the settle background from the
  // instant open veil to the progressive dismiss reveal (see bgStyle). Reset
  // on a spring-back so a cancelled pull restores the veil.
  const dismissing = useSharedValue(false);
  // Mount-cost gate ("opens too slow", Simon round 3): during the presentation
  // only the ENTRY page mounts — the siblings render as empty slot views so
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
  useEffect(() => {
    if (source) {
      progress.value = withSpring(1, springs.enter, (finished) => {
        if (finished) runOnJS(bumpWarm)(1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Belt for an interrupted open (the spring callback fires finished=false
    // and would leave the siblings unmounted forever).
    if (warmLevel === 0) {
      const t = setTimeout(() => bumpWarm(1), OPEN_SETTLE_MS + 120);
      return () => clearTimeout(t);
    }
    // Remaining pages mount on JS idle — requestIdleCallback, NOT the
    // deprecated InteractionManager; the timeout floor guarantees a busy
    // thread still warms within a beat.
    if (warmLevel === 1) {
      const id = requestIdleCallback(() => bumpWarm(2), { timeout: 800 });
      return () => cancelIdleCallback(id);
    }
  }, [warmLevel, bumpWarm]);

  // The clone always shows the ACTIVE page's photo: the entry page on open,
  // whatever page you're on at pull-down. A photoless active page (blind /
  // NonPhotoHero) has no clone → the dismiss is the plain fade.
  const clampedActive = detail ? Math.min(active, maxPage) : 0;
  const activeWine = detail ? detail.wines[clampedActive] : null;
  const activeUri = activeWine && !activeWine._blind && activeWine.imageUrl ? activeWine.imageUrl : null;
  const hasClone = !!(sourceFrame && activeUri);
  const heroCloneH = Math.round(windowH * HERO_RATIO) + radius.xl;
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
    dismissing.value = true; // bg follows progress on the way out (see bgStyle)
    // Plain self-write first: it cancels any running animation, so this spring
    // starts from rest. Without it a NEW spring ADDS the running one's velocity
    // (spring.ts onStart) — an Android back pressed during a spring-back would
    // inherit its upward velocity, cross the clamping bound and jump-cut to 0.
    progress.value = progress.value;
    progress.value = withSpring(0, springs.release, (finished) => {
      if (finished) runOnJS(closeDetail)();
    });
  }, [source, progress, dismissing, closeDetail]);
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
  // Counter-scale for the clone's image: the outer axis scales are non-uniform
  // (card frame aspect ≠ hero aspect), which would DISTORT the photo — the old
  // layout animation avoided that by re-cover-cropping every frame. The inner
  // wrapper scales by max(sx,sy)/sx|sy, so the image's net scale is UNIFORM
  // (no distortion) and ≥ the box on both axes (still covers; outer
  // overflow:hidden crops) — a continuous, transform-only "cover".
  const cloneImgStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!sourceFrame) return { transform: [{ scale: 1 }] };
    const sx = interpolate(p, [0, 1], [sourceFrame.width, screenW]) / screenW;
    const sy = interpolate(p, [0, 1], [sourceFrame.height, heroCloneH]) / heroCloneH;
    const q = Math.max(sx, sy);
    return { transform: [{ scaleX: q / sx }, { scaleY: q / sy }] };
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
  // NEW touches only land while fully open: a tap during the close animation
  // (invisible but otherwise hit-testable content) could push a route and make
  // the deferred back() pop THAT instead — an invisible ghost modal over the
  // feed. Hit-testing happens at touch-down, so an in-flight dismiss pan is
  // unaffected when this flips mid-gesture.
  const contentPointerProps = useAnimatedProps(() => ({
    pointerEvents: (progress.value < 1 ? 'none' : 'auto') as 'none' | 'auto',
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
  // rect, NOT a child of the animating clone: the clone animates layout props
  // (left/top/width/height), and text inside it re-shapes on every frame — a
  // measurable stutter source (round 3c). It only shows past 0.7, when the
  // clone sits within a few px of the final rect, so the fixed anchor reads
  // as the title gliding in with the settle; at coincidence it yields to the
  // page's identical real block.
  const cloneTitleStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return { opacity: p < 1 ? interpolate(p, [0.7, 1], [0, 1], Extrapolation.CLAMP) : 0 };
  });
  // The bar rides its own layer ABOVE the clone (chrome over the traveling
  // photo, no rise — see the layer comments in the render). Same tap gate;
  // 'box-none' so the wrapper never swallows touches meant for the pages.
  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 0.8], [0, 1], Extrapolation.CLAMP),
  }));
  const barPointerProps = useAnimatedProps(() => ({
    pointerEvents: (progress.value < 1 ? 'none' : 'box-none') as 'none' | 'box-none',
  }));

  const onPagerScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.max(0, Math.min(maxPage, Math.round(e.nativeEvent.contentOffset.x / screenW)));
      landCard(i);
      setActive((cur) => (cur === i ? cur : i));
    },
    [screenW, maxPage, landCard],
  );

  const reportCollapse = useCallback((page: number, c: boolean) => {
    setCollapsed((prev) => (prev[page] === c ? prev : { ...prev, [page]: c }));
  }, []);
  const reportTitle = useCallback((page: number, t: string) => {
    setTitles((prev) => (prev[page] === t ? prev : { ...prev, [page]: t }));
  }, []);

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

  const { wines, author, createdAt, verb, place, momentName, sessionId } = detail;
  const total = wines.length;
  // Read-side clamp: `active` seeds from the raw route param before wines are
  // known, so index the per-page maps through the clamped value.
  const page = clampedActive;
  const barSolid = !!collapsed[page];
  // Only photo-bearing impressions go fullscreen (a blind/photoless page has
  // nothing to show); wineIndex maps a gallery page back to its pager slot.
  const galleryPages: GalleryPage[] = wines
    .map((w, i) => ({ uri: !w._blind && w.imageUrl ? w.imageUrl : null, wine: w, wineIndex: i }))
    .filter((p): p is GalleryPage => p.uri !== null);

  return (
    // Transparent root — the feed shows through while the presentation runs.
    // The settle bg below fades to opaque with progress.
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
          <Reanimated.View style={[{ width: '100%', height: '100%' }, cloneImgStyle]}>
            <Image source={{ uri: activeUri! }} style={{ width: '100%', height: '100%' }} contentFit="cover" alt="" />
          </Reanimated.View>
          <Reanimated.View style={[StyleSheet.absoluteFill, cardScrimStyle]}>
            <LinearGradient colors={FEED_PANEL_SCRIM} style={StyleSheet.absoluteFill} />
          </Reanimated.View>
          <Reanimated.View style={[StyleSheet.absoluteFill, heroScrimStyle]}>
            <LinearGradient colors={HERO_SCRIM} style={StyleSheet.absoluteFill} />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}

      <Reanimated.View style={[{ flex: 1 }, contentStyle]} animatedProps={contentPointerProps}>
        {total === 1 ? (
          <DetailPage
            wine={wines[0]}
            index={0}
            total={1}
            author={author}
            createdAt={createdAt}
            verb={verb}
            place={place}
            momentName={momentName}
            sessionId={sessionId}
            onCollapse={(c) => reportCollapse(0, c)}
            onTitle={(t) => reportTitle(0, t)}
            insetTop={insets.top}
            bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
            progress={progress}
            dismissing={dismissing}
            isClonePage={hasClone}
            onClosed={closeDetail}
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
                    verb={verb}
                    place={place}
                    momentName={momentName}
                    sessionId={sessionId}
                    onCollapse={(c) => reportCollapse(i, c)}
                    onTitle={(t) => reportTitle(i, t)}
                    insetTop={insets.top}
                    bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
                    progress={progress}
                    dismissing={dismissing}
                    isClonePage={hasClone && i === page}
                    onClosed={closeDetail}
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
          <HeroTitle wine={activeWine!} index={clampedActive} total={detail.wines.length} />
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
          with the body (it's chrome, not content). */}
      <Reanimated.View style={[StyleSheet.absoluteFill, barStyle]} animatedProps={barPointerProps}>
        <FloatBar
          solid={barSolid}
          title={barSolid ? titles[page] ?? '' : ''}
          onBack={requestClose}
          insetTop={insets.top}
        />
      </Reanimated.View>

      {/* fullscreen gallery — a Modal, so its place in this tree is chrome-
          independent. Closing lands the pager on the viewed impression. */}
      <FullscreenGallery
        pages={galleryPages}
        startWineIndex={galleryAt ?? 0}
        visible={galleryAt != null}
        onClose={landPager}
      />
    </View>
  );
}

// The on-photo name block at the hero's bottom-left. Shared between the
// DetailPage hero and the parent's traveling CLONE (which occludes the page's
// copy mid-flight — the clone fades this in over the final settle so the
// title glides instead of popping at coincidence). Positioning matches at
// rest by construction: both containers end at the same hero frame.
function HeroTitle({ wine, index, total }: { wine: SessionFeedWine; index: number; total: number }) {
  const blind = !!wine._blind;
  const name = blind ? `Wine ${index + 1}` : wine.name;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: 16 + radius.xl }}>
      {total > 1 ? (
        <VText variant="label" style={styles.heroPos}>
          {`#${index + 1} of ${total}`}
        </VText>
      ) : null}
      <VText style={[styles.heroName, { color: '#fff' }]}>
        {name}
        {!blind && wine.vintage ? (
          <VText style={[styles.heroVintage, { color: 'rgba(255,255,255,0.7)' }]}>{` - ${wine.vintage}`}</VText>
        ) : null}
      </VText>
      {!blind && (wine.producer || wine.type) ? (
        <VText style={styles.heroSub}>
          {[wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ')}
        </VText>
      ) : null}
    </View>
  );
}

// The floating→solid bar. Transparent + glass back button over the hero; solid
// bg + ink title once collapsed. Overlaid, absolute at top. (A lean read-only
// bar — 02e's IrBar carries crave/menu/reveal we don't want here.)
function FloatBar({
  solid,
  title,
  onBack,
  insetTop,
  pending,
}: {
  solid: boolean;
  title: string;
  onBack: () => void;
  insetTop: number;
  pending?: boolean;
}) {
  const { theme } = useTheme();
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
        paddingBottom: 4,
        // Opaque when collapsed, transparent over the photo (ADR-0003).
        backgroundColor: solid ? theme.bg : 'transparent',
      }}
    >
      <View style={styles.barRow}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={[styles.backBtn, solid ? null : { backgroundColor: GLASS_FILL }]}
        >
          <Icon name="back" size={20} color={solid ? theme.ink : '#fff'} />
        </Pressable>
        {solid && !pending ? (
          <VText variant="subhead" numberOfLines={1} style={[styles.barTitle, { color: theme.ink }]}>
            {title}
          </VText>
        ) : null}
      </View>
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
  verb,
  place,
  momentName,
  sessionId,
  onCollapse,
  onTitle,
  insetTop,
  bottomPad,
  progress,
  dismissing,
  isClonePage,
  onClosed,
  onOpenGallery,
  deferBody,
}: {
  wine: SessionFeedWine;
  index: number;
  total: number;
  author: FeedAuthor;
  createdAt: string;
  verb: string;
  place: string | null;
  momentName: string | null;
  sessionId: number | null;
  onCollapse: (collapsed: boolean) => void;
  onTitle: (title: string) => void;
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
  // Pop the route (called after the dismiss animation lands at 0).
  onClosed: () => void;
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
  const { code: momentCode, enter: enterMoment } = useEnterableMoment(sessionId);
  const blind = !!wine._blind;
  const heroH = Math.round(windowH * HERO_RATIO);
  const BAR_H = barHeight(insetTop);

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
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    onCollapse(y >= nameBottom.current - BAR_H);
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
  // Armed = the touch went down while the page sat at the top. Without it, a
  // drag that starts mid-list and scrolls to 0 would jump-start a dismiss with
  // the accumulated translation.
  const dismissArmed = useSharedValue(false);
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
    })
    .onUpdate((e) => {
      if (!dismissArmed.value || scrollY.value > 1) return;
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
    .onEnd((e) => {
      if (!dismissArmed.value || progress.value >= 1) return;
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
        if (!dismissBuzzed.value) runOnJS(closeHaptic)(); // flick-commit, never crossed
        progress.value = withSpring(0, { ...springs.release, velocity }, (finished) => {
          if (finished) runOnJS(onClosed)();
        });
      } else {
        progress.value = withSpring(1, { ...springs.release, velocity }, (finished) => {
          if (finished) dismissing.value = false; // veil restored (see bgStyle)
        });
      }
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
  const tastes = topFlavours(wine.flavors, wine.type, axisColor);
  const hasPhoto = !blind && !!wine.imageUrl;
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
      {/* HERO — full-bleed photo under the status bar (or a masked/no-photo name
          block). The photo runs radius.xl past the seam so the rounded body
          panel below overlaps it. */}
      {hasPhoto ? (
        <View
          style={{ height: heroH + radius.xl, overflow: 'hidden' }}
          onLayout={(e) =>
            // name-bottom in content space ≈ hero bottom minus the caption inset.
            (nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height - 16 - radius.xl)
          }
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
          {/* Scrim + title hide WITH the image: the clone travels BENEATH the
              content layer, and a statically-positioned scrim/title over a
              traveling photo reads as floating chrome. The clone carries the
              scrim crossfade; the parent's title overlay fades the name in
              near settle. All hand off at coincidence. */}
          <Reanimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, heroImgStyle]}>
            <LinearGradient colors={HERO_SCRIM} style={StyleSheet.absoluteFill} />
            <HeroTitle wine={wine} index={index} total={total} />
          </Reanimated.View>
        </View>
      ) : (
        // No-photo / masked hero: a dark name block that clears the status bar
        // (no photo to run under it). Same measured collapse.
        <View
          style={{ backgroundColor: theme.surfaceSunk, paddingTop: insetTop + BAR_ROW + 16, paddingHorizontal: GUTTER, paddingBottom: 20 + radius.xl }}
          onLayout={(e) => (nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height - radius.xl)}
        >
          {total > 1 ? (
            <VText variant="label" color="inkSoft" style={styles.heroPosDark}>
              {`#${index + 1} of ${total}`}
            </VText>
          ) : null}
          <VText style={[styles.heroName, { color: theme.ink }]}>{name}</VText>
          {blind ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 4 }}>
              Hidden until the host reveals it
            </VText>
          ) : (wine.producer || wine.type) ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 4 }}>
              {[wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ')}
            </VText>
          ) : null}
        </View>
      )}

      {/* BODY — rounded panel overlapping the hero, carrying the rating. */}
      <View
        style={{
          marginTop: -radius.xl,
          backgroundColor: theme.bg,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          paddingHorizontal: GUTTER,
          paddingTop: space.lg,
        }}
      >
        {/* dots — IN-CONTENT under the hero (Simon), so no collapse question. */}
        {total > 1 ? (
          <View style={styles.dots}>
            {Array.from({ length: total }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { backgroundColor: i === index ? theme.accent : theme.inkFaint },
                  i === index && styles.dotOn,
                ]}
              />
            ))}
          </View>
        ) : null}

        {/* full header — avatar · name + verb · place · time (mirrors the feed
            card's header, in-content below the dots so the hero stays full-bleed;
            Simon). The moment name (the "place" of a session) is TAPPABLE when the
            viewer was a member (momentCode from their own sessions). */}
        <View style={styles.header}>
          <Avatar imageUrl={author.imageUrl} name={author.name} size={38} />
          <View style={styles.headerWho}>
            <VText variant="body" numberOfLines={1}>
              <VText variant="body" style={styles.attribName}>
                {author.name}
              </VText>
              <VText variant="body" color="inkSoft">
                {` ${verb}`}
              </VText>
            </VText>
            <VText variant="caption" color="inkSoft" numberOfLines={1}>
              {/* place: for a session it's the (tappable) moment name; for a
                  standalone it's the venue. Time always trails. */}
              {place && momentName && momentCode ? (
                <VText variant="caption" color="accent" style={styles.attribName} onPress={enterMoment}>
                  {place}
                </VText>
              ) : place ? (
                place
              ) : null}
              {place ? ' · ' : ''}
              {timeAgo(createdAt)}
            </VText>
          </View>
        </View>

        {/* Everything below the header is the DEFERRED body — the wheel SVG is
            the mount cost the shell-first commit keeps off the tap path. */}
        {bodyReady ? (
          <>
        {/* score + word */}
        {hasScore ? (
          <View style={styles.scoreRow}>
            <StarScore value={wine.score!} size={22} />
            <VText variant="body" color="inkSoft" style={{ marginLeft: 10 }}>
              {scoreWord(wine.score!)}
            </VText>
          </View>
        ) : null}

        {/* big labelled wheel */}
        {axes.length > 0 ? (
          <View style={styles.wheelWrap}>
            <StructureWheel axes={axes} size={182} labels maxWidth={screenW - GUTTER * 2} />
          </View>
        ) : null}

        {/* "Tastes like" chips */}
        {tastes.length > 0 ? (
          <View style={{ marginTop: space.sm }}>
            <TastesLike flavours={tastes} chipBg="surfaceSunk" />
          </View>
        ) : null}

        {/* Aroma descriptor chips — the author's selections, read-only
            (grouped display via AromaReadChips). Shown for blind too: aromas
            are the taster's own perception, never wine identity (§7). */}
        {wine.aromas?.length ? (
          <View style={{ marginTop: space.sm }}>
            <AromaReadChips aromas={wine.aromas} lead="Aromas" />
          </View>
        ) : null}

        {/* taste note */}
        {wine.notes ? (
          <VText variant="body" color="ink" style={styles.note}>
            {wine.notes}
          </VText>
        ) : null}

        {/* About this impression — identity metadata; hidden entirely for blind
            (it's all identity) and when the wine carries none. */}
        {!blind ? <AboutBlock wine={wine} /> : null}
          </>
        ) : null}
          </View>
        </Reanimated.ScrollView>
      </GestureDetector>
    </GestureDetector>
  );
}

// About this impression — Origin · Variety · Process rows + description +
// "Where to buy". Renders only what the wine carries; the block drops when
// there's no metadata (e.g. a standalone check-in with only country/grape shows
// just those rows). Mirrors 02e's AboutBlock, read-only.
function AboutBlock({ wine }: { wine: SessionFeedWine }) {
  const { theme } = useTheme();
  const country = wine.country ? countryName(wine.country) || wine.country : '';
  const origin = [wine.region, country].filter(Boolean).join(' · ');
  const rows: Array<[string, string]> = [];
  if (origin) rows.push(['Origin', origin]);
  if (wine.grape) rows.push(['Variety', wine.grape]);
  if (wine.vinification) rows.push(['Process', wine.vinification]);
  const hasTrailer = !!wine.description || !!wine.purchaseUrl;
  if (rows.length === 0 && !hasTrailer) return null;
  return (
    <View style={styles.about}>
      <VText variant="label" color="inkSoft" style={styles.aboutLabel}>
        About this impression
      </VText>
      {rows.map(([label, value], i) => {
        const lastRow = !hasTrailer && i === rows.length - 1;
        return (
          <View key={label} style={[styles.aboutRow, { borderBottomColor: theme.ruleSoft, borderBottomWidth: lastRow ? 0 : 1 }]}>
            <VText variant="small" color="inkSoft" style={styles.aboutKey}>
              {label}
            </VText>
            <VText variant="small" color="ink" style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium' }}>
              {value}
            </VText>
          </View>
        );
      })}
      {wine.description ? (
        <VText variant="small" color="inkSoft" style={{ marginTop: rows.length ? 12 : 0 }}>
          {wine.description}
        </VText>
      ) : null}
      {wine.purchaseUrl ? (
        <Pressable
          onPress={() => WebBrowser.openBrowserAsync(wine.purchaseUrl!).catch(() => {})}
          style={{ marginTop: 12 }}
        >
          <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
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
  barRow: { height: 44, marginVertical: (BAR_ROW - 44) / 2, flexDirection: 'row', alignItems: 'center', gap: 10 },
  backBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  barTitle: { flex: 1, fontFamily: 'InstrumentSans_600SemiBold' },
  clone: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  heroPos: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)' },
  heroPosDark: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase' },
  heroName: { fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, lineHeight: 31, marginTop: 4 },
  heroVintage: { fontFamily: 'InstrumentSans_400Regular', fontSize: 26, lineHeight: 31 },
  heroSub: { fontFamily: 'InstrumentSans_400Regular', fontSize: 14, color: 'rgba(255,255,255,0.82)', marginTop: 2 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, paddingBottom: space.md },
  dot: { width: 6, height: 6, borderRadius: 999 },
  dotOn: { transform: [{ scale: 1.15 }] },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.md },
  headerWho: { flex: 1, minWidth: 0 },
  attribName: { fontFamily: 'InstrumentSans_600SemiBold' },
  scoreRow: { flexDirection: 'row', alignItems: 'center', marginBottom: space.md },
  wheelWrap: { alignItems: 'center', marginTop: space.xs },
  note: { marginTop: space.lg, lineHeight: 22 },
  about: { marginTop: space.lg },
  aboutLabel: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 },
  aboutRow: { flexDirection: 'row', gap: 14, paddingVertical: 9 },
  aboutKey: { width: 78 },
});
