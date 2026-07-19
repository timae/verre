import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

// ⚠️ Load-bearing: declaring a <Stack.Screen> below hoists that route to the
// FRONT of the stack's route order, and react-navigation's default initial
// route is the first one — without this anchor, a fresh mount of the Feed tab
// (app reload → tab press) would cold-mount impression/[id] with no params →
// the "This impression is gone" screen. Also anchors deep links so the list
// sits beneath a cold-opened detail (back has somewhere to go).
export const unstable_settings = { initialRouteName: 'index' };

// The Feed tab is a stack: the feed list (03·12) → the full impression
// detail page (proposal 08 §3) pushes within the tab. The detail is
// IMMERSIVE — the tabs layout hides the bottom nav on /impression/ routes
// (Simon, 2026-07-08); the floating back button is the only chrome. In-flow
// screens draw their own chrome (collapsing hero), not the native header.
export default function FeedStack() {
  const { theme } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.bg },
        // Edge-only back gesture — see moments/_layout.tsx (iOS 26 flipped
        // the RNS full-screen-swipe default to true).
        fullScreenGestureEnabled: false,
      }}
    >
      <Stack.Screen name="index" />
      {/* The detail is a TRANSPARENT modal with no native animation: the
          screen itself draws the shared-element open (hero clone grows out of
          the tapped card's photo) and the pull-down dismiss (proposal 09),
          with the feed showing through underneath. gestureEnabled off — the
          pull-down IS the dismiss gesture; a native edge-swipe would pop the
          route without reversing the presentation. */}
      <Stack.Screen
        name="impression/[id]"
        options={{
          presentation: 'transparentModal',
          animation: 'none',
          gestureEnabled: false,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      {/* The edit screens render FULL SCREEN from both entry points (Simon,
          2026-07-18). With the default card presentation, a push from the
          impression detail sits above a modal, so UIKit presents it modally —
          the iOS pageSheet (partial, parent peeking at the top). fullScreenModal
          keeps the full-page look regardless of what's beneath; both stages
          need it or the details push would re-inherit the sheet. */}
      <Stack.Screen name="edit/[id]" options={{ presentation: 'fullScreenModal' }} />
      <Stack.Screen name="edit/details" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}
