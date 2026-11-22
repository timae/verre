// Behavioural pins for the bottle picker's search controller (catalogue model
// change step 7b, ADR-0010): the PRODUCTION module BottlePicker drives
// (apps/mobile/src/lib/bottleSearch.ts), run through asynchronous schedules the
// way the screen meets them: answers out of order, A → B → A, a retry of the
// same text, a scope change mid-flight, a 429, a failure, a debounce in flight.
//
//   npx tsx scripts/tests/bottle-search-units.ts

import {
  initialSearch, offersAddProducer, offersNew, pendingRequest, pickRow, searchNotice, searchReducer, visibleRows,
  type SearchAnswer, type SearchEvent, type SearchFailure, type SearchState,
} from '../../apps/mobile/src/lib/bottleSearch';

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
};

type Hit = { id: string; name: string; year: number | null };
const ans = (ids: string[], o: Partial<SearchAnswer<Hit>> = {}): SearchAnswer<Hit> =>
  ({ results: ids.map((id) => ({ id, name: id, year: o.results?.[0]?.year ?? null })), more: !!o.more, tooLong: !!o.tooLong });

// A driver like the screen's hook: every waiting state sends ONE request for
// its generation; the test decides when (and in which order) answers arrive.
function driver(min = 3) {
  let s: SearchState<Hit> = initialSearch<Hit>(min);
  const sent: { gen: number; q: string }[] = [];
  const dispatch = (e: SearchEvent<Hit>) => {
    s = searchReducer(s, e);
    const r = pendingRequest(s);
    if (r && !sent.some((x) => x.gen === r.gen)) sent.push(r);
  };
  return {
    get s() { return s; },
    sent,
    type: (text: string) => dispatch({ type: 'text', text }),
    reset: () => dispatch({ type: 'reset' }),
    answer: (gen: number, a: SearchAnswer<Hit>) => dispatch({ type: 'answer', gen, answer: a }),
    fail: (gen: number, failure: SearchFailure) => dispatch({ type: 'fail', gen, failure }),
  };
}
const ids = (s: SearchState<Hit>) => visibleRows(s).rows.map((r) => r.id);

// ── Under the minimum: nothing is asked ────────────────────────────────────
{
  const d = driver();
  d.type('pi');
  check('under 3 characters: idle, no request, no "Add Wine to Catalogue"', d.s.status === 'idle' && d.sent.length === 0 && !offersNew(d.s));
  const w = driver(0);
  w.type('');
  check('a producer\'s wines (min 0): the empty text is asked (the A to Z list)', w.sent.length === 1 && w.sent[0].q === '');
}

// ── A slow answer for old text, after new text ─────────────────────────────
{
  const d = driver();
  d.type('pich');
  d.type('pichler');
  const [old, cur] = d.sent;
  d.answer(cur.gen, ans(['p1', 'p2']));
  d.answer(old.gen, ans(['x9']));
  check('a late answer for older text is dropped (the current answer stays)', JSON.stringify(ids(d.s)) === '["p1","p2"]', ids(d.s));
  check('… and the current one is selectable with "Add Wine to Catalogue"', visibleRows(d.s).selectable && offersNew(d.s));
}

// ── A → B → A, the second A failing ────────────────────────────────────────
{
  const d = driver();
  d.type('alder');
  d.type('birch');
  d.type('alder');
  const [a1, , a2] = d.sent;
  d.fail(a2.gen, 'failed');
  d.answer(a1.gen, ans(['old-alder']));
  check('A → B → A, the second A fails: the FIRST A\'s late answer is dropped (generation, not text)', d.s.status === 'failed' && ids(d.s).length === 0, d.s);
  check('… no "Add Wine to Catalogue" after a failure', !offersNew(d.s));
  check('… the failure says so', searchNotice(d.s) === 'Search failed. Try again.', searchNotice(d.s));
}

// ── The same text again (a retry by typing) ────────────────────────────────
{
  const d = driver();
  d.type('kellerberg');
  d.fail(d.sent[0].gen, 'failed');
  d.type('kellerberg');
  check('the same text typed again is a NEW request', d.sent.length === 2 && d.sent[1].gen !== d.sent[0].gen);
  d.answer(d.sent[1].gen, ans(['k1']));
  check('… and its answer shows', JSON.stringify(ids(d.s)) === '["k1"]' && offersNew(d.s));
}

// ── A scope change (another moment) mid-flight ─────────────────────────────
{
  const d = driver();
  d.type('pichler');
  d.reset();
  d.answer(d.sent[0].gen, ans(['p1']));
  check('a scope change mid-flight drops the answer in flight', d.s.status === 'idle' && ids(d.s).length === 0);
}

// ── A 429 and the switch ───────────────────────────────────────────────────
{
  const d = driver();
  d.type('pichler');
  d.fail(d.sent[0].gen, 'busy');
  check('a 429: the notice, no rows, no "Add Wine to Catalogue"', searchNotice(d.s) === 'Too many searches. Wait a moment.' && !offersNew(d.s) && ids(d.s).length === 0);
  const o = driver();
  o.type('pichler');
  o.fail(o.sent[0].gen, 'off');
  check('the catalogue switched off (a 404): its line, no "Add Wine to Catalogue"', searchNotice(o.s) === 'Adding bottles is unavailable right now.' && !offersNew(o.s));
}

