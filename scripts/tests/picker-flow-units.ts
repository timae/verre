// Behavioural pins for the "Add Wine to Catalogue" pages' handoff (ruled
// 2026-11-22: real pages; apps/mobile/src/lib/pickerFlow.ts, the PRODUCTION
// module the picker and the pages drive). One key per invocation; the result
// consumed once; a dead flow refuses; the depth a finish pops.
//
//   npx tsx scripts/tests/picker-flow-units.ts

import {
  __flowsForTests, endFlow, finishFlow, flowClientId, getFlow, holdFlow, pageMounted, pageUnmounted, popsPast, setFlowChoice, setFlowDraft, setFlowProducer, startFlow, takeResult,
} from '../../apps/mobile/src/lib/pickerFlow';

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const draft = (name: string, producer: { id: string | null; name: string } = { id: 'p1', name: 'Weingut X' }) =>
  ({ producer: producer as { id: string; name: string }, name, colour: 'red' as const, sparkling: false, nv: false, year: '2019', abv: '', grapes: '', region: '', country: '' });

{
  __flowsForTests.clear();
  const a = startFlow({ code: 'M1' }, 'target-a');
  const b = startFlow(null, 'target-b');
  check('flow: one key per invocation (two flows never share one)', a !== b && __flowsForTests.size() === 2);
  check('flow: a page reads its scope and target by the key', getFlow(a)?.scope !== undefined && (getFlow(a)?.target as string) === 'target-a' && getFlow(b)?.scope === null);
  check('flow: an unknown key (a cold link) reads nothing', getFlow('nope') === null && getFlow('') === null && getFlow(undefined) === null);

  setFlowProducer(a, { id: 'p1', name: 'Weingut X' });
  check('flow: the producer chosen on page 1 is there for page 2', getFlow(a)?.producer?.id === 'p1');
  setFlowDraft(a, draft('Kabinett'));
  setFlowProducer(a, { id: 'p2', name: 'Weingut Y' });
  check('flow: another producer drops a draft made under the previous one', getFlow(a)?.draft === null && getFlow(a)?.producer?.id === 'p2');

  pageMounted(a); pageMounted(a); pageMounted(a);
  pageUnmounted(a); // a swipe back from page 3
  check('flow: the depth counts the pages still mounted (a swipe back unmounts one)', finishFlow(a, { kind: 'product', product: { id: 'w1' }, yearText: '' }) === 2);
  check('flow: a finished flow is read as gone by a page (no second finish)', getFlow(a) === null && finishFlow(a, { kind: 'product', product: { id: 'w2' }, yearText: '' }) === 0);
  check('flow: the host takes the result once', (takeResult<{ id: string }>(a) as { kind: string; product: { id: string } } | null)?.product.id === 'w1' && takeResult(a) === null);
  check('flow: … and the flow is forgotten', __flowsForTests.size() === 1);

  check('flow: nothing to take before a finish', takeResult(b) === null && getFlow(b) !== null);
  endFlow(b);
  check('flow: a host that leaves kills its flow (a page still open reads it as gone)', getFlow(b) === null && finishFlow(b, { kind: 'new', draft: draft('X') }) === 0 && __flowsForTests.size() === 0);

  const c = startFlow(null, 't', { draft: draft('Spätlese', { id: null, name: 'Neuer Hof' }) });
  check('flow: Edit seeds the draft and its producer (a new producer too)', getFlow(c)?.draft?.name === 'Spätlese' && getFlow(c)?.producer?.id === null && getFlow(c)?.producer?.name === 'Neuer Hof');
  pageMounted(c);
  check('flow: Use from page 3 alone pops one page', finishFlow(c, { kind: 'new', draft: draft('Spätlese', { id: null, name: 'Neuer Hof' }) }) === 1);
  const r = takeResult(c);
  check('flow: the new wine\'s draft comes back to the host', r?.kind === 'new' && r.draft.name === 'Spätlese');
  check('flow: depth never goes below zero', (() => { const k = startFlow(null, 't'); pageUnmounted(k); pageUnmounted(k); return finishFlow(k, { kind: 'product', product: {}, yearText: '' }) === 0; })());
  check('flow: setters on a dead flow change nothing', (() => { const k = startFlow(null, 't'); endFlow(k); setFlowProducer(k, { id: 'x', name: 'x' }); setFlowDraft(k, draft('y')); return getFlow(k) === null; })());
}

// Adding (ruled 2026-11-22: the details are a screen of their own).
{
  __flowsForTests.clear();
  const a = startFlow(null, 't', { mode: 'add', dest: { kind: 'checkin' } });
  check('add: the flow knows where its details go', (getFlow(a)?.dest as { kind: string }).kind === 'checkin' && getFlow(a)?.mode === 'add');
  setFlowChoice(a, { kind: 'product', product: { id: 'w1' }, yearText: '2019' });
  check('add: a pick (with the typed year) waits for the details screen', getFlow<unknown, unknown, { id: string }>(a)?.choice?.kind === 'product' && (getFlow(a)?.choice as { yearText: string }).yearText === '2019');
  setFlowChoice(a, { kind: 'new', draft: draft('Neu') });
  check('add: another pick replaces it (back to the search, pick again)', getFlow(a)?.choice?.kind === 'new');
  const c = startFlow(null, 't');
  setFlowChoice(c, { kind: 'product', product: {}, yearText: '' });
  check('add: a change flow never takes a pick that way (it finishes instead)', getFlow(c)?.choice === null && getFlow(c)?.mode === 'change');
  holdFlow(a, { process: 'v1' });
  holdFlow(a, { process: 'v2' });
  check('add: a save that may have landed holds the form, kept CURRENT (a photo retry changes it)', (getFlow(a)?.hold as { process: string }).process === 'v2');
  let made = 0;
  const mk = () => `id${++made}`;
  const id1 = flowClientId(a, mk);
  check('add: ONE client id for the whole flow (a details screen opened again reuses it)', flowClientId(a, mk) === id1 && made === 1);
  check('add: … replaced only when the server says it is someone else\'s', flowClientId(a, mk, true) !== id1 && flowClientId(a, mk) === 'id2');
  check('add: a change flow (or none) has no shared id: a fresh one each time', flowClientId(c, mk) !== flowClientId(c, mk) && flowClientId('nope', mk) !== flowClientId('nope', mk));
  holdFlow(c, { clientId: 'x' });
  check('add: a change flow holds nothing', getFlow(c)?.hold === null);
  endFlow(a);
  check('add: the search leaving ends the flow and its hold', getFlow(a) === null);
}
// Leaving a flow: pop its first screen and everything above it.
{
  const names = ['index', 'session/[code]', 'session/[code]/add', 'catalog/producer', 'catalog/wines', 'session/[code]/add-wine'];
  check('leave: from the details over two catalogue pages: 4 screens', popsPast(names, 5, 'session/[code]/add') === 4);
  check('leave: from the details over the search alone: 2', popsPast(['index', 'session/[code]', 'session/[code]/add', 'session/[code]/add-wine'], 3, 'session/[code]/add') === 2);
  check('leave: the check-in rate stage over the details and the search: 3', popsPast(['index', 'check-in/index', 'check-in/wine', 'check-in/rate'], 3, 'check-in/index') === 3);
  check('leave: the root not on the stack (a cold link): null, the caller goes back once', popsPast(['index', 'session/[code]/add-wine'], 1, 'session/[code]/add') === null);
  check('leave: the NEAREST root below the focus counts', popsPast(['check-in/index', 'x', 'check-in/index', 'check-in/wine'], 3, 'check-in/index') === 2);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
