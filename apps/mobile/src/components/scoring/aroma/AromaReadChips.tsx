import { useState } from 'react';
import { View, Pressable, useWindowDimensions } from 'react-native';
import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AromaSelection } from '@verre/core';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';
import { AromaChip, ChipMeasurePass, MoreChipsPill, displayOrder, packChips, pairKey } from './parts';

const CHIP_GAP = 7;
// Read badges are COMPACT: vPad 0 (Simon, 2026-07-13 gallery pass) — inner
// vertical padding floors at 0, the label keeps its inherited 23pt line box
// (badgeVMetrics leaves lineHeight untouched at 0). Write surfaces keep the
// default 4.5; this constant is the read-side ruling for every consumer
// (feed impression detail now, compare when it grows aromas).
const READ_VPAD = 0;

// Read-only aroma chips — THE native display surface for someone's stored
// selections (feed impression detail now; further native read surfaces reuse
// this; the web has its own twin, components/ui/AromaReadChips.tsx — no
// shared RN/web layer). Renders the canonical badge (AromaChip — family tint,
// aroma-then-modifier words, Pronounced border) in the shared display order
// (pronounced first, then grouped by family — aroma-layer.md §7). No input,
// no refine, no ×: mutations only ever happen through AromaInput.
//
// `collapse` mirrors the rating page's selected-chips behaviour: the row caps
// at two lines (the shared width-based packer), the tail files behind a
// "+N more" pill, and the pill opens a read-only bottom sheet with the full
// selection.
export function AromaReadChips({
  aromas,
  collapse,
}: {
  aromas: AromaSelection[] | undefined;
  collapse?: boolean;
}) {
  const [rowW, setRowW] = useState(0);
  // Real chip widths from the hidden measuring pass, keyed by pair.
  const [chipW, setChipW] = useState<Record<string, number>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!aromas?.length) return null;
  const ordered = displayOrder(aromas);
  const { visible, overflow } = collapse
    ? packChips(ordered, rowW, chipW, { gap: CHIP_GAP, removable: false })
    : { visible: ordered, overflow: 0 };
  return (
    <View
      onLayout={collapse ? (e) => setRowW(e.nativeEvent.layout.width) : undefined}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: CHIP_GAP }}
    >
      {collapse ? (
        <ChipMeasurePass
          selections={ordered}
          chipW={chipW}
          onMeasure={(key, w) => setChipW((m) => (m[key] === w ? m : { ...m, [key]: w }))}
          vPad={READ_VPAD}
        />
      ) : null}
      {visible.map((sel) => (
        <AromaChip key={pairKey(sel)} a={sel.a} m={sel.m} pronounced={!!sel.p} vPad={READ_VPAD} />
      ))}
      {overflow > 0 ? <MoreChipsPill count={overflow} onPress={() => setSheetOpen(true)} vPad={READ_VPAD} /> : null}
      {collapse ? <ReadSheet open={sheetOpen} onClose={() => setSheetOpen(false)} aromas={ordered} /> : null}
    </View>
  );
}

// The read-only overflow sheet — SelectionSheet's look ("Aromas · N" + Done +
// the full wrapped selection) without any of its mutation surface. Cap-aware
// sizing per the catalog's gorhom rule: dynamic fit while the selection fits,
// fixed snap + BottomSheetScrollView past the threshold (content past the
// screen cap CLIPS unreachably under dynamic sizing).
const SCROLL_PAST = 12;
function ReadSheet({ open, onClose, aromas }: { open: boolean; onClose: () => void; aromas: AromaSelection[] }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const scrolls = aromas.length > SCROLL_PAST;
  const chips = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: CHIP_GAP }}>
      {aromas.map((sel) => (
        <AromaChip key={pairKey(sel)} a={sel.a} m={sel.m} pronounced={!!sel.p} vPad={READ_VPAD} />
      ))}
    </View>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      snapPoints={scrolls ? ['70%'] : undefined}
      enableDynamicSizing={!scrolls}
      maxDynamicContentSize={height * 0.75}
    >
      <BottomSheetView style={{ flex: scrolls ? 1 : undefined, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
        <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 14 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            Aromas · {aromas.length}
          </VText>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
              Done
            </VText>
          </Pressable>
        </View>
        {scrolls ? (
          <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
            {chips}
          </BottomSheetScrollView>
        ) : (
          <View style={{ paddingHorizontal: 20 }}>{chips}</View>
        )}
      </BottomSheetView>
    </Sheet>
  );
}
