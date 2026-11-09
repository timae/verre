import { Stack } from 'expo-router';
import { SessionTabProvider } from '@/lib/sessionStack';
import { textStyle, useTheme } from '@/theme';

// ⚠️ Load-bearing (same as the Feed stack): declaring a <Stack.Screen> below
// hoists that route to the FRONT of the stack's route order, and the default
// initial route is the first one — without this anchor a fresh mount of the
// You tab would cold-mount impression/[id] with no params.
export const unstable_settings = { anchor: 'index' };

// The You tab: your profile (handoff 04, step 1) and everything a profile can
// open — a post's detail + edit screens, someone's profile, a moment — via
// one-line re-export mirrors of the Feed / Moments routes, so back-nav stays on
// You. Screen options mirror the Feed stack (feed/_layout.tsx): in-flow
// screens draw their own chrome, the post detail is a transparent modal that
// draws its own open/close, and the edit screens present full screen.
export default function YouStack() {
  const { theme } = useTheme();
  // The owning tab for every screen in this stack (lib/sessionStack.ts
  // useSessionTab): mount location, not the globally focused route.
  return (
    <SessionTabProvider value="you">
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
      {/* See feed/_layout.tsx: transparent modal, no native animation, no
          native back gesture — the screen draws the shared-element open and
          the pull-down dismiss itself. */}
      <Stack.Screen
        name="impression/[id]"
        options={{
          presentation: 'transparentModal',
          animation: 'none',
          gestureEnabled: false,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <Stack.Screen name="edit/[id]" options={{ presentation: 'fullScreenModal' }} />
      <Stack.Screen name="edit/details" options={{ presentation: 'fullScreenModal' }} />
      {/* In-tab so the tab bar stays visible while theme-testing; keeps its
          native header. */}
      <Stack.Screen
        name="dev-gallery"
        options={{
          headerShown: true,
          title: 'Dev gallery',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.bg },
          headerTintColor: theme.ink,
          headerTitleStyle: { ...textStyle('subhead'), color: theme.ink },
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
    </Stack>
    </SessionTabProvider>
  );
}
