import { useEffect, useReducer, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ChoiceChip } from '@/components/ui/ChoiceChip';
import { InfoTip } from '@/components/ui/InfoTip';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { CatalogSearchError, type CatalogScope, type ProductHit, type SearchAnswer } from '@/lib/api/catalog';
import { initialSearch, pendingRequest, searchReducer, type SearchEvent, type SearchState } from '@/lib/bottleSearch';
import type { BottleLabel } from '@/lib/catalogChoice';
import { FOOT_CLEARANCE, GUTTER, usePhoneTokens } from '@/lib/layout';
import { getFlow, pageMounted, pageUnmounted } from '@/lib/pickerFlow';
import type { SessionMount } from '@/lib/sessionStack';
import { radius, useTheme } from '@/theme';

// The bottle picker's parts, shared by the inline picker (BottlePicker.tsx) and
// the "Add Wine to Catalogue" pages (CatalogPages.tsx): one search field's
// controller hook, the result rows, the chosen line, the year row with its NV
// chip and the alcohol slot, the quiet lines.

// One search field's state, driven by the pure controller: one request per
// pause in typing (300 ms), its answer kept only for the generation it was
// asked for.
export function useCatalogSearch<T>(min: number, run: (q: string) => Promise<SearchAnswer<T>>) {
  const [state, dispatch] = useReducer((s: SearchState<T>, e: SearchEvent<T>) => searchReducer(s, e), min, (m: number) => initialSearch<T>(m));
  const runRef = useRef(run);
  runRef.current = run;
  const req = pendingRequest(state);
  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => {
      runRef.current(req.q)
        .then((answer) => dispatch({ type: 'answer', gen: req.gen, answer }))
        .catch((e) => dispatch({ type: 'fail', gen: req.gen, failure: e instanceof CatalogSearchError ? e.reason : 'failed' }));
    }, 300);
    return () => clearTimeout(t);
  }, [req?.gen]); // eslint-disable-line react-hooks/exhaustive-deps
  return [state, dispatch] as const;
}


export function Spinner() {
  const { theme } = useTheme();
  return <ActivityIndicator size="small" color={theme.inkSoft} style={{ alignSelf: 'flex-start', marginTop: 8 }} />;
}

export const labelLine = (l: BottleLabel) => [l.name, l.year].filter(Boolean).join(' ');

// The year field, its NV tick chip with the ⓘ, and the alcohol % beside it.
// `knownAbv`: the catalogue's alcohol for the picked wine and year, shown in
// the same place, not editable (ruled 2026-11-22); `showAbv` (a new year, or a
// listed year without an alcohol: abvEditable) is the editable field instead.
export function YearRow({
  nv, onNv, yearText, onYear, showAbv, abvText, onAbv, knownAbv,
}: {
  nv: boolean; onNv: (v: boolean) => void;
  yearText: string; onYear: (t: string) => void;
  showAbv: boolean; abvText: string; onAbv: (t: string) => void;
  knownAbv?: string | null;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 12 }}>
      <View style={{ width: 92 }}>
        <TextField label="Year" placeholder="Year" value={yearText} onChangeText={(t) => onYear(t.replace(/\D/g, '').slice(0, 4))} editable={!nv} keyboardType="number-pad" maxLength={4} accessibilityHint="Leave empty if the year is unknown." />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingBottom: 6 }}>
        <ChoiceChip tick label="NV" on={nv} onPress={() => onNv(!nv)} accessibilityLabel="Non-vintage" />
        <NvInfo />
      </View>
      {showAbv ? (
        <View style={{ width: 96, marginLeft: 'auto' }}>
          <TextField label="Alcohol %" placeholder="e.g. 13.5" value={abvText} onChangeText={onAbv} keyboardType="decimal-pad" maxLength={5} />
        </View>
      ) : knownAbv ? (
        <View style={{ width: 96, marginLeft: 'auto' }}>
          <TextField label="Alcohol %" value={knownAbv} editable={false} accessibilityLabel={`Alcohol ${knownAbv} %, from the catalogue`} />
        </View>
      ) : null}
    </View>
  );
}

// The ⓘ beside NV (ui/InfoTip).
export function NvInfo() {
  return <InfoTip accessibilityLabel="What does NV mean?" text="Non-vintage: a release without a year." />;
}

