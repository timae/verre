import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { alpha } from '@/theme/color';
import { radius, useTheme } from '@/theme';

// .fr-row — a person row in a sheet's list (the moment invite sheet's browse
// pane, Add Friends' search pane): avatar · name + one line · one trailing
// control, a hairline between rows. Defaults = the invite sheet's row: the
// line "Friend", a Joined chip or an Invite button. `onPress` makes the row
// itself a button (its trailing control stays its own target).
export function FriendRow({
  person, first, joined, onInvite, subtitle = 'Friend', trailing, onPress,
}: {
  person: { name: string; imageUrl: string | null };
  first: boolean;
  joined?: boolean;
  onInvite?: () => void;
  subtitle?: string | null;
  trailing?: React.ReactNode;
  onPress?: () => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  const main = (
    <>
      <Avatar imageUrl={person.imageUrl} name={person.name} size={phone.grow(42)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText surface="compactList" variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>{person.name}</VText>
        {subtitle ? <VText surface="compactList" variant="small" color="inkSoft">{subtitle}</VText> : null}
      </View>
    </>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16), paddingVertical: surface.paddingY(phone.lerp(9, 13)), borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft }}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={subtitle ? `${person.name}, ${subtitle}` : person.name}
          onPress={onPress}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16), opacity: pressed ? 0.6 : 1 })}
        >
          {main}
        </Pressable>
      ) : main}
      {trailing !== undefined ? trailing : joined ? (
        <FriendRowBadge label="Joined" />
      ) : (
        <FriendRowButton label="Invite" plus accessibilityLabel={`Invite ${person.name}`} onPress={onInvite} />
      )}
    </View>
  );
}

// .fr-in — the translucent positive ✓ chip (a status, not a button).
export function FriendRowBadge({ label }: { label: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: alpha(theme.positive, 0.14), borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}>
      <Icon name="check" size={14} color={theme.positive} />
      <VText surface="compactList" variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.positive }}>{label}</VText>
    </View>
  );
}

// .fr-btn — the accent pill (Invite, Follow, Follow Back). `plus` = the
// leading + glyph. `busy`: dimmed and inert while its write is in flight.
export function FriendRowButton({
  label, plus, accessibilityLabel, onPress, busy,
}: {
  label: string;
  plus?: boolean;
  accessibilityLabel: string;
  onPress?: () => void;
  busy?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={busy ? { busy: true } : undefined}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: theme.accent, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 8, opacity: busy ? 0.5 : pressed ? 0.85 : 1 })}
    >
      {plus ? <Icon name="plus" size={14} color={theme.accentInk} /> : null}
      <VText surface="compactList" variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accentInk }}>{label}</VText>
    </Pressable>
  );
}
