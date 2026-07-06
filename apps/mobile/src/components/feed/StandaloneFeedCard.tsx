import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
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
import { DEFAULT_ASPECT, fitInFrame, frameAspectFor, rawAspect } from '@/lib/feedAspect';
import { useFeedFitMode } from '@/lib/feedFitMode';
import { GUTTER } from '@/lib/layout';
import { timeAgo, wineTypeLabel } from '@/lib/momentFormat';
import { space, useTheme } from '@/theme';
import { formatScore } from '@verre/core';
import type { CheckinPayload, FeedAuthor } from '@/lib/api/feed';

// Standalone check-in card ("<name> had a wine") — Phase-1 MINIMAL render.
// Proposal 08 §5: 03·12 is a session spec; the standalone card face is an
// undesigned Phase-2 problem (Simon flagged the current one as bad UX). This
// is a correct, plain placeholder — header · photo · a readable info block
// under it · like · caption — with the same like gesture + the detail path
// wired (tap opens the full impression page). It intentionally does NOT try
// to invent the glass/wheel treatment; that's the Phase-2 design round.

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
  const fitMode = useFeedFitMode(); // dev toggle: 'bars' | 'crop' (dev gallery)
  const { width: screenW } = useWindowDimensions();
  const photoW = screenW;

  // Single-photo frame: the photo's native aspect, clamped to the band. In
  // band → fills, no bars. Taller than 3:4 → frame caps at 3:4 and the photo
  // crops (never pillarbox). Wider than 4:3 → frame caps at 4:3 and the photo
  // contains with tint bars. Measured via expo-image's onLoad (reliable — the
  // dims of the image it already loaded; RNImage.getSize refetched and could
  // fail silently against MinIO). Settles from the 4:5 default.
  const uri = checkin.imageUrl;
  const [raw, setRaw] = useState<number | null>(null);
  const frameAspect = raw ? frameAspectFor([raw]) : DEFAULT_ASPECT;
  const photoH = Math.round(photoW * frameAspect);
  const fit = fitMode === 'crop' ? 'cover' : raw ? fitInFrame(raw, frameAspect) : 'cover';

  const burstScale = useSharedValue(0);
  const burstOpacity = useSharedValue(0);
  const burstStyle = useAnimatedStyle(() => ({ opacity: burstOpacity.value, transform: [{ scale: burstScale.value }] }));
  const like = useCallback(() => {
    if (!checkin.liked) {
      onToggleLike(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    burstScale.value = withSequence(withTiming(1, { duration: 180 }), withTiming(1, { duration: 260 }));
    burstOpacity.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 340 }));
  }, [checkin.liked, onToggleLike, burstScale, burstOpacity]);

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd((_e, ok) => {
      if (ok) runOnJS(like)();
    });

  const sub = [wineTypeLabel(checkin.type), checkin.producer].filter(Boolean).join(' · ');
  const place = [checkin.venueName, checkin.city].filter(Boolean).join(', ');

  return (
    <View style={{ marginBottom: space.lg }}>
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
            {[place, timeAgo(createdAt)].filter(Boolean).join(' · ')}
          </VText>
        </View>
      </View>

      {uri ? (
        <GestureDetector gesture={doubleTap}>
          {/* full-bleed at x=0 (card content is unpadded, blocks self-inset by
              GUTTER). Native aspect clamped to the band; the surfaceSunk
              background shows as tint bars when the photo contains. */}
          <Pressable onPress={onOpen} style={{ width: photoW, height: photoH, backgroundColor: theme.surfaceSunk }}>
            <Image
              source={{ uri }}
              style={{ width: photoW, height: photoH }}
              contentFit={fit}
              transition={120}
              alt={checkin.wineName || 'Wine photo'}
              onLoad={(e) => {
                const src = e.source;
                if (src?.width && src?.height) setRaw(rawAspect(src.width, src.height));
              }}
            />
            <AnimatedView pointerEvents="none" style={[styles.burst, burstStyle]}>
              <Icon name="heart-fill" size={96} color="#fff" />
            </AnimatedView>
          </Pressable>
        </GestureDetector>
      ) : null}

      {/* info block — tappable, opens the full impression page */}
      <Pressable onPress={onOpen} style={[styles.info, { paddingHorizontal: GUTTER }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <VText variant="subhead" numberOfLines={1}>
            {checkin.wineName}
            {/* year = smaller + thinner than the title, same colour (Simon's
                target — the original standalone look). Default variant='body'
                (smaller than the subhead title) + medium weight; no colour
                override so it inherits the title's ink. */}
            {checkin.vintage ? <VText style={styles.vin}> - {checkin.vintage}</VText> : null}
          </VText>
          {sub ? (
            <VText variant="caption" color="inkSoft" numberOfLines={1}>
              {sub}
            </VText>
          ) : null}
        </View>
        {checkin.score != null && checkin.score > 0 && (
          <View style={styles.score}>
            <Icon name="starf" size={17} color={theme.accent} />
            <VText variant="subhead" style={styles.bold}>
              {formatScore(checkin.score)}
            </VText>
          </View>
        )}
      </Pressable>

      {checkin.notes ? (
        <View style={{ paddingHorizontal: GUTTER, paddingTop: space['3xs'] }}>
          <VText variant="small" color="ink" numberOfLines={3}>
            {checkin.notes}
          </VText>
        </View>
      ) : null}

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

      {checkin.likeCount > 0 && (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VText variant="small" style={styles.bold}>
            {checkin.likeCount} {checkin.likeCount === 1 ? 'like' : 'likes'}
          </VText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  vin: { fontFamily: 'InstrumentSans_500Medium' },
  burst: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  info: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  score: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  acts: { flexDirection: 'row', alignItems: 'center', paddingTop: space.xs },
  actBtn: { paddingVertical: space['3xs'], paddingHorizontal: space['3xs'] },
});
