import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

// The check-in edit's details as a route BOUNDARY with its own stack (ruled
// 2026-11-22: the "Add Wine to Catalogue" pages are real pages). On a tab stack
// the details are a `fullScreenModal` (feed/_layout.tsx), and a card pushed
// above a modal lands BEHIND it (expo-router NativeStackView warns), so the
// pages push INSIDE this boundary: the form is `index`, the pages are
// `catalog/…` (lib/sessionStack.ts catalogHref). On an opened post's stack the
// details stay a plain card and its pages are siblings there.
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
