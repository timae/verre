import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
  useFonts,
} from '@expo-google-fonts/instrument-sans';
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
  Stack,
  ThemeProvider as NavThemeProvider,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { authClient } from '@/lib/authClient';
import { dismissKeyboardOnOutsideTouch } from '@/lib/keyboardDismiss';
import { QueryProvider } from '@/lib/query';
import { consumePendingUpdateRequired } from '@/lib/updateGate';
import { ThemeProvider, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

// ⚠️ THE SPLASH MUST NOT WAIT ON THE NETWORK INDEFINITELY.
// `authClient.useSession()` fetches /api/auth/native/get-session, and RN fetch
// has NO default timeout (the same trap apiFetch.ts guards with an
// AbortController — the auth client does not route through it). With the server
// unreachable the request hangs on the OS TCP timeout, so gating first paint on
// `!isPending` alone left the app on a dark screen for 30–60s+.
//
// After this deadline we paint regardless. The session query keeps resolving in
// the background; when it lands, `session` flips and the Stack.Protected guard
// swaps to the tabs on its own. Painting early is safe because the UNRESOLVED
// state is treated as SIGNED OUT, which is the same thing an unreachable server
// means in practice — and a signed-out welcome screen is a far better failure
// mode than an indefinite black screen.
const SPLASH_MAX_WAIT_MS = 2500;

function RootNavigator() {
  const { theme } = useTheme();
  const { data: session, isPending } = authClient.useSession();
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const ready = !isPending || waitedTooLong;

  useEffect(() => {
    if (!isPending) return;
    const t = setTimeout(() => setWaitedTooLong(true), SPLASH_MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, [isPending]);

  useEffect(() => {
    if (!ready) return;
    SplashScreen.hideAsync();
    // A 426 from the first get-session lands before the navigator exists and
    // is buffered (lib/updateGate.ts) — route it now that the Stack is up.
    consumePendingUpdateRequired();
  }, [ready]);

  // Theme react-navigation's base palette so any screen that falls back to
  // colors.background (e.g. a leaf tab with no contentStyle) renders on theme.bg
  // instead of the default near-white/black — one source of truth for the
  // screen base across every tab.
  const navTheme = useMemo(() => {
    const base = theme.scheme === 'dark' ? NavDarkTheme : NavDefaultTheme;
    return { ...base, colors: { ...base.colors, background: theme.bg, card: theme.surface, text: theme.ink, border: theme.rule } };
  }, [theme]);

  if (!ready) return null;

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      {/* fullScreenGestureEnabled false: edge-only back gesture — see
          moments/_layout.tsx (iOS 26 flipped the RNS default to true). */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg }, fullScreenGestureEnabled: false }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        {/* Outside both guards: must be reachable in any auth state (proposal 04). */}
        <Stack.Screen name="update-required" options={{ gestureEnabled: false }} />
        {/* 🔒 Legal surfaces sit outside BOTH guards for the same reason: the
            attributions are a LICENCE OBLIGATION and must render for a
            signed-out user, on first launch, before any account exists. Inside
            (tabs) they would be session-gated and unreachable exactly when
            someone evaluating the app wants to read them. */}
        <Stack.Screen name="about" />
        <Stack.Screen name="attributions" />
      </Stack>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
  });

  if (!fontsLoaded) return null;

  return (
    // Gesture-handler requires the root wrapper to register its native gesture
    // system — the score-input Pan/Tap gestures (and @gorhom/bottom-sheet's pan)
    // depend on it. The BottomSheetModalProvider is NOT here: it's mounted
    // per-screen (see moments/session/[code] + moments/create), because a root
    // provider's gorhom host measures zero height across the expo-router/
    // react-native-screens Stack boundary and sheets never present (gorhom
    // #1884/#2035).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <QueryProvider>
          {/* Tap anywhere outside a text input → keyboard leaves, tap still
              lands (capture returns false; registry in lib/keyboardDismiss). */}
          <View style={{ flex: 1 }} onStartShouldSetResponderCapture={dismissKeyboardOnOutsideTouch}>
            <RootNavigator />
          </View>
        </QueryProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
