import { Stack } from 'expo-router';
import { textStyle, useTheme } from '@/theme';

// The Moments tab is a stack: home (02s) → recents (02s·2) / session line-up
// (02b) push within the tab, keeping the bottom nav visible (the prototype
// shows the global nav inside a session too).
export default function MomentsStack() {
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
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="recents" options={{ title: 'Recent moments' }} />
      <Stack.Screen name="session/[code]" options={{ title: '' }} />
    </Stack>
  );
}
