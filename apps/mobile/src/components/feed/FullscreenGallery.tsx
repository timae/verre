import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { GestureViewer, useGestureViewerEvent, useGestureViewerState } from 'react-native-gesture-image-viewer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassPanelInner } from '@/components/feed/FeedGlassPanel';
import { Icon } from '@/components/ui/Icon';
import { usePhoneTokens, GLASS_FILL } from '@/lib/layout';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space } from '@/theme';
import type { SessionFeedWine } from '@/lib/api/feed';

// Fullscreen impression GALLERY (design `gFull` in .local/design/vero-feed.js
// / `.fpg-f*` in vero-feed.css): swipe between the moment's photo impressions
// fullscreen — the glass panel lives INSIDE each page so it SWIPES WITH its
// image, exactly like the feed card's panel-rides-the-photo rule (Simon,
// 2026-07-08; the mock's static swap-on-scroll panel was rejected for the
// same reason on the card). Tapping toggles the info (panel + ✕) on/off, and
// CLOSING LANDS the underlying pager on the impression you swiped to (the
// mock's gLand). Implemented to the app's fullscreen standards — the same
// GestureViewer machinery as ui/FullscreenImage (pinch/zoom, momentum pan,
// swipe up/down dismiss, black ground, glass ✕) — so the two viewers feel
// identical; the deliberate behavioural fork is single-tap: here it toggles
// the info per the design, there it dismisses (no info to toggle).
//
// The zoom transform is applied by the library to the whole content wrapper,
// so an in-page panel would scale with a pinch — the panel fades out while
// zoomed (scale > 1) and back at rest. The panel view itself is
// non-interactive (the viewer's tap gesture owns ALL fullscreen taps — no
// contention); a tap is routed by COORDINATE hit-test instead: within the
// measured panel region → close + land (back to the detail of what you're
// looking at, Simon 2026-07-08), anywhere else → toggle the info. While bare,
// a tap anywhere (panel region included) just brings the info back.
//
// Surface: the shared glass fill is imperceptible over the viewer's black
// ground (the same reason glass is photos-only on the cards), so the gallery
// panel gets a viewer-scoped ELEVATED DARK CARD — near-opaque warm dark fill
// + a faint white hairline — theme-independent like the viewer itself (black
// ground, white ✕). Same layout/inner face as FeedGlassPanel.
//
// `pages` carries only PHOTO-BEARING impressions (a blind/photoless wine has
// nothing to show fullscreen); `wineIndex` maps each page back to its pager
// position for the landing.

export type GalleryPage = { uri: string; wine: SessionFeedWine; wineIndex: number };

// Distinct viewer instance — the default id belongs to ui/FullscreenImage.
const VIEWER_ID = 'feed-gallery';

