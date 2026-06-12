import { Text, type TextProps } from 'react-native';
import { textStyle, useTheme, type TextVariant, type ThemeColors } from '@/theme';

type ColorToken = 'ink' | 'inkSoft' | 'inkFaint' | 'accent' | 'positive' | 'caution' | 'critical';

interface Props extends TextProps {
  variant?: TextVariant;
  color?: ColorToken | (string & {});
}

export function VText({ variant = 'body', color = 'ink', style, ...rest }: Props) {
  const { theme } = useTheme();
  const resolved = color in theme ? theme[color as keyof ThemeColors] : color;
  return <Text {...rest} style={[textStyle(variant), { color: resolved as string }, style]} />;
}
