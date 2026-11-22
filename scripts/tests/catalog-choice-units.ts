// Behavioural pins for the app's bottle picker rules (catalogue model change
// step 7, ADR-0009): the client id, the year field + NV chip, the alcohol %,
// the pick / create bodies, the freeze rule's outcome, and the details' facts.
// PRODUCTION modules, imported as the screens import them.
//
//   npx tsx scripts/tests/catalog-choice-units.ts

import { clientIdFromUuids } from '../../apps/mobile/src/lib/clientIdFormat';
import {
  backStep, linkBody, newWineChoice, pickedChoice, readAbv, readYear, shownAbv, writeOutcome, yearFate, yearLine,
  ABV_INVALID, KIND_MISSING, maxYear, NAME_MISSING, yearInvalid, type NewWineDraft,
} from '../../apps/mobile/src/lib/catalogChoice';
import { alcoholText, bottleGrapes, bottleOrigin } from '../../apps/mobile/src/lib/bottleFacts';

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── The catalogue's alcohol, shown read-only where the field is (ruled 2026-11-22) ──
{
  const V = [{ id: 'v19', year: 2019, abv: 13 }, { id: 'v18', year: 2018, abv: null }, { id: 'vnv', year: null, abv: null }];
  const at = (nv: boolean, t: string, wine: number | null) => shownAbv(yearFate(V, readYear(nv, t)), V, wine);
  check('abv: a year the wine has shows that year\'s own alcohol', at(false, '2019', 12.5) === '13');
  check('abv: a year without its own shows NOTHING, never the wine\'s (one figure for every year)', at(false, '2018', 12.5) === null);
  check('abv: NV listed: the NV row\'s own only', at(true, '', 12.5) === null && shownAbv(yearFate([{ id: 'n', year: null, abv: 11 }], readYear(true, '')), [{ id: 'n', year: null, abv: 11 }], 12.5) === '11');
  check('abv: no year typed: the wine\'s', at(false, '', 12.5) === '12.5');
  check('abv: nothing recorded: nothing shown', at(false, '2018', null) === null && at(false, '', null) === null);
  check('abv: a NEW year shows none (its field is editable instead)', at(false, '2016', 12.5) === null);
  check('abv: nothing while the years load, or for an invalid year', shownAbv(yearFate(null, readYear(false, '2019')), null, 12.5) === null && at(false, '1850', 12.5) === null);
  check('abv: the field\'s own text (a number, at most two decimals)', shownAbv(yearFate([{ id: 'a', year: 2020, abv: 12.345 }], readYear(false, '2020')), [{ id: 'a', year: 2020, abv: 12.345 }], null) === '12.35');
}

// ── The screen's back steps through the picker first (ruled 2026-11-22) ──
{
  const base = { frozen: false, editing: false, changing: true, mode: 'find' as const, picked: false, producer: null, creating: false };
  check('back: on the one search field it leaves the page', backStep(base) === 'none');
  check('back: a picked wine goes back to the list', backStep({ ...base, picked: true }) === 'unpick');
  check('back: an edit\'s search keeps the bottle as it was', backStep({ ...base, editing: true }) === 'keep');
  check('back: an edit not being changed leaves the page', backStep({ ...base, editing: true, changing: false }) === 'none');
  check('back: a frozen choice (a save may have landed) leaves the page', backStep({ ...base, frozen: true, picked: true }) === 'none');
  const add = { ...base, mode: 'new' as const };
  check('back: "Add Wine to Catalogue"\'s producer search → the one search field', backStep(add) === 'search');
  check('back: a listed producer\'s wines → the producer search', backStep({ ...add, producer: 'listed' }) === 'producer');
  check('back: a wine picked under a producer → its wines', backStep({ ...add, producer: 'listed', picked: true }) === 'wines');
  check('back: a new wine under a listed producer → that producer\'s wines', backStep({ ...add, producer: 'listed', creating: true }) === 'wines');
  check('back: a new wine of a NEW producer ("Add Producer") → the producer search', backStep({ ...add, producer: 'new', creating: true }) === 'producer');
}