// ── A debounce in flight ───────────────────────────────────────────────────
{
  const d = driver();
  d.type('pichler');
  d.answer(d.sent[0].gen, ans(['p1']));
  d.type('pichler k');
  check('while the next answer is awaited: the old rows stay visible but NOT selectable', ids(d.s).length === 1 && !visibleRows(d.s).selectable);
  check('… no "Add Wine to Catalogue" for text the server has not answered', !offersNew(d.s));
  check('… a tap on a stale row picks nothing', pickRow(d.s, 'p1') === null);
}

// ── A row tap keeps the carried year ───────────────────────────────────────
{
  const d = driver();
  d.type('pichler kellerberg 2019');
  d.answer(d.sent[0].gen, { results: [{ id: 'k1', name: 'Kellerberg', year: 2019 }, { id: 'k2', name: 'Cuvée 2000', year: null }], more: false, tooLong: false });
  check('a tap picks the wine and fills the year field with the carried year', JSON.stringify(pickRow(d.s, 'k1')) === JSON.stringify({ hit: { id: 'k1', name: 'Kellerberg', year: 2019 }, yearText: '2019' }));
  check('… a row that carries no year leaves the year field empty', pickRow(d.s, 'k2')?.yearText === '');
  check('… an id not in the answer picks nothing', pickRow(d.s, 'nope') === null);
}

// ── The flags from the server ──────────────────────────────────────────────
{
  const d = driver();
  d.type(Array(17).fill('pichler').join(' '));
  d.answer(d.sent[0].gen, ans([], { tooLong: true }));
  check('`tooLong`: its notice and NO "Add Wine to Catalogue" (the server never searched)', !offersNew(d.s) && searchNotice(d.s) === 'Too many words. Try a shorter search.', searchNotice(d.s));
  const m = driver();
  m.type('chateau');
  m.answer(m.sent[0].gen, ans(['c1'], { more: true }));
  check('`more`: "type more", and "Add Wine to Catalogue" still offered', searchNotice(m.s) === 'More wines match. Type more to narrow the list.' && offersNew(m.s));
  check('… the producer field says producers', searchNotice(m.s, 'producers') === 'More producers match. Type more to narrow the list.');
  const e = driver();
  e.type('christoph pichler');
  e.answer(e.sent[0].gen, ans([]));
  check('an empty answer: no rows, "Add Wine to Catalogue" offered, no notice', ids(e.s).length === 0 && offersNew(e.s) && searchNotice(e.s) === null);
}

// ── A pick (or leaving the step) moves the generation ──────────────────────
{
  const d = driver();
  d.type('pichler');
  d.answer(d.sent[0].gen, ans(['p1']));
  d.type('pichler k');
  d.reset();
  d.answer(d.sent[1].gen, ans(['p2']));
  check('after a reset, the answer in flight never lands', d.s.status === 'idle' && ids(d.s).length === 0);
  d.type('rudi');
  check('… and a new text starts from there', d.s.status === 'waiting' && d.sent[d.sent.length - 1].q === 'rudi');
}

// ── "Add Producer" (ruled 2026-11-21): nothing found, or no exact name ────
// "Exact" is the server's verdict (`exact`, the database's fold: Codex 2026-11-21).
{
  type P = { id: string; name: string };
  const prod = (text: string, names: string[], exact = false) => {
    let s = initialSearch<P>();
    s = searchReducer(s, { type: 'text', text });
    return searchReducer(s, { type: 'answer', gen: s.gen, answer: { results: names.map((name, i) => ({ id: `p${i}`, name })), more: false, tooLong: false, exact } });
  };
  check('Add Producer: the search found nothing → offered', offersAddProducer(prod('christoph pichler', [])));
  check('… found "Weingut Marx" for "marx" (the server: no exact name) → offered, a new "Marx" stays addable', offersAddProducer(prod('marx', ['Weingut Marx'])));
  check('… the server says a listed producer IS the typed name → NOT offered (pick it)', !offersAddProducer(prod('weingut strass', ['Weingut Straß'], true)));
  check('… the client never decides "exact" itself (names that look equal, server says no → offered)', offersAddProducer(prod('weingut marx', ['Weingut Marx'], false)));
  let w = initialSearch<P>();
  w = searchReducer(w, { type: 'text', text: 'marx' });
  check('… never while the answer is awaited', !offersAddProducer(w));
  w = searchReducer(w, { type: 'fail', gen: w.gen, failure: 'busy' });
  check('… never after a failure', !offersAddProducer(w));
  let x = prod('weingut strass', ['Weingut Straß'], true);
  x = searchReducer(x, { type: 'text', text: 'weingut strasse' });
  check('… a new text clears the previous answer\'s exact verdict', !x.exact);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
