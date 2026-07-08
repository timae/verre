import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { FeedGlassPanel } from '@/components/feed/FeedGlassPanel';
import { NonPhotoHero } from '@/components/feed/NonPhotoHero';
import { topFlavours } from '@/lib/flavourAxes';
import { frameAspectFor, rawAspect } from '@/lib/feedAspect';
import { FEED_PANEL_SCRIM, GUTTER } from '@/lib/layout';
import { setFeedTransitionSource } from '@/lib/feedTransition';
import { timeAgo } from '@/lib/momentFormat';
import { useEnterableMoment } from '@/lib/useEnterableMoment';
import { useFlavourColors } from '@/theme/flavourColors';
import { space, useTheme } from '@/theme';
import type { FeedAuthor, SessionFeedPayload, SessionFeedWine } from '@/lib/api/feed';

// The 03·12 "linked · glass" session card (proposal 08 §2). Pixel-spec off
// .local/design/vero-feed.js `sessG` + vero-feed.css `.fp8*` / `.fpg*` /
// `.fp2-panel`. Anatomy: header · edge-to-edge 4:5 photo carousel with a
// glass panel riding it (switches per photo) · dot strip · action row ·
// likes line · caption. Deviations from the mock (Simon 2026-07-06): no
// fullscreen-from-feed (photo single-tap is inert; DOUBLE-tap likes); the
// glass panel opens the full impression PAGE, not a bottom sheet.

const AnimatedView = Animated.createAnimatedComponent(View);

