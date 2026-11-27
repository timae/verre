import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Switch, View } from 'react-native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { countryName } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { ChoiceChip } from '@/components/ui/ChoiceChip';
import { DashedAddRow } from '@/components/ui/DashedAddRow';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { CountrySheet, Disclosure, FieldGroup, SelectField } from '@/components/moments/momentForm';
import { Gone, ListNote, PageShell, ResultList, ResultRow, Spinner, StatusLine, useCatalogSearch, usePageFlow, YearRow } from '@/components/catalog/pickerParts';
import { searchProducers, searchProducts, type ProducerHit, type ProductHit } from '@/lib/api/catalog';
import { offersAddProducer, offersNew, searchNotice, visibleRows } from '@/lib/bottleSearch';
import { COLOURS, newWineChoice, type Colour, type NewWineDraft } from '@/lib/catalogChoice';
import { kindLabel } from '@/lib/momentFormat';
import { finishFlow, setFlowChoice, setFlowDraft, setFlowProducer, type FlowProducer } from '@/lib/pickerFlow';
import { catalogHref, pickedHref, type FlowDest } from '@/lib/sessionStack';
import { usePushGuard } from '@/lib/usePushGuard';
import { useTheme } from '@/theme';
import { alpha } from '@/theme/color';

// The "Add Wine to Catalogue" pages (ruled 2026-11-22: "that swipe back and back
// button behave differently is bad UX" → real pages; Codex: on the host's own
// stack). Producer → that producer's wines → a new wine's fields. Back on any of
// them is one page back, the bar's arrow and the edge swipe alike. A wine picked
// on the producer's page, or a new wine's draft after "Use", goes back to the
// host form through the flow (lib/pickerFlow.ts, the key in the params) and
// every page of the flow closes. Nothing is written to the catalogue here.
// The route files are one-line re-exports beside each host
// (lib/sessionStack.ts catalogHref).

const draftFor = (producer: FlowProducer, name = ''): NewWineDraft => ({
  producer, name, colour: null, sparkling: false, nv: false, year: '', abv: '', grapes: '', region: '', country: '',
});

// 1 — the producer: the every-word producer search; a listed one opens its
// wines, "Add Producer" (only without a producer of exactly that name, the
// server's `exact`) goes straight to the new wine's fields.
export function ProducerPage() {
  const { key, flow } = usePageFlow();
  const router = useRouter();
  const guard = usePushGuard();
  const scope = flow?.scope ?? null;
  const [s, d] = useCatalogSearch<ProducerHit>(3, (q) => searchProducers(scope, q));
  if (!flow) return <Gone />;
  const rows = visibleRows(s);
  // Inside the guard, the flow's change too (a double tap must not change it twice).
  const go = (p: FlowProducer) => guard(() => {
    setFlowProducer(key, p);
    router.push(catalogHref(flow.target.mount, flow.target.inDetails, p.id ? 'wines' : 'new', key));
  });
  return (
    <PageShell title="Producer">
      <TextField label="Producer" placeholder="Search producers" value={s.text} onChangeText={(text) => d({ type: 'text', text })} autoCorrect={false} returnKeyType="search" autoFocus />
      {s.status !== 'idle' ? (
        <ResultList>
          {rows.rows.map((p) => (
            <ResultRow key={p.id} title={p.name} sub={[p.region, p.country ? countryName(p.country) || p.country : null].filter(Boolean).join(', ')} disabled={!rows.selectable} onPress={() => { if (rows.selectable) go({ id: p.id, name: p.name, region: p.region, country: p.country }); }} />
          ))}
          {offersAddProducer(s) ? <DashedAddRow title={`Add Producer “${s.text.trim()}”`} onPress={() => go({ id: null, name: s.text.trim() })} /> : null}
        </ResultList>
      ) : null}
      {s.status === 'waiting' ? <Spinner /> : null}
      <StatusLine text={searchNotice(s, 'producers')} error={s.status === 'failed'} />
    </PageShell>
  );
}

