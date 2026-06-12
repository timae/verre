import { forwardRef, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { control, radius, typeScale, useTheme } from '@/theme';
import { VText } from './VText';

interface Props extends TextInputProps {
  label?: string;
  error?: string;
}

// .field: 14px h-padding, 1px rule border at rest; focus = accent border + inset
// 1px ring (≈2px) — RN has no inset shadow, so focus thickens the border to 2px
// (borders draw inside the bounds: no sibling layout shift) and the padding
// compensates by 1px so the text doesn't nudge.
export const TextField = forwardRef<TextInput, Props>(function TextField(
  { label, error, style, onFocus, onBlur, editable, ...rest },
  ref,
) {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? theme.critical : focused ? theme.accent : theme.rule;
  return (
    <View style={{ gap: 7 }}>
      {label ? (
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: typeScale.small.size }}>{label}</VText>
      ) : null}
      <TextInput
        {...rest}
        ref={ref}
        editable={editable}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        placeholderTextColor={theme.inkFaint}
        style={[
          {
            height: control.h,
            fontFamily: 'InstrumentSans_400Regular',
            fontSize: typeScale.body.size,
            color: theme.ink,
            backgroundColor: editable === false ? theme.surfaceSunk : theme.surface,
            borderWidth: focused ? 2 : 1,
            borderColor,
            borderRadius: radius.sm,
            paddingHorizontal: focused ? 13 : 14,
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
