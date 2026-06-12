import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '@/theme';

// The real OS tab bar (locked design ruling, 2026-06-12: bottom nav is
// native-chrome — the design's floating pill mimics the iOS 26 bar, so we use
// the genuine one, tint-only: accent/bg/label colors from theme tokens, OS
// physics and iconography). The 4th slot's purpose (explore vs notifications)
// is undecided — it ships as a tappable "Soon" tab with an empty state.
// There is no index route in (tabs) — "/" resolves to the guard-blocked
// (auth) index when logged in, and the router redirects into this navigator
// at its anchor. The anchor must be Moments, not the first trigger (Feed).
export const unstable_settings = { initialRouteName: 'moments' };

export default function TabsLayout() {
  const { theme } = useTheme();
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
