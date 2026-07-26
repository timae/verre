// Vintage free-text units — drives the REAL @verre/core module that every
// vintage input on web + native now routes through. Run from repo root:
//   npx tsx scripts/tests/vintage-text-units.ts
//
// Why this exists: the MOBILE clients could not produce a non-vintage marker and
// actively destroyed an existing one. They stripped non-digits on every keystroke
// (so "NV" was untypeable, and on an existing NV check-in the first text change
// blanked the field, which saving then persisted), and the web label scanner ran
// the same strip on the model's output, converting a scanned "NV" to blank. The
// web forms' own text inputs always accepted it, so stored NV strings exist and
// were being destroyed by the other paths.
//
// The pins below are written to FAIL against the pre-fix behaviour (a bare
// `\D`-strip) and against the plausible wrong fixes: substring matching,
// running the boundary normalizer per keystroke, and dropping the 4-char cap.

import {
  NV_DISPLAY,
  isNonVintageToken,
  normalizeVintageText,
  filterVintageInput,
} from '@verre/core';
import { applyIdentityEditRule, validateYear } from '../../lib/catalogWrite';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── isNonVintageToken: case-insensitive EXACT allowlist ──
// Spelling must match the backfill rule in docs/dev/proposals/wine-catalog.md
// § "Token handling" — if these two disagree, a token the client accepts is one
// the backfill files as garbage.
// 🔒 FOUR tokens, not three — `NV.` was MISSING from the first cut and contract
// review caught it. A token a client rejects that the backfill accepts is the
// same class of failure as the reverse. Whitespace is trimmed before matching;
// internal punctuation is NEVER removed, and the match is never a substring.
for (const t of [
  'NV', 'nv', 'Nv',
  'N.V.', 'n.v.',
  'NV.', 'nv.', 'Nv.',
  'non-vintage', 'Non-Vintage', 'NON-VINTAGE',
  ' NV ', '  N.V.  ', '\tNV.\t', ' non-vintage ',
]) {
  check(`isNonVintageToken accepts ${JSON.stringify(t)}`, isNonVintageToken(t));
}
// 🔒 NOT a substring or prefix test. "NV Selection" is a wine name.
for (const t of ['NV Selection', 'Cuvée NV', 'nvintage', 'N.V', 'nonvintage', 'non vintage', '', '2019']) {
  check(`isNonVintageToken rejects ${JSON.stringify(t)}`, !isNonVintageToken(t));
}

// ── normalizeVintageText: the BOUNDARY normalizer (scan result / submit) ──
check('normalize: NV token → canonical NV', normalizeVintageText('nv') === NV_DISPLAY);
check('normalize: N.V. → NV', normalizeVintageText('N.V.') === NV_DISPLAY);
check('normalize: non-vintage → NV (fits Char(4))', normalizeVintageText('non-vintage') === NV_DISPLAY);
check('normalize: NV canonical is 2 chars, fits Char(4)', NV_DISPLAY.length <= 4);
check('normalize: plain year survives', normalizeVintageText('2019') === '2019');
check('normalize: year with whitespace', normalizeVintageText(' 2019 ') === '2019');
check('normalize: empty stays empty', normalizeVintageText('') === '');

// THE REGRESSION: this is the exact value the label scanner used to destroy.
check('normalize: scanned "NV" is NOT blanked (the bug)', normalizeVintageText('NV') === 'NV');
check('normalize: scanned "N.V." is NOT blanked', normalizeVintageText('N.V.') !== '');

// A half-typed prefix must NOT reach the server: Char(4) would truncate
// "non-vinta" → "non", inventing a value the user never typed.
check('normalize: half-typed "non-vinta" → dropped, not truncated', normalizeVintageText('non-vinta') === '');
check('normalize: half-typed "n" → dropped', normalizeVintageText('n') === '');
check('normalize: "NV Selection" is not an NV claim', normalizeVintageText('NV Selection') === '');

// 🔒 EXACTLY four digits, or nothing. These pins were WRONG in the first cut —
// they asserted the CODE's 1-4-digit behaviour instead of the contract the
// docstring states, so the suite passed while the normalizer produced '2' and
// '12'. A partial or truncated year invents a value the user never typed.
check('normalize: overlong "20191" → empty, NOT truncated', normalizeVintageText('20191') === '');
check('normalize: partial "2" → empty', normalizeVintageText('2') === '');
check('normalize: partial "201" → empty', normalizeVintageText('201') === '');
check('normalize: "abc12" → empty, not "12"', normalizeVintageText('abc12') === '');
// Blanket digit extraction is GONE. The approximation ("circa") forms are the
// only non-bare-year shape accepted, and they are matched by an EXPLICIT narrow
// grammar — they used to work only as a side effect of `replace(/\D/g,'')`.
check('normalize: explicit circa grammar yields the year', normalizeVintageText('c. 2019') === '2019');
// 🔒 A LEADING SIGN IS A REJECTION, NOT A STRIP. Digit-extraction alone turned
// '-2019' into '2019' — laundering a malformed negative year into a valid one.
// This guard lives in the NORMALIZER (not only the scan boundary) because a
// direct client reaches it without passing the scanner at all.
check('normalize: "-2019" → empty, sign NOT stripped', normalizeVintageText('-2019') === '');
check('normalize: "+2019" → empty', normalizeVintageText('+2019') === '');
check('normalize: U+2212 minus "−2019" → empty', normalizeVintageText('\u22122019') === '');
check('normalize: "2019" unaffected by the sign guard', normalizeVintageText('2019') === '2019');

