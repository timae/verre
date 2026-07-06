import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
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
import { FlavourWheel } from '@/components/scoring/FlavourWheel';
import { buildWheelAxes } from '@/lib/flavourAxes';
import { fitInFrame, frameAspectFor, rawAspect } from '@/lib/feedAspect';
import { useFeedFitMode } from '@/lib/feedFitMode';
import { GLASS_FILL, GUTTER } from '@/lib/layout';
import { timeAgo, wineTypeLabel } from '@/lib/momentFormat';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space, useTheme } from '@/theme';
import { formatScore } from '@verre/core';
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
  const fitMode = useFeedFitMode(); // dev toggle: 'bars' | 'crop' (dev gallery)
  const { width: screenW } = useWindowDimensions();
  const photoW = screenW; // full-bleed at x=0

  const [activeIdx, setActiveIdx] = useState(0);
  const wines = session.wines;
  const avg = groupAvg(wines);

  // Carousel frame rule (Simon): the TALLEST photo wins, clamped to the band,
  // so the frame is always ≥ every slide → shorter (landscape) slides
  // letterbox top/bottom with tint bars, never pillarbox. A slide TALLER than
  // the frame (only when the frame hit the 3:4 cap) crops. Needs every wine's
  // intrinsic aspect — the payload lacks dims, so each slide measures ITS OWN
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
            {[session.deleted ? '[deleted moment]' : session.sessionName, timeAgo(createdAt)]
              .filter(Boolean)
              .join(' · ')}
          </VText>
        </View>
      </View>

      {/* photo carousel. Full-bleed: the card content is NOT horizontally
          padded (each text block self-insets by GUTTER), so photos sit at x=0
          spanning the full screen width. The glass panel lives INSIDE each
          slide (Simon) so it travels with its photo instead of a static
          overlay that pops content on scroll-end. The CONTAINER carries the
          tint background so an overscroll pull reveals the tint (matching the
          letterbox bars), sitting FLAT — no shadow (Simon). */}
      <View style={{ width: photoW, height: photoH, backgroundColor: theme.surfaceSunk }}>
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
                fit={
                  fitMode === 'crop'
                    ? 'cover'
                    : w.imageUrl && aspects[w.imageUrl]
                      ? fitInFrame(aspects[w.imageUrl], frameAspect)
                      : 'cover'
                }
                onMeasure={reportAspect}
                onPressPanel={() => onOpenImpression(i)}
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

      {/* action row — like · group-avg chip */}
      <View style={[styles.acts, { paddingHorizontal: GUTTER }]}>
        <Pressable
          style={styles.actBtn}
          onPress={() => onToggleLike(!session.liked)}
          accessibilityRole="button"
          accessibilityLabel={session.liked ? 'Unlike' : 'Like'}
        >
          <Icon name={session.liked ? 'heart-fill' : 'heart'} size={21} color={session.liked ? theme.accent : theme.ink} />
        </Pressable>
        <View style={{ flex: 1 }} />
        {avg != null && (
          <View style={styles.scoreChip}>
            <VText variant="caption" color="inkSoft">
              group{' '}
            </VText>
            <Icon name="starf" size={13} color={theme.ink} />
            <VText variant="caption" style={styles.bold}>
              {' '}
              {formatScore(avg)}
            </VText>
          </View>
        )}
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

