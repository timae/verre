import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

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
      }}
    />
  );
}
