import { Stack } from 'expo-router';
import { SessionTabProvider, TAB_MOUNTS } from '@/lib/sessionStack';
import { useTheme } from '@/theme';

// Load-bearing since the profile sub-tree mounts here (the `<Stack.Screen>`s
// below hoist their routes to the front, see feed/_layout.tsx): without the
// anchor a fresh mount would cold-open the post route `[id]` with no params.
export const unstable_settings = { anchor: 'index' };

// The Moments tab is a stack: home (02s) → recents (02s·2) / session line-up
// (02b) push within the tab, keeping the bottom nav visible. In-flow screens
// draw the design's own .vbar (components/VBar) — the native header's
// centered title + glass back-circle don't match the variant-B spec.
// Since 2026-11-15 it also mounts Feed's post + profile sub-tree (one-line
// mirrors: a person opened inside a moment, and everything reached from their
// profile), so Back from a profile returns to the moment.
export default function MomentsStack() {
  const { theme } = useTheme();
  // The owning tab for every screen in this stack (lib/sessionStack.ts
  // useSessionTab): mount location, not the globally focused route.
  return (
    <SessionTabProvider value={TAB_MOUNTS.moments}>
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
    >
      <Stack.Screen name="index" />
      {/* See feed/_layout.tsx: the opened post's own stack (a contained
          transparent modal, no native animation or back gesture: the detail
          draws its own open and pull-down close) and the full-screen post
          edits. The name must stay wholly dynamic (post identity). */}
      <Stack.Screen
        name="[id]"
        options={{
          presentation: 'containedTransparentModal',
          animation: 'none',
          gestureEnabled: false,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      {/* The post edit is an ordinary PUSH with swipe-back, like Edit
          Impression (ruled 2026-11-24; was a fullScreenModal since 2026-07-18,
          for a push from the old modal detail, which now opens the edit on its
          own stack). So anything can open on top of it (a look-in link) and
          Back returns to the edit. */}
      <Stack.Screen name="edit/[id]" />
      <Stack.Screen name="edit/details" />
    </Stack>
    </SessionTabProvider>
  );
}
