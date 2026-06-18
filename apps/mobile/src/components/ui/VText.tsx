import { Text, type TextProps } from 'react-native';
import { usePhoneTokens, type FontSurfaceName } from '@/lib/layout';
import { textStyle, useTheme, type TextVariant, type ThemeColors } from '@/theme';

type ColorToken = 'ink' | 'inkSoft' | 'inkFaint' | 'accent' | 'positive' | 'caution' | 'critical';

interface Props extends TextProps {
  variant?: TextVariant;
  color?: ColorToken | (string & {});
  surface?: FontSurfaceName;
}

export function VText({ variant = 'body', color = 'ink', surface, style, ...rest }: Props) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const resolved = color in theme ? theme[color as keyof ThemeColors] : color;
  const surfaceTextProps = surface ? phone.surface(surface).textProps : null;
  return <Text {...rest} {...surfaceTextProps} style={[textStyle(variant), phone.text(variant), { color: resolved as string }, style]} />;
}
