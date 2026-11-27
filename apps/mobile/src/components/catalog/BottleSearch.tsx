import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { DashedAddRow } from '@/components/ui/DashedAddRow';
import { TextField } from '@/components/ui/TextField';
import { Gone, ListNote, PageShell, ResultList, ResultRow, Spinner, StatusLine, useCatalogSearch, usePageFlow, type CatalogTarget } from '@/components/catalog/pickerParts';
import { searchBottles, type BottleHit, type CatalogScope, type ProductHit } from '@/lib/api/catalog';
import { closeNote, offersNew, pickRow, searchNotice, visibleRows } from '@/lib/bottleSearch';
import { endFlow, finishFlow, setFlowChoice, startFlow } from '@/lib/pickerFlow';
import { catalogHref, pickedHref, useSessionTab, type FlowDest } from '@/lib/sessionStack';
import { usePushGuard } from '@/lib/usePushGuard';

// The one field (ADR-0010: producer, wine, region and year in any order, every
// typed word must match) as a SCREEN of its own (ruled 2026-11-22: picking a
// wine opens its details on a page of their own, so back returns to the search).
// Three users: Add Impression's and Check In's FIRST screen (`AddSearchScreen`,
// an 'add' flow: a pick pushes the details on top), and an edit's Change
// (`SearchPage`, a 'change' flow: a pick goes back to the form).

function BottleSearchBody({ scope, onPick, onAdd }: { scope: CatalogScope; onPick: (hit: BottleHit, yearText: string) => void; onAdd: () => void }) {
  const [bottle, bottleDo] = useCatalogSearch<BottleHit>(3, (q) => searchBottles(scope, q));
  // A new scope (another moment) starts the search over.
  useEffect(() => { bottleDo({ type: 'reset' }); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = visibleRows(bottle);
  const pick = (id: string) => {
    const r = pickRow(bottle, id);
    // The typed year goes along (ruling 4): the details' year field gets it.
    if (r) onPick(r.hit, r.yearText);
  };
  return (
    <View>
      <TextField label="Wine" placeholder="Search wines" value={bottle.text} onChangeText={(text) => bottleDo({ type: 'text', text })} autoCorrect={false} returnKeyType="search" autoFocus accessibilityHint="Producer, wine, region or year, in any order." />
      {bottle.status !== 'idle' ? (
        <ResultList>
          {closeNote(bottle) ? <ListNote text={closeNote(bottle)!} /> : null}
          {rows.rows.map((b) => (
            <ResultRow key={b.id} title={b.name} sub={b.producerName} trailing={b.year === null ? null : String(b.year)} disabled={!rows.selectable} onPress={() => pick(b.id)} />
          ))}
          {offersNew(bottle) ? <DashedAddRow title="Add Wine to Catalogue" onPress={onAdd} /> : null}
        </ResultList>
      ) : null}
      {bottle.status === 'waiting' ? <Spinner /> : null}
      <StatusLine text={searchNotice(bottle)} error={bottle.status === 'failed'} />
    </View>
  );
}

// Add Impression's / Check In's first screen: one 'add' flow for as long as it
// is mounted (the details, the pages and a held save hang off it).
export function AddSearchScreen({ title, scope: scopeIn, dest }: { title: string; scope: CatalogScope; dest: FlowDest }) {
  const router = useRouter();
  const guard = usePushGuard();
  const mount = useSessionTab();
  // 🔒 Keyed on the moment's CODE (a caller's inline `{ code }` is a new object
  // every render; the search depends on the scope).
  const scopeCode = scopeIn?.code ?? null;
  const scope: CatalogScope = useMemo(() => (scopeCode ? { code: scopeCode } : null), [scopeCode]);
  const [key] = useState(() => startFlow<CatalogScope, CatalogTarget>(scope, { mount, inDetails: false }, { mode: 'add', dest }));
  useEffect(() => () => endFlow(key), [key]);
  const onPick = (hit: BottleHit, yearText: string) => guard(() => {
    setFlowChoice<ProductHit>(key, { kind: 'product', product: hit, yearText });
    router.push(pickedHref(mount, dest, key));
  });
  const onAdd = () => guard(() => router.push(catalogHref(mount, false, 'producer', key)));
  return (
    <PageShell title={title}>
      <BottleSearchBody scope={scope} onPick={onPick} onAdd={onAdd} />
    </PageShell>
  );
}

// An edit's Change: the search as a page of a 'change' flow; a pick goes back
// to the form with the wine and its typed year.
export function SearchPage() {
  const { key, flow } = usePageFlow();
  const router = useRouter();
  const guard = usePushGuard();
  const scope = flow?.scope ?? null;
  if (!flow) return <Gone />;
  const onPick = (hit: BottleHit, yearText: string) => {
    const depth = finishFlow<ProductHit>(key, { kind: 'product', product: hit, yearText });
    if (depth > 0) router.dismiss(depth);
  };
  const onAdd = () => guard(() => router.push(catalogHref(flow.target.mount, flow.target.inDetails, 'producer', key)));
  return (
    <PageShell title="Choose the Bottle">
      <BottleSearchBody scope={scope} onPick={onPick} onAdd={onAdd} />
    </PageShell>
  );
}