// ── The matrix pinned by the backfill contract (2026-07-26) ────────────────
check('matrix: "NV." → NV (the token that was missing)', normalizeVintageText('NV.') === NV_DISPLAY);
check('matrix: "nv." → NV', normalizeVintageText('nv.') === NV_DISPLAY);
for (const t of [' NV ', '  N.V.  ', ' NV. ', ' non-vintage ']) {
  check(`matrix: surrounding whitespace on ${JSON.stringify(t)} → NV`, normalizeVintageText(t) === NV_DISPLAY);
}
check('matrix: "NV Selection" → empty', normalizeVintageText('NV Selection') === '');
check('matrix: "nvintage" → empty', normalizeVintageText('nvintage') === '');
// 🔒 A LOSSY REPAIR, rejected by the backfill contract: joining digits across
// whitespace is the same family as stripping a sign or truncating a range.
check('matrix: "20 19" → empty (digits NOT joined across whitespace)', normalizeVintageText('20 19') === '');
check('matrix: "2019-2020" → empty (range NOT truncated)', normalizeVintageText('2019-2020') === '');
check('matrix: "-2019" → empty', normalizeVintageText('-2019') === '');
check('matrix: "+2019" → empty', normalizeVintageText('+2019') === '');
check('matrix: "2" → empty (partial)', normalizeVintageText('2') === '');
check('matrix: "201" → empty (partial)', normalizeVintageText('201') === '');
check('matrix: "20191" → empty (five digits)', normalizeVintageText('20191') === '');
// Side effects of the narrow grammar — these used to be "rescued" by blanket
// digit extraction and are now correctly rejected.
check('matrix: "2019er" → empty', normalizeVintageText('2019er') === '');
check('matrix: "(2019)" → empty', normalizeVintageText('(2019)') === '');
check('matrix: "vintage 2019" → empty', normalizeVintageText('vintage 2019') === '');
// 🔒 NO PLAUSIBILITY BOUNDS AT THIS BOUNDARY — and these pins guard the ABSENCE.
// A 1800..current+1 range was added here and REVERTED, because this function runs
// on every edit RESEND: bounding it blanked an existing out-of-range value the
// moment the user touched any other field, and the comparator then read ''-vs-''
// as unchanged and KEPT the catalog link (blank vintage, retained vintage-grain
// link — the third instance of that defect class on this branch).
//
// Any four-digit value therefore ROUND-TRIPS. Range plausibility is enforced only
// at catalog promotion (`validateYear`), where a value becomes shared identity.
const nextYear = new Date().getUTCFullYear() + 1;
for (const legacy of ['1780', '3000', '1799', '0001', '9999', String(nextYear + 1)]) {
  check(`matrix: out-of-range ${legacy} is PRESERVED, not blanked`, normalizeVintageText(legacy) === legacy);
}
check('matrix: current+1 preserved', normalizeVintageText(String(nextYear)) === String(nextYear));
check('matrix: 1800 preserved', normalizeVintageText('1800') === '1800');
// The circa form, now EXPLICIT rather than an extraction accident.
for (const c of ['c. 2019', 'c.2019', 'ca 2019', 'ca. 2019', 'circa 2019', 'C. 2019']) {
  check(`matrix: ${JSON.stringify(c)} → 2019`, normalizeVintageText(c) === '2019');
}
check('matrix: "c. 1799" preserved (no bounds at this boundary)', normalizeVintageText('c. 1799') === '1799');
check('matrix: "c. 20 19" rejected', normalizeVintageText('c. 20 19') === '');

