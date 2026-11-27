import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// THE dashed "add" row: a full-width accent dashed outline (a control
// affordance, not a card edge) with a plus and its label centred. The
// line-up's Add Impression, and the bottle picker's Add Wine to Catalogue /
// Add Producer / Add Wine (ruled 2026-11-22: "like the add impression in the
// line up list itself"). Extracted from the line-up's AddImpressionRow (the
// catalog's pending DashedAddRow).
export function DashedAddRow({
  title, onPress, accessibilityLabel, style,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        marginTop: 8, paddingVertical: 14, paddingHorizontal: 12, borderRadius: radius.md,
        borderWidth: 1, borderStyle: 'dashed', borderColor: theme.accentLine,
        opacity: pressed ? 0.6 : 1,
      }, style]}
    >
      <Icon name="plus" size={17} color={theme.accent} />
      <VText variant="small" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', flexShrink: 1 }} color="accent">
        {title}
      </VText>
    </Pressable>
  );
}
