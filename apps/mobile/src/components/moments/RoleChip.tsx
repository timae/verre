import { View } from 'react-native';
import type { SessionRole } from '@/lib/api/sessions';
import { radius, useTheme } from '@/theme';
import { alpha } from '@/theme/color';
import { VText } from '@/components/ui/VText';

const LABELS: Record<Exclude<SessionRole, null>, string> = {
  host: 'Host',
  cohost: 'Co-host',
  provider: 'Provider',
};

// .pl-role — text-only chip (badges never carry symbols). Host = accent tint,
// Provider = sage/positive tint, Co-host = neutral. Plain tasters get nothing.
export function RoleChip({ role }: { role: SessionRole }) {
  const { theme } = useTheme();
  if (!role) return null;
  const tone =
    role === 'host'
      ? { bg: theme.accentTint, text: theme.accent }
      : role === 'provider'
        ? { bg: alpha(theme.positive, 0.14), text: theme.positive }
        : { bg: theme.surfaceSunk, text: theme.inkSoft };
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: tone.bg,
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <VText variant="caption" color={tone.text} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {LABELS[role]}
      </VText>
    </View>
  );
}
