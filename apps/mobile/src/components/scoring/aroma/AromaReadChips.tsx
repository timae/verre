import { useRef, useState } from 'react';
import { View, Pressable, useWindowDimensions, type LayoutRectangle } from 'react-native';
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
// selection. A parent sheet passes overflowSheetStack="push" so the read sheet
// opens above it and returns cleanly.
export function AromaReadChips({
  aromas,
  collapse,
  onPressAroma,
  overflowSheetStack = 'replace',
  overflowTitle,
  overflowPillOnSurface = false,
  emphasizeKeys,
}: {
  aromas: AromaSelection[] | undefined;
  collapse?: boolean;
  /** Optional read-side inspection. The canonical chip remains the visual;
      this callback receives its exact screen rect for an anchored popover. */
  onPressAroma?: (selection: AromaSelection, rect: LayoutRectangle) => void;
  /** Use `push` when this read lives inside an already-open parent sheet, so
      +N opens above it and returns to it instead of replacing it. */
  overflowSheetStack?: 'replace' | 'push';
  /** Optional personalized heading for the +N read sheet. */
  overflowTitle?: string;
  /** Preserve the shared overflow pill's contrast when this row sits on a
      sheet's `surface` background. Visual anatomy remains unchanged. */
  overflowPillOnSurface?: boolean;
  /** Search/focus treatment: matching exact pairs move first; the rest pale. */
  emphasizeKeys?: ReadonlySet<string>;
}) {
  const [rowW, setRowW] = useState(0);
  // Real chip widths from the hidden measuring pass, keyed by pair.
  const [chipW, setChipW] = useState<Record<string, number>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!aromas?.length) return null;
  const baseOrder = displayOrder(aromas);
  const hasEmphasis = !!emphasizeKeys?.size;
  const ordered = hasEmphasis
    ? [...baseOrder.filter((selection) => emphasizeKeys!.has(pairKey(selection))), ...baseOrder.filter((selection) => !emphasizeKeys!.has(pairKey(selection)))]
    : baseOrder;
  const collapsed = !!collapse;
  const { visible, overflow } = collapsed
    ? packChips(ordered, rowW, chipW, { gap: CHIP_GAP, removable: false })
    : { visible: ordered, overflow: 0 };
  return (
    <View
      onLayout={collapse ? (e) => setRowW(e.nativeEvent.layout.width) : undefined}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: CHIP_GAP }}
    >
      {collapsed ? (
        <ChipMeasurePass
          selections={ordered}
          chipW={chipW}
          onMeasure={(key, w) => setChipW((m) => (m[key] === w ? m : { ...m, [key]: w }))}
          vPad={READ_VPAD}
        />
      ) : null}
      {visible.map((sel) => (
        <ReadAromaChip key={pairKey(sel)} selection={sel} muted={hasEmphasis && !emphasizeKeys!.has(pairKey(sel))} onPress={onPressAroma} />
      ))}
      {overflow > 0 ? (
        <MoreChipsPill
          count={overflow}
          onPress={() => setSheetOpen(true)}
          vPad={READ_VPAD}
          onSurface={overflowPillOnSurface}
        />
      ) : null}
      {collapse ? (
        <ReadSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          aromas={ordered}
          onPressAroma={onPressAroma}
          stackBehavior={overflowSheetStack}
          title={overflowTitle}
          emphasizeKeys={emphasizeKeys}
        />
      ) : null}
    </View>
  );
}

function ReadAromaChip({
  selection,
  muted,
  onPress,
}: {
  selection: AromaSelection;
  muted?: boolean;
  onPress?: (selection: AromaSelection, rect: LayoutRectangle) => void;
}) {
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <AromaChip
        a={selection.a}
        m={selection.m}
        pronounced={!!selection.p}
        muted={muted}
        vPad={READ_VPAD}
        onPress={onPress ? () => ref.current?.measureInWindow((x, y, width, height) => onPress(selection, { x, y, width, height })) : undefined}
      />
    </View>
  );
}

// The read-only overflow sheet — SelectionSheet's look ("Aromas · N" + Done +
// the full wrapped selection) without any of its mutation surface. Cap-aware
// sizing per the catalog's gorhom rule: dynamic fit while the selection fits,
// fixed snap + BottomSheetScrollView past the threshold (content past the
// screen cap CLIPS unreachably under dynamic sizing).
const SCROLL_PAST = 12;
function ReadSheet({
  open,
  onClose,
  aromas,
  onPressAroma,
  stackBehavior,
  title,
  emphasizeKeys,
}: {
  open: boolean;
  onClose: () => void;
  aromas: AromaSelection[];
  onPressAroma?: (selection: AromaSelection, rect: LayoutRectangle) => void;
  stackBehavior: 'replace' | 'push';
  title?: string;
  emphasizeKeys?: ReadonlySet<string>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const scrolls = aromas.length > SCROLL_PAST;
  const chips = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: CHIP_GAP }}>
      {aromas.map((sel) => (
        <ReadAromaChip
          key={pairKey(sel)}
          selection={sel}
          muted={!!emphasizeKeys?.size && !emphasizeKeys.has(pairKey(sel))}
          onPress={onPressAroma}
        />
      ))}
    </View>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      stackBehavior={stackBehavior}
      layer={stackBehavior === 'push' ? 1 : 0}
      snapPoints={scrolls ? ['70%'] : undefined}
      enableDynamicSizing={!scrolls}
      maxDynamicContentSize={height * 0.75}
    >
      <BottomSheetView style={{ flex: scrolls ? 1 : undefined, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
        <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 14 }}>
          <VText numberOfLines={2} variant="subhead" style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold' }}>
            {title ?? `Aromas · ${aromas.length}`}
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