// ── The client id: 21 characters of the server's alphabet ─────────────────
{
  const A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const B = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const id = clientIdFromUuids(A, B);
  check('client id: 21 characters of [A-Za-z0-9_-] (lib/occurrences.ts CLIENT_ID)', /^[A-Za-z0-9_-]{21}$/.test(id), id);
  check('client id: the same UUIDs give the same id (a pure function)', clientIdFromUuids(A, B) === id);
  check('client id: other UUIDs give another id', clientIdFromUuids(B, A) !== id);
  let threw = false;
  try { clientIdFromUuids('not-a-uuid', B); } catch { threw = true; }
  check('client id: refuses anything but two v4 UUIDs', threw);
  // 1,000 random v4 UUID pairs: no collision, always the shape.
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const v4 = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
  const seen = new Set<string>();
  let shaped = true;
  for (let i = 0; i < 1000; i++) { const x = clientIdFromUuids(v4(), v4()); shaped &&= /^[A-Za-z0-9_-]{21}$/.test(x); seen.add(x); }
  check('client id: 1,000 random pairs, all shaped, no collision', shaped && seen.size === 1000);
}

// ── The year field + NV chip ───────────────────────────────────────────────
check('year: empty = unknown (no year key)', eq(readYear(false, ''), { ok: true }));
check('year: NV ticked → a REAL null', eq(readYear(true, ''), { ok: true, year: null }));
check('year: NV ticked wins over a typed year (the field is cleared and disabled)', eq(readYear(true, '2019'), { ok: true, year: null }));
check('year: four digits → the year', eq(readYear(false, '2019'), { ok: true, year: 2019 }));
check('year: a typed "NV" still reads as NV (habit)', eq(readYear(false, 'nv'), { ok: true, year: null }));
check('year: three digits are invalid', eq(readYear(false, '201'), { ok: false }));
check('year: the server\'s range, 1900 to the current year (else refused on the phone, never a raw server line)', maxYear() === new Date().getUTCFullYear() && eq(readYear(false, '1900'), { ok: true, year: 1900 }) && eq(readYear(false, String(maxYear())), { ok: true, year: maxYear() }) && eq(readYear(false, '1899'), { ok: false }) && eq(readYear(false, String(maxYear() + 1)), { ok: false }));
check('year: the message names the current year', yearInvalid() === `Type a year between 1900 and ${new Date().getUTCFullYear()}, or tap NV.`);

// ── The alcohol % ──────────────────────────────────────────────────────────
check('abv: empty = none', eq(readAbv(''), { ok: true }));
check('abv: a comma is a decimal point', eq(readAbv('13,5'), { ok: true, abv: 13.5 }));
check('abv: 0 is a value (alcohol-free), never "none"', eq(readAbv('0'), { ok: true, abv: 0 }));
check('abv: 25 is the top', eq(readAbv('25'), { ok: true, abv: 25 }));
check('abv: above 25 refused', eq(readAbv('25.5'), { ok: false }));
check('abv: junk refused', eq(readAbv('12%'), { ok: false }) && eq(readAbv('1.2.3'), { ok: false }));

