import { useRef } from 'react';
import { Pressable, View } from 'react-native';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';
import { Icon } from './Icon';
import { TextField } from './TextField';

// The app-wide compact sheet/search pill. Extracted from CompareBody when the
// aroma detail sheet became its seventh consumer; feature components should
// not import a generic input from one another.
export function SheetSearchField({
  value,
  onChangeText,
  placeholder,
  highlight,
  onFocus,
  onBlur,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  highlight?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  // Clearing is part of typing — the × must not bounce the keyboard.
  const clearRef = useRef<View | null>(null);
  useRegisterInput(clearRef, value !== '');
  // ONE skin everywhere (Simon's standard, 2026-07-03): surface + rule
  // border, matching the chip controls — never the sunken fill. Height rides
  // the formControl surface: 36 at default scale, growing with the text.
  // The clear target deliberately shares that compact height; widening it is
  // preferable to making every sibling search/control pill 44pt tall.
  const fieldH = phone.surface('formControl').height(36);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: fieldH, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.surface, borderWidth: highlight ? 1.5 : 1, borderColor: highlight ? theme.accent : theme.rule }}>
      <Icon name="search" size={16} color={theme.inkSoft} />
      <View style={{ flex: 1 }}>
        <TextField
          placeholder={placeholder}
          accessibilityLabel={placeholder}
          value={value}
          onChangeText={onChangeText}
          autoCorrect={false}
          autoCapitalize="none"
          onFocus={onFocus}
          onBlur={onBlur}
          style={{ height: fieldH, borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, borderRadius: 0, fontSize: phone.text('small').fontSize, lineHeight: Math.round(phone.text('small').fontSize * 1.2) }}
        />
      </View>
      {value !== '' ? (
        <Pressable
          ref={clearRef}
          accessibilityRole="button"
          accessibilityLabel="Clear Search"
          onPress={() => onChangeText('')}
          hitSlop={{ left: 8, right: 8 }}
          style={{ width: 40, height: fieldH, alignItems: 'center', justifyContent: 'center', marginRight: -6 }}
        >
          <Icon name="x" size={14} color={theme.inkFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}
