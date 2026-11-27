import { BottomSheetFooter, BottomSheetScrollView, BottomSheetView, type BottomSheetFooterProps } from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { View, useWindowDimensions, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AROMA_SELECTION_CAP, aromaModifierDisplay, getAromaNode, resolveAxes, type AromaSelection } from '@verre/core';
import { FilterChip, FilterDates, FilterFooter, FilterLabel, FilterTitle, categoryLabel, dateChipLabel, summarize, type ActiveFilter } from '@/components/moments/MomentFilters';
import { SelectField } from '@/components/moments/momentForm';
import { AromaInput } from '@/components/scoring/aroma/AromaInput';
import { capFirst } from '@/components/scoring/aroma/parts';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import { IntensityScaleInfo } from '@/components/scoring/IntensityScaleInfo';
import { ScoreRange, ScoreRangeValue, RANGE_MAX, RANGE_MIN, isAnyRange, rangeLabel } from '@/components/scoring/ScoreRange';
import { StructureInput, type StructureRanges } from '@/components/scoring/StructureInput';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import type { AromaMode } from '@/lib/api/lists';
import { intensityRangeWord } from '@/lib/scoreWords';
import { useTheme } from '@/theme';

// "Filter Impressions" (04·6d/6e/6f, ruled 2026-11-14): the applied chips ·
// Date · Category · Score (the two-dot range) · Aromas · Structure · Reset /
// Done, the Filter Moments anatomy. Aromas and Structure are Filter Moments'
// Host / Friends There: a summary row opening its own sheet over this one,
// one chip per facet. Under the Aromas row, once two or more are picked, the
// person chooses whether an impression needs ALL of them or ANY.
//
// Filter for Aromas = the rating's aroma input (search + canvas, refine with
// modifiers + Pronounced), each pick read broad by the server (Fruity finds
// everything under it; plain Apricot finds dried apricot too; core
// aroma/filter.ts). Filter for Structure = the rating's StructureInput with
// `range`. Both write as you pick; the list follows a moment later
// (`debounce`), like a score drag.

export type ImpFilters = {
  from: Date | null; to: Date | null; category: string; lo: number; hi: number;
  structure: StructureRanges; aromas: AromaSelection[]; aromaMode: AromaMode;
};
export const NO_IMP_FILTERS: ImpFilters = { from: null, to: null, category: 'any', lo: RANGE_MIN, hi: RANGE_MAX, structure: {}, aromas: [], aromaMode: 'all' };
export const impFilterCount = (f: ImpFilters) =>
  (f.from || f.to ? 1 : 0) + (f.category !== 'any' ? 1 : 0) + (isAnyRange(f.lo, f.hi) ? 0 : 1) + (f.aromas.length > 0 ? 1 : 0) + (Object.keys(f.structure).length > 0 ? 1 : 0);
export type ImpFilterUpdate = (update: (f: ImpFilters) => ImpFilters, opts?: { debounce?: boolean }) => void;

// The filter's axes: the wine set with Bubbles (it only finds sparkling ones).
const FILTER_STYLE = 'spark';
const AXES = resolveAxes('wine', FILTER_STYLE);

// One pick in words: "Apricot", "Apricot (dried)", "Lemon (pronounced)".
function aromaWord(sel: AromaSelection): string {
  const node = getAromaNode(sel.a);
  const name = capFirst(node?.label ?? sel.a);
  const refine = [sel.m ? aromaModifierDisplay(sel.a, sel.m) : null, sel.p ? 'pronounced' : null].filter(Boolean);
  return refine.length ? `${name} (${refine.join(', ')})` : name;
}
// "Apricot and Lemon", "Apricot, Lemon or Fig", "Apricot, Lemon and 3 more".
export function aromaSummary(aromas: AromaSelection[], mode: AromaMode): string {
  const words = aromas.map(aromaWord);
  const joiner = mode === 'any' ? 'or' : 'and';
  if (words.length <= 1) return words.join('');
  if (words.length <= 3) return `${words.slice(0, -1).join(', ')} ${joiner} ${words[words.length - 1]}`;
  return `${words.slice(0, 2).join(', ')} ${joiner} ${words.length - 2} more`;
}
// "Sweetness: Faint – Medium", two axes in full, then "+N".
export function structureSummary(structure: StructureRanges): string {
  return summarize(AXES.filter((a) => structure[a.k]).map((a) => `${a.l}: ${intensityRangeWord(structure[a.k][0], structure[a.k][1])}`));
}

const HANDLE_H = 24;

