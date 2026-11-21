import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View, type TextInputInstance } from 'react-native';
import { countryName } from '@verre/core';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Button } from '@/components/ui/Button';
import { ChoiceChip } from '@/components/ui/ChoiceChip';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { CountrySheet, Disclosure, FieldGroup, SelectField } from '@/components/moments/momentForm';
import { CatalogSearchError, listVintages, searchProducers, searchProducts, type CatalogScope, type ProducerHit, type ProductHit, type VintageHit } from '@/lib/api/catalog';
import { COLOURS, newWineChoice, pickedChoice, readYear, yearFate, yearLine, type BottleLabel, type CatalogChoice, type Colour } from '@/lib/catalogChoice';
import { kindLabel } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

// The bottle picker (ADR-0009): inline in the form, producer first, then its
// wines, then the year. A wine that isn't there opens its fields in place.
// It reports its state to the form on every change; the form sends it with
// the save. The rules (the bodies, the year's fate, the errors) are pure in
// lib/catalogChoice.ts. The web's components/wine/CatalogPicker.tsx is the
// behaviour reference.
// 🔒 Nothing links until the person picks: no top hit is ever taken.

export type PickerState =
  | { status: 'unchanged' } // edit: the bottle keeps its wine
  | { status: 'none' } // nothing chosen yet
  | { status: 'pending' } // a picked wine's years are still loading
  | { status: 'error'; error: string }
  | { status: 'ok'; choice: CatalogChoice };

type NewProducer = { id: null; name: string };