export function FullscreenGallery({
  pages,
  startWineIndex,
  visible,
  onClose,
}: {
  pages: GalleryPage[];
  startWineIndex: number;
  visible: boolean;
  // Fired on any close (✕, swipe-dismiss, panel tap, hardware back) with the
  // WINE index of the page being viewed — the caller lands its pager there.
  onClose: (landedWineIndex: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const phone = usePhoneTokens();
  const axisColor = useFlavourColors();
  const closeSize = phone.size('fullscreenClose');
  // Seeded from initialIndex on mount (verified in useGestureViewer), so a
  // close-without-swipe lands on the entry impression.
  const { currentIndex } = useGestureViewerState(VIEWER_ID);

  // Zoom tracking: the ref gates taps (same discipline as FullscreenImage);
  // the shared value drives the panels' fade-out while zoomed.
  const scaleRef = useRef(1);
  const zoomedOut = useSharedValue(1); // 1 = at rest (panel showable), 0 = zoomed
  useGestureViewerEvent(VIEWER_ID, 'zoomChange', (data) => {
    scaleRef.current = data.scale;
    const target = data.scale > 1.02 ? 0 : 1;
    if (zoomedOut.value !== target) zoomedOut.value = withTiming(target, { duration: 140 });
  });

  // Bare mode (design `is-bare`): tapping toggles the info (panels + ✕) off
  // and back. State resets to "info shown" + scale to 1 on each open.
  const [bare, setBare] = useState(false);
  const info = useSharedValue(1);
  useEffect(() => {
    if (!visible) return;
    scaleRef.current = 1;
    zoomedOut.value = 1;
    setBare(false);
    info.value = 1;
  }, [visible, info, zoomedOut]);
  const toggleBare = () => {
    setBare((prev) => {
      const next = !prev;
      info.value = withTiming(next ? 0 : 1, { duration: 180 });
      return next;
    });
  };

  const closeStyle = useAnimatedStyle(() => ({ opacity: info.value }));
  const startIndex = Math.max(0, pages.findIndex((p) => p.wineIndex === startWineIndex));
  const land = () => onClose(pages[currentIndex]?.wineIndex ?? startWineIndex);

  // Per-page measured panel heights (they vary — wheel/sub-line presence) for
  // the tap hit-test. Keyed by wineIndex.
  const panelHeights = useRef<Record<number, number>>({});
  const reportPanelHeight = (wineIndex: number, h: number) => {
    panelHeights.current[wineIndex] = h;
  };
  // A tap INSIDE the visible panel goes back to the detail (close + land);
  // anywhere else toggles the info. Coordinates are screen-space (the viewer
  // is fullscreen); the panel sits at [space.xs .. width-space.xs] ×
  // [panelTop .. panelTop+h] with its bottom at insets.bottom + space.xs.
  const onTap = (x: number, y: number) => {
    if (scaleRef.current > 1.02) return;
    if (!bare) {
      const h = panelHeights.current[pages[currentIndex]?.wineIndex ?? -1] ?? 0;
      const panelBottom = height - insets.bottom - space.xs;
      if (h > 0 && y >= panelBottom - h && y <= panelBottom && x >= space.xs && x <= width - space.xs) {
        land();
        return;
      }
    }
    toggleBare();
  };

  if (!pages.length) return null;
  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={land}
    >
      <StatusBar hidden />
      <GestureViewer
        id={VIEWER_ID}
        data={pages}
        initialIndex={startIndex}
        ListComponent={FlatList}
        listProps={{ keyExtractor: (item: GalleryPage) => item.wine.id }}
        // Black ground + container, exactly as ui/FullscreenImage (its in-file
        // comments carry the rationale: universal photo ground, and the
        // dismiss-drag backdrop fade needs a black container behind it).
        backdropStyle={{ backgroundColor: '#000' }}
        containerStyle={{ backgroundColor: '#000' }}
        dismiss={{ direction: 'both' }}
        onDismiss={land}
        // Design: tap → toggle the info on/off; tap ON THE PANEL → back to
        // the detail (close + land). While zoomed a tap is a no-op, same gate
        // as FullscreenImage.
        onSingleTap={(e) => onTap(e.x, e.y)}
        renderItem={(item: GalleryPage) => (
          <View style={{ width, height }}>
            <Image
              source={{ uri: item.uri }}
              alt={item.wine.name || 'Wine photo'}
              accessibilityLabel={item.wine.name || 'Wine photo'}
              style={{ width, height }}
              contentFit="contain"
            />
            {/* THIS page's panel — inside the page so it swipes with the
                image (the feed card's panel-rides-the-photo rule). */}
            <GalleryPanel
              page={item}
              axisColor={axisColor}
              info={info}
              zoomedOut={zoomedOut}
              bottom={insets.bottom}
              onMeasure={reportPanelHeight}
            />
          </View>
        )}
        renderContainer={(children, { dismiss }) => (
          <>
            {children}
            <Reanimated.View pointerEvents={bare ? 'none' : 'box-none'} style={[StyleSheet.absoluteFill, closeStyle]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close photo"
                onPress={dismiss}
                hitSlop={10}
                style={[styles.close, { top: insets.top + 10, width: closeSize, height: closeSize, borderRadius: closeSize / 2 }]}
              >
                <Icon name="x" size={phone.size('fullscreenCloseIcon')} color="#fff" />
              </Pressable>
            </Reanimated.View>
          </>
        )}
      />
    </Modal>
  );
}

// One page's panel: the shared panel FACE (GlassPanelInner) on the gallery's
// elevated-dark-card surface, pinned above the home-indicator inset (design
// .fpg-finfo — space.xs sides + gap). Hidden while bare (info) OR zoomed.
// View is non-interactive; the tap hit-test in the parent owns the press
// (see the header comment). Reports its measured height up for that test.
function GalleryPanel({
  page,
  axisColor,
  info,
  zoomedOut,
  bottom,
  onMeasure,
}: {
  page: GalleryPage;
  axisColor: (k: string) => string;
  info: SharedValue<number>;
  zoomedOut: SharedValue<number>;
  bottom: number;
  onMeasure: (wineIndex: number, height: number) => void;
}) {
  const style = useAnimatedStyle(() => ({ opacity: info.value * zoomedOut.value }));
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: space.xs, right: space.xs, bottom: bottom + space.xs }, style]}
    >
      <View
        style={styles.panel}
        accessibilityRole="button"
        accessibilityLabel={`Back to details${page.wine.name ? `: ${page.wine.name}` : ''}`}
        onLayout={(e) => onMeasure(page.wineIndex, e.nativeEvent.layout.height)}
      >
        <GlassPanelInner wine={page.wine} index={page.wineIndex} axisColor={axisColor} />
      </View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  close: {
    position: 'absolute',
    right: 16,
    backgroundColor: GLASS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  // Row layout mirrors FeedGlassPanel's `panel`; the SURFACE is the gallery's
  // own (see header): glass reads as nothing over the black ground, so this
  // is an elevated dark card — a warm fill a step lighter than the ground,
  // NO border (the app has none anywhere — Simon; surfaces elevate by tone).
  // Theme-independent on purpose (sanctioned over-photo literals).
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(42,39,34,0.96)',
  },
});
