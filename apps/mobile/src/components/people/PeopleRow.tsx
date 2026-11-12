import { Pressable, View } from 'react-native';
import { FollowButton } from '@/components/profile/ProfileHeader';
import { Avatar } from '@/components/ui/Avatar';
import { VText } from '@/components/ui/VText';
import type { PersonRow } from '@/lib/api/people';
import { usePhoneTokens } from '@/lib/layout';
import { usePersonBusy } from '@/lib/relationship';

// D2 (ruled 2026-11-12): the first that applies, else no line. No
// relationship words and no follow dates: the button beside the row says it.
export function personLine(p: Pick<PersonRow, 'momentsTogether' | 'friendsInCommon'>): string | null {
  const m = p.momentsTogether ?? 0, f = p.friendsInCommon ?? 0;
  if (m > 0) return m === 1 ? '1 moment together' : `${m} moments together`;
  if (f > 0) return f === 1 ? '1 friend in common' : `${f} friends in common`;
  return null;
}

// .sh-row.yo-prow — a person on a People list: the 44pt photo (.yo-pav, grows
// with the device like every list row), the 600 name, the D2 line, one action.
// RecentRow's metrics (gap 12→16, padding 10→16), no separators. The row taps
// through to the profile; the button is its own target. Your own row (someone
// else's list): no line, no button.
export function PeopleRow({
  row, self, onPress, onFollow,
}: {
  row: PersonRow;
  self: boolean;
  onPress: () => void;
  onFollow: () => void;
}) {
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  const busy = usePersonBusy(row.id);
  const line = self ? null : personLine(row);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16) }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={line ? `${row.name}, ${line}` : row.name}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: phone.lerp(12, 16),
          paddingVertical: surface.paddingY(phone.lerp(10, 16)),
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Avatar imageUrl={row.imageUrl} name={row.name} size={phone.grow(44)} />
        <View style={{ flex: 1, minWidth: 0, gap: surface.gap(phone.lerp(2, 4)) }}>
          <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            {row.name}
          </VText>
          {line ? (
            <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>
              {line}
            </VText>
          ) : null}
        </View>
      </Pressable>
      {self ? null : (
        <FollowButton isFollowing={row.isFollowing} followsYou={row.followsViewer} busy={busy} onPress={onFollow} name={row.name} />
      )}
    </View>
  );
}
