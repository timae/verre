import { Stack } from 'expo-router';
import { textStyle, useTheme } from '@/theme';

export default function YouStack() {
  const { theme } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.ink,
        headerTitleStyle: { ...textStyle('subhead'), color: theme.ink },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: theme.bg },
        // Edge-only back gesture — see moments/_layout.tsx (iOS 26 flipped
        // the RNS full-screen-swipe default to true).
        fullScreenGestureEnabled: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {/* In-tab so the native tab bar stays visible while theme-testing. */}
      <Stack.Screen name="dev-gallery" options={{ title: 'Dev gallery' }} />
    </Stack>
  );
}
