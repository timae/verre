import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { STAR_PATH, formatScore } from '@verre/core';
import { useTheme } from '@/theme';
import { VText } from '@/components/ui/VText';

// Score display = ONE STAR + VALUE everywhere (handoff §4) — never five-star
// rows in dense surfaces. Pixel spec .sv1/.scorenum: accent star AND accent
// number, 15/600, gap 4. 0 means "not rated"; callers decide whether to
// render this at all for 0.
export function StarScore({ value, size = 15 }: { value: number; size?: number }) {
  const { theme } = useTheme();
  // .sv1 svg runs slightly larger than the number (17px beside 15px).
  const starSize = Math.round(size * (17 / 15));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Svg width={starSize} height={starSize} viewBox="0 0 24 24">
        <Path d={STAR_PATH} fill={theme.accent} />
      </Svg>
      <VText
        color="accent"
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: size, lineHeight: Math.round(size * 1.2) }}
      >
        {formatScore(value)}
      </VText>
    </View>
  );
}
