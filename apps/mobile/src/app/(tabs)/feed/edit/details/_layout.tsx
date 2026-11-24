import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

// The check-in edit's details as a route BOUNDARY with its own stack (ruled
// 2026-11-22: the "Add Wine to Catalogue" pages are real pages). On a tab stack
// the pages push INSIDE this boundary: the form is `index`, the pages are
// `catalog/…` (lib/sessionStack.ts catalogHref). It was needed while the
// details were a `fullScreenModal` (a card pushed above a modal lands BEHIND
// it); since 2026-11-24 the details are a plain push there too and the
// boundary simply stays (flattening it is a later cleanup). On an opened
// post's stack its pages are siblings.
export const unstable_settings = { anchor: 'index' };

export default function EditDetailsStack() {
  const { theme } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.bg },
        // Edge-only back gesture (iOS 26 flipped the RNS default; every Stack
        // layout sets it, apps/mobile/CLAUDE.md).
        fullScreenGestureEnabled: false,
      }}
    />
  );
}
