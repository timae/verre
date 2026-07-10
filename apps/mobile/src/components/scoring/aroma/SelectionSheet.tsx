import { useRef, useState } from 'react';
import { View, Pressable, useWindowDimensions } from 'react-native';
import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import type { MenuAnchor } from '@/components/ui/AnchoredMenu';
import { useTheme } from '@/theme';
import { AromaChip, ModifierPopup, displayOrder, useTapOrDouble, type AromaOps } from './parts';

// "Your Aromas · N" — the full-selection overflow sheet, reached ONLY from
// the "+N more" pill (feedback round 1: chip refine happens in the anchored
// popup, not here — this sheet exists to see and manage a selection too big
// for the inline row). Tap a chip for its refine popup (an RN Modal, so it
// renders above the sheet), × removes.
//
// Cap-aware sizing (the catalog's gorhom rule + CompareBody recipe): while
// the selection fits, dynamic sizing with PLAIN views (a BottomSheetScrollView
// measures 0 under dynamic sizing); past the threshold, a FIXED snap +
// BottomSheetScrollView — under dynamic sizing content past the screen cap
// CLIPS unreachably, and chips a user can't reach can't be removed (review
// finding: a 30-selection set overflows a small phone's 75%).
const SCROLL_PAST = 12;
export function SelectionSheet({
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
  const { height, width: screenW } = useWindowDimensions();
  const [popup, setPopup] = useState<{ a: string; m: string | null; anchor: MenuAnchor; right?: number } | null>(null);
  const chipRefs = useRef<Record<string, View | null>>({});
  const tap = useTapOrDouble();
  const scrolls = ops.value.length > SCROLL_PAST;

  const chips = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
          {displayOrder(ops.value).map((sel) => {
            const key = `${sel.a}|${sel.m ?? ''}`;
            return (
              <View key={key} ref={(n) => { chipRefs.current[key] = n; }} collapsable={false}>
                <AromaChip
                  a={sel.a}
                  m={sel.m}
                  pronounced={!!sel.p}
                  // single = refine popup (delayed past the double window);
                  // double = toggle Pronounced (same gesture as inline chips).
                  onPress={() =>
                    tap(
                      `sheetchip:${key}`,
                      () =>
                        chipRefs.current[key]?.measureInWindow((x, y, _w, h) =>
                          setPopup({ a: sel.a, m: sel.m, anchor: { top: y, bottom: y + h }, right: Math.max(12, screenW - x - 280) }),
                        ),
                      () => ops.togglePronounced(sel.a, sel.m),
                      'delayed',
                    )
                  }
                  onRemove={() => {
                    delete chipRefs.current[key];
                    if (popup?.a === sel.a && popup?.m === sel.m) setPopup(null);
                    ops.removePair(sel.a, sel.m);
                  }}
                />
              </View>
            );
          })}
    </View>
  );

  const header = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 10 }}>
        <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Your Aromas · {ops.value.length}
        </VText>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
          <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
            Done
          </VText>
        </Pressable>
      </View>
      <VText variant="small" color="inkSoft" style={{ marginBottom: 12 }}>
        Tap a chip to refine it · × removes.
      </VText>
    </>
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
        <View style={{ paddingHorizontal: 20 }}>{header}</View>
        {scrolls ? (
          <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
            {chips}
          </BottomSheetScrollView>
        ) : (
          <View style={{ paddingHorizontal: 20 }}>{chips}</View>
        )}
        <ModifierPopup
          target={popup}
          onClose={() => setPopup(null)}
          ops={ops}
          onTargetChange={(pair) => setPopup((p) => (p ? { ...p, ...pair } : p))}
        />
      </BottomSheetView>
    </Sheet>
  );
}
