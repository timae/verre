import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable } from 'react-native';
import { BottomSheetFooter, BottomSheetScrollView, type BottomSheetFooterProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';
import { RailPicker } from './RailPicker';
import { RingsPicker } from './RingsPicker';
import { MapPicker } from './MapPicker';
import { CanvasPicker } from './CanvasPicker';
import { ListPicker } from './ListPicker';
import { SelectionSheet } from './SelectionSheet';
import { CapHint, RefineAddRow, SelectedChipsRow, usePendingAdd, type AromaOps } from './parts';

// "Browse Aromas" — the bottom sheet behind the grid button (02e·11). Holds
// the five picker variants behind a segmented control, ALL shipping for
// on-device feel-testing (Simon's ruling, 2026-07-10 — the tab switcher is
// the deliverable, not exploration scaffolding; one variant gets ruled after
// device time). Fixed snap + BottomSheetScrollView (picker content exceeds
// any dynamic fit; the CountrySheet precedent). Gesture layering after two
// device rounds: the SCROLL is locked on the stage variants (round 1 — it
// stole vertical ring-turns; Rail and List keep it), but the sheet's
// CONTENT-PAN stays ON (round 2 — pull-down-to-dismiss must work): the
// stage pans activate at 4–6pt in any direction and win the race on the
// stages themselves, while pulls on the header/hint/add-bar drag the sheet.
// Device-verify the split holds.
const VARIANTS = [
  { key: 'map', label: 'Map' }, // H3 zoom map
  { key: 'rings', label: 'Rings' }, // W4 accordion rings
  { key: 'rail', label: 'Rail' }, // D badge rail
  { key: 'canvas', label: 'Canvas' }, // H2 zoom canvas
  { key: 'list', label: 'List' }, // L drill list (device ask, round 3)
] as const;
type VariantKey = (typeof VARIANTS)[number]['key'];

const HINTS: Record<VariantKey, string> = {
  map: 'Tap or pinch to zoom between families, groups and notes. Drag to roam the map.',
  rings: 'Turn a ring to choose — the hub reads your pick, the row below adds it.',
  rail: 'Swipe the rail, tap to drill in — the round mark adds a whole family or group.',
  canvas: 'Tap a comb to dive into its family — pick a note, then add it.',
  list: 'Tap a row to open it — the round mark picks a whole family or group.',
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
  const [variant, setVariant] = useState<VariantKey>('map');
  const [selOpen, setSelOpen] = useState(false);
  // The List's armed pick lives HERE: its refine row pins to the sheet's
  // bottom (device round 5 — always reachable however far the list scrolls),
  // outside the scroll the rows ride.
  const [listPend, setListPend] = useState<string | null>(null);
  const listPendState = usePendingAdd(variant === 'list' ? listPend : null, ops);
  useEffect(() => setListPend(null), [variant]);
  // Measured footer height drives the list's scroll clearance below — the
  // footer grows with Dynamic Type and the cap hint, so a hard-coded number
  // either clipped the last rows or wasted a band (review finding).
  const [footerH, setFooterH] = useState(0);
  // Latest-ref for the pend state's ACTIONS: the footer render is memoized
  // on its DISPLAY inputs, but commit/setPendM close over ops.value — an
  // unrelated value change (removing a chip) recreated none of the deps, and
  // the stale commit re-added the removed chip from its old snapshot (review
  // finding). The ref always calls this render's closures.
  const listActions = useRef(listPendState);
  listActions.current = listPendState;
  // gorhom's footer primitive — an absolute bottom:0 child anchored to the
  // modal container and clipped below the screen (device round 6).
  const renderListFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props}>
        <View
          onLayout={(e) => setFooterH(e.nativeEvent.layout.height)}
          style={{
            paddingHorizontal: 20,
            paddingTop: 10,
            paddingBottom: insets.bottom + 12,
            backgroundColor: theme.surface,
            gap: 8,
          }}
        >
          <RefineAddRow
            a={listPend}
            m={listPendState.pendM}
            p={listPendState.pendP}
            added={listPendState.added}
            onM={(m) => listActions.current.setPendM(m)}
            onP={() => listActions.current.togglePendP()}
            onAdd={() => {
              if (listActions.current.commit()) setListPend(null);
            }}
          />
          <CapHint show={listPendState.capHit} />
        </View>
      </BottomSheetFooter>
    ),
    [listPend, listPendState.pendM, listPendState.pendP, listPendState.added, listPendState.capHit, insets.bottom, theme.surface],
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      snapPoints={['90%']}
      enableDynamicSizing={false}
      footerComponent={variant === 'list' ? renderListFooter : undefined}
    >
      {/* ONE scroll for the whole sheet (device round 4) — header, chips and
          picker all ride it, whatever the variant; the stage gestures still
          claim their own drags by activating first. Mounted once, always
          enabled (gorhom latches scrollEnabled from the first render — the
          earlier per-variant toggle left the List unscrollable). */}
      <BottomSheetScrollView
        keyboardShouldPersistTaps="handled"
        // Extra clearance on the List so the last rows scroll out from under
        // its pinned footer — the footer's MEASURED height (it scales with
        // Dynamic Type + the cap hint), with a pre-measure fallback.
        contentContainerStyle={{ paddingTop: 16, paddingBottom: variant === 'list' ? (footerH || 140) + 12 : insets.bottom + 24 }}
      >
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              Browse Aromas
            </VText>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
                Done
              </VText>
            </Pressable>
          </View>
          {/* everything added so far, always in view (device round 3) — THE
              shared chips block, exactly the impression page's behaviour
              (device round 4): wrap + "+N more" overflow sheet + refine
              popup + add flash. */}
          <SelectedChipsRow ops={ops} onOverflow={() => setSelOpen(true)} />
          <Segmented segments={VARIANTS} active={variant} onSelect={setVariant} />
          {variant !== 'list' ? (
            // The list is self-explanatory (device round 4) — no hint line.
            <VText variant="small" color="inkSoft">
              {HINTS[variant]}
            </VText>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 20 }}>
          {variant === 'map' ? <MapPicker ops={ops} /> : null}
          {variant === 'rings' ? <RingsPicker ops={ops} /> : null}
          {variant === 'rail' ? <RailPicker ops={ops} /> : null}
          {variant === 'canvas' ? <CanvasPicker ops={ops} /> : null}
          {variant === 'list' ? <ListPicker pend={listPend} onPend={setListPend} pendP={listPendState.pendP} /> : null}
        </View>
      </BottomSheetScrollView>
      <SelectionSheet open={selOpen} onClose={() => setSelOpen(false)} ops={ops} stackBehavior="push" layer={1} />
    </Sheet>
  );
}