// The glass-panel content: name - vintage · producer·type · ★ score ·
// mini wheel · chevron. Redacted (_blind) wines render "Wine N" and skip
// the identity fields — the mystery slot, keyed on `_blind` alone.
function GlassPanelInner({
  wine,
  activeIdx,
  axisColor,
}: {
  wine: SessionFeedWine | undefined;
  activeIdx: number;
  axisColor: (k: string) => string;
}) {
  if (!wine) return null;
  const blind = !!wine._blind;
  const typeLabel = wineTypeLabel(wine.type);
  const sub = blind ? 'Hidden until the host reveals it' : [wine.producer, typeLabel].filter(Boolean).join(' · ');
  const axes = blind ? [] : buildWheelAxes(wine.flavors, wine.type, axisColor);
  return (
    <>
      <View style={styles.panelMain}>
        <VText variant="body" numberOfLines={1} style={[styles.panelName, { color: '#fff' }]}>
          {blind ? `Wine ${activeIdx + 1}` : wine.name}
          {/* year = smaller (small=13 vs the name's body=15) + thinner (medium)
              + same colour as the name — matches the standalone look (Simon).
              caption=12 read too small; small is a 2px drop, closer feel.
              color="#fff" is REQUIRED: VText defaults color='ink' and always
              re-injects its own resolved colour, so a nested VText does NOT
              inherit the parent's #fff — it'd paint the year theme-ink. */}
          {!blind && wine.vintage ? (
            <VText variant="small" color="#fff" style={styles.vin}>
              {' - '}
              {wine.vintage}
            </VText>
          ) : null}
        </VText>
        {sub ? (
          <VText variant="caption" numberOfLines={1} style={styles.panelSub}>
            {sub}
          </VText>
        ) : null}
        {wine.score != null && wine.score > 0 && (
          <View style={styles.panelScore}>
            <Icon name="starf" size={17} color="#fff" />
            <VText variant="subhead" style={[styles.bold, { color: '#fff' }]}>
              {formatScore(wine.score)}
            </VText>
          </View>
        )}
      </View>
      {axes.length > 0 && (
        <View style={styles.mini}>
          <FlavourWheel axes={axes} size={62} labels={false} />
        </View>
      )}
      {/* disclosure chevron (design .fpg-chev = i-back rotated 180° = a
          right-pointing chevron) — signals the panel opens the detail page. */}
      <View style={styles.chev}>
        <Icon name="chevron-right" size={16} color="#fff" />
      </View>
    </>
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
  fit,
  axisColor,
  onMeasure,
  onPressPanel,
}: {
  wine: SessionFeedWine;
  index: number;
  width: number;
  height: number;
  // 'contain' = show whole photo, tint bars fill the gap. 'cover' = crop to
  // fill (taller-than-frame, or the crop dev mode). See lib/feedAspect.
  fit: 'cover' | 'contain';
  axisColor: (k: string) => string;
  // Report this photo's intrinsic aspect (h/w) up once loaded — the parent
  // computes the frame (tallest wins) from all slides' reports.
  onMeasure: (uri: string, aspect: number) => void;
  onPressPanel: () => void;
}) {
  const { theme } = useTheme();
  const uri = wine._blind ? null : wine.imageUrl;
  return (
    // The container background IS the letterbox tint bar — surfaceSunk shows
    // through where a contained photo doesn't reach the frame edges. (The
    // overscroll shadow lives on the carousel CONTAINER, not here — RN
    // ScrollViews clip child shadows, so a per-slide shadow wouldn't show.)
    <View style={{ width, height, backgroundColor: theme.surfaceSunk }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width, height }}
          contentFit={fit}
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
        colors={['rgba(15,12,10,0)', 'rgba(15,12,10,0.55)']}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* glass panel — inside the slide, so it slides with the photo. Opens the
          full impression page on tap (anywhere on the panel). */}
      <View style={styles.panelWrap} pointerEvents="box-none">
        <Pressable
          style={[styles.panel, { backgroundColor: GLASS_FILL }]}
          onPress={onPressPanel}
          accessibilityRole="button"
          accessibilityLabel={`Impression details${wine._blind ? '' : `: ${wine.name}`}`}
        >
          <GlassPanelInner wine={wine} activeIdx={index} axisColor={axisColor} />
        </Pressable>
      </View>
    </View>
  );
}

// Group average across the author's rated wines (the "group ★" chip). Only
// counts real scores (> 0); returns null when nothing is scored. Rounded to
// a 0.25 step so the chip shows a clean score (formatScore expects quarter
// steps — a raw mean like 4.083 would render "4.08").
function groupAvg(wines: SessionFeedWine[]): number | null {
  const scores = wines.map((w) => w.score).filter((s): s is number => s != null && s > 0);
  if (!scores.length) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(mean * 4) / 4;
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  burst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  panelWrap: { position: 'absolute', left: space.xs, right: space.xs, bottom: space.xs },
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  panelMain: { flex: 1, minWidth: 0 },
  panelName: { fontFamily: 'InstrumentSans_600SemiBold' },
  // Same colour as the name (Simon's call) — the year is distinguished by
  // weight (medium vs semibold) alone, not colour. No opacity dim (0.72/0.85
  // read as murky low-contrast grey over a busy photo).
  vin: { fontFamily: 'InstrumentSans_500Medium' },
  panelSub: { color: '#fff', opacity: 0.78, marginTop: 1 },
  panelScore: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  mini: { flexShrink: 0 },
  chev: { flexShrink: 0, opacity: 0.65 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, paddingVertical: space.xs },
  dot: { width: 6, height: 6, borderRadius: 999 },
  dotOn: { transform: [{ scale: 1.15 }] },
  acts: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingTop: space.xs, paddingBottom: space['3xs'] },
  actBtn: { paddingVertical: space['3xs'], paddingHorizontal: space['3xs'] },
  scoreChip: { flexDirection: 'row', alignItems: 'center' },
});
