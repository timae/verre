import { Stack } from 'expo-router';
import { SessionTabProvider } from '@/lib/sessionStack';
import { useTheme } from '@/theme';

// The Moments tab is a stack: home (02s) → recents (02s·2) / session line-up
// (02b) push within the tab, keeping the bottom nav visible. In-flow screens
// draw the design's own .vbar (components/VBar) — the native header's
// centered title + glass back-circle don't match the variant-B spec.
export default function MomentsStack() {
  const { theme } = useTheme();
  // The owning tab for every screen in this stack (lib/sessionStack.ts
  // useSessionTab): mount location, not the globally focused route.
  return (
    <SessionTabProvider value="moments">
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.bg },
        // iOS 26 flipped react-native-screens' fullScreenSwipeEnabled default
        // to TRUE (the OS content-area pop gesture) — a right-swipe anywhere
        // popped the screen, fighting every horizontal drag surface (score
        // slider, structure tracks, aroma pickers, reorder). Explicit false
        // restores the edge-only gesture app-wide (Simon, 2026-07-12);
        // gestureResponseDistance on drag-heavy screens applies again.
        fullScreenGestureEnabled: false,
      }}
    />
    </SessionTabProvider>
  );
}
