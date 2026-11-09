import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedList } from '@/components/feed/FeedList';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { GUTTER, usePhoneTokens } from '@/lib/layout';
import { radius, space, useTheme } from '@/theme';

// The feed tab (proposal 08). An infinite, focus-refreshed list of the
// caller's network posts — the shared FeedList (also behind every profile)
// under the root title bar. Scene background comes from the tabs layout's
// shared sceneStyle.

export default function Feed() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <FeedList
      contentTopPad={insets.top + space.md}
      centerLoading
      header={
        // .vbar-root — top-right carries the page's primary action as the
        // .hv-add accent pill ("+ Check In" → the standalone create form).
        <View style={{ paddingHorizontal: GUTTER, paddingBottom: space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <VText variant="title">Feed</VText>
          <CheckInPill onPress={() => router.push('/feed/check-in')} />
        </View>
      }
      empty={
        <CenteredMessage
          title="Nothing here yet"
          body="Follow other tasters or join a moment. What your network drinks shows up here."
        />
      }
    />
  );
}

// .hv-add base — accent pill (the moments-home NewPill shape; still a copy —
// the <IconPill> extraction in apps/mobile/CLAUDE.md stays pending).
function CheckInPill({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  const actionLabel = phone.text('small');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New check-in"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: surface.height(phone.size('actionPillHeight')),
        paddingLeft: phone.lerp(11, 14),
        paddingRight: phone.lerp(14, 17),
        borderRadius: radius.pill,
        backgroundColor: theme.accent,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name="plus" size={phone.size('actionIcon')} color={theme.accentInk} />
      <VText surface="button" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...actionLabel, color: theme.accentInk }}>
        Check In
      </VText>
    </Pressable>
  );
}
