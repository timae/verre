import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { ChosenLine, labelLine, Spinner, StatusLine, YearLine, YearRow, type CatalogTarget } from '@/components/catalog/pickerParts';
import { CatalogSearchError, listVintages, type CatalogScope, type ProductHit, type VintageHit } from '@/lib/api/catalog';
import { abvEditable, newWineChoice, pickedChoice, readYear, shownAbv, yearFate, yearLine, type BottleLabel, type CatalogChoice, type NewWineDraft } from '@/lib/catalogChoice';
import { kindLabel } from '@/lib/momentFormat';
import { endFlow, startFlow, takeResult, type FlowResult } from '@/lib/pickerFlow';
import { catalogHref, useSessionTab } from '@/lib/sessionStack';
import { usePushGuard } from '@/lib/usePushGuard';
import { radius, useTheme } from '@/theme';

// The bottle section of a form (ADR-0009 / ADR-0010, ruled 2026-11-22: the
// search and "Add Wine to Catalogue" are pages of their own, BottleSearch.tsx
// and CatalogPages.tsx). Two uses:
//  - ADDING (Add Impression's / Check In's details screen): `initial` is the
//    pick the details opened with: a wine (with the year typed in the search)
//    or a new wine's draft. It shows fixed (back on the screen changes it); a
//    picked wine's year and alcohol are set here.
//  - EDITING (`current`): the bottle as it is with Change, which opens the
//    search as a page; the wine picked there comes back here with its year
//    (Keep returns to the bottle as it was), a new wine folded (Edit / Remove).
// It reports its state to the form on every change; the form sends it with the
// save. The rules are pure in lib/catalogChoice.ts, the pages' handoff in
// lib/pickerFlow.ts. 🔒 Nothing links until the person picks.

export type PickerState =
  | { status: 'unchanged' } // edit: the bottle keeps its wine
  | { status: 'none' } // nothing chosen yet
  | { status: 'pending' } // a picked wine's years are still loading
  | { status: 'error'; error: string }
  | { status: 'ok'; choice: CatalogChoice };

