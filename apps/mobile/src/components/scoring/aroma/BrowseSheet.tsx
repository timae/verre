import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';
import { RailPicker } from './RailPicker';
import type { AromaOps } from './parts';

// "Browse Aromas" — the bottom sheet behind the grid button (02e·11). Holds
// the four picker variants behind a segmented control, ALL FOUR SHIPPING for
// on-device feel-testing (Simon's ruling, 2026-07-10 — the tab switcher is
// the deliverable, not exploration scaffolding; one variant gets ruled after
// device time). Build lands incrementally: a variant appears in the control
// once its picker exists. Fixed snap + BottomSheetScrollView (picker content
// exceeds any dynamic fit; the CountrySheet precedent).
const VARIANTS = [
  // { key: 'map', label: 'Map' },      — H3 zoom map, next up
  // { key: 'rings', label: 'Rings' },  — W4 accordion rings
  { key: 'rail', label: 'Rail' },
  // { key: 'canvas', label: 'Canvas' } — H2 zoom canvas
] as const;
type VariantKey = (typeof VARIANTS)[number]['key'];

const HINTS: Record<VariantKey, string> = {
  rail: 'Swipe the rail, tap to drill in — the round mark adds a whole family or group.',
};

export function BrowseSheet({
  open,
  onClose,
  ops,
}: {
  open: boolean;
  onClose: () => void;
  ops: AromaOps;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [variant, setVariant] = useState<VariantKey>('rail');

  return (
    <Sheet open={open} onClose={onClose} snapPoints={['75%']} enableDynamicSizing={false}>
      <BottomSheetView style={{ flex: 1, paddingTop: 8, paddingBottom: insets.bottom + 8 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              Browse Aromas{ops.value.length ? ` · ${ops.value.length}` : ''}
            </VText>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
                Done
              </VText>
            </Pressable>
          </View>
          {VARIANTS.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 4, padding: 3, borderRadius: 999, backgroundColor: theme.bg }}>
              {VARIANTS.map((v) => {
                const on = v.key === variant;
                return (
                  <Pressable
                    key={v.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setVariant(v.key)}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      paddingVertical: 7,
                      borderRadius: 999,
                      backgroundColor: on ? theme.surface : 'transparent',
                    }}
                  >
                    <VText
                      surface="badge"
                      style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? theme.ink : theme.inkSoft }}
                    >
                      {v.label}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <VText variant="small" color="inkSoft">
            {HINTS[variant]}
          </VText>
        </View>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
        >
          {variant === 'rail' ? <RailPicker ops={ops} /> : null}
        </BottomSheetScrollView>
      </BottomSheetView>
    </Sheet>
  );
}
