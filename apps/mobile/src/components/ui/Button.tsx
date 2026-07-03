import { useEffect, useState } from 'react';
import { Pressable, type PressableProps, type ViewStyle } from 'react-native';
import { usePhoneTokens } from '@/lib/layout';
import { control, radius, useTheme, type TextVariant } from '@/theme';
import { alpha, mix } from '@/theme/color';
import { VText } from './VText';

// onlight/ghostlight = the design's over-photo skins (.btn-onlight /
// .btn-ghostlight, welcome screen). Theme-INDEPENDENT by spec — they sit on a
// photo, not a themed surface, so their literals are sanctioned (the same
// carve-out as GLASS_FILL/HERO_SCRIM).
type Variant = 'primary' | 'positive' | 'secondary' | 'tertiary' | 'danger' | 'onlight' | 'ghostlight';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<PressableProps, 'children' | 'style'> {
  title: string;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  // .btn-bar — squarer corners for full-width footer action bars
  bar?: boolean;
  loading?: boolean;
  // Shown in place of `title` when `loading` outlasts the slow threshold
  // (e.g. "Saving…"). Without it, a slow action just stays dimmed.
  loadingTitle?: string;
  style?: ViewStyle;
}

// In-flight feedback (Simon's ruling, 2026-06-12): no spinner. The button
// dims immediately on `loading` (action acknowledged, double-tap blocked);
// only when the request outlasts this threshold does the label swap to
// `loadingTitle` — fast saves never flash an indicator.
const SLOW_AFTER_MS = 500;

const HEIGHTS: Record<Size, number> = { sm: control.hSm, md: control.h, lg: control.hLg };
const PAD: Record<Size, number> = { sm: 14, md: 20, lg: 26 };
// .btn label scale: small / body / bodyLg.
const LABEL_VARIANT: Record<Size, TextVariant> = { sm: 'small', md: 'body', lg: 'bodyLg' };

export function Button({ title, variant = 'primary', size = 'md', block, bar, loading, loadingTitle, disabled, style, ...rest }: Props) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [loading]);

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
      case 'onlight':
        return { bg: pressed ? '#e9e5e1' : '#ffffff', text: '#1a1512' };
      case 'ghostlight':
        return {
          bg: pressed ? 'rgba(255,255,255,0.14)' : 'transparent',
          text: '#ffffff',
          border: `rgba(255,255,255,${pressed ? 0.7 : 0.5})`,
        };
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
            minHeight: surface.height(bar ? control.hLg : HEIGHTS[size]),
            paddingHorizontal: variant === 'tertiary' ? 12 : PAD[size],
            borderRadius: bar ? radius.md : radius.pill,
            backgroundColor: c.bg,
            borderWidth: c.border ? 1 : 0,
            borderColor: c.border,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 8,
            opacity: disabled ? 0.4 : loading ? 0.55 : 1,
            // Always an array — a conditional `undefined` transform key reaches
            // RN's _validateTransforms as null and crashes (processTransform:142).
            transform: [{ scale: pressed ? 0.975 : 1 }],
          },
          block ? { width: '100%' } : null,
          style,
        ];
      }}
    >
      {({ pressed }) => {
        const c = colors(pressed);
        return (
          <VText
            variant={LABEL_VARIANT[size]}
            surface="button"
            color={c.text}
            style={{
              fontFamily: 'InstrumentSans_600SemiBold',
            }}
          >
            {loading && slow && loadingTitle ? loadingTitle : title}
          </VText>
        );
      }}
    </Pressable>
  );
}