export function SessionFeedCard({
  author,
  session,
  createdAt,
  onOpenImpression,
  onToggleLike,
}: {
  author: FeedAuthor;
  session: SessionFeedPayload;
  // The feed item's post time (lives on the FeedItem wrapper, not the payload).
  createdAt: string;
  // Open the full impression detail page for wine at `index` (glass-panel tap).
  onOpenImpression: (index: number) => void;
  // Optimistic like toggle — parent owns the cache write + server call.
  onToggleLike: (nextLiked: boolean) => void;
}) {
  const { theme } = useTheme();
  const axisColor = useFlavourColors();
  const { width: screenW } = useWindowDimensions();
  const photoW = screenW; // full-bleed at x=0
  // The moment name is tappable → open the moment, but ONLY if the viewer was a
  // member (code resolved from their own sessions; never on the feed wire).
  const { code: momentCode, enter: enterMoment } = useEnterableMoment(session.sessionId);

  const [activeIdx, setActiveIdx] = useState(0);
  const wines = session.wines;
  // Shared-element source (proposal 09): opening an impression measures the
  // photo carousel's window frame and hands it to the detail, whose hero clone
  // grows out of it. A slide with no real photo (blind/placeholder) and the
  // all-photoless carousel have nothing to share → the fade presentation.
  const photoFrameRef = useRef<View>(null);
  const openImpression = useCallback(
    (i: number) => {
      const w = wines[i];
      const uri = !w?._blind && w?.imageUrl ? w.imageUrl : null;
      const node = photoFrameRef.current;
      if (!uri || !node) {
        setFeedTransitionSource({ kind: 'fade' });
        onOpenImpression(i);
        return;
      }
      node.measureInWindow((x, y, width, height) => {
        setFeedTransitionSource(
          width > 0 && height > 0 ? { kind: 'photo', x, y, width, height, uri } : { kind: 'fade' },
        );
        onOpenImpression(i);
      });
    },
    [wines, onOpenImpression],
  );
  // Does ANY impression in this moment have a real photo? A blind wine's photo
  // is redacted (imageUrl null + _blind), so it doesn't count. If none do, the
  // photo carousel would be a strip of glyph placeholders (Simon: don't show
  // that) — we render a themed impression carousel instead (NonPhotoHero per
  // slide). When at least one has a photo, the photo carousel stays and its
  // photoless/blind slides keep the placeholder (a placeholder makes sense
  // alongside real photos; the artsy topic-doodle placeholder is a later pass).
  const anyPhoto = wines.some((w) => !w._blind && !!w.imageUrl);
  // For the all-photoless carousel: does ANY impression have a flavour wheel? If
  // so the slides reserve the tall square (the wheel needs it) and bare slides
  // bottom-align their panel within it. If NONE do (an all-bare moment — just
  // names+scores), the carousel collapses to the panel's own height instead of a
  // screen-tall square of empty space (the 22:44 device bug). A blind wine is
  // NOT special here — it draws its real flavors like any wine (identity is
  // masked in the panel), so the plain flavour check covers it.
  const anyWheel = !anyPhoto && wines.some((w) => topFlavours(w.flavors, w.type, axisColor).length > 0);
  const nonPhotoSlideH = anyWheel ? photoW : undefined;

  // Carousel frame rule (Simon): the TALLEST photo wins, clamped to the band;
  // every slide crop-fills the frame (contentFit cover — the contain/letterbox
  // path and its dev toggle were deleted, see lib/feedAspect.ts). Needs every
  // wine's intrinsic aspect — the payload lacks dims, so each slide measures ITS OWN
  // image via expo-image's onLoad (reliable — it reports the dims of the image
  // it already loaded; RNImage.getSize did a separate fetch that could fail
  // silently against MinIO, leaving every slide on the cover fallback) and
  // reports up into this uri→rawAspect map. Frame settles from the 4:5 default.
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const reportAspect = useCallback((uri: string, a: number) => {
    setAspects((prev) => (prev[uri] === a ? prev : { ...prev, [uri]: a }));
  }, []);
  const measured = wines
    .filter((w) => !w._blind && w.imageUrl)
    .map((w) => aspects[w.imageUrl as string])
    .filter(Boolean);
  const frameAspect = frameAspectFor(measured);
  const photoH = Math.round(photoW * frameAspect);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / photoW);
      setActiveIdx((cur) => (cur === i ? cur : Math.max(0, Math.min(wines.length - 1, i))));
    },
    [photoW, wines.length],
  );

  // Heart-burst: a scaled heart-fill flashes over the photo on a double-tap
  // like. Reanimated shared values so the animation runs on the UI thread.
  const burstScale = useSharedValue(0);
  const burstOpacity = useSharedValue(0);
  const burstStyle = useAnimatedStyle(() => ({
    opacity: burstOpacity.value,
    transform: [{ scale: burstScale.value }],
  }));
  const fireBurst = useCallback(() => {
    burstScale.value = withSequence(withTiming(1, { duration: 180 }), withTiming(1, { duration: 260 }));
    burstOpacity.value = withSequence(
      withTiming(1, { duration: 140 }),
      withTiming(0, { duration: 340 }),
    );
  }, [burstScale, burstOpacity]);

  const like = useCallback(() => {
    // Instagram semantics: double-tap LIKES (never unlikes). No-op if
    // already liked. Unliking is the explicit heart button only.
    if (!session.liked) {
      onToggleLike(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    fireBurst();
  }, [session.liked, onToggleLike, fireBurst]);

  // Double-tap on the photo. A single-tap is declared and left inert so the
  // double-tap doesn't wait-fail into a dismiss (there is no fullscreen from
  // the feed — proposal §2). The horizontal carousel pan wins over both taps
  // naturally (ScrollView owns the pan; taps only fire on a stationary touch).
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd((_e, ok) => {
      if (ok) runOnJS(like)();
    });

  return (
    <View style={{ marginBottom: space.lg }}>
      {/* header — avatar · "<name> shared a moment" · place · time · ⋯ */}
      <View style={[styles.head, { paddingHorizontal: GUTTER }]}>
        <Avatar imageUrl={author.imageUrl} name={author.name} size={38} />
        <View style={styles.who}>
          <VText variant="body" numberOfLines={1}>
            <VText variant="body" style={styles.bold}>
              {author.name}
            </VText>
            <VText variant="body" color="inkSoft">
              {' '}
              shared a moment
            </VText>
          </VText>
          <VText variant="caption" color="inkSoft" numberOfLines={1}>
            {session.deleted ? (
              '[deleted moment]'
            ) : session.sessionName ? (
              // Tappable when the viewer was a member (momentCode resolved).
              momentCode ? (
                <VText variant="caption" color="accent" style={styles.bold} onPress={enterMoment}>
                  {session.sessionName}
                </VText>
              ) : (
                session.sessionName
              )
            ) : null}
            {(session.deleted || session.sessionName) ? ' · ' : ''}
            {timeAgo(createdAt)}
          </VText>
        </View>
      </View>

      {anyPhoto ? (
        /* photo carousel. Full-bleed: the card content is NOT horizontally
           padded (each text block self-insets by GUTTER), so photos sit at x=0
           spanning the full screen width. The glass panel lives INSIDE each
           slide (Simon) so it travels with its photo instead of a static
           overlay that pops content on scroll-end. The CONTAINER carries the
           tint background so an overscroll pull (or a not-yet-loaded photo)
           reveals the tint, sitting FLAT — no shadow (Simon). */
        <View ref={photoFrameRef} style={{ width: photoW, height: photoH, backgroundColor: theme.surfaceSunk }}>
          <GestureDetector gesture={doubleTap}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onScroll={onScroll}
              scrollEventThrottle={16}
              style={StyleSheet.absoluteFill}
            >
              {wines.map((w, i) => (
                <WineSlide
                  key={w.id}
                  wine={w}
                  index={i}
                  width={photoW}
                  height={photoH}
                  axisColor={axisColor}
                  onMeasure={reportAspect}
                  onPressPanel={() => openImpression(i)}
                />
              ))}
            </ScrollView>
          </GestureDetector>

          {/* heart-burst overlay (centered, non-interactive) — stays static; it
              fires on the active slide, doesn't slide with the carousel. */}
          <AnimatedView pointerEvents="none" style={[styles.burst, burstStyle]}>
            <Icon name="heart-fill" size={96} color="#fff" />
          </AnimatedView>
        </View>
      ) : (
        /* all-photoless moment: no photo carousel (a strip of glyph
           placeholders is the thing Simon rejected). Instead a themed
           impression carousel — one NonPhotoHero per wine (has-flavour → a
           lighter card with the wheel; bare → just the darker panel), same
           swipe + dots. No backdrop tint (the hero matches the scene, Simon);
           no double-tap-like (no photo target); the heart button still likes. A
           blind wine renders like any other with identity masked in its panel
           (no mystery branch — see NonPhotoHero).
           Height: a screen-tall SQUARE only when some slide shows a wheel/blind
           (it needs the room; bare slides bottom-align their panel within it).
           When ALL slides are bare (just names+scores) the height is undefined
           → the ScrollView sizes to the panels' own height, so there's no
           screen-tall void (the 22:44 device bug). Auto-height paging is fine
           because all-bare slides are naturally the same height. */
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          style={nonPhotoSlideH != null ? { width: photoW, height: nonPhotoSlideH } : { width: photoW }}
        >
          {wines.map((w, i) => (
            <NonPhotoHero
              key={w.id}
              wine={w}
              index={i}
              axisColor={axisColor}
              width={photoW}
              height={nonPhotoSlideH}
              onOpen={() => openImpression(i)}
            />
          ))}
        </ScrollView>
      )}

      {/* dot strip */}
      {wines.length > 1 && (
        <View style={styles.dots}>
          {wines.map((w, i) => (
            <View
              key={w.id}
              style={[
                styles.dot,
                { backgroundColor: i === activeIdx ? theme.accent : theme.inkFaint },
                i === activeIdx && styles.dotOn,
              ]}
            />
          ))}
        </View>
      )}

      {/* action row — like (the ★ avg chip was removed entirely; Simon
          2026-07-08 — the author's own average isn't a useful card signal) */}
      <View style={[styles.acts, { paddingHorizontal: GUTTER }]}>
        <Pressable
          style={styles.actBtn}
          onPress={() => onToggleLike(!session.liked)}
          accessibilityRole="button"
          accessibilityLabel={session.liked ? 'Unlike' : 'Like'}
        >
          <Icon name={session.liked ? 'heart-fill' : 'heart'} size={21} color={session.liked ? theme.accent : theme.ink} />
        </Pressable>
      </View>

      {/* likes line */}
      <View style={{ paddingHorizontal: GUTTER }}>
        {session.likeCount > 0 && (
          <VText variant="small" style={styles.bold}>
            {session.likeCount} {session.likeCount === 1 ? 'like' : 'likes'}
          </VText>
        )}
      </View>
    </View>
  );
}

// One carousel slide: the photo + ITS OWN glass panel (so the panel travels
// with the photo, Simon) + an overscroll shadow. Blind/photoless wines fall
// back to the glass-glyph placeholder.
function WineSlide({
  wine,
  index,
  width,
  height,
  axisColor,
  onMeasure,
  onPressPanel,
}: {
  wine: SessionFeedWine;
  index: number;
  width: number;
  height: number;
  axisColor: (k: string) => string;
  // Report this photo's intrinsic aspect (h/w) up once loaded — the parent
  // computes the frame (tallest wins) from all slides' reports.
  onMeasure: (uri: string, aspect: number) => void;
  onPressPanel: () => void;
}) {
  const { theme } = useTheme();
  const uri = wine._blind ? null : wine.imageUrl;
  return (
    // surfaceSunk shows while the photo loads (cover-fill leaves no bars once
    // it has). (The overscroll shadow lives on the carousel CONTAINER, not
    // here — RN ScrollViews clip child shadows, so a per-slide shadow wouldn't
    // show.)
    <View style={{ width, height, backgroundColor: theme.surfaceSunk }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width, height }}
          // Crop-fill (Simon's chosen default; the bars alternative + its dev
          // toggle were removed). The frame is still the tallest photo's aspect
          // (clamped to the band), so the minority orientation crops.
          contentFit="cover"
          transition={120}
          alt={wine._blind ? 'Hidden wine' : wine.name || 'Wine photo'}
          onLoad={(e) => {
            const src = e.source;
            if (src?.width && src?.height) onMeasure(uri, rawAspect(src.width, src.height));
          }}
        />
      ) : (
        <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="glass" size={Math.round(width * 0.24)} color={theme.inkFaint} />
        </View>
      )}
      {/* bottom scrim so the glass panel + text keep contrast over any photo */}
      <LinearGradient
        colors={FEED_PANEL_SCRIM}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* glass panel — inside the slide, so it slides with the photo. Opens the
          full impression page on tap (anywhere on the panel). Shared with the
          standalone card (FeedGlassPanel). */}
      <FeedGlassPanel wine={wine} index={index} axisColor={axisColor} onPress={onPressPanel} />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  burst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, paddingVertical: space.xs },
  dot: { width: 6, height: 6, borderRadius: 999 },
  dotOn: { transform: [{ scale: 1.15 }] },
  acts: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingTop: space.xs, paddingBottom: space['3xs'] },
  actBtn: { paddingVertical: space['3xs'], paddingHorizontal: space['3xs'] },
});