// ── filterVintageInput: the PER-KEYSTROKE filter ──
// 🔒 Must let an NV-token PREFIX through, or the user can never finish typing.
// This is the pin that fails if someone "simplifies" by calling the boundary
// normalizer on every keystroke.
check('filter: "n" survives (prefix of nv/non-vintage)', filterVintageInput('n') === 'n');
check('filter: "no" survives (prefix of non-vintage)', filterVintageInput('no') === 'no');
check('filter: "non-" survives', filterVintageInput('non-') === 'non-');
check('filter: "nv" survives', filterVintageInput('nv') === 'nv');
check('filter: "N.V" survives (prefix of n.v.)', filterVintageInput('N.V') === 'N.V');
check('filter: full "non-vintage" survives', filterVintageInput('non-vintage') === 'non-vintage');
// Simulate the real typing sequence keystroke by keystroke — the pre-fix
// handler produced '' at every step, which is what made NV unreachable.
{
  let field = '';
  for (const ch of 'NV') field = filterVintageInput(field + ch);
  check('filter: typing N→V accumulates to "NV"', field === 'NV', JSON.stringify(field));
  let long = '';
  for (const ch of 'non-vintage') long = filterVintageInput(long + ch);
  check('filter: typing "non-vintage" accumulates fully', long === 'non-vintage', JSON.stringify(long));
  // And the year path still works keystroke by keystroke.
  let yr = '';
  for (const ch of '2019') yr = filterVintageInput(yr + ch);
  check('filter: typing a year accumulates to "2019"', yr === '2019', JSON.stringify(yr));
}
// Non-token letters are still rejected, so the field isn't free text.
check('filter: "x" rejected', filterVintageInput('x') === '');
check('filter: "abc" rejected', filterVintageInput('abc') === '');
check('filter: "nx" rejected (not a token prefix)', filterVintageInput('nx') === '');
check('filter: digits capped at 4', filterVintageInput('20191') === '2019');
check('filter: "2019abc" → digits only', filterVintageInput('2019abc') === '2019');
check('filter: length capped (no unbounded growth)', filterVintageInput('n'.repeat(200)).length <= 11);

// ── Round-trip: whatever the filter allows, the boundary either canonicalizes
// or drops — it must never emit something the Char(4) column would mangle.
{
  const typed = ['', 'n', 'no', 'non', 'non-', 'non-v', 'non-vintage', 'nv', 'NV', 'N.V.', '2', '20', '201', '2019', 'x', '20191'];
  let ok = true;
  let bad = '';
  for (const t of typed) {
    const out = normalizeVintageText(filterVintageInput(t));
    if (out.length > 4) { ok = false; bad = `${t} → ${out}`; break; }
    if (out !== '' && out !== NV_DISPLAY && !/^\d{4}$/.test(out)) { ok = false; bad = `${t} → ${out}`; break; }
  }
  check('round-trip: filter→normalize is always NV, digits, or empty', ok, bad);
}

// ── applyIdentityEditRule: canonicalizing must NOT clear a catalog link ──
// 🔒 The write path canonicalizes 'N.V.' → 'NV'. applyIdentityEditRule compares
// "what will actually be stored", so it must use the SAME normalizer — with a
// raw/sliced compare, an edit that only canonicalized reported a change and
// silently returned {productId: null, vintageId: null}, dropping a correct link.
{
  const existing = { name: 'Blanc de Blancs', producer: 'A Maker', vintage: 'N.V.', productId: 'p1', vintageId: 'v1' };
  const kept = applyIdentityEditRule(existing, { vintage: 'NV' }, null);
  check('link: N.V. → NV PRESERVES the catalog link', kept.productId === 'p1' && kept.vintageId === 'v1', JSON.stringify(kept));
  const kept2 = applyIdentityEditRule(existing, { vintage: 'non-vintage' }, null);
  check('link: N.V. → non-vintage preserves the link', kept2.productId === 'p1', JSON.stringify(kept2));
  // A REAL identity change must still clear it — the fix must not over-preserve.
  const cleared = applyIdentityEditRule(existing, { vintage: '2019' }, null);
  check('link: N.V. → 2019 CLEARS the link (real change)', cleared.productId === null && cleared.vintageId === null, JSON.stringify(cleared));
  // And a year edit that only reformats keeps it.
  const yr = { name: 'X', producer: 'Y', vintage: '2019', productId: 'p2', vintageId: 'v2' };
  check('link: "2019" → " 2019 " preserves the link', applyIdentityEditRule(yr, { vintage: ' 2019 ' }, null).productId === 'p2');
  check('link: "2019" → "2020" clears the link', applyIdentityEditRule(yr, { vintage: '2020' }, null).productId === null);

  // 🔒 NON-STRING input: the comparator must model the write's TYPE handling,
  // not just its string handling. `scrub` returns null for a non-string, so the
  // write stores '' — while a String(v)-coercing comparator saw numeric 2019 as
  // equal to stored '2019' and KEPT the link. Result: blank vintage, retained
  // vintage-grain link. Same defect class as the omitted-vs-empty edit bug via a
  // different route.
  const numeric = applyIdentityEditRule(yr, { vintage: 2019 as unknown as string }, null);
  check('link: NUMERIC 2019 clears the link (write would store empty)', numeric.productId === null && numeric.vintageId === null, JSON.stringify(numeric));
  // 🔒 NAME IS ASYMMETRIC WITH VINTAGE, because the WRITES are. `name` is
  // required, so both write paths either fall back (`scrub(name) || existing`,
  // the check-in PATCH) or reject outright (the session path) — an invalid or
  // blank name is IGNORED and the stored name retained. Nothing moves, so the
  // link must SURVIVE. An earlier pin here asserted it cleared, which locked in
  // over-clearing: the comparator's contract is to model what the write actually
  // stores, and the write stores the old name.
  const numName = applyIdentityEditRule(yr, { name: 123 as unknown as string }, null);
  check('link: NUMERIC name PRESERVES the link (write keeps the old name)', numName.productId === 'p2', JSON.stringify(numName));
  const blankName = applyIdentityEditRule(yr, { name: '' }, null);
  check('link: BLANK name PRESERVES the link (write falls back)', blankName.productId === 'p2', JSON.stringify(blankName));
  const realName = applyIdentityEditRule(yr, { name: 'Other Wine' }, null);
  check('link: a REAL name change still clears the link', realName.productId === null, JSON.stringify(realName));
  // Producer is optional and IS stored when blanked, so it is not exempt.
  const blankProd = applyIdentityEditRule(yr, { producer: '' }, null);
  check('link: BLANK producer clears the link (optional field, really stored)', blankProd.productId === null, JSON.stringify(blankProd));
}

