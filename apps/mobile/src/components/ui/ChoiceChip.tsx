import { Pressable } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// THE choice pill (`.hlchip`, the catalog's pending `<ChoiceChips>`
// extraction): on = accent fill + accent ink, off = the page fill with the
// rule outline (a control affordance, not a surface edge) and soft ink. One of
// a set (the line-up reveal timings, a new wine's colour) or, with `tick`, a
// tick of its own (ADR-0009: Sparkling, NV), drawn with a check that is faint
// while off so it never reads as one more option of the set beside it.
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
        paddingHorizontal: tick ? 11 : 13,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? 'transparent' : theme.rule,
        backgroundColor: on ? theme.accent : theme.bg,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {tick ? <Icon name="check" size={14} color={on ? theme.accentInk : theme.inkFaint} /> : null}
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: on ? theme.accentInk : theme.inkSoft }}>
        {label}
      </VText>
    </Pressable>
  );
}
