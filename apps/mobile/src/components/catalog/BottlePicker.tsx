import { useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react';
import { useIsFocused, usePreventRemove } from 'expo-router';
import { ActivityIndicator, Pressable, View, type TextInputInstance } from 'react-native';
import { countryName } from '@verre/core';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Button } from '@/components/ui/Button';
import { ChoiceChip } from '@/components/ui/ChoiceChip';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { CountrySheet, Disclosure, FieldGroup, SelectField } from '@/components/moments/momentForm';
import {
  CatalogSearchError, listVintages, searchBottles, searchProducers, searchProducts,
  type BottleHit, type CatalogScope, type ProducerHit, type ProductHit, type SearchAnswer, type VintageHit,
} from '@/lib/api/catalog';
import { closeNote, initialSearch, offersAddProducer, offersNew, pendingRequest, pickRow, searchNotice, searchReducer, visibleRows, type SearchEvent, type SearchState } from '@/lib/bottleSearch';
import { backStep, COLOURS, newWineChoice, pickedChoice, readYear, yearFate, yearLine, type BottleLabel, type CatalogChoice, type Colour } from '@/lib/catalogChoice';
import { kindLabel } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';
import { usePhoneTokens } from '@/lib/layout';

// The bottle picker (ADR-0010, which supersedes ADR-0009's "producer first"):
// inline in the form, ONE field (producer, wine, region and year in any order,
// every typed word must match), one row per wine with its producer under it and
// the typed year; a tap picks it and the year field gets that year. Nothing fits
// → "Add Wine to Catalogue": the producer field (the same every-word search;
// pick one, or "Add Producer" when none is exactly the typed name), that
// producer's wines, then a new wine's fields. It reports
// its state to the form on every change; the form sends it with the save. The
// rules (the bodies, the year's fate, the errors) are pure in
// lib/catalogChoice.ts, the searches' state in lib/bottleSearch.ts.
// 🔒 Nothing links until the person picks: no top hit is ever taken.

export type PickerState =
  | { status: 'unchanged' } // edit: the bottle keeps its wine
  | { status: 'none' } // nothing chosen yet
  | { status: 'pending' } // a picked wine's years are still loading
  | { status: 'error'; error: string }
  | { status: 'ok'; choice: CatalogChoice };

type NewProducer = { id: null; name: string };

export type BottlePickerHandle = { stepBack: () => void };

// The screen's back steps through the picker first (ruled 2026-11-22): while
// the picker is past its first step, a BACK (the bar's arrow = GO_BACK, the
// edge swipe = POP: the native stack snaps the screen back and reports it,
// Android's back) goes one picker step back instead of leaving the page. Any
// other removal (a replace, a pop to the tab's root, a redirect) goes through.
// Only while the screen is in front: Check In's first stage stays mounted under
// its rate stage, whose exit removes both. A screen's own exits (a save, "this
// is gone") call `allowLeave()` before they go back.
export function usePickerBack(enabled = true) {
  const ref = useRef<BottlePickerHandle>(null);
  const [can, setCan] = useState(false);
  const focused = useIsFocused();
  const allowLeave = usePreventRemove(enabled && focused && can, ({ data, repeat }) => {
    const t = data.action.type;
    if ((t === 'GO_BACK' || t === 'POP') && ref.current) ref.current.stepBack();
    else repeat();
  });
  return { pickerProps: { ref, onCanStepBack: setCan }, allowLeave };
}

