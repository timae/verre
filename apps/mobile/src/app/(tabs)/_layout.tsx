import { usePathname, useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useTabBarOverlayHidden } from '@/lib/sheetVisibility';
import { useTheme } from '@/theme';

// The real OS tab bar (locked design ruling, 2026-06-12: bottom nav is
// native-chrome — the design's floating pill mimics the iOS 26 bar, so we use
// the genuine one, tint-only: accent/bg/label colors from theme tokens, OS
// physics and iconography). The 4th slot's purpose (explore vs notifications)
// is undecided — it ships as a tappable "Soon" tab with an empty state.
export default function TabsLayout() {
  const { theme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  // Hide the OS tab bar while any bottom sheet is open (so the sheet sits above
  // it, in-screen, no FullWindowOverlay) OR while blind Reveal mode is active on
  // the line-up (the sticky "Done" footer replaces the nav) — see
  // lib/sheetVisibility.ts.
  const overlayHidesBar = useTabBarOverlayHidden();
  const [keyboardShown, setKeyboardShown] = useState(false);

  // Cold-start anchor. NativeTabs honors neither initialRouteName nor
  // unstable_settings (verified in the SDK 56 navigator source — the options
  // are never forwarded), so with no index route "/" lands on the first
  // trigger (Feed). Snap the very first mount to Moments; any real deep link
  // (session URL etc.) has a different pathname and is left alone. Caveat: a
  // genuine /feed deep link at cold start would be snapped too — acceptable
  // until feed deep links exist; revisit with the Universal-Links milestone.
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

  return (
    <NativeTabs
      // KNOWN iOS-26 LIMITATION (parked — revisit after core screens): the
      // native UITabBar is OS-controlled "Liquid Glass" on iOS 26. It is
      // translucent, frosts whatever content scrolls under it (so the tint
      // varies per tab), and recomputes its light/dark on tab re-entry
      // (expo/expo #40389). This is documented UIKit behavior — backgroundColor
      // / blurEffect:'none' do NOT force opacity on iOS 26 (verified on-device
      // after a clean rebuild). The only true fix for full consistency is a
      // custom JS tab bar (would reverse the native-chrome design ruling),
      // deferred until the core screens exist and we can judge it in use.
      // Props below are best-effort tint + the pre-26 fallback.
      // ALSO parked here: the per-tab label baseline differs because the OS
      // renders each SF symbol with its own optical box (hourglass/person sit
      // lower than house/wineglass) and NativeTabs exposes no icon-size/offset
      // prop — a custom bar would fix this alignment too.
      tintColor={theme.accent}
      backgroundColor={theme.surface}
      // Removes one source of variation: stops the scroll-edge appearance going
      // fully transparent (correct regardless of the glass-override above).
      disableTransparentOnScrollEdge
      iconColor={theme.inkSoft}
      labelStyle={{ default: { color: theme.inkSoft }, selected: { color: theme.accent } }}
      // The design ruling "in-flow footer actions replace the nav while
      // rating/creating": 02e (Previous / Save & next), 02a (Create), 02b·add
      // (Add to line-up), and the 02f settings sub-screens (Moment details /
      // Reveal & blind, Discard / Save) carry their own action bars — hide the
      // OS tab bar there. The settings HUB keeps the bar (it's a nav list, no
      // footer).
      hidden={
        overlayHidesBar ||
        keyboardShown ||
        pathname.includes('/impression/') ||
        pathname.endsWith('/moments/create') ||
        pathname.endsWith('/add') ||
        pathname.endsWith('/settings/details') ||
        pathname.endsWith('/settings/reveal')
      }
    >
      {/* contentStyle themes each leaf tab's SCREEN background. Feed/Soon have
          no Stack _layout, so without this they'd render on react-navigation's
          default near-white; Moments/You get theme.bg from their inner Stack
          _layout. (Also makes the glass bar frost theme.bg rather than white on
          these screens — partial mitigation, not a full fix per the note above.) */}
      <NativeTabs.Trigger name="feed" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="moments">
        <NativeTabs.Trigger.Label>Moments</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="wineglass" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="soon" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Label>Soon</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="hourglass" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'person', selected: 'person.fill' }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
