import { Pressable } from 'react-native';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// THE choice pill (`.hlchip`, the catalog's pending `<ChoiceChips>`
// extraction): on = accent fill + accent ink, off = the page fill with the
// rule outline (a control affordance, not a surface edge) and soft ink. One of
// a set (the line-up reveal timings, a new wine's colour) or, with `tick`, a
// toggle of its own (ADR-0009: Sparkling, NV): the same look, on = the fill,
// announced as a checkbox. No check glyph (ruled 2026-11-22: "that is not how
// it works").
export function ChoiceChip({
  label, on, onPress, tick, disabled, accessibilityLabel,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  tick?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole={tick ? 'checkbox' : 'button'}
      accessibilityState={tick ? { checked: on, disabled: !!disabled } : { selected: on, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? 'transparent' : theme.rule,
        backgroundColor: on ? theme.accent : theme.bg,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: on ? theme.accentInk : theme.inkSoft }}>
        {label}
      </VText>
    </Pressable>
  );
}
