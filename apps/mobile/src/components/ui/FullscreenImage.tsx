import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { GestureViewer, useGestureViewerEvent } from 'react-native-gesture-image-viewer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { useReportFullscreenViewer } from '@/lib/fullscreenViewer';
import { GLASS_FILL, usePhoneTokens } from '@/lib/layout';

// Fullscreen image viewer (single image today; data[] is the seam for the
// future multi-image feed gallery). Pinch-to-zoom with correct focal point,
// momentum pan, double-tap zoom, reliable single-tap-to-dismiss, and swipe
// up/down-to-dismiss all come from react-native-gesture-image-viewer's
// GestureViewer — which composes its gestures correctly (thresholded dismiss
// pan, Exclusive tap/double-tap) so tap and swipe coexist, unlike the prior
// hand-rolled stack and react-native-zoom-toolkit (whose unthresholded pan in a
// Gesture.Race made onTap fire ~1/20). Built for reanimated v4 / New Arch.
export function FullscreenImage({
  uri,
  visible,
  label = 'Photo',
  onClose,
}: {
  uri: string;
  visible: boolean;
  label?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const phone = usePhoneTokens();
  const closeSize = phone.size('fullscreenClose');
  // Zoomed ⇒ a single tap must NOT dismiss (Simon's rule: fully zoom out
  // first). The library fires onSingleTap regardless of zoom, so track the
  // live scale via its zoomChange event (ref, not state — no re-render per
  // pinch frame) and gate the dismiss. Small epsilon: settling springs can
  // rest a hair off 1.0.
  const scaleRef = useRef(1);
  useGestureViewerEvent('zoomChange', (data) => {
    scaleRef.current = data.scale;
  });
  // Fresh open ⇒ fresh scale: closing WHILE zoomed (✕ button) would leave a
  // stale >1 value that blocks the first tap-to-close of the next session.
  useEffect(() => {
    if (visible) scaleRef.current = 1;
  }, [visible]);
  // Status bar: hidden while open as a SCREEN TRAIT, set twice because the
  // viewer is hosted on three kinds of screen (lib/fullscreenViewer has the
  // why): the ROOT Stack's trait is what reaches UIKit when the host is a
  // transparentModal screen (the feed's impression detail), and the NEAREST
  // screen's trait is what reaches it when the host is itself a
  // fullScreenModal screen (feed edit details), which UIKit asks directly. The
  // hook sets both and restores both. A pushed host is covered by either.
  useReportFullscreenViewer(visible);

  return (
    // overFullScreen, not fullScreen (device pass 2026-11-06, SDK 58): the
    // feed's impression detail is a transparentModal screen, and a fullScreen
    // cross-dissolve presented from it hides THAT screen for the whole fade,
    // so the feed list underneath showed through until the viewer was opaque
    // (and again on close). Over-full-screen keeps the presenting chain's
    // views in place and just fades the viewer in over them. Consequence:
    // UIKit never asks this modal's controller for the status bar, so the
    // hide is a screen trait (see above) — the <StatusBar> element is the
    // Android path only.
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      <GestureViewer
        data={[uri]}
        ListComponent={FlatList}
        listProps={{ keyExtractor: (item: string) => item }}
        // Solid black backdrop — the universal photo-viewer ground. NOT
        // theme.scrim (a semi-transparent dark that reads GREY over the modal),
        // and theme-independent on purpose: a themed tint behind a photo is
        // wrong. One of the sanctioned raw literals (over-photo surfaces).
        backdropStyle={{ backgroundColor: '#000' }}
        // The library FADES the backdrop's opacity 1→0 during the pull-to-dismiss
        // (useGestureViewer interpolates dismissDistance [0,200]→[1,0]). Without a
        // black CONTAINER behind it, that fade reveals the Modal's default white
        // → a black-to-white flash mid-swipe. Black container keeps it black the
        // whole gesture.
        containerStyle={{ backgroundColor: '#000' }}
        // Swipe up OR down dismisses (the library gates this to the un-zoomed
        // state — a swipe while zoomed pans the image instead).
        dismiss={{ direction: 'both' }}
        onDismiss={onClose}
        // Reliable single-tap dismiss — the library's own callback (it advises
        // this over overlaying a Pressable, which RNGH would swallow). Gated
        // on the tracked scale: while zoomed, a tap is a no-op.
        onSingleTap={() => {
          if (scaleRef.current <= 1.02) onClose();
        }}
        renderItem={(item: string) => (
          <Image
            source={{ uri: item }}
            alt={label}
            accessibilityLabel={label}
            style={{ width, height }}
            contentFit="contain"
          />
        )}
        // Close button overlaid via the container (RNGH swallows a sibling
        // Pressable's touches, so it rides the viewer's container).
        renderContainer={(children, { dismiss }) => (
          <>
            {children}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close photo"
              onPress={dismiss}
              hitSlop={10}
              style={[styles.close, { top: insets.top + 10, width: closeSize, height: closeSize, borderRadius: closeSize / 2 }]}
            >
              <Icon name="x" size={phone.size('fullscreenCloseIcon')} color="#fff" />
            </Pressable>
          </>
        )}
      />
    </Modal>
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
});
