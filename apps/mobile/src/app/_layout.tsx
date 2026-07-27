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
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { authClient } from '@/lib/authClient';
import { dismissKeyboardOnOutsideTouch } from '@/lib/keyboardDismiss';
import { QueryProvider } from '@/lib/query';
import { markUpdateNavigationReady } from '@/lib/updateGate';
import { ThemeProvider, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

// ⚠️ THE SPLASH MUST NOT WAIT ON THE NETWORK INDEFINITELY.
// `authClient.useSession()` fetches /api/auth/native/get-session, and RN fetch
// has NO default timeout (the same trap apiFetch.ts guards with an
// AbortController — the auth client does not route through it). With the server
// unreachable the request hangs on the OS TCP timeout, so gating first paint on
// `!isPending` alone left the app on a dark screen for 30–60s+.
//
// After this deadline the native splash is hidden regardless, so the app is
// never stuck on a black screen.
//
// 🔒 BUT THE DEADLINE MUST NOT RESOLVE "UNKNOWN" AS "SIGNED OUT". `session` is
// still `undefined` while pending, so activating the guards at that moment would
// select the AUTH group — and a user whose session resolves a second later has
// already been redirected away from the protected deep link they launched into,
// after a flash of the welcome screen. The route set stays UNDECIDED until the
// session actually resolves; only the splash goes away, replaced by a neutral
// themed screen. Four timing paths, all deliberate:
//   • resolves before the deadline  → normal boot, no neutral state at all
//   • resolves after the deadline, authenticated → tabs, deep link intact
//   • resolves after the deadline, unauthenticated/error → welcome
//   • 426 at any point → update-required (buffered via lib/updateGate.ts,
//     and its screen sits outside both guards so it renders either way)
const SPLASH_MAX_WAIT_MS = 2500;

function RootNavigator() {
  const { theme } = useTheme();
  const { data: session, isPending } = authClient.useSession();
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  // Hide the splash once EITHER the session resolved or we waited long enough.
  const splashCanHide = !isPending || waitedTooLong;
  // ...but only mount a route GROUP once the session is actually known.
  const sessionResolved = !isPending;

  useEffect(() => {
    if (!isPending) return;
    const t = setTimeout(() => setWaitedTooLong(true), SPLASH_MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, [isPending]);

  useEffect(() => {
    if (!splashCanHide) return;
    SplashScreen.hideAsync();
  }, [splashCanHide]);

  useEffect(() => {
    // 🔒 Mark navigation ready ONLY once the resolved-session Stack below has
    // actually committed — a buffered 426 is replaced into it at that moment
    // (lib/updateGate.ts). Gated on `sessionResolved`, NOT on the splash
    // deadline: at the deadline neither route group is mounted (the neutral
    // screen renders instead), so there would be no navigator to replace into
    // and the queued action could be silently discarded.
    if (!sessionResolved) return;
    markUpdateNavigationReady();
  }, [sessionResolved]);

  // Theme react-navigation's base palette so any screen that falls back to
  // colors.background (e.g. a leaf tab with no contentStyle) renders on theme.bg
  // instead of the default near-white/black — one source of truth for the
  // screen base across every tab.
  const navTheme = useMemo(() => {
    const base = theme.scheme === 'dark' ? NavDarkTheme : NavDefaultTheme;
    return { ...base, colors: { ...base.colors, background: theme.bg, card: theme.surface, text: theme.ink, border: theme.rule } };
  }, [theme]);

  // Still waiting and still inside the deadline: the native splash is up, so
  // render nothing behind it.
  if (!splashCanHide) return null;

  // Past the deadline with the session STILL pending. Neither route group can
  // be mounted (see the guards below), so there is nothing for the Stack to
  // render — show a neutral themed screen instead of an empty navigator. This
  // is the state a slow or unreachable server lands on, and it deliberately
  // makes NO auth claim: as soon as the session resolves this unmounts and the
  // real route group takes over, deep link intact.
  if (!sessionResolved) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <ActivityIndicator color={theme.inkSoft} />
      </View>
    );
  }

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      {/* fullScreenGestureEnabled false: edge-only back gesture — see
          moments/_layout.tsx (iOS 26 flipped the RNS default to true). */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg }, fullScreenGestureEnabled: false }}>
        {/* 🔒 BOTH guards key on `sessionResolved`, so while the session is
            still pending past the splash deadline NEITHER group is mounted and
            no navigation decision is made. That is what preserves a protected
            deep link: the router has nothing to redirect it to yet, so the
            pending URL survives until the session lands. Do not "simplify"
            these to `guard={!!session}` / `guard={!session}` — that resolves
            unknown as signed out and throws the deep link away. */}
        <Stack.Protected guard={sessionResolved && !!session}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={sessionResolved && !session}>
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
