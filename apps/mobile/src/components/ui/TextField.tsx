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
  // COMPACT lineHeight (== fontSize) on a single-line input — the third state
  // of a two-sided trap: a PARAGRAPH lineHeight (body is 1.53× the font size)
  // biases the glyph DOWN inside the tall line box (descenders crowd the
  // bottom edge — the original device finding), while NO lineHeight at all
  // mis-centers the PLACEHOLDER on Fabric with Instrument Sans (it sat high;
  // Simon caught it in the compare search + add Name fields). lineHeight ==
  // fontSize gives a line box the size of the glyph, which iOS centers —
  // entered text AND placeholder alike. The surface cap (maxFontSizeMultiplier)
  // bounds how large the OS can scale the glyph within the scaled height.
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
            lineHeight: text.fontSize,
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
