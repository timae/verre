// Segmented — the pill segmented control (rounded theme.bg track, active
// segment = theme.surface pill). Extracted at its 3rd consumer per the catalog
// rule; the metrics are style-verbatim from the two originals:
// - default: the BrowseSheet variant switcher (full-width, flex-1 segments,
//   padV 7, label 12) — also the aroma detail sheet's tab bar (slice 3d).
// - compact: the ListPicker look switcher's "mini twin" (content-sized,
//   padV 4 / padH 9, label 11.5).
// The dev gallery's knobPill copies stay local (lab code, not migrated).

import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';

export function Segmented<K extends string>({
  segments,
  active,
  onSelect,
  compact,
  style,
}: {
  segments: ReadonlyArray<{ key: K; label: string }>;
  active: K;
  onSelect: (key: K) => void;
  /** The ListPicker mini-twin metrics: content-sized, tighter pad, 11.5 label. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useTheme();
  return (
    <View style={[{ flexDirection: 'row', gap: compact ? 3 : 4, padding: compact ? 2 : 3, borderRadius: 999, backgroundColor: theme.bg }, style]}>
      {segments.map((s) => {
        const on = s.key === active;
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(s.key)}
            style={{
              ...(compact ? { paddingVertical: 4, paddingHorizontal: 9 } : { flex: 1, alignItems: 'center' as const, paddingVertical: 7 }),
              borderRadius: 999,
              backgroundColor: on ? theme.surface : 'transparent',
            }}
          >
            <VText
              surface="badge"
              style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: compact ? 11.5 : 12, color: on ? theme.ink : theme.inkSoft }}
            >
              {s.label}
            </VText>
          </Pressable>
        );
      })}
    </View>
  );
}
