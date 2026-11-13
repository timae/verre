import { Pressable } from 'react-native';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// .hv-add — the bar's accent pill with a glyph (34h, glyph 17, label small
// 600, pad 0 14 0 11): the metrics of the Feed's Check In pill and Moments
// home's NewPill, extracted for the profile lists' "+ Check In" / "+ New" and
// People's "+ Add" (the older copies migrate when next touched).
export function IconPill({ icon, label, accessibilityLabel, onPress }: { icon: IconName; label: string; accessibilityLabel?: string; onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
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
      <Icon name={icon} size={phone.size('actionIcon')} color={theme.accentInk} />
      <VText surface="button" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: theme.accentInk }}>
        {label}
      </VText>
    </Pressable>
  );
}
