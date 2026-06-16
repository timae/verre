import { StatusBar } from 'expo-status-bar';
import { Image, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';

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

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <StatusBar hidden />
      <View style={styles.root}>
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={[styles.scrollContent, { width, minHeight: height }]}
          centerContent
          maximumZoomScale={4}
          minimumZoomScale={1}
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Close photo" onPress={onClose} style={{ width, height }}>
            <Image source={{ uri }} accessibilityLabel={label} style={{ width, height }} resizeMode="contain" />
          </Pressable>
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          onPress={onClose}
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
    backgroundColor: '#000',
  },
  scrollContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    position: 'absolute',
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
