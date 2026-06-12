import { ActivityIndicator, Pressable, type PressableProps, type ViewStyle } from 'react-native';
import { control, radius, typeScale, useTheme } from '@/theme';
import { alpha, mix } from '@/theme/color';
import { VText } from './VText';

type Variant = 'primary' | 'positive' | 'secondary' | 'tertiary' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<PressableProps, 'children' | 'style'> {
  title: string;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  // .btn-bar — squarer corners for full-width footer action bars
  bar?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

const HEIGHTS: Record<Size, number> = { sm: control.hSm, md: control.h, lg: control.hLg };
const PAD: Record<Size, number> = { sm: 14, md: 20, lg: 26 };
// .btn label scale: small / body / bodyLg sizes + their tracking, line-height 1
const LABEL: Record<Size, { size: number; tracking: number }> = {
  sm: { size: typeScale.small.size, tracking: typeScale.small.trackingPx },
  md: { size: typeScale.body.size, tracking: typeScale.body.trackingPx },
  lg: { size: typeScale.bodyLg.size, tracking: typeScale.bodyLg.trackingPx },
};

export function Button({ title, variant = 'primary', size = 'md', block, bar, loading, disabled, style, ...rest }: Props) {
  const { theme } = useTheme();

  const colors = (pressed: boolean): { bg: string; text: string; border?: string } => {
    switch (variant) {
      case 'primary':
        return { bg: pressed ? mix(theme.accent, theme.press, 0.82) : theme.accent, text: theme.accentInk };
      case 'positive':
        return { bg: pressed ? mix(theme.positive, theme.press, 0.8) : theme.positive, text: theme.positiveInk };
      case 'danger':
        return { bg: pressed ? mix(theme.critical, theme.press, 0.82) : theme.critical, text: theme.criticalInk };
      case 'secondary':
        // .btn-secondary: 28% ink border, 42% + sunk bg on press
        return {
          bg: pressed ? theme.surfaceSunk : 'transparent',
          text: theme.ink,
          border: alpha(theme.ink, pressed ? 0.42 : 0.28),
        };
      case 'tertiary':
        return { bg: pressed ? theme.accentTint : 'transparent', text: theme.accent };
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      {...rest}
      style={({ pressed }) => {
        const c = colors(pressed);
        return [
          {
            height: bar ? control.hLg : HEIGHTS[size],
            paddingHorizontal: variant === 'tertiary' ? 12 : PAD[size],
            borderRadius: bar ? radius.md : radius.pill,
            backgroundColor: c.bg,
            borderWidth: c.border ? 1 : 0,
            borderColor: c.border,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 8,
            opacity: disabled ? 0.4 : 1,
            transform: pressed ? [{ scale: 0.975 }] : undefined,
          },
          block ? { width: '100%' } : null,
          style,
        ];
      }}
    >
      {({ pressed }) => {
        const c = colors(pressed);
        const label = LABEL[size];
        return loading ? (
          <ActivityIndicator color={c.text} />
        ) : (
          <VText
            color={c.text}
            style={{
              fontFamily: 'InstrumentSans_600SemiBold',
              fontSize: label.size,
              lineHeight: label.size,
              letterSpacing: label.tracking,
            }}
          >
            {title}
          </VText>
        );
      }}
    </Pressable>
  );
}
