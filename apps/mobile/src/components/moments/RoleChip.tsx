import { View, type ViewStyle } from 'react-native';
import type { SessionRole } from '@/lib/api/sessions';
import { usePhoneTokens } from '@/lib/layout';
import { radius, useTheme } from '@/theme';
import { alpha } from '@/theme/color';
import { VText } from '@/components/ui/VText';

const LABELS: Record<Exclude<SessionRole, null>, string> = {
  host: 'Host',
  cohost: 'Co-host',
  provider: 'Provider',
};

const BADGE_MIN_HEIGHT = 22;

export function BadgePill({
  label,
  bg,
  color,
  border,
  uppercase = true,
  paddingHorizontal = 8,
  paddingVertical = 3,
  style,
}: {
  label: string;
  bg: string;
  color: string;
  border?: string;
  uppercase?: boolean;
  paddingHorizontal?: number;
  paddingVertical?: number;
  style?: ViewStyle;
}) {
  const phone = usePhoneTokens();
  const surface = phone.surface('badge');
  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: surface.height(BADGE_MIN_HEIGHT),
          backgroundColor: bg,
          borderRadius: radius.pill,
          paddingHorizontal,
          paddingVertical: surface.paddingY(paddingVertical),
          borderWidth: border ? 1 : 0,
          borderColor: border,
        },
        style,
      ]}
    >
      <VText
        surface="badge"
        variant="caption"
        color={color}
        style={{
          fontFamily: 'InstrumentSans_600SemiBold',
          letterSpacing: uppercase ? phone.text('caption').fontSize * 0.04 : undefined,
          textAlignVertical: 'center',
          textTransform: uppercase ? 'uppercase' : undefined,
        }}
      >
        {label}
      </VText>
    </View>
  );
}

// .pl-role — text-only chip (badges never carry symbols). Host = accent tint,
// Provider = sage/positive tint, Co-host = neutral. Plain tasters get nothing.
export function RoleChip({ role }: { role: SessionRole }) {
  const { theme } = useTheme();
  if (!role) return null;
  const tone =
    role === 'host'
      ? { bg: theme.accentTint, text: theme.accent }
      : role === 'provider'
        ? { bg: alpha(theme.positive, 0.16), text: theme.positive }
        : { bg: theme.surfaceSunk, text: theme.inkSoft };
  // .pl-role pixel spec: 10.5/600, uppercase, 0.04em tracking, 2×8 padding.
  return (
    <BadgePill label={LABELS[role]} bg={tone.bg} color={tone.text} />
  );
}
