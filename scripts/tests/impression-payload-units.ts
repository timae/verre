// Behavioural pins for the session impression payload builder + the scanner
// coercion helpers. Both are PRODUCTION modules imported by the components —
// the whole point of extracting them.
//
//   npx tsx scripts/tests/impression-payload-units.ts
//
// WHY THIS FILE EXISTS: two earlier attempts at this coverage were hollow.
//   1. The add-vs-edit split was asserted by grepping for `isEditMode` and an
//      `optional()` helper. Review showed the bypass: change
//      `vintage: optional(cleanVintage)` to `vintage: cleanVintage || undefined`
//      and the gate still passed, because it never checked that vintage USED the
//      helper. Behaviour, not existence, is what needs pinning.
//   2. The scanner coercion was implemented in the component and a COPY of it
//      was tested here. Mutating production to accept floats left the suite
//      green. A test of a copy tests nothing.

import { buildImpressionPayload, OPTIONAL_IMPRESSION_FIELDS } from '../../apps/mobile/src/lib/impressionPayload';
import { scanText, scanVintage, normalizeVintageText, NV_DISPLAY } from '@verre/core';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const FILLED = {
  name: '  Test Cuvee  ',
  type: 'white',
  producer: '  Fixture Estate  ',
  vintage: '2019',
  grape: '  Fixture Grape  ',
  region: '  Fixture Region  ',
  country: 'IT',
  vinification: '  Skin contact  ',
  description: '  Lovely  ',
  purchaseUrl: '  https://x.test  ',
};
const EMPTY = {
  name: 'Just a name',
  type: 'red',
  producer: '',
  vintage: '',
  grape: '',
  region: '',
  country: '',
  vinification: '',
  description: '',
  purchaseUrl: '',
};

// ── ADD mode: empty optionals are OMITTED ──────────────────────────────────
{
  const p = buildImpressionPayload(EMPTY, 'add') as Record<string, unknown>;
  for (const f of OPTIONAL_IMPRESSION_FIELDS) {
    check(`add + empty ${f} → property OMITTED`, !(f in p), JSON.stringify(p[f]));
  }
  check('add: required name is trimmed and present', p.name === 'Just a name');
  check('add: required type present', p.type === 'red');
}

// ── EDIT mode: empty optionals are PRESENT as '' ───────────────────────────
// 🔒 This is the bug. Omission means "unchanged" to the server, so a cleared
// field silently kept its old value — and for vintage the server stored the
// empty value anyway while applyIdentityEditRule read the omission as unchanged
// and KEPT the catalog link (blank vintage, retained vintage-grain link).
{
  const p = buildImpressionPayload(EMPTY, 'edit') as Record<string, unknown>;
  for (const f of OPTIONAL_IMPRESSION_FIELDS) {
    check(`edit + empty ${f} → property PRESENT as ''`, f in p && p[f] === '', JSON.stringify(p[f]));
  }
}

// ── Populated values survive, and are trimmed, in BOTH modes ───────────────
for (const mode of ['add', 'edit'] as const) {
  const p = buildImpressionPayload(FILLED, mode) as Record<string, unknown>;
  check(`${mode}: name trimmed`, p.name === 'Test Cuvee', String(p.name));
  check(`${mode}: producer trimmed`, p.producer === 'Fixture Estate', String(p.producer));
  check(`${mode}: grape trimmed`, p.grape === 'Fixture Grape', String(p.grape));
  check(`${mode}: region trimmed`, p.region === 'Fixture Region', String(p.region));
  check(`${mode}: vinification trimmed`, p.vinification === 'Skin contact', String(p.vinification));
  check(`${mode}: description trimmed`, p.description === 'Lovely', String(p.description));
  check(`${mode}: purchaseUrl trimmed`, p.purchaseUrl === 'https://x.test', String(p.purchaseUrl));
  check(`${mode}: country passed through (already canonical ISO-2)`, p.country === 'IT', String(p.country));
  check(`${mode}: vintage survives`, p.vintage === '2019', String(p.vintage));
}