export function BottlePicker({
  scope: scopeIn, current, frozen, showErrors, onChange,
}: {
  scope: CatalogScope;
  /** Edit: the bottle as it is. Its summary shows with Change; until then the state is `unchanged`. */
  current?: BottleLabel | null;
  /** A save may have landed: the choice shows read-only (ADR-0009 freeze rule). */
  frozen?: { label: BottleLabel; isNew: boolean } | null;
  /** After a save attempt: a draft's error shows under it. */
  showErrors?: boolean;
  onChange: (s: PickerState) => void;
}) {
  const { theme } = useTheme();
  // 🔒 Keyed on the moment's CODE: a caller passing `{ code }` inline makes a new
  // object every render, and the searches below depend on the scope (review r1:
  // every keystroke elsewhere in the form re-ran the year lookup and spent the
  // search budget).
  const scopeCode = scopeIn?.code ?? null;
  const scope: CatalogScope = useMemo(() => (scopeCode ? { code: scopeCode } : null), [scopeCode]);
  const [changing, setChanging] = useState(!current);
  const [producerQ, setProducerQ] = useState('');
  const [producers, setProducers] = useState<ProducerHit[]>([]);
  const [producer, setProducer] = useState<ProducerHit | NewProducer | null>(null);
  const [wineQ, setWineQ] = useState('');
  const [products, setProducts] = useState<ProductHit[]>([]);
  const [more, setMore] = useState(false);
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  // One sequence and one spinner flag PER search (review r2: a shared one let
  // the wine search's early return drop the producer search's answer on Change).
  const [producerSearching, setProducerSearching] = useState(false);
  const [wineSearching, setWineSearching] = useState(false);
  const searching = producerSearching || wineSearching;
  const [notice, setNotice] = useState<string | null>(null);
  // The catalogue is switched off (a search 404): no "+ New" rows then, since a
  // new wine would be refused at the save.
  const [off, setOff] = useState(false);
  const producerSeq = useRef(0);
  const wineSeq = useRef(0);
  const wineRef = useRef<TextInputInstance>(null);

  const fail = (e: unknown) => {
    setNotice(e instanceof CatalogSearchError ? e.message : 'Search failed. Try again.');
    if (e instanceof CatalogSearchError && e.reason === 'off') setOff(true);
  };

  // One search per pause in typing; a late answer to an older query is dropped.
  useEffect(() => {
    if (producer || producerQ.trim().length < 3) { producerSeq.current++; setProducers([]); setProducerSearching(false); return; }
    const n = ++producerSeq.current;
    setProducerSearching(true);
    const t = setTimeout(() => {
      searchProducers(scope, producerQ.trim())
        .then((r) => { if (n === producerSeq.current) { setProducers(r); setNotice(null); setOff(false); } })
        .catch((e) => { if (n === producerSeq.current) fail(e); })
        .finally(() => { if (n === producerSeq.current) setProducerSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [producerQ, producer, scope]);
  // A picked producer's wines: under 3 characters the server lists them A to Z.
  useEffect(() => {
    if (!producer?.id || product || creating) { wineSeq.current++; setProducts([]); setWineSearching(false); return; }
    const id = producer.id;
    const n = ++wineSeq.current;
    setWineSearching(true);
    const t = setTimeout(() => {
      searchProducts(scope, id, wineQ.trim())
        .then((r) => { if (n === wineSeq.current) { setProducts(r.results); setMore(r.more); setNotice(null); setOff(false); } })
        .catch((e) => { if (n === wineSeq.current) fail(e); })
        .finally(() => { if (n === wineSeq.current) setWineSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [wineQ, producer, product, creating, scope]);
  useEffect(() => {
    if (!product) { setVintages(null); setVintagesFailed(false); return; }
    let live = true;
    setVintagesFailed(false);
    listVintages(scope, product.id)
      .then((r) => { if (live) { setVintages(r); setNotice(null); } })
      .catch((e) => { if (live) { setVintagesFailed(true); fail(e); } });
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

  const resetYear = () => { setYearText(''); setNv(false); setAbvText(''); };
  // A new wine's facts never carry over to another producer or wine (review r1:
  // a hidden "More" kept the old grapes for a new permanent entry).
  const resetNew = () => { setColour(null); setSparkling(false); setGrapes(''); setRegion(''); setCountry(''); setMoreOpen(false); };
  const backToProducer = () => { setProducer(null); setProduct(null); setCreating(false); setWineQ(''); resetYear(); resetNew(); setNotice(null); };
  const backToWine = () => { setProduct(null); setCreating(false); resetYear(); resetNew(); setNotice(null); };

  if (frozen) return <Summary label={frozen.label} isNew={frozen.isNew} />;
  if (current && !changing) return <Summary label={current} onChange={() => setChanging(true)} />;

  const q = producerQ.trim();
  const fate = product ? yearFate(vintages, readYear(nv, yearText)) : null;

  return (
    <View style={{ marginBottom: 16 }}>
      {current ? (
        <Pressable accessibilityRole="button" onPress={() => { backToProducer(); setProducerQ(''); setChanging(false); }} style={{ alignSelf: 'flex-start', marginBottom: 10 }}>
          <VText variant="small" style={{ color: theme.accent, fontFamily: 'InstrumentSans_600SemiBold' }}>{`Keep “${labelLine(current)}”`}</VText>
        </Pressable>
      ) : null}

      {/* 1 — the producer */}
      {!producer ? (
        <View>
          <TextField label="Producer" placeholder="Search producers" value={producerQ} onChangeText={setProducerQ} autoCorrect={false} returnKeyType="search" />
          {q.length >= 3 ? (
            <ResultList>
              {producers.map((p) => (
                <ResultRow key={p.id} title={p.name} sub={[p.region, p.country ? countryName(p.country) || p.country : null].filter(Boolean).join(', ')} onPress={() => { setProducer(p); setNotice(null); setTimeout(() => wineRef.current?.focus(), 50); }} />
              ))}
              {!off ? <ResultRow add title={`New Producer “${q}”`} onPress={() => { setProducer({ id: null, name: q }); setCreating(true); setNotice(null); }} /> : null}
            </ResultList>
          ) : null}
        </View>
      ) : (
        <ChosenLine title={producer.name} sub={producer.id ? null : 'New producer'} onChange={backToProducer} />
      )}

      {/* 2 — the wine under it */}
      {producer && !product && !creating ? (
        <View style={{ marginTop: 12 }}>
          <TextField ref={wineRef} label="Wine" placeholder="Search its wines" value={wineQ} onChangeText={setWineQ} autoCorrect={false} returnKeyType="search" />
          <ResultList>
            {more && wineQ.trim().length < 3 ? <VText variant="caption" color="inkFaint" style={{ paddingHorizontal: 12, paddingVertical: 4 }}>The first 20. Type to narrow the list.</VText> : null}
            {products.map((p) => (
              <ResultRow key={p.id} title={p.name} sub={kindLabel(p)} onPress={() => { setProduct(p); resetYear(); }} />
            ))}
            {wineQ.trim() && !off ? <ResultRow add title={`New Wine “${wineQ.trim()}”`} onPress={() => setCreating(true)} /> : null}
          </ResultList>
        </View>
      ) : null}

      {/* 3 — a picked wine's year (one field: listed, or added) */}
      {product ? (
        <View style={{ marginTop: 12 }}>
          <ChosenLine title={product.name} sub={kindLabel(product)} onChange={backToWine} />
          <YearRow
            nv={nv} onNv={(v) => { setNv(v); if (v) setYearText(''); retryYears(); }}
            yearText={yearText} onYear={onYear}
            showAbv={fate?.fate === 'added'} abvText={abvText} onAbv={setAbvText}
          />
          <StatusLine text={fate ? yearLine(fate) : null} />
          {showErrors && state.status === 'error' ? <StatusLine text={state.error} error /> : null}
          {fate?.fate === 'pending' && !vintagesFailed && (yearText.trim() || nv) ? <ActivityIndicator size="small" color={theme.inkSoft} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
        </View>
      ) : null}

      {/* 2b — a new wine's facts, in place */}
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

      {searching && !notice ? <ActivityIndicator size="small" color={theme.inkSoft} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
      {notice ? <StatusLine text={notice} error /> : null}
    </View>
  );
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

// A chosen step: its name (and a quiet line) with Change.
function ChosenLine({ title, sub, onChange }: { title: string; sub: string | null; onChange: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText variant="body" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
        {sub ? <VText variant="caption" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
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
        <VText variant="body" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{labelLine(label)}</VText>
        <VText variant="caption" color="inkSoft" numberOfLines={1}>{[label.producer, kindLabel(label), isNew ? 'New' : null].filter(Boolean).join(' · ')}</VText>
      </View>
      {onChange ? <Button title="Change" variant="tertiary" size="sm" onPress={onChange} /> : null}
    </View>
  );
}

function ResultList({ children }: { children: React.ReactNode }) {
  return <View style={{ marginTop: 6, gap: 2 }}>{children}</View>;
}

function ResultRow({ title, sub, add, onPress }: { title: string; sub?: string | null; add?: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}, ${sub}` : title}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.sm, backgroundColor: pressed ? theme.surfaceSunk : 'transparent' })}
    >
      {add ? <Icon name="plus" size={16} color={theme.accent} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText variant="body" numberOfLines={1} style={{ fontFamily: add ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium', color: add ? theme.accent : theme.ink }}>{title}</VText>
        {sub ? <VText variant="caption" color="inkSoft" numberOfLines={1}>{sub}</VText> : null}
      </View>
    </Pressable>
  );
}
