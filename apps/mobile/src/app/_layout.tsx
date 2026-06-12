import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  useFonts,
} from '@expo-google-fonts/instrument-sans';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { authClient } from '@/lib/authClient';
import { QueryProvider } from '@/lib/query';
import { consumePendingUpdateRequired } from '@/lib/updateGate';
import { ThemeProvider, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function RootNavigator() {
  const { theme } = useTheme();
  const { data: session, isPending } = authClient.useSession();
  const ready = !isPending;

  useEffect(() => {
    if (!ready) return;
    SplashScreen.hideAsync();
    // A 426 from the first get-session lands before the navigator exists and
    // is buffered (lib/updateGate.ts) — route it now that the Stack is up.
    consumePendingUpdateRequired();
  }, [ready]);

  if (!ready) return null;

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        {/* Outside both guards: must be reachable in any auth state (proposal 04). */}
        <Stack.Screen name="update-required" options={{ gestureEnabled: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
  });

  if (!fontsLoaded) return null;

  return (
    <ThemeProvider>
      <QueryProvider>
        <RootNavigator />
      </QueryProvider>
    </ThemeProvider>
  );
}
