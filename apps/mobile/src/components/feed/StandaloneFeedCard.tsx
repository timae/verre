import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
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
import { DEFAULT_ASPECT, frameAspectFor, rawAspect } from '@/lib/feedAspect';
import { FEED_PANEL_SCRIM, GUTTER } from '@/lib/layout';
import { timeAgo } from '@/lib/momentFormat';
import { useFlavourColors } from '@/theme/flavourColors';
import { space, useTheme } from '@/theme';
import { checkinToWine, type CheckinPayload, type FeedAuthor, type SessionFeedWine } from '@/lib/api/feed';

// Standalone check-in card ("<name> had a wine") — 03·12 design language,
// adapted to a SINGLE impression (Simon, 2026-07-06; proposal 08 §5 redesign).
// Face = the session card's language: plain header · a hero with the impression
// info · double-tap-to-like (photo only) · action row · likes · caption.
//
// The hero adapts to what the check-in carries (Simon's "more impression
// details as the hero — but what if there's only a score?"):
//   • photo    → the photo (IG-framed) + the over-photo GLASS panel + double-tap-like.
//   • no photo → NonPhotoHero: a tinted stage (wheel + "Tastes like" chips, or a
//                note/origin block, or bare) + a THEMED panel card (ink-on-
//                surface, NOT glass — glass only reads over real photos; Simon).
// Both route to the same detail page on tap.

const AnimatedView = Animated.createAnimatedComponent(View);

export function StandaloneFeedCard({
  author,
  checkin,
  createdAt,
  onOpen,
  onToggleLike,
}: {
  author: FeedAuthor;
  checkin: CheckinPayload;
  createdAt: string;
  onOpen: () => void;
  onToggleLike: (nextLiked: boolean) => void;
}) {
  const { theme } = useTheme();
  const axisColor = useFlavourColors();
  const { width: screenW } = useWindowDimensions();

  // Adapt the CheckinPayload into the SessionFeedWine shape the shared panel +
  // hero speak — ONE adapter (checkinToWine), shared with the detail screen's
  // detailFromItem, so the card and the detail page can never drift apart.
  const wine = useMemo<SessionFeedWine>(() => checkinToWine(checkin), [checkin]);

  const uri = checkin.imageUrl;

  const like = useCallback(() => {
    if (!checkin.liked) {
      onToggleLike(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  }, [checkin.liked, onToggleLike]);

  return (
    <View style={{ marginBottom: space.lg }}>
      {/* header — avatar · "<name> had a wine" · place · time */}
      <View style={[styles.head, { paddingHorizontal: GUTTER }]}>
        <Avatar imageUrl={author.imageUrl} name={author.name} size={38} />
        <View style={styles.who}>
          <VText variant="body" numberOfLines={1}>
            <VText variant="body" style={styles.bold}>
              {author.name}
            </VText>
            <VText variant="body" color="inkSoft">
              {' '}
              had a wine
            </VText>
          </VText>
          <VText variant="caption" color="inkSoft" numberOfLines={1}>
            {[[checkin.venueName, checkin.city].filter(Boolean).join(', '), timeAgo(createdAt)]
              .filter(Boolean)
              .join(' · ')}
          </VText>
        </View>
      </View>

      {/* hero — photo (glass panel) OR the themed non-photo hero */}
      {uri ? (
        <PhotoHero
          uri={uri}
          wine={wine}
          axisColor={axisColor}
          photoW={screenW}
          onLike={like}
          onOpen={onOpen}
        />
      ) : (
        <NonPhotoHero wine={wine} axisColor={axisColor} width={screenW} onOpen={onOpen} />
      )}

      {/* action row — like */}
      <View style={[styles.acts, { paddingHorizontal: GUTTER }]}>
        <Pressable
          onPress={() => onToggleLike(!checkin.liked)}
          accessibilityRole="button"
          accessibilityLabel={checkin.liked ? 'Unlike' : 'Like'}
          style={styles.actBtn}
        >
          <Icon name={checkin.liked ? 'heart-fill' : 'heart'} size={21} color={checkin.liked ? theme.accent : theme.ink} />
        </Pressable>
      </View>

      {/* likes line */}
      {checkin.likeCount > 0 && (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VText variant="small" style={styles.bold}>
            {checkin.likeCount} {checkin.likeCount === 1 ? 'like' : 'likes'}
          </VText>
        </View>
      )}

      {/* caption — the taste note, always visible (Simon: the note reads here) */}
      {checkin.notes ? (
        <View style={{ paddingHorizontal: GUTTER, paddingTop: space['3xs'] }}>
          <VText variant="small" color="ink" numberOfLines={3}>
            {checkin.notes}
          </VText>
        </View>
      ) : null}
    </View>
  );
}

// Photo hero: the IG-framed photo + double-tap-to-like + the over-photo glass
// panel. Mirrors a single session slide (feedAspect crop/fit, heart-burst, panel).
function PhotoHero({
  uri,
  wine,
  axisColor,
  photoW,
  onLike,
  onOpen,
}: {
  uri: string;
  wine: SessionFeedWine;
  axisColor: (k: string) => string;
  photoW: number;
  onLike: () => void;
  onOpen: () => void;
}) {
  const { theme } = useTheme();
  const [raw, setRaw] = useState<number | null>(null);
  const frameAspect = raw ? frameAspectFor([raw]) : DEFAULT_ASPECT;
  const photoH = Math.round(photoW * frameAspect);

  const burstScale = useSharedValue(0);
  const burstOpacity = useSharedValue(0);
  const burstStyle = useAnimatedStyle(() => ({ opacity: burstOpacity.value, transform: [{ scale: burstScale.value }] }));
  const fireBurst = useCallback(() => {
    burstScale.value = withSequence(withTiming(1, { duration: 180 }), withTiming(1, { duration: 260 }));
    burstOpacity.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 340 }));
  }, [burstScale, burstOpacity]);
  const onDoubleTap = useCallback(() => {
    onLike();
    fireBurst();
  }, [onLike, fireBurst]);
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd((_e, ok) => {
      if (ok) runOnJS(onDoubleTap)();
    });

  return (
    <GestureDetector gesture={doubleTap}>
      <View style={{ width: photoW, height: photoH, backgroundColor: theme.surfaceSunk }}>
        <Image
          source={{ uri }}
          style={{ width: photoW, height: photoH }}
          contentFit="cover"
          transition={120}
          alt={wine.name || 'Wine photo'}
          onLoad={(e) => {
            const src = e.source;
            if (src?.width && src?.height) setRaw(rawAspect(src.width, src.height));
          }}
        />
        <LinearGradient
          colors={FEED_PANEL_SCRIM}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <FeedGlassPanel wine={wine} index={0} axisColor={axisColor} onPress={onOpen} />
        <AnimatedView pointerEvents="none" style={[styles.burst, burstStyle]}>
          <Icon name="heart-fill" size={96} color="#fff" />
        </AnimatedView>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  burst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  acts: { flexDirection: 'row', alignItems: 'center', paddingTop: space.xs },
  actBtn: { paddingVertical: space['3xs'], paddingHorizontal: space['3xs'] },
});
