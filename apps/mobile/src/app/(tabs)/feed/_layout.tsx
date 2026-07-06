import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

// The Feed tab is a stack: the feed list (03·12) → the full impression
// detail page (proposal 08 §3) pushes within the tab, keeping the bottom
// nav visible (mirrors the Moments stack). In-flow screens draw their own
// chrome (VBar / collapsing hero), not the native header.
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
