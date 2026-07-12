import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

export default function AuthLayout() {
  const { theme } = useTheme();
  return (
    // Edge-only back gesture — see moments/_layout.tsx (iOS 26 flipped the
    // RNS full-screen-swipe default to true).
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg }, fullScreenGestureEnabled: false }} />
  );
}