// 2 — that producer's wines (A to Z until 3 characters are typed): a tap goes
// back to the form with the wine picked (its year is set there); "Add Wine “…”"
// opens the new wine's fields with that name.
export function WinesPage() {
  const { key, flow } = usePageFlow();
  const router = useRouter();
  const guard = usePushGuard();
  const scope = flow?.scope ?? null;
  const producer = flow?.producer?.id ? flow.producer : null;
  const [s, d] = useCatalogSearch<ProductHit>(0, (q) => searchProducts(scope, producer?.id ?? '', q));
  // List them on arrival (the controller sends nothing until a text event).
  useEffect(() => { if (producer?.id) d({ type: 'text', text: '' }); }, [producer?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flow || !producer) return <Gone />;
  const rows = visibleRows(s);
  // Adding: the details screen on top (ruled 2026-11-22); an edit's Change:
  // back to the form with the wine.
  const pick = (p: ProductHit) => {
    if (flow.mode === 'add') return guard(() => { setFlowChoice<ProductHit>(key, { kind: 'product', product: p, yearText: '' }); router.push(pickedHref(flow.target.mount, flow.dest as FlowDest, key)); });
    const depth = finishFlow<ProductHit>(key, { kind: 'product', product: p, yearText: '' });
    if (depth > 0) router.dismiss(depth);
  };
  const add = () => guard(() => {
    setFlowDraft(key, draftFor(producer, s.text.trim()));
    router.push(catalogHref(flow.target.mount, flow.target.inDetails, 'new', key));
  });
  return (
    <PageShell title={producer.name}>
      <TextField label="Wine" placeholder="Search its wines" value={s.text} onChangeText={(text) => d({ type: 'text', text })} autoCorrect={false} returnKeyType="search" />
      <ResultList>
        {s.more && s.text.trim().length < 3 && rows.selectable ? <ListNote text="The first 20. Type to narrow the list." /> : null}
        {rows.rows.map((p) => (
          <ResultRow key={p.id} title={p.name} sub={kindLabel(p)} disabled={!rows.selectable} onPress={() => { if (rows.selectable) pick(p); }} />
        ))}
        {s.text.trim() && offersNew(s) ? <DashedAddRow title={`Add Wine “${s.text.trim()}”`} onPress={add} /> : null}
      </ResultList>
      {s.status === 'waiting' ? <Spinner /> : null}
      {s.status === 'failed' ? <StatusLine text={searchNotice(s)} error /> : null}
    </PageShell>
  );
}

// 3 — a new wine's facts (a new producer, or a wine its producer lacks). "Use"
// checks them (the same rule as the save) and takes the draft back to the form,
// which sends it with its own save. Seeded from the flow: the name typed on the
// wines page, or the draft the form holds (its Edit).
export function NewWinePage() {
  const { theme } = useTheme();
  // The OFF track ToggleRow uses (settingsParts.tsx): a neutral ink at 18%.
  const offTrack = alpha(theme.ink, 0.18);
  const { key, flow } = usePageFlow();
  const router = useRouter();
  const guard = usePushGuard();
  const seed = flow?.draft ?? null;
  const producer = flow?.producer ?? null;
  // A new wine's name: its OWN field (review 2026-11-21: never a search's text).
  const [wineQ, setWineQ] = useState(seed?.name ?? '');
  const [colour, setColour] = useState<Colour | null>(seed?.colour ?? null);
  const [sparkling, setSparkling] = useState(seed?.sparkling ?? false);
  const [nv, setNv] = useState(seed?.nv ?? false);
  const [yearText, setYearText] = useState(seed?.year ?? '');
  const [abvText, setAbvText] = useState(seed?.abv ?? '');
  const [grapes, setGrapes] = useState(seed?.grapes ?? '');
  const [region, setRegion] = useState(seed?.region ?? '');
  const [country, setCountry] = useState(seed?.country ?? '');
  const [moreOpen, setMoreOpen] = useState(!!(seed?.grapes || seed?.region || seed?.country));
  const [countryOpen, setCountryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!flow || !producer) return <Gone />;
  const use = () => {
    const r = newWineChoice({ producer, name: wineQ, colour, sparkling, nv, year: yearText, abv: abvText, grapes, region, country });
    if ('error' in r) { setError(r.error); return; }
    const draft = { producer, name: wineQ, colour, sparkling, nv, year: yearText, abv: abvText, grapes, region, country };
    // Adding: the details screen on top; an edit's Change: back to the form.
    if (flow.mode === 'add') return guard(() => { setFlowChoice<ProductHit>(key, { kind: 'new', draft }); router.push(pickedHref(flow.target.mount, flow.dest as FlowDest, key)); });
    const depth = finishFlow<ProductHit>(key, { kind: 'new', draft });
    if (depth > 0) router.dismiss(depth);
  };
  return (
    // In-screen provider: the Country sheet needs a host on this screen
    // (apps/mobile/CLAUDE.md § Bottom sheet).
    <BottomSheetModalProvider>
    <PageShell title="New Wine" right={<Button title="Use" variant="tertiary" size="sm" onPress={use} />}>
      <View style={{ gap: 12 }}>
        <VText variant="small" color="inkSoft">{producer.id ? producer.name : `${producer.name}, a new producer`}</VText>
        <TextField label="Wine" placeholder="Its name" value={wineQ} onChangeText={setWineQ} autoCorrect={false} />
        {/* Colour and Sparkling on one line (ruled 2026-11-22): the colours on
            the left, Sparkling at the right end under a title of its own, a
            switch (not a fourth chip: it combines with any colour). */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          {/* Content width (it shrinks and wraps only when the line is short),
              so Sparkling sits right after the colours, not at the far end. */}
          <View style={{ flexShrink: 1 }}>
            <FieldGroup label="Colour">
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                {COLOURS.map((c) => (
                  <ChoiceChip key={c.code} label={c.label} on={colour === c.code} onPress={() => setColour((v) => (v === c.code ? null : c.code))} />
                ))}
              </View>
            </FieldGroup>
          </View>
          {/* The rest of the line, Sparkling CENTRED in it (between the last
              colour chip and the edge, ruled 2026-11-22): FieldGroup's label
              and gap, the switch centred under its title. */}
          <View style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ alignItems: 'center', gap: 7, marginBottom: 14 }}>
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Sparkling</VText>
              <Switch
                value={sparkling}
                onValueChange={setSparkling}
                trackColor={{ false: offTrack, true: theme.accent }}
                ios_backgroundColor={offTrack}
                accessibilityLabel="Sparkling"
                // React Native's iOS Switch defaults to `alignSelf: 'flex-start'`
                // (Switch.js), which left it at the column's start, not centred
                // under its title as ruled (2026-11-22).
                style={{ alignSelf: 'center' }}
              />
            </View>
          </View>
        </View>
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
        <StatusLine text={error} error />
      </View>
      <CountrySheet open={countryOpen} selected={country} onSelect={(c) => { setCountry(c); setCountryOpen(false); }} onClose={() => setCountryOpen(false)} />
    </PageShell>
    </BottomSheetModalProvider>
  );
}
