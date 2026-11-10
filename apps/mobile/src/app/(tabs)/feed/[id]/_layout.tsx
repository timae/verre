import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { SessionTabProvider, useSessionTab } from '@/lib/sessionStack';
import { useTheme } from '@/theme';

// ⚠️ Load-bearing: declaring a <Stack.Screen> below hoists it to the front of
// the route order, so without this anchor a cold mount would open a child with
// no post beneath it (same trap as feed/_layout.tsx).
export const unstable_settings = { anchor: 'index' };

// The OPENED POST's own stack. The outer Feed / You stack presents this whole
// navigator as one transparent modal (`[id]` there); inside it, `index` is the
// post detail (it draws its own shared-element open and pull-down close), and
// everything opened FROM the post — a moment (session/[code]/…), a profile
// (u/[personId]), another post in card mode (post/[postId]) — pushes HERE as a
// real card: swipe-back, no page sheet, no modal stacking. All of them are
// siblings on this one stack, so no route tree nests inside itself (a post
// opened from a profile opened from the post is just the next card).
// react-native-screens draws no container background for a stack inside a
// transparent presentation, so the feed still shows through while `index`
// runs its open (NativeStackView `isInTransparentPresentation`).
//
// The You tab mounts the same layout (you/[id]/_layout.tsx re-exports it):
// the tab comes from the ENCLOSING provider, the post id from this route.
export default function PostStack() {
  const { theme } = useTheme();
  const outer = useSessionTab();
  const { id } = useLocalSearchParams<{ id: string }>();
  // The mount every screen inside resolves (lib/sessionStack.ts): pinned at
  // first render — a mounted post stack's identity never changes, and the
  // owning id comes from THIS route, which every child URL carries. An
  // anchored `index` (cold link to a child, `withAnchor`) gets no params of its
  // own, so the detail reads the post id from here.
  const [mount] = useState(() => ({ tab: outer.tab, post: String(id) }));
  return (
    <SessionTabProvider value={mount}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
          // Edge-only back gesture — see moments/_layout.tsx (iOS 26 flipped
          // the RNS full-screen-swipe default to true).
          fullScreenGestureEnabled: false,
          // The themed status-bar default for every screen here, mirroring the
          // root Stack's: UIKit may ask this contained modal itself, and a
          // screen without a style reports `auto` (the phone's appearance, not
          // the theme). Photo-hero screens override it (and forward it to the
          // root, lib/forwardedStatusBar, for the channel that asks the root).
          statusBarStyle: theme.scheme === 'dark' ? 'light' : 'dark',
          statusBarAnimation: 'fade',
        }}
      >
        {/* The post detail: transparent (the feed shows through while it
            opens), no native back gesture — the pull-down IS its dismiss, and
            an edge-swipe would pop the outer modal without reversing the
            presentation. */}
        <Stack.Screen
          name="index"
          options={{ gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }}
        />
        {/* The post edit, started inside the post: a PUSH that slides up and
            has no swipe-back, so it reads like the outer full-screen edit
            (Simon, 2026-07-18) without presenting a native modal over the
            contained post, which hung the app (device pass 2026-11-10). Both
            stages, like the outer ones. */}
        <Stack.Screen name="edit/[postId]" options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
        <Stack.Screen name="edit/details" options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
      </Stack>
    </SessionTabProvider>
  );
}