// ── A picked wine's year: listed, or added (Simon's one field) ────────────
const P = { id: 'prod_1', name: 'Oslavje', colour: 'white', sparkling: false, region: null, producerId: 'pr_1', producerName: 'Radikon' };
const V = [{ id: 'vin_2019', year: 2019 }, { id: 'vin_nv', year: null }];
check('fate: loading years = pending', yearFate(null, { ok: true, year: 2019 }).fate === 'pending');
check('fate: empty = unknown even before the years load', yearFate(null, { ok: true }).fate === 'unknown');
check('fate: an exact year it has = listed, with that vintage', eq(yearFate(V, { ok: true, year: 2019 }), { fate: 'listed', vintageId: 'vin_2019', year: 2019 }));
check('fate: NV it has = listed', eq(yearFate(V, { ok: true, year: null }), { fate: 'listed', vintageId: 'vin_nv', year: null }));
check('fate: a year it lacks = added', eq(yearFate(V, { ok: true, year: 2018 }), { fate: 'added', year: 2018 }));
check('fate: NV it lacks = added (a real null)', eq(yearFate([V[0]], { ok: true, year: null }), { fate: 'added', year: null }));
check('line: "2019 is in the catalogue."', yearLine({ fate: 'listed', vintageId: 'x', year: 2019 }) === '2019 is in the catalogue.');
check('line: "2018 is added on save."', yearLine({ fate: 'added', year: 2018 }) === '2018 is added on save.');
check('line: "Non-vintage is in the catalogue." / "Non-vintage is added on save."', yearLine({ fate: 'listed', vintageId: 'x', year: null }) === 'Non-vintage is in the catalogue.' && yearLine({ fate: 'added', year: null }) === 'Non-vintage is added on save.');
check('line: nothing while empty, loading or invalid', [{ fate: 'unknown' }, { fate: 'pending' }, { fate: 'invalid' }].every((f) => yearLine(f as never) === null));

{
  const unknown = pickedChoice(P, V, false, '', '');
  check('pick: year unknown → the product alone (vintageId null)', 'choice' in unknown && eq(linkBody(unknown.choice), { productId: 'prod_1', vintageId: null }), unknown);
  const listed = pickedChoice(P, V, false, '2019', '14');
  check('pick: a listed year → that vintage, and NO abv (an existing entry is never edited)', 'choice' in listed && eq(linkBody(listed.choice), { productId: 'prod_1', vintageId: 'vin_2019' }), listed);
  const nvListed = pickedChoice(P, V, true, '', '');
  check('pick: NV ticked, the wine has NV → the NV vintage', 'choice' in nvListed && eq(linkBody(nvListed.choice), { productId: 'prod_1', vintageId: 'vin_nv' }) && nvListed.choice.label.year === 'NV', nvListed);
  const added = pickedChoice(P, V, false, '2018', '13,5');
  check('pick: a year it lacks → create { productId, year, abv }', 'choice' in added && eq(linkBody(added.choice), { create: { productId: 'prod_1', year: 2018, abv: 13.5 } }), added);
  const nvAdded = pickedChoice(P, [V[0]], true, '', '');
  check('pick: NV it lacks → create { productId, year: null } (a real null, never "NV")', 'choice' in nvAdded && eq(linkBody(nvAdded.choice), { create: { productId: 'prod_1', year: null } }), nvAdded);
  check('pick: while the years load the choice waits (never a guess)', 'pending' in pickedChoice(P, null, false, '2019', ''));
  check('pick: an invalid year names the fix', eq(pickedChoice(P, V, false, '20', ''), { error: yearInvalid() }));
  check('pick: a bad abv on an added year names the fix', eq(pickedChoice(P, V, false, '2017', '40'), { error: ABV_INVALID }));
  check('pick: the label carries the wine and its kind', 'choice' in listed && eq(listed.choice.label, { name: 'Oslavje', producer: 'Radikon', year: '2019', colour: 'white', sparkling: false }));
}