// One search field's state, driven by the pure controller: one request per
// pause in typing (300 ms), its answer kept only for the generation it was
// asked for.
function useCatalogSearch<T>(min: number, run: (q: string) => Promise<SearchAnswer<T>>) {
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

export function BottlePicker({
  scope: scopeIn, current, frozen, showErrors, onChange, ref, onCanStepBack,
}: {
  scope: CatalogScope;
  /** Edit: the bottle as it is. Its summary shows with Change; until then the state is `unchanged`. */
  current?: BottleLabel | null;
  /** A save may have landed: the choice shows read-only (ADR-0009 freeze rule). */
  frozen?: { label: BottleLabel; isNew: boolean } | null;
  /** After a save attempt: a draft's error shows under it. */
  showErrors?: boolean;
  onChange: (s: PickerState) => void;
  /** `usePickerBack`: the screen's back steps through the picker. */
  ref?: React.Ref<BottlePickerHandle>;
  onCanStepBack?: (can: boolean) => void;
}) {
  const { theme } = useTheme();
  // 🔒 Keyed on the moment's CODE: a caller passing `{ code }` inline makes a new
  // object every render, and the searches below depend on the scope (review r1:
  // every keystroke elsewhere in the form re-ran the year lookup and spent the
  // search budget).
  const scopeCode = scopeIn?.code ?? null;
  const scope: CatalogScope = useMemo(() => (scopeCode ? { code: scopeCode } : null), [scopeCode]);
  const [changing, setChanging] = useState(!current);
  // 'find' = the one field; 'new' = "Add Wine to Catalogue": producer → its wines → a new wine.
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [bottle, bottleDo] = useCatalogSearch<BottleHit>(3, (q) => searchBottles(scope, q));
  const [producerS, producerDo] = useCatalogSearch<ProducerHit>(3, (q) => searchProducers(scope, q));
  const [producer, setProducer] = useState<ProducerHit | NewProducer | null>(null);
  const producerIdRef = useRef<string | null>(null);
  const [wineS, wineDo] = useCatalogSearch<ProductHit>(0, (q) => searchProducts(scope, producerIdRef.current ?? '', q));
  const [product, setProduct] = useState<ProductHit | null>(null);
  const [creating, setCreating] = useState(false);
  const [vintages, setVintages] = useState<VintageHit[] | null>(null);
  // A failed year lookup is its own state (never "still loading") and is asked
  // again on the next keystroke in the year field or a tap on NV.
  const [vintagesTry, setVintagesTry] = useState(0);
  const [vintagesFailed, setVintagesFailed] = useState(false);
  const [yearText, setYearText] = useState('');
  const [nv, setNv] = useState(false);
  const [abvText, setAbvText] = useState('');
  const [colour, setColour] = useState<Colour | null>(null);
  const [sparkling, setSparkling] = useState(false);
  const [grapes, setGrapes] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState('');
  // A new wine's name: its OWN field (review 2026-11-21: typing it into the
  // wine search's state sent a catalogue search on every pause, spending the
  // search budget for a list nobody sees). Seeded from that search's text when
  // "Add Wine “…”" is tapped.
  const [wineQ, setWineQ] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [yearNotice, setYearNotice] = useState<string | null>(null);
  const producerRef = useRef<TextInputInstance>(null);
  const wineRef = useRef<TextInputInstance>(null);

  // A new scope (another moment) starts every search over.
  useEffect(() => { bottleDo({ type: 'reset' }); producerDo({ type: 'reset' }); wineDo({ type: 'reset' }); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!product) { setVintages(null); setVintagesFailed(false); return; }
    let live = true;
    setVintagesFailed(false);
    listVintages(scope, product.id)
      .then((r) => { if (live) { setVintages(r); setYearNotice(null); } })
      .catch((e) => { if (live) { setVintagesFailed(true); setYearNotice(e instanceof CatalogSearchError ? e.message : 'Search failed. Try again.'); } });
    return () => { live = false; };
  }, [product, scope, vintagesTry]);
  const retryYears = () => { if (vintagesFailed) setVintagesTry((n) => n + 1); };
  const onYear = (t: string) => { setYearText(t); retryYears(); };

  // The state the form sends with its save.
  const state: PickerState = (() => {
    if (current && !changing) return { status: 'unchanged' };
    if (product) {
      const r = pickedChoice(product, vintages, nv, yearText, abvText);
      if ('pending' in r && vintagesFailed) return { status: 'error', error: 'Couldn’t load its years. Type the year again, or tap NV.' };
      return 'choice' in r ? { status: 'ok', choice: r.choice } : 'error' in r ? { status: 'error', error: r.error } : { status: 'pending' };
    }
    if (creating && producer) {
      const r = newWineChoice({ producer, name: wineQ, colour, sparkling, nv, year: yearText, abv: abvText, grapes, region, country });
      return 'choice' in r ? { status: 'ok', choice: r.choice } : { status: 'error', error: r.error };
    }
    return { status: 'none' };
  })();
  const stateKey = JSON.stringify(state);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => { onChangeRef.current(JSON.parse(stateKey) as PickerState); }, [stateKey]);

  const resetYear = () => { setYearText(''); setNv(false); setAbvText(''); setYearNotice(null); };
  // A new wine's facts never carry over to another producer or wine (review r1:
  // a hidden "More" kept the old grapes for a new permanent entry).
  const resetNew = () => { setWineQ(''); setColour(null); setSparkling(false); setGrapes(''); setRegion(''); setCountry(''); setMoreOpen(false); };
  const choose = (p: ProducerHit | NewProducer) => {
    setProducer(p);
    producerIdRef.current = p.id;
    if (p.id) { wineDo({ type: 'reset' }); wineDo({ type: 'text', text: '' }); setTimeout(() => wineRef.current?.focus(), 50); } else setCreating(true);
  };
  const backToProducer = () => { setProducer(null); producerIdRef.current = null; setProduct(null); setCreating(false); wineDo({ type: 'reset' }); resetYear(); resetNew(); };
  const backToWine = () => { setProduct(null); setCreating(false); resetYear(); resetNew(); };
  // From a picked wine: back to wherever it was picked from.
  const unpick = () => { if (mode === 'new') backToWine(); else { setProduct(null); resetYear(); } };
  const toFind = () => { backToProducer(); producerDo({ type: 'reset' }); setMode('find'); };
  const toNew = () => { setMode('new'); producerDo({ type: 'reset' }); setTimeout(() => producerRef.current?.focus(), 50); };
  const keep = () => { toFind(); bottleDo({ type: 'reset' }); setChanging(false); };
  const step = backStep({
    frozen: !!frozen, editing: !!current, changing, mode, picked: !!product,
    producer: producer ? (producer.id ? 'listed' : 'new') : null, creating,
  });
  const back = { keep, unpick, wines: backToWine, producer: backToProducer, search: toFind, none: null }[step];
  const backRef = useRef(back);
  backRef.current = back;
  useImperativeHandle(ref, () => ({ stepBack: () => { backRef.current?.(); } }), []);
  const onCanStepBackRef = useRef(onCanStepBack);
  onCanStepBackRef.current = onCanStepBack;
  const canBack = back !== null;
  useEffect(() => {
    onCanStepBackRef.current?.(canBack);
    return () => onCanStepBackRef.current?.(false);
  }, [canBack]);
  const pickBottle = (id: string) => {
    const r = pickRow(bottle, id);
    if (!r) return;
    // The typed year goes into the year field (ruling 4): the wine that lacks it
    // shows it as "added on save", one that has it as "in the catalogue".
    setProduct(r.hit); resetYear(); setYearText(r.yearText);
  };

  if (frozen) return <Summary label={frozen.label} isNew={frozen.isNew} />;
  if (current && !changing) return <Summary label={current} onChange={() => setChanging(true)} />;

  const fate = product ? yearFate(vintages, readYear(nv, yearText)) : null;
  const waiting = (s: SearchState<unknown>) => s.status === 'waiting';
  const bottleRows = visibleRows(bottle);
  const producerRows = visibleRows(producerS);
  const wineRows = visibleRows(wineS);

  return (
    <View style={{ marginBottom: 16 }}>
      {current ? (
        <Pressable accessibilityRole="button" onPress={keep} style={{ alignSelf: 'flex-start', marginBottom: 10 }}>
          <VText variant="small" style={{ color: theme.accent, fontFamily: 'InstrumentSans_600SemiBold' }}>{`Keep “${labelLine(current)}”`}</VText>
        </Pressable>
      ) : null}

      {/* 1 — the one field: producer, wine, region, year, any order */}
      {mode === 'find' && !product ? (
        <View>
          <TextField label="Wine" placeholder="Search wines" value={bottle.text} onChangeText={(text) => bottleDo({ type: 'text', text })} autoCorrect={false} returnKeyType="search" accessibilityHint="Producer, wine, region or year, in any order." />
          {bottle.status !== 'idle' ? (
            <ResultList>
              {closeNote(bottle) ? <ListNote text={closeNote(bottle)!} /> : null}
              {bottleRows.rows.map((b) => (
                <ResultRow key={b.id} title={b.name} sub={b.producerName} trailing={b.year === null ? null : String(b.year)} disabled={!bottleRows.selectable} onPress={() => pickBottle(b.id)} />
              ))}
              {offersNew(bottle) ? <ResultRow add title="Add Wine to Catalogue" onPress={toNew} /> : null}
            </ResultList>
          ) : null}
          {waiting(bottle) ? <Spinner /> : null}
          <StatusLine text={searchNotice(bottle)} error={bottle.status === 'failed'} />
        </View>
      ) : null}

      {/* "Add Wine to Catalogue" — 1: the producer */}
      {mode === 'new' && !producer ? (
        <View>
          <Pressable accessibilityRole="button" onPress={toFind} style={{ alignSelf: 'flex-start', marginBottom: 10 }}>
            <VText variant="small" style={{ color: theme.accent, fontFamily: 'InstrumentSans_600SemiBold' }}>Back to Search</VText>
          </Pressable>
          <TextField ref={producerRef} label="Producer" placeholder="Search producers" value={producerS.text} onChangeText={(text) => producerDo({ type: 'text', text })} autoCorrect={false} returnKeyType="search" />
          {producerS.status !== 'idle' ? (
            <ResultList>
              {producerRows.rows.map((p) => (
                <ResultRow key={p.id} title={p.name} sub={[p.region, p.country ? countryName(p.country) || p.country : null].filter(Boolean).join(', ')} disabled={!producerRows.selectable} onPress={() => { if (producerRows.selectable) choose(p); }} />
              ))}
              {offersAddProducer(producerS) ? <ResultRow add title={`Add Producer “${producerS.text.trim()}”`} onPress={() => choose({ id: null, name: producerS.text.trim() })} /> : null}
            </ResultList>
          ) : null}
          {waiting(producerS) ? <Spinner /> : null}
          <StatusLine text={searchNotice(producerS, 'producers')} error={producerS.status === 'failed'} />
        </View>
      ) : null}
      {mode === 'new' && producer ? <ChosenLine title={producer.name} sub={producer.id ? null : 'New producer'} onChange={backToProducer} /> : null}

      {/* "Add Wine to Catalogue" — 2: the wines under it */}
      {mode === 'new' && producer?.id && !product && !creating ? (
        <View style={{ marginTop: 12 }}>
          <TextField ref={wineRef} label="Wine" placeholder="Search its wines" value={wineS.text} onChangeText={(text) => wineDo({ type: 'text', text })} autoCorrect={false} returnKeyType="search" />
          <ResultList>
            {wineS.more && wineS.text.trim().length < 3 && wineRows.selectable ? <ListNote text="The first 20. Type to narrow the list." /> : null}
            {wineRows.rows.map((p) => (
              <ResultRow key={p.id} title={p.name} sub={kindLabel(p)} disabled={!wineRows.selectable} onPress={() => { if (wineRows.selectable) { setProduct(p); resetYear(); } }} />
            ))}
            {wineS.text.trim() && offersNew(wineS) ? <ResultRow add title={`Add Wine “${wineS.text.trim()}”`} onPress={() => { setWineQ(wineS.text.trim()); setCreating(true); }} /> : null}
          </ResultList>
          {waiting(wineS) ? <Spinner /> : null}
          {wineS.status === 'failed' ? <StatusLine text={searchNotice(wineS)} error /> : null}
        </View>
      ) : null}

      {/* A picked wine's year (one field: listed, or added) */}
      {product ? (
        <View style={{ marginTop: mode === 'new' ? 12 : 0 }}>
          <ChosenLine title={product.name} sub={[mode === 'find' ? product.producerName : null, kindLabel(product)].filter(Boolean).join(' · ') || null} onChange={unpick} />
          <YearRow
            nv={nv} onNv={(v) => { setNv(v); if (v) setYearText(''); retryYears(); }}
            yearText={yearText} onYear={onYear}
            showAbv={fate?.fate === 'added'} abvText={abvText} onAbv={setAbvText}
          />
          <StatusLine text={fate ? yearLine(fate) : null} />
          {showErrors && state.status === 'error' ? <StatusLine text={state.error} error /> : null}
          {fate?.fate === 'pending' && !vintagesFailed && (yearText.trim() || nv) ? <Spinner /> : null}
          <StatusLine text={yearNotice} error />
        </View>
      ) : null}

      {/* "Add Wine to Catalogue" — 3: a new wine's facts, in place */}
      {creating && producer ? (
        <View style={{ marginTop: 12, padding: 14, borderRadius: radius.md, backgroundColor: theme.surface, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', flex: 1 }}>{producer.id ? `New wine under ${producer.name}` : 'New wine'}</VText>
            {producer.id ? <Button title="Change" variant="tertiary" size="sm" onPress={backToWine} /> : null}
          </View>
          <TextField label="Wine" placeholder="Its name" value={wineQ} onChangeText={setWineQ} autoCorrect={false} />
          <FieldGroup label="Colour">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
              {COLOURS.map((c) => (
                <ChoiceChip key={c.code} label={c.label} on={colour === c.code} onPress={() => setColour((v) => (v === c.code ? null : c.code))} />
              ))}
              <ChoiceChip tick label="Sparkling" on={sparkling} onPress={() => setSparkling((v) => !v)} />
            </View>
          </FieldGroup>
          <YearRow
            nv={nv} onNv={(v) => { setNv(v); if (v) setYearText(''); }}
            yearText={yearText} onYear={setYearText}
            showAbv abvText={abvText} onAbv={setAbvText}
          />
          <Disclosure label="More" open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>
            <TextField label="Grapes" placeholder="Separated by commas" value={grapes} onChangeText={setGrapes} autoCorrect={false} />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <TextField label="Region" placeholder="Where it is from" value={region} onChangeText={setRegion} autoCorrect={false} maxLength={255} />
              </View>
              <View style={{ flex: 1 }}>
                <FieldGroup label="Country">
                  <SelectField value={countryName(country) || ''} placeholder="Country" onPress={() => setCountryOpen(true)} accessibilityLabel={`Country${country ? `: ${countryName(country)}` : ''}`} />
                </FieldGroup>
              </View>
            </View>
          </Disclosure>
          {showErrors && state.status === 'error' ? <StatusLine text={state.error} error /> : null}
          <CountrySheet open={countryOpen} selected={country} onSelect={(c) => { setCountry(c); setCountryOpen(false); }} onClose={() => setCountryOpen(false)} />
        </View>
      ) : null}
    </View>
  );
}

function Spinner() {
  const { theme } = useTheme();
  return <ActivityIndicator size="small" color={theme.inkSoft} style={{ alignSelf: 'flex-start', marginTop: 8 }} />;
}

const labelLine = (l: BottleLabel) => [l.name, l.year].filter(Boolean).join(' ');

// The year field, its NV tick chip with the ⓘ, and the alcohol % beside it.
function YearRow({
  nv, onNv, yearText, onYear, showAbv, abvText, onAbv,
}: {
  nv: boolean; onNv: (v: boolean) => void;
  yearText: string; onYear: (t: string) => void;
  showAbv: boolean; abvText: string; onAbv: (t: string) => void;
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
      ) : null}
    </View>
  );
}