// A handler with a stable identity that always runs the latest closure (the
// pinned footers are a component TYPE to gorhom: a new callback remounts them).
function useStable<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export function ImpressionFilterSheet({ open, onClose, filters, onChange }: {
  open: boolean; onClose: () => void; filters: ImpFilters; onChange: ImpFilterUpdate;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const [sub, setSub] = useState<'aromas' | 'structure' | null>(null);
  // Fit-to-content while it fits, else a fixed snap that SCROLLS with the
  // footer pinned (dynamic sizing clips rows past the cap unreachably, and the
  // footer is the last row: apps/mobile/CLAUDE.md, Bottom sheet). Decided by
  // the measured height, Dynamic Type included; it only ever grows, so the
  // sheet can't flip back and forth while the All / Any switch comes and goes.
  const cap = Math.round(windowH * 0.85);
  const [natural, setNatural] = useState(0);
  // gorhom fits content + handle under the cap: clipping starts a handle's
  // height (~24) before the content alone reaches it.
  const scrolls = natural + HANDLE_H > cap;
  const reset = useStable(() => onChange(() => NO_IMP_FILTERS));
  const done = useStable(onClose);
  const footer = usePinnedFooter(<FilterFooter onReset={reset} onDone={done} />);
  const closeSub = useStable(() => setSub(null));
  const setAromas = useStable((aromas: AromaSelection[]) => onChange((f) => ({ ...f, aromas, aromaMode: aromas.length > 1 ? f.aromaMode : 'all' }), { debounce: true }));
  const setStructure = useStable((structure: StructureRanges) => onChange((f) => ({ ...f, structure }), { debounce: true }));
  const resetStructure = useStable(() => onChange((f) => ({ ...f, structure: {} })));
  // Every opening starts on the sheet itself (Filter Moments' rule).
  useEffect(() => {
    if (open) setSub(null);
  }, [open]);
  const set = (patch: Partial<ImpFilters>) => onChange((f) => ({ ...f, ...patch }));
  const hasAromas = filters.aromas.length > 0;
  const hasStructure = Object.keys(filters.structure).length > 0;
  const applied: ActiveFilter[] = [];
  if (filters.from || filters.to) applied.push({ key: 'date', label: dateChipLabel(filters.from, filters.to), onClear: () => set({ from: null, to: null }) });
  if (filters.category !== 'any') applied.push({ key: 'category', label: categoryLabel(filters.category), onClear: () => set({ category: 'any' }) });
  if (!isAnyRange(filters.lo, filters.hi)) applied.push({ key: 'score', label: rangeLabel(filters.lo, filters.hi), onClear: () => set({ lo: RANGE_MIN, hi: RANGE_MAX }) });
  if (hasAromas) applied.push({ key: 'aromas', label: aromaSummary(filters.aromas, filters.aromaMode), onEdit: () => setSub('aromas'), onClear: () => set({ aromas: [], aromaMode: 'all' }) });
  if (hasStructure) applied.push({ key: 'structure', label: structureSummary(filters.structure), onEdit: () => setSub('structure'), onClear: () => set({ structure: {} }) });
  const body = (
    <>
          <FilterTitle applied={applied}>Filter Impressions</FilterTitle>
          <View style={{ gap: 10 }}>
            <FilterLabel>DATE</FilterLabel>
            <FilterDates from={filters.from} to={filters.to} onChange={(from, to) => set({ from, to })} />
          </View>
          <View style={{ gap: 10 }}>
            <FilterLabel>CATEGORY</FilterLabel>
            {/* v1: wine only, like Filter Moments. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <FilterChip label="Any" on={filters.category === 'any'} onPress={() => set({ category: 'any' })} />
              <FilterChip label={categoryLabel('wine')} on={filters.category === 'wine'} onPress={() => set({ category: 'wine' })} />
            </View>
          </View>
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <FilterLabel>SCORE</FilterLabel>
              <ScoreRangeValue lo={filters.lo} hi={filters.hi} />
            </View>
            {/* A drag reaches the list debounced (every quarter step would be a
                request on the lists' shared rate budget). */}
            <ScoreRange lo={filters.lo} hi={filters.hi} onChange={(lo, hi) => onChange((f) => ({ ...f, lo, hi }), { debounce: true })} />
          </View>
          <View style={{ gap: 10 }}>
            <FilterLabel>AROMAS</FilterLabel>
            <SelectField value={hasAromas ? aromaSummary(filters.aromas, filters.aromaMode) : ''} placeholder="Any" onPress={() => setSub('aromas')} accessibilityLabel={hasAromas ? `Aromas: ${aromaSummary(filters.aromas, filters.aromaMode)}` : 'Filter by aromas'} />
            {filters.aromas.length > 1 ? (
              <Segmented
                segments={[{ key: 'all', label: 'All of These' }, { key: 'any', label: 'Any of These' }]}
                active={filters.aromaMode}
                onSelect={(aromaMode) => set({ aromaMode })}
              />
            ) : null}
          </View>
          <View style={{ gap: 10 }}>
            <FilterLabel>STRUCTURE</FilterLabel>
            <SelectField value={hasStructure ? structureSummary(filters.structure) : ''} placeholder="Any" onPress={() => setSub('structure')} accessibilityLabel={hasStructure ? `Structure: ${structureSummary(filters.structure)}` : 'Filter by structure'} />
          </View>
    </>
  );
  return (
    <>
      <Sheet open={open} onClose={onClose} {...(scrolls ? { snapPoints: [cap], enableDynamicSizing: false, footerComponent: footer.render } : { maxDynamicContentSize: cap })}>
        {scrolls ? (
          // A plain View around the scroll (never BottomSheetView: it would
          // re-register the scrollable as a VIEW and lock it).
          <View style={{ flex: 1 }}>
            <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: footer.height + 12, gap: 18 }}>
              {body}
            </BottomSheetScrollView>
          </View>
        ) : (
          <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 16 }}>
            <View
              style={{ gap: 18 }}
              onLayout={(e) => {
                const h = Math.ceil(e.nativeEvent.layout.height) + 12 + insets.bottom + 16;
                setNatural((prev) => (h > prev ? h : prev));
              }}
            >
              {body}
              <FilterFooter onReset={reset} onDone={done} />
            </View>
          </BottomSheetView>
        )}
      </Sheet>
      <AromaFilterSheet open={sub === 'aromas'} onClose={closeSub} value={filters.aromas} onChange={setAromas} />
      <StructureFilterSheet open={sub === 'structure'} onClose={closeSub} value={filters.structure} onChange={setStructure} onReset={resetStructure} />
    </>
  );
}