// ── The scanner's untrusted JSON ───────────────────────────────────────────
// MOVED to scripts/tests/impression-payload-units.ts, which imports the
// PRODUCTION helpers (@verre/core scanText/scanVintage). The pins that used to
// live here tested a local COPY of the coercion logic, so mutating production to
// accept floats left them green — a test of a copy tests nothing.

// ── 🔒 THE GRAIN BOUNDARY IS EXECUTABLE, NOT JUST A COMMENT ────────────────
// The encounter string accepts ANY structurally valid four-digit value (no
// plausibility range at all); catalog promotion accepts only 1900..current+1.
// The asymmetry is deliberate (catalog review, 2026-07-26): input validation is
// per-encounter and must never invalidate stored data, while promotion mints
// permanent shared identity and can afford to be strict.
//
// Values outside the catalog range stay encounter text and default to
// product-grain handling at backfill — they are never auto-promoted.
//
// A future reader will notice the two layers disagree and be tempted to unify
// them. These assertions make that FAIL rather than pass silently — pinning the
// DIVERGENCE itself, which a comment cannot do. ⚠️ Unifying by adding a range to
// the shared normalizer is the direction that DESTROYS DATA: it runs on every
// edit resend, so it blanks a stored out-of-range value the moment any other
// field is touched, and the comparator then reads ''-vs-'' as unchanged and
// keeps the catalog link.
{
  const nextYear = new Date().getUTCFullYear() + 1;
  // The encounter field accepts ANY four-digit value (structural grammar only,
  // so a legacy row round-trips unharmed)...
  check('boundary: encounter string ACCEPTS 1800', normalizeVintageText('1800') === '1800');
  check('boundary: encounter string ACCEPTS 1899', normalizeVintageText('1899') === '1899');
  check('boundary: encounter string ACCEPTS out-of-range 1780', normalizeVintageText('1780') === '1780');
  check('boundary: encounter string ACCEPTS out-of-range 3000', normalizeVintageText('3000') === '3000');
  // ...and the catalog grain REFUSES it. If validateYear is ever widened to
  // 1800, this fails — which is the point.
  for (const y of [1780, 1800, 1899, 3000]) {
    let rejected = false;
    try { validateYear(y); } catch { rejected = true; }
    check(`boundary: catalog validateYear(${y}) REJECTS (do not align this down)`, rejected);
  }
  // Both agree from 1900 up, and on the same moving upper bound.
  check('boundary: both accept 1900', normalizeVintageText('1900') === '1900' && validateYear(1900) === 1900);
  check('boundary: both accept current+1', normalizeVintageText(String(nextYear)) === String(nextYear) && validateYear(nextYear) === nextYear);
  let over = false;
  try { validateYear(nextYear + 1); } catch { over = true; }
  check('boundary: catalog rejects current+2 (the encounter string does not)', over && normalizeVintageText(String(nextYear + 1)) === String(nextYear + 1));
  // And NV is null at catalog grain but the literal string at encounter grain —
  // the other asymmetry that gets conflated.
  check('boundary: catalog NV is year=null', validateYear(null) === null);
  check('boundary: encounter NV is the string "NV"', normalizeVintageText('nv.') === NV_DISPLAY);
}

console.log(failures === 0 ? '\nAll vintage-text pins passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