// ── A new wine ─────────────────────────────────────────────────────────────
{
  const base: NewWineDraft = { producer: { id: null, name: ' Radikon ' }, name: ' Oslavje ', colour: null, sparkling: false, nv: false, year: '', abv: '', grapes: '', region: '', country: '' };
  check('new: a colour or Sparkling is required', eq(newWineChoice(base), { error: KIND_MISSING }));
  check('new: a name is required', eq(newWineChoice({ ...base, name: ' ', colour: 'red' }), { error: NAME_MISSING }));
  const red = newWineChoice({ ...base, colour: 'red' });
  check('new: a new producer by name, the wine, its colour, no year (unknown)', 'choice' in red && eq(linkBody(red.choice), { create: { producer: { name: 'Radikon' }, product: { name: 'Oslavje', colour: 'red' } } }), red);
  const spRose = newWineChoice({ ...base, producer: { id: 'pr_1', name: 'Radikon' }, colour: 'rose', sparkling: true, year: '2019', abv: '12' });
  check('new: under a known producer; a sparkling rosé is BOTH; year and abv at the top level', 'choice' in spRose && eq(linkBody(spRose.choice), { create: { producerId: 'pr_1', product: { name: 'Oslavje', colour: 'rose', sparkling: true }, year: 2019, abv: 12 } }), spRose);
  const sp = newWineChoice({ ...base, sparkling: true, nv: true });
  check('new: Sparkling alone is valid (colour unknown); NV → year: null', 'choice' in sp && eq(linkBody(sp.choice), { create: { producer: { name: 'Radikon' }, product: { name: 'Oslavje', sparkling: true }, year: null } }), sp);
  const more = newWineChoice({ ...base, colour: 'white', grapes: ' Ribolla, , Chardonnay ', region: ' Collio ', country: 'IT' });
  check('new: grapes split on commas, region trimmed, country as picked', 'choice' in more && eq((linkBody(more.choice).create as { product: unknown }).product, { name: 'Oslavje', colour: 'white', grapes: ['Ribolla', 'Chardonnay'], region: 'Collio', country: 'IT' }), more);
  check('new: never an alcohol-free choice (the abv is the fact)', 'choice' in red && !JSON.stringify(red.choice).includes('nonalc'));
  check('new: an invalid year / abv names the fix', eq(newWineChoice({ ...base, colour: 'red', year: '99' }), { error: yearInvalid() }) && eq(newWineChoice({ ...base, colour: 'red', abv: 'x' }), { error: ABV_INVALID }));
}

// ── The freeze rule's outcome ──────────────────────────────────────────────
check('outcome: a 2xx landed', writeOutcome(201) === 'landed' && writeOutcome(200) === 'landed');
check('outcome: a 4xx is a definite refusal (the form stays editable)', writeOutcome(400) === 'refused' && writeOutcome(409) === 'refused' && writeOutcome(429) === 'refused');
check('outcome: no answer, a timeout or a 5xx MAY have landed (the choice freezes)', writeOutcome(null) === 'unknown' && writeOutcome(500) === 'unknown' && writeOutcome(503) === 'unknown');

// ── The details' facts ─────────────────────────────────────────────────────
check('alcohol: "13.5 %"', alcoholText(13.5) === '13.5 %');
check('alcohol: 0.5 reads alcohol-free WITH its value (never rounded to 0)', alcoholText(0.5) === 'Alcohol-Free · 0.5 %');
check('alcohol: 0 → "Alcohol-Free · 0 %"', alcoholText(0) === 'Alcohol-Free · 0 %');
check('alcohol: 0.6 is not alcohol-free', alcoholText(0.6) === '0.6 %');
check('alcohol: no abv (a blind row) → nothing', alcoholText(null) === null && alcoholText(undefined) === null);
const E = { region: 'Collio', country: 'IT', grapes: ['Ribolla Gialla'] };
check('origin: the entry wins over the bottle\'s copy', eq(bottleOrigin(E, { region: 'Old', country: 'FR' }), { region: 'Collio', country: 'IT' }));
check('origin: an entry without a region shows none (never the stale copy)', eq(bottleOrigin({ ...E, region: null }, { region: 'Old', country: 'FR' }), { region: '', country: 'IT' }));
check('origin: an unlinked old bottle keeps its own', eq(bottleOrigin(null, { region: 'Old', country: 'FR' }), { region: 'Old', country: 'FR' }));
check('grapes: the entry\'s, joined; else the bottle\'s', bottleGrapes(E, 'x') === 'Ribolla Gialla' && bottleGrapes(null, 'Merlot') === 'Merlot');

console.log(failures === 0 ? '\nAll catalog-choice pins passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
