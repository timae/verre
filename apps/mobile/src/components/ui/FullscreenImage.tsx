import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withDecay, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { GLASS_FILL, usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

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
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const closeSize = phone.size('fullscreenClose');
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // True while a two-finger pinch is active. The pan + pinch run simultaneously
  // (so a two-finger drag can both zoom and move), but pinch.onUpdate owns the
  // focal-zoom translate math during a pinch — pan.onUpdate must NOT also write
  // translate then, or the two fight and the image jitters/jumps.
  const isPinching = useSharedValue(false);
  // LATCH, separate from the live isPinching flag: set true the moment a pinch
  // touches a pan, and only cleared by pan.onEnd. pinch.onEnd and pan.onEnd fire
  // independently under Gesture.Simultaneous; if pinch ends FIRST it clears
  // isPinching, so a later pan.onEnd would no longer see a pinch and could fling
  // off a two-finger velocity. This latch survives that ordering — pan.onEnd
  // checks it (not isPinching) to suppress the decay after a pinch.
  const panContaminatedByPinch = useSharedValue(false);

  // Max pan distance from center for a given scale: the image overflows the
  // viewport by (viewport * (scale - 1)), split evenly each side.
  const translateBound = (nextScale: number, viewport: number) => {
    'worklet';
    return Math.max(0, (viewport * (nextScale - 1)) / 2);
  };

  const clampTranslate = (translation: number, nextScale: number, viewport: number) => {
    'worklet';
    const max = translateBound(nextScale, viewport);
    return Math.min(max, Math.max(-max, translation));
  };

  const translateForFocalZoom = (focal: number, viewport: number, savedTranslation: number, fromScale: number, toScale: number) => {
    'worklet';
    const focalFromCenter = focal - viewport / 2;
    return focalFromCenter - ((focalFromCenter - savedTranslation) / fromScale) * toScale;
  };

  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    isPinching.value = false;
    panContaminatedByPinch.value = false;
  }, [uri, visible, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY, isPinching, panContaminatedByPinch]);

  const close = () => {
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    onClose();
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      isPinching.value = true;
      panContaminatedByPinch.value = true;
    })
    .onUpdate((event) => {
      const nextScale = Math.min(Math.max(savedScale.value * event.scale, 1), 4);
      scale.value = nextScale;
      translateX.value = clampTranslate(
        translateForFocalZoom(event.focalX, width, savedTranslateX.value, savedScale.value, nextScale),
        nextScale,
        width,
      );
      translateY.value = clampTranslate(
        translateForFocalZoom(event.focalY, height, savedTranslateY.value, savedScale.value, nextScale),
        nextScale,
        height,
      );
    })
    .onEnd(() => {
      isPinching.value = false;
      if (scale.value <= 1.01) {
        scale.value = withSpring(1);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        return;
      }

      savedScale.value = scale.value;
      savedTranslateX.value = clampTranslate(translateX.value, scale.value, width);
      savedTranslateY.value = clampTranslate(translateY.value, scale.value, height);
      translateX.value = withSpring(savedTranslateX.value);
      translateY.value = withSpring(savedTranslateY.value);
    });

  const pan = Gesture.Pan()
    .onStart(() => {
      // During a pinch, pinch.onUpdate owns translate AND reads savedTranslate*
      // as its focal-zoom reference frame. The pan and pinch start together on a
      // two-finger gesture, so if pan.onStart overwrote savedTranslate* here it
      // would corrupt that frame mid-pinch (the "weird" pinch). Leave saved*
      // alone while pinching — pinch.onEnd sets the post-zoom anchor.
      if (isPinching.value) return;
      // Re-grabbing mid-glide: stop the decay and pin saved* to the live
      // on-screen position, so the next drag continues from where it is
      // instead of jumping back to the pre-glide anchor.
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((event) => {
      // While pinching, pinch.onUpdate owns the translate (focal-zoom math) —
      // don't let the pan also write it, or the two recognizers fight.
      if (isPinching.value) return;
      if (scale.value > 1.01) {
        translateX.value = clampTranslate(savedTranslateX.value + event.translationX, scale.value, width);
        translateY.value = clampTranslate(savedTranslateY.value + event.translationY, scale.value, height);
        return;
      }

      translateX.value = 0;
      translateY.value = event.translationY;
    })
    .onEnd((event) => {
      // If a pinch touched this pan at any point, do NOT fling: pinch.onEnd may
      // have already cleared isPinching (it ends independently under
      // Gesture.Simultaneous), so we check the LATCH, not the live flag. A pan
      // velocity carried over from a two-finger pinch would otherwise decay into
      // an unexpected fling. Settle to the clamped position and clear the latch.
      if (panContaminatedByPinch.value) {
        panContaminatedByPinch.value = false;
        if (scale.value > 1.01) {
          savedTranslateX.value = clampTranslate(translateX.value, scale.value, width);
          savedTranslateY.value = clampTranslate(translateY.value, scale.value, height);
          translateX.value = withSpring(savedTranslateX.value);
          translateY.value = withSpring(savedTranslateY.value);
        }
        return;
      }
      if (scale.value <= 1.01 && (Math.abs(event.translationY) > 120 || Math.abs(event.velocityY) > 900)) {
        runOnJS(close)();
        translateY.value = withTiming(0);
        return;
      }

      if (scale.value <= 1.01) {
        translateY.value = withTiming(0);
        savedTranslateY.value = 0;
        return;
      }

      // Carry the release velocity into a decaying glide that eases to rest and
      // stops at the panned-image edge (clamp) — the native photo-viewer feel,
      // instead of a dead stop. The decay's completion writes the resting
      // position back to saved* so the next pan starts from the right place.
      const boundX = translateBound(scale.value, width);
      const boundY = translateBound(scale.value, height);
      translateX.value = withDecay(
        { velocity: event.velocityX, clamp: [-boundX, boundX], rubberBandEffect: true },
        () => { savedTranslateX.value = translateX.value; },
      );
      translateY.value = withDecay(
        { velocity: event.velocityY, clamp: [-boundY, boundY], rubberBandEffect: true },
        () => { savedTranslateY.value = translateY.value; },
      );
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.value > 1.01) {
        scale.value = withSpring(1);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        return;
      }

      const nextScale = 2;
      const nextX = clampTranslate(translateForFocalZoom(event.x, width, 0, 1, nextScale), nextScale, width);
      const nextY = clampTranslate(translateForFocalZoom(event.y, height, 0, 1, nextScale), nextScale, height);
      scale.value = withSpring(nextScale);
      translateX.value = withSpring(nextX);
      translateY.value = withSpring(nextY);
      savedScale.value = 2;
      savedTranslateX.value = nextX;
      savedTranslateY.value = nextY;
    });

  const singleTap = Gesture.Tap().onEnd(() => {
    if (scale.value <= 1.01) {
      runOnJS(close)();
    }
  });

  const tap = Gesture.Exclusive(doubleTap, singleTap);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <StatusBar hidden />
      <View style={[styles.root, { backgroundColor: theme.scrim }]}>
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, tap)}>
          <Animated.Image
            source={{ uri }}
            accessibilityRole="image"
            accessibilityLabel={label}
            style={[styles.image, { width, height }, imageStyle]}
            resizeMode="contain"
          />
        </GestureDetector>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          onPress={close}
          hitSlop={10}
          style={[styles.close, { top: insets.top + 10, width: closeSize, height: closeSize, borderRadius: closeSize / 2 }]}
        >
          <Icon name="x" size={phone.size('fullscreenCloseIcon')} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  image: {
    flex: 1,
  },
  close: {
    position: 'absolute',
    right: 16,
    backgroundColor: GLASS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