export function BottlePicker({
  scope: scopeIn, current, initial, frozen, showErrors, onChange, inDetails = false, locked = false,
}: {
  scope: CatalogScope;
  /** Edit: the bottle as it is. Its summary shows with Change; until then the state is `unchanged`. */
  current?: BottleLabel | null;
  /** Adding: the pick the details screen opened with (lib/pickerFlow.ts). */
  initial?: FlowResult<ProductHit> | null;
  /** A save may have landed: the choice shows read-only (ADR-0009 freeze rule). */
  frozen?: { label: BottleLabel; isNew: boolean } | null;
  /** After a save attempt: a draft's error shows under it. */
  showErrors?: boolean;
  onChange: (s: PickerState) => void;
  /** The check-in edit's details: on a tab stack its pages live inside its own boundary (lib/sessionStack.ts catalogHref). */
  inDetails?: boolean;
  /** A save is in flight: the choice reads only, no page opens (Codex 2026-11-22: a page opened then was popped by the save's exit). */
  locked?: boolean;
}) {
  const { theme } = useTheme();
  const router = useRouter();
  const guard = usePushGuard();
  const mount = useSessionTab();
  // 🔒 Keyed on the moment's CODE: a caller passing `{ code }` inline makes a new
  // object every render, and the lookups below depend on the scope (review r1).
  const scopeCode = scopeIn?.code ?? null;
  const scope: CatalogScope = useMemo(() => (scopeCode ? { code: scopeCode } : null), [scopeCode]);
  const target: CatalogTarget = useMemo(() => ({ mount, inDetails: inDetails && mount.post == null }), [mount, inDetails]);
  // Edit: a Change's result is in hand (Keep drops it).
  const [changing, setChanging] = useState(false);
  const [product, setProduct] = useState<ProductHit | null>(initial?.kind === 'product' ? initial.product : null);
  const [newDraft, setNewDraft] = useState<NewWineDraft | null>(initial?.kind === 'new' ? initial.draft : null);
  // The years and alcohol of the wine they were looked up for (Codex
  // 2026-11-22: a second Change kept the previous wine's years until the new
  // lookup answered, pairing one wine with another's vintage).
  const [years, setYears] = useState<{ productId: string; vintages: VintageHit[]; abv: number | null } | null>(null);
  const vintages = years && product && years.productId === product.id ? years.vintages : null;
  const wineAbv = years && product && years.productId === product.id ? years.abv : null;
  // A failed year lookup is its own state (never "still loading") and is asked
  // again on the next keystroke in the year field or a tap on NV.
  const [vintagesTry, setVintagesTry] = useState(0);
  const [vintagesFailed, setVintagesFailed] = useState(false);
  const [yearText, setYearText] = useState(initial?.kind === 'product' ? initial.yearText : '');
  const [nv, setNv] = useState(false);
  const [abvText, setAbvText] = useState('');
  const [yearNotice, setYearNotice] = useState<string | null>(null);
  // An edit's open Change flow (one key per invocation).
  const flowKey = useRef<string | null>(null);

  // A new scope (another moment) kills an open flow; so does leaving the form.
  useEffect(() => { endFlow(flowKey.current); flowKey.current = null; }, [scope]);
  useEffect(() => () => endFlow(flowKey.current), []);
  // A save in flight or one that may have landed: an open flow is dead.
  const lockedRef = useRef(locked || !!frozen);
  lockedRef.current = locked || !!frozen;
  useEffect(() => { if (locked || frozen) { endFlow(flowKey.current); flowKey.current = null; } }, [locked, frozen]);

  const resetYear = () => { setYearText(''); setNv(false); setAbvText(''); setYearNotice(null); };
  // Back from a Change: its result, once (never while locked).
  useFocusEffect(useCallback(() => {
    if (lockedRef.current) return;
    const r = takeResult<ProductHit>(flowKey.current);
    if (!r) return;
    flowKey.current = null;
    setChanging(true);
    if (r.kind === 'product') { setNewDraft(null); setProduct(r.product); resetYear(); setYearText(r.yearText); }
    else { setProduct(null); setNewDraft(r.draft); }
  }, []));

  useEffect(() => {
    if (!product) { setYears(null); setVintagesFailed(false); return; }
    let live = true;
    setVintagesFailed(false);
    const id = product.id;
    listVintages(scope, id)
      .then((r) => { if (live) { setYears({ productId: id, vintages: r.vintages, abv: r.abv }); setYearNotice(null); } })
      .catch((e) => { if (live) { setVintagesFailed(true); setYearNotice(e instanceof CatalogSearchError ? e.message : 'Search failed. Try again.'); } });
    return () => { live = false; };
  }, [product, scope, vintagesTry]);
  const retryYears = () => { if (vintagesFailed) setVintagesTry((n) => n + 1); };
  // 🔒 A typed alcohol belongs to the year it was typed for: another year (NV
  // included) empties it, or it would be sent for that year, where a report's
  // first value is the one everyone sees (Codex build-2 r1).
  const changeYear = (nextNv: boolean, nextText: string) => {
    if (JSON.stringify(readYear(nv, yearText)) !== JSON.stringify(readYear(nextNv, nextText))) setAbvText('');
    setNv(nextNv);
    setYearText(nextText);
    retryYears();
  };
  const onYear = (t: string) => changeYear(nv, t);

  // The state the form sends with its save.
  const state: PickerState = (() => {
    if (current && !changing) return { status: 'unchanged' };
    if (product) {
      const r = pickedChoice(product, vintages, nv, yearText, abvText);
      if ('pending' in r && vintagesFailed) return { status: 'error', error: 'Couldn’t load its years. Type the year again, or tap NV.' };
      return 'choice' in r ? { status: 'ok', choice: r.choice } : 'error' in r ? { status: 'error', error: r.error } : { status: 'pending' };
    }
    if (newDraft) {
      const r = newWineChoice(newDraft);
      return 'choice' in r ? { status: 'ok', choice: r.choice } : { status: 'error', error: r.error };
    }
    return { status: 'none' };
  })();
  const stateKey = JSON.stringify(state);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => { onChangeRef.current(JSON.parse(stateKey) as PickerState); }, [stateKey]);

  // An edit's Change: the search as a page, or the new wine's fields again
  // with its draft (Edit). 🔒 Everything inside the guard (Codex 2026-11-22: a
  // double tap replaced the flow after the first push).
  const openChange = (seed?: NewWineDraft) => guard(() => {
    if (lockedRef.current) return;
    endFlow(flowKey.current);
    const key = startFlow(scope, target, seed ? { draft: seed } : {});
    flowKey.current = key;
    router.push(catalogHref(target.mount, target.inDetails, seed ? 'new' : 'search', key));
  });
  const keep = () => { setProduct(null); setNewDraft(null); resetYear(); setChanging(false); };

  if (frozen) return <Summary label={frozen.label} isNew={frozen.isNew} />;
  if (current && !changing) return <Summary label={current} onChange={locked ? undefined : () => openChange()} />;
  // While a save is in flight the choice it sends reads only (like frozen).
  if (locked && state.status === 'ok') return <Summary label={state.choice.label} isNew={state.choice.kind === 'create'} />;

  const fate = product ? yearFate(vintages, readYear(nv, yearText)) : null;
  const editing = !!current;

  return (
    <View style={{ marginBottom: 16 }}>
      {current ? (
        <Pressable accessibilityRole="button" onPress={keep} style={{ alignSelf: 'flex-start', marginBottom: 10 }}>
          <VText variant="small" style={{ color: theme.accent, fontFamily: 'InstrumentSans_600SemiBold' }}>{`Keep “${labelLine(current)}”`}</VText>
        </Pressable>
      ) : null}

      {/* A picked wine and its year (one field: listed, or added) */}
      {product ? (
        <View>
          <ChosenLine title={product.name} sub={[product.producerName, kindLabel(product)].filter(Boolean).join(' · ') || null} onChange={editing ? () => openChange() : undefined} />
          <YearRow
            nv={nv} onNv={(v) => changeYear(v, v ? '' : yearText)}
            yearText={yearText} onYear={onYear}
            showAbv={fate ? abvEditable(fate, vintages) : false} abvText={abvText} onAbv={setAbvText}
            knownAbv={fate ? shownAbv(fate, vintages, wineAbv) : null}
          />
          <YearLine text={fate ? yearLine(fate) : null} />
          {showErrors && state.status === 'error' ? <StatusLine text={state.error} error /> : null}
          {fate?.fate === 'pending' && !vintagesFailed && (yearText.trim() || nv) ? <Spinner /> : null}
          <StatusLine text={yearNotice} error />
        </View>
      ) : null}

      {/* A new wine made on its page, folded (an edit's: Edit / Remove) */}
      {newDraft ? (
        <View>
          <ChosenLine
            title={[newDraft.name, newDraft.nv ? 'NV' : newDraft.year].filter(Boolean).join(' ')}
            sub={[newDraft.producer.name, newDraft.producer.id ? null : 'new producer', 'New wine'].filter(Boolean).join(' · ')}
            changeTitle="Edit"
            onChange={editing ? () => openChange(newDraft) : undefined}
            second={editing ? { title: 'Remove', onPress: keep } : undefined}
          />
          {showErrors && state.status === 'error' ? <StatusLine text={state.error} error /> : null}
        </View>
      ) : null}
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