// ── Vintage is CANONICALIZED by the builder, not merely trimmed ─────────────
{
  const nv = buildImpressionPayload({ ...FILLED, vintage: 'n.v.' }, 'add') as Record<string, unknown>;
  check('builder canonicalizes an NV token', nv.vintage === NV_DISPLAY, String(nv.vintage));
  // A half-typed NV prefix is allowed through the per-keystroke FILTER, so the
  // builder must drop it rather than send it to a Char(4) column.
  const partial = buildImpressionPayload({ ...FILLED, vintage: 'non-vinta' }, 'add') as Record<string, unknown>;
  check('builder drops a half-typed NV prefix on ADD (omitted)', !('vintage' in partial), String(partial.vintage));
  const partialEdit = buildImpressionPayload({ ...FILLED, vintage: 'non-vinta' }, 'edit') as Record<string, unknown>;
  check("builder drops a half-typed NV prefix on EDIT (present as '')", partialEdit.vintage === '', String(partialEdit.vintage));
  const overlong = buildImpressionPayload({ ...FILLED, vintage: '2019-2020' }, 'edit') as Record<string, unknown>;
  check("builder drops an overlong vintage (NOT truncated to '2019')", overlong.vintage === '', String(overlong.vintage));
}

// ── The scanner coercion helpers (PRODUCTION, imported by AddWineModal) ─────
{
  // Vintage: string OR integer.
  check('scanVintage: string "2019" accepted', scanVintage('2019') === '2019');
  check('scanVintage: integer 2019 → "2019"', scanVintage(2019) === '2019');
  check('scanVintage: integer canonicalizes through the normalizer', normalizeVintageText(scanVintage(2019) ?? '') === '2019');
  check('scanVintage: "NV" passes through to canonicalize', normalizeVintageText(scanVintage('NV') ?? '') === NV_DISPLAY);
  check('scanVintage: "n.v." canonicalizes to NV', normalizeVintageText(scanVintage('n.v.') ?? '') === NV_DISPLAY);
  check('scanVintage: "non-vintage" canonicalizes to NV', normalizeVintageText(scanVintage('non-vintage') ?? '') === NV_DISPLAY);
  // 🔒 Rejections — and none of these may THROW (the scan path treats a bad
  // field as "not extracted", never as an error).
  check('scanVintage: float 2019.5 REJECTED', scanVintage(2019.5) === null);
  check('scanVintage: object REJECTED', scanVintage({ y: 2019 }) === null);
  check('scanVintage: array REJECTED', scanVintage([2019]) === null);
  check('scanVintage: null REJECTED', scanVintage(null) === null);
  check('scanVintage: undefined REJECTED', scanVintage(undefined) === null);
  check('scanVintage: boolean REJECTED', scanVintage(true) === null);
  check('scanVintage: NaN REJECTED', scanVintage(NaN) === null);
  check('scanVintage: Infinity REJECTED', scanVintage(Infinity) === null);
  check('scanVintage: unsafe integer REJECTED', scanVintage(2 ** 60) === null);
  // 🔒 SIGN LAUNDERING. Accepting "any safe integer" let -2019 stringify to
  // "-2019", and the normalizer's digit-extraction then STRIPPED THE SIGN and
  // stored "2019" — a malformed negative year became a valid one. Measured
  // before the fix. A number must already be a plausible 4-digit year.
  check('scanVintage: NEGATIVE -2019 REJECTED (would have laundered to 2019)', scanVintage(-2019) === null);
  check('scanVintage: 0 REJECTED', scanVintage(0) === null);
  check('scanVintage: 999 REJECTED (too few digits)', scanVintage(999) === null);
  check('scanVintage: 10000 REJECTED (too many digits)', scanVintage(10000) === null);
  check('scanVintage: 1000 accepted (lower bound)', scanVintage(1000) === '1000');
  check('scanVintage: 9999 accepted (upper bound)', scanVintage(9999) === '9999');
  // End-to-end: nothing numeric can reach storage as a laundered year.
  check('scan→store: -2019 stores EMPTY', normalizeVintageText(scanVintage(-2019) ?? '') === '');

  // Text fields: STRINGS ONLY. A numeric producer/grape is a malformed response,
  // and coercing it would launder junk into the form.
  check('scanText: string accepted', scanText('Fixture Estate') === 'Fixture Estate');
  check('scanText: integer REJECTED (asymmetry with vintage is deliberate)', scanText(2019) === null);
  check('scanText: float REJECTED', scanText(1.5) === null);
  check('scanText: object REJECTED', scanText({ a: 1 }) === null);
  check('scanText: null REJECTED', scanText(null) === null);
  check('scanText: boolean REJECTED', scanText(false) === null);

  // No-throw guarantee, stated as its own pin.
  let threw = false;
  try {
    for (const v of [2019.5, {}, [], null, undefined, true, NaN, Infinity, Symbol('x')]) {
      scanVintage(v as unknown);
      scanText(v as unknown);
    }
  } catch {
    threw = true;
  }
  check('scan helpers never throw on any input shape', !threw);
}

console.log(failures === 0 ? '\nAll impression-payload + scanner pins passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
