import { usePathname, useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useRef } from 'react';
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

  return (
    <NativeTabs
      tintColor={theme.accent}
      backgroundColor={theme.surface}
      iconColor={theme.inkSoft}
      labelStyle={{ default: { color: theme.inkSoft }, selected: { color: theme.accent } }}
    >
      <NativeTabs.Trigger name="feed">
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="moments">
        <NativeTabs.Trigger.Label>Moments</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="wineglass" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="soon">
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
