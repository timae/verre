import { forwardRef, useRef, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from './Icon';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { usePhoneTokens, type FontSurfaceName } from '@/lib/layout';
import { control, radius, useTheme } from '@/theme';
import { VText } from './VText';

interface Props extends TextInputProps {
  label?: string;
  error?: string;
  /** Red border WITHOUT an inline message (the failing-field flag when a single
   *  form-level summary carries the copy). `error` (a string) still shows both
   *  the border and a per-field message. */
  invalid?: boolean;
  surface?: FontSurfaceName;
  /** When set, the field GROWS from one line up to this many lines as the value
   *  wraps, then scrolls internally. For FULL-WIDTH fields only — a half-width
   *  field in a side-by-side row must stay single-line so its height tracks its
   *  row partner (Simon, 2026-07-21). Omit for the default fixed single line. */
  growLines?: number;
}

// .field: 14px h-padding, 1px rule border at rest; focus = accent border + inset
// 1px ring (≈2px) — RN has no inset shadow, so focus thickens the border to 2px
// (borders draw inside the bounds: no sibling layout shift) and the padding
// compensates by 1px so the text doesn't nudge.
export const TextField = forwardRef<TextInput, Props>(function TextField(
  { label, error, invalid, surface: surfaceName = 'formControl', style, onFocus, onBlur, editable, growLines, ...rest },
  ref,
) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface(surfaceName);
  const fieldHeight = surface.height(control.h);
  const text = phone.text('body');
  const lh = Math.round(text.fontSize * 1.2);
  // Grow mode (full-width fields only): a multiline TextInput bounded between one
  // line (fieldHeight) and growLines lines, then it scrolls. The extra lines'
  // height is the line-height × (growLines − 1) added onto the single-line box;
  // vertical padding is symmetric so line 1 still sits where the fixed field's
  // centered glyph does. Non-grow fields keep the fixed one-line box.
  const grows = !!growLines && growLines > 1 && !rest.secureTextEntry;
  const maxHeight = grows ? fieldHeight + lh * (growLines! - 1) : undefined;
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
  // Secure fields get a show/hide eye inside the field (Simon's ask). The
  // toggle flips OUR secure flag; the caller's secureTextEntry marks the
  // field as a password field.
  const secure = !!rest.secureTextEntry;
  const [revealed, setRevealed] = useState(false);
  // Keyboard-safe registration (lib/keyboardDismiss): the input itself and the
  // eye toggle must not bounce the keyboard when tapped.
  const innerRef = useRef<TextInput | null>(null);
  const eyeRef = useRef<View | null>(null);
  useRegisterInput(innerRef);
  useRegisterInput(eyeRef, secure);
  const isInvalid = !!(error || invalid);
  const borderColor = isInvalid ? theme.critical : focused ? theme.accent : theme.rule;
  // Grow mode seats line 1 by symmetric vertical padding (a multiline box can't
  // use textAlignVertical:center); the padding is (fieldHeight − lineHeight)/2 so
  // a one-line value sits exactly where the fixed field's centered glyph does.
  const growPadV = grows ? Math.max(0, Math.round((fieldHeight - lh) / 2)) : 0;
  const input = (
    <TextInput
      {...rest}
      // GROW fields are multiline (bounded min→max, then scroll). NON-grow fields
      // stay a NON-multiline TextInput, which on iOS is inherently one line and
      // scrolls horizontally when the value is long. ⚠️ Do NOT set numberOfLines
      // on the non-grow field: numberOfLines={1} on a single-line iOS TextInput
      // makes a long value WRAP+truncate on blur (the exact "line-breaks when you
      // leave the field" bug) — the field must stay a plain unbounded-width,
      // horizontally-scrolling input.
      // ⚠️ Do NOT set numberOfLines in GROW mode either: on Android RN maps it to
      // EditText.setLines(n), which PINS the box at n lines instead of growing
      // 1→n (the field renders permanently expanded). Grow is fully expressed by
      // minHeight/maxHeight/scrollEnabled; iOS ignores numberOfLines for multiline
      // sizing anyway. numberOfLines only rides through for a caller's own
      // multiline field.
      multiline={grows || rest.multiline}
      numberOfLines={grows ? undefined : rest.multiline ? rest.numberOfLines : undefined}
      scrollEnabled={grows ? true : rest.scrollEnabled}
      // Screen-reader invalid state (the red border alone isn't announced).
      aria-invalid={isInvalid}
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      editable={editable}
      secureTextEntry={secure && !revealed}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      placeholderTextColor={theme.inkFaint}
      {...surface.textProps}
      style={[
        {
          fontFamily: 'InstrumentSans_400Regular',
          fontSize: text.fontSize,
          // lineHeight ONLY in grow (multiline) mode. ⚠️ On a single-line iOS
          // TextInput, a lineHeight makes a long value WRAP onto several lines
          // (visible on blur) instead of scrolling horizontally — the reported
          // bug. Omitting it keeps the field a true one-line horizontal scroller.
          ...(grows ? { lineHeight: lh } : null),
          color: theme.ink,
          backgroundColor: editable === false ? theme.surfaceSunk : theme.surface,
          borderWidth: focused ? 2 : 1,
          borderColor,
          borderRadius: radius.sm,
          paddingLeft: focused ? 13 : 14,
          paddingRight: secure ? 42 : focused ? 13 : 14,
          opacity: editable === false ? 0.55 : 1,
          // GROW: multiline box bounded min→max lines, clip past that + seat line
          // 1 by symmetric padding. NON-GROW: the original fixed single-line box
          // (centered) — a non-multiline iOS TextInput can't hold a newline and
          // scrolls a long value horizontally, so it needs no numberOfLines /
          // overflow clip (both of which caused the wrap-on-blur regression).
          ...(grows
            ? { minHeight: fieldHeight, maxHeight, paddingTop: growPadV, paddingBottom: growPadV, overflow: 'hidden' as const }
            : { height: fieldHeight, paddingVertical: 0, textAlignVertical: 'center' as const }),
        },
        style,
      ]}
    />
  );
  return (
    <View style={{ gap: 7 }}>
      {label ? (
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{label}</VText>
      ) : null}
      {secure ? (
        <View>
          {input}
          <Pressable
            ref={eyeRef}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            hitSlop={8}
            onPress={() => setRevealed((r) => !r)}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 42, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={revealed ? 'eyeoff' : 'eye'} size={18} color={theme.inkSoft} />
          </Pressable>
        </View>
      ) : (
        input
      )}
      {error ? (
        <VText variant="caption" color="critical">{error}</VText>
      ) : null}
    </View>
  );
});