// The ⓘ beside NV: an info popover (never a "bubble": bubbles are sparkling).
function NvInfo() {
  const { theme } = useTheme();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <AnchorButton icon="info" iconColor={theme.inkSoft} accessibilityLabel="What does NV mean?" onOpen={setAnchor} />
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={16} minWidth={200}>
        <VText variant="small" style={{ color: theme.ink, paddingHorizontal: 10, paddingVertical: 6 }}>Non-vintage: a release without a year.</VText>
      </AnchoredMenu>
    </>
  );
}

function StatusLine({ text, error }: { text: string | null; error?: boolean }) {
  const { theme } = useTheme();
  if (!text) return null;
  return <VText variant="small" style={{ marginTop: 8, color: error ? theme.critical : theme.inkSoft }}>{text}</VText>;
}

// A quiet line inside a result list ("The first 20", the close matches' line):
// the app's list notes (`small`, ink-soft), at the rows' inset.
function ListNote({ text }: { text: string }) {
  return <VText surface="compactList" variant="small" color="inkSoft" style={{ paddingHorizontal: 12, paddingVertical: 4 }}>{text}</VText>;
}

// A chosen step: its name (and a quiet line) with Change. The app's list-row
// type (ListRow / RecentRow / PeopleRow, ruled 2026-11-22: "the font sizes are
// quite random there"): name body semibold, the line under it `small` ink-soft.
function ChosenLine({ title, sub, onChange }: { title: string; sub: string | null; onChange: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
        {sub ? <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
      </View>
      <Button title="Change" variant="tertiary" size="sm" onPress={onChange} />
    </View>
  );
}

// The folded choice: name and year, producer, and Change (none when frozen).
function Summary({ label, isNew, onChange }: { label: BottleLabel; isNew?: boolean; onChange?: () => void }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: radius.md, backgroundColor: theme.surface, marginBottom: 16 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText surface="compactList" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {label.name}
          {label.year ? <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{` ${label.year}`}</VText> : null}
        </VText>
        <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>{[label.producer, kindLabel(label), isNew ? 'New' : null].filter(Boolean).join(' · ')}</VText>
      </View>
      {onChange ? <Button title="Change" variant="tertiary" size="sm" onPress={onChange} /> : null}
    </View>
  );
}

function ResultList({ children }: { children: React.ReactNode }) {
  return <View style={{ marginTop: 6, gap: 2 }}>{children}</View>;
}

// A search row, on the app's list-row type (ListRow / RecentRow / PeopleRow):
// the name body semibold, the line under it `small` ink-soft, the comfort
// padding every list row grows by. `trailing`: the carried year at the end of
// the row (ADR-0010), drawn like a list's vintage (the name's size, ink-soft,
// medium). `disabled`: a row of an older answer while the next one is awaited
// (shown, not selectable).
function ResultRow({ title, sub, trailing, add, disabled, onPress }: { title: string; sub?: string | null; trailing?: string | null; add?: boolean; disabled?: boolean; onPress: () => void }) {
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
      {add ? <Icon name="plus" size={16} color={theme.accent} /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: surface.gap(phone.lerp(2, 4)) }}>
        <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', color: add ? theme.accent : theme.ink }}>{title}</VText>
        {sub ? <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
      </View>
      {trailing ? <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>{trailing}</VText> : null}
    </Pressable>
  );
}
