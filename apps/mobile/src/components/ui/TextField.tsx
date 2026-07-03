import { forwardRef, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { usePhoneTokens, type FontSurfaceName } from '@/lib/layout';
import { control, radius, useTheme } from '@/theme';
import { VText } from './VText';

interface Props extends TextInputProps {
  label?: string;
  error?: string;
  surface?: FontSurfaceName;
}

// .field: 14px h-padding, 1px rule border at rest; focus = accent border + inset
// 1px ring (≈2px) — RN has no inset shadow, so focus thickens the border to 2px
// (borders draw inside the bounds: no sibling layout shift) and the padding
// compensates by 1px so the text doesn't nudge.
export const TextField = forwardRef<TextInput, Props>(function TextField(
  { label, error, surface: surfaceName = 'formControl', style, onFocus, onBlur, editable, ...rest },
  ref,
) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface(surfaceName);
  const fieldHeight = surface.height(control.h);
  const text = phone.text('body');
  // lineHeight = 1.2× fontSize — the empirically centered value of a
  // three-state trap, each state device-confirmed with Instrument Sans:
  //   · PARAGRAPH lineHeight (body's 1.53×): glyphs biased DOWN.
  //   · NO lineHeight: entered text centers, PLACEHOLDER sits high (Fabric).
  //   · COMPACT (1.0×): BOTH sit high — the box crops the font's descent
  //     share (natural line ≈ 1.2 em), so iOS seats glyphs high in it.
  // 1.2× ≈ the font's own ascent+descent: placeholder and entered text
  // track together and center. Overriding fontSize? Override lineHeight to
  // 1.2× the same value. The surface cap (maxFontSizeMultiplier) bounds how
  // large the OS can scale the glyph within the scaled height.
  const [focused, setFocused] = useState(false);
  const borderColor = error ? theme.critical : focused ? theme.accent : theme.rule;
  return (
    <View style={{ gap: 7 }}>
      {label ? (
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{label}</VText>
      ) : null}
      <TextInput
        {...rest}
        ref={ref}
        editable={editable}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        placeholderTextColor={theme.inkFaint}
        {...surface.textProps}
        style={[
          {
            height: fieldHeight,
            fontFamily: 'InstrumentSans_400Regular',
            fontSize: text.fontSize,
            lineHeight: Math.round(text.fontSize * 1.2),
            color: theme.ink,
            backgroundColor: editable === false ? theme.surfaceSunk : theme.surface,
            borderWidth: focused ? 2 : 1,
            borderColor,
            borderRadius: radius.sm,
            paddingHorizontal: focused ? 13 : 14,
            paddingVertical: 0,
            textAlignVertical: 'center',
            opacity: editable === false ? 0.55 : 1,
          },
          style,
        ]}
      />
      {error ? (
        <VText variant="caption" color="critical">{error}</VText>
      ) : null}
    </View>
  );
});
