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
        ? { bg: alpha(theme.positive, 0.16), text: theme.positive }
        : { bg: theme.surfaceSunk, text: theme.inkSoft };
  // .pl-role pixel spec: 10.5/600, uppercase, 0.04em tracking, 2×8 padding.
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
      <VText
        color={tone.text}
        style={{
          fontFamily: 'InstrumentSans_600SemiBold',
          fontSize: 10.5,
          // Tight line box so the 2px padding hugs the glyphs (flat chip, like
          // the .ovc-map pill). Without an explicit lineHeight, VText's default
          // multiplier inflates the text box and the chip reads tall.
          lineHeight: 13,
          letterSpacing: 0.42,
          textTransform: 'uppercase',
        }}
      >
        {LABELS[role]}
      </VText>
    </View>
  );
}
