import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { GLASS_FILL } from '@/lib/layout';
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
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [uri, visible, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

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
    .onUpdate((event) => {
      scale.value = Math.min(Math.max(savedScale.value * event.scale, 1), 4);
    })
    .onEnd(() => {
      if (scale.value <= 1.01) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        return;
      }

      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      if (scale.value > 1.01) {
        translateX.value = savedTranslateX.value + event.translationX;
        translateY.value = savedTranslateY.value + event.translationY;
        return;
      }

      translateX.value = 0;
      translateY.value = event.translationY;
    })
    .onEnd((event) => {
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

      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1.01) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        return;
      }

      scale.value = withTiming(2);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedScale.value = 2;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
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
          style={[styles.close, { top: insets.top + 10 }]}
        >
          <Icon name="x" size={18} color="#fff" />
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
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: GLASS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
