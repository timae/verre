import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { STAR_PATH, formatScore } from '@verre/core';
import { useTheme } from '@/theme';
import { VText } from '@/components/ui/VText';

// Score display = ONE STAR + VALUE everywhere (handoff §4) — never five-star
// rows in dense surfaces. 0 means "not rated"; callers decide whether to
// render this at all for 0.
export function StarScore({ value, size = 14 }: { value: number; size?: number }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={STAR_PATH} fill={theme.accent} />
      </Svg>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {formatScore(value)}
      </VText>
    </View>
  );
}