// A footer pinned to the sheet's bottom (gorhom's footer: an absolute child
// would clip off-screen); the scroll pads by its height. The render callback
// keeps its identity (gorhom renders it as a component TYPE, so a new one
// remounts the buttons mid-drag), so the children's handlers must be stable
// (useStable): the footer may keep the element of an earlier render.
function usePinnedFooter(children: React.ReactNode) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const render = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props}>
        <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)} style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 12, backgroundColor: theme.surface }}>
          {childrenRef.current}
        </View>
      </BottomSheetFooter>
    ),
    [insets.bottom, theme.surface],
  );
  return { render, height: height || insets.bottom + 70 };
}

function SubTitle({ children }: { children: string }) {
  return <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{children}</VText>;
}

// Filter for Aromas (04·6f): the rating's aroma input, bare (the title is the
// heading), its "+N more" sheet pushed on top of this one.
function AromaFilterSheet({ open, onClose, value, onChange }: {
  open: boolean; onClose: () => void; value: AromaSelection[]; onChange: (v: AromaSelection[]) => void;
}) {
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const scrollYRef = useRef(0);
  const footer = usePinnedFooter(<Button title="Done" block onPress={onClose} />);
  const fit = useAromaSearchScroll(scrollRef, scrollYRef, footer.height);
  return (
    <Sheet open={open} onClose={onClose} snapPoints={['90%']} enableDynamicSizing={false} stackBehavior="push" layer={1} footerComponent={footer.render}>
      <BottomSheetScrollView
        // gorhom's scroll view is a ScrollView underneath (scrollTo); the hook
        // only scrolls it.
        ref={scrollRef as unknown as RefObject<never>}
        // gorhom runs this from its own scroll handler, every frame.
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: footer.height + 12, gap: 12 }}
      >
        <SubTitle>Filter for Aromas</SubTitle>
        <AromaInput
          bare
          value={value}
          onChange={onChange}
          onRequestScroll={fit}
          limitText={`Limit reached: a filter holds up to ${AROMA_SELECTION_CAP} aromas.`}
          overflowSheet={{ stackBehavior: 'push', layer: 2 }}
        />
      </BottomSheetScrollView>
    </Sheet>
  );
}

// Filter for Structure (04·6e): the rating's structure tracks, each holding a
// range. Reset clears every axis (at once); Done closes.
function StructureFilterSheet({ open, onClose, value, onChange, onReset }: {
  open: boolean; onClose: () => void; value: StructureRanges; onChange: (v: StructureRanges) => void; onReset: () => void;
}) {
  // Reset applies at once (not debounced like a drag), like every Reset.
  const footer = usePinnedFooter(<FilterFooter onReset={onReset} onDone={onClose} />);
  return (
    <Sheet open={open} onClose={onClose} snapPoints={['85%']} enableDynamicSizing={false} stackBehavior="push" layer={1} footerComponent={footer.render}>
      <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: footer.height + 12, gap: 10 }}>
        <SubTitle>Filter for Structure</SubTitle>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <VText variant="small" color="inkSoft" style={{ flexShrink: 1 }}>Drag across an axis to set a range. Tap a set axis twice to clear it.</VText>
          <IntensityScaleInfo />
        </View>
        <StructureInput range kind={FILTER_STYLE} value={value} onChange={onChange} />
      </BottomSheetScrollView>
    </Sheet>
  );
}
