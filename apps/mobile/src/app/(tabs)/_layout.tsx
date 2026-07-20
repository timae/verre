import { usePathname, useRouter } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { PillTabBar } from '@/components/PillTabBar';
import { useTabBarOverlayHidden } from '@/lib/sheetVisibility';
import { useTheme } from '@/theme';

// The brand floating-pill bottom nav (ADR-0006, supersedes the bottom-nav
// slice of the 2026-06-12 native-chrome ruling). We shipped NativeTabs first
// per that ruling; in use on iOS 26 the OS bar scrambled — selected-label
// truncation ("Mo…") + item misalignment after returning from stack screens
// (upstream, open, no fix path: expo#42364, react-navigation#12908) — and its
// colors drifted (expo#44029 labelStyle ignored on iOS; expo#40389 glass
// light/dark recompute; Liquid Glass frosting varies per content). The ruling
// itself deferred a custom bar "until the core screens exist and we can judge
// it in use" — judged: Simon called it broken on-device (2026-07-02). The
// pill is the design's own .tabbar-float anyway; classic JS tabs render it
// deterministically. NativeTabs' baseline quirks (SF-symbol optical boxes)
// went with it.
export default function TabsLayout() {
  const { theme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  // Hide the pill while any bottom sheet is open (the sheet sits above it,
  // in-screen, no FullWindowOverlay) OR while blind Reveal mode is active on
  // the line-up (the sticky "Done" footer replaces the nav) — see
  // lib/sheetVisibility.ts.
  const overlayHidesBar = useTabBarOverlayHidden();
  const [keyboardShown, setKeyboardShown] = useState(false);

  // Cold-start anchor. Kept from the NativeTabs era (classic tabs would honor
  // initialRouteName, but the replace also covers a stray "/feed" cold start):
  // with no index route "/" lands on the first trigger (Feed) — snap the very
  // first mount to Moments; any real deep link (session URL etc.) has a
  // different pathname and is left alone. Caveat: a genuine /feed deep link at
  // cold start would be snapped too — acceptable until feed deep links exist;
  // revisit with the Universal-Links milestone.
  const anchored = useRef(false);
  useEffect(() => {
    if (anchored.current) return;
    anchored.current = true;
    if (pathname === '/' || pathname === '/feed') router.replace('/moments');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const setShown = (shown: boolean) => {
      setKeyboardShown((current) => (current === shown ? current : shown));
    };
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setShown(true));
    const hide = Keyboard.addListener(hideEvent, () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // The design ruling "in-flow footer actions replace the nav while
  // rating/creating": 02e (Previous / Save & next), 02a (Create), 02b·add
  // (Add to line-up), and the 02f settings sub-screens (Moment details /
  // Moment Setup, Discard / Save) carry their own action bars — hide the
  // pill there. The settings HUB keeps the bar (it's a nav list, no footer).
  const hidden =
    overlayHidesBar ||
    keyboardShown ||
    // Matches BOTH impression surfaces: 02e (/moments/…/impression/, footer
    // bar replaces the nav) AND the read-only feed detail (/feed/impression/,
    // no footer — Simon's ruling 2026-07-08: immersive, no bottom nav; the
    // floating back button is the only chrome).
    pathname.includes('/impression/') ||
    pathname.includes('/edit-impression/') ||
    pathname.endsWith('/moments/create') ||
    pathname.includes('/feed/check-in') || // both check-in create stages (sticky Rate It / Check In bars)
    pathname.includes('/feed/edit') || // feed-post edit screens (sticky Save/Done bars)
    pathname.endsWith('/add') ||
    pathname.endsWith('/settings/details') ||
    pathname.endsWith('/settings/reveal');

  return (
    <Tabs
      // The pill floats over content (absolute) — hiding it is just not
      // rendering it; scenes never resize (no layout jump on hide/show).
      tabBar={(props) => (hidden ? null : <PillTabBar {...props} />)}
      // sceneStyle themes every tab's screen background (replaces the
      // NativeTabs per-trigger contentStyle: Feed/Soon have no Stack _layout,
      // so without this they'd render on react-navigation's default
      // near-white; Moments/You also get theme.bg from their inner Stacks).
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: theme.bg } }}
    >
      <Tabs.Screen name="feed" options={{ title: 'Feed' }} />
      <Tabs.Screen name="moments" options={{ title: 'Moments' }} />
      <Tabs.Screen name="soon" options={{ title: 'Soon' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