export function StatusLine({ text, error }: { text: string | null; error?: boolean }) {
  const { theme } = useTheme();
  if (!text) return null;
  return <VText variant="small" style={{ marginTop: 8, color: error ? theme.critical : theme.inkSoft }}>{text}</VText>;
}

// What the typed year will be ("2019 is in the catalogue." / "2019 is added on
// save."): green with a tick (ruled 2026-11-22), the app's positive colour and
// check glyph (the username's "Available", a friend row's badge).
export function YearLine({ text }: { text: string | null }) {
  const { theme } = useTheme();
  if (!text) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
      <Icon name="check" size={14} color={theme.positive} />
      <VText variant="small" color="positive" style={{ flexShrink: 1 }}>{text}</VText>
    </View>
  );
}

// A quiet line inside a result list ("The first 20", the close matches' line):
// the app's list notes (`small`, ink-soft), at the rows' inset.
export function ListNote({ text }: { text: string }) {
  return <VText surface="compactList" variant="small" color="inkSoft" style={{ paddingHorizontal: 12, paddingVertical: 4 }}>{text}</VText>;
}

// A chosen step: its name (and a quiet line) with Change. The app's list-row
// type (ListRow / RecentRow / PeopleRow, ruled 2026-11-22: "the font sizes are
// quite random there"): name body semibold, the line under it `small` ink-soft.
export function ChosenLine({ title, sub, onChange, changeTitle = 'Change', second }: { title: string; sub: string | null; onChange?: () => void; changeTitle?: string; second?: { title: string; onPress: () => void } }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
        {sub ? <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
      </View>
      {second ? <Button title={second.title} variant="tertiary" size="sm" onPress={second.onPress} /> : null}
      {onChange ? <Button title={changeTitle} variant="tertiary" size="sm" onPress={onChange} /> : null}
    </View>
  );
}

export function ResultList({ children }: { children: React.ReactNode }) {
  return <View style={{ marginTop: 6, gap: 2 }}>{children}</View>;
}

// A search row, on the app's list-row type (ListRow / RecentRow / PeopleRow):
// the name body semibold, the line under it `small` ink-soft, the comfort
// padding every list row grows by. `trailing`: the carried year at the end of
// the row (ADR-0010), drawn like a list's vintage (the name's size, ink-soft,
// medium). `disabled`: a row of an older answer while the next one is awaited
// (shown, not selectable). The add rows are `DashedAddRow`.
export function ResultRow({ title, sub, trailing, disabled, onPress }: { title: string; sub?: string | null; trailing?: string | null; disabled?: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, sub, trailing].filter(Boolean).join(', ')}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: surface.paddingY(phone.lerp(10, 14)), paddingHorizontal: 12, borderRadius: radius.sm, opacity: disabled ? 0.5 : 1, backgroundColor: pressed ? theme.surfaceSunk : 'transparent' })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: surface.gap(phone.lerp(2, 4)) }}>
        <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>{title}</VText>
        {sub ? <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
      </View>
      {trailing ? <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{trailing}</VText> : null}
    </Pressable>
  );
}

// ── The pages' frame and their flow (BottleSearch.tsx, CatalogPages.tsx) ──

export type CatalogTarget = { mount: SessionMount; inDetails: boolean };
export type PageFlow = NonNullable<ReturnType<typeof getFlow<CatalogScope, CatalogTarget, ProductHit>>>;

// The page's flow, read ONCE (a finish marks it done while the page is still
// on screen during the pop: it must not flash "not available"), and counted
// as mounted while it is (what a finish pops back to the host).
export function usePageFlow(): { key: string; flow: PageFlow | null } {
  const { key: raw } = useLocalSearchParams<{ key?: string }>();
  const key = typeof raw === 'string' ? raw : '';
  const [flow] = useState(() => getFlow<CatalogScope, CatalogTarget, ProductHit>(key));
  useEffect(() => {
    if (!key || !flow) return;
    pageMounted(key);
    return () => pageUnmounted(key);
  }, [key, flow]);
  return { key, flow };
}

export function PageShell({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={title} right={right} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

// A page whose flow is gone (its form closed, a cold link): say so, back only.
export function Gone() {
  return (
    <PageShell title="">
      <CenteredMessage title="This isn’t available any more" body="Go back and choose the bottle again." />
    </PageShell>
  );
}

