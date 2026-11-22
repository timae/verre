import { normalizeVintageText } from '@verre/core';

// The search hits this module reads, STRUCTURAL (lib/api/catalog.ts has the
// full shapes): a root unit test imports this module, and the app's API types
// pull React Native's global typings into the web build (listPost.ts's lesson).
type ProductHit = { id: string; name: string; colour: string | null; sparkling: boolean; producerName: string };
type VintageHit = { id: string; year: number | null };

// The bottle picker's rules, pure (ADR-0009; units in
// scripts/tests/catalog-choice-units.ts). Every new bottle is a catalogue
// wine: a PICK of ids, or a CREATE (the `/api/catalog/entries` add-flow body,
// minted with the add). The web's components/wine/CatalogPicker.tsx is the
// behaviour reference.
// 🔒 Nothing links until the person picks: a choice is built only from a
// producer and a wine they tapped, never from the top search hit.

export type Colour = 'red' | 'white' | 'rose';
export type BottleLabel = { name: string; producer: string; year: string; colour: Colour | null; sparkling: boolean };
export type CatalogChoice =
  | { kind: 'pick'; productId: string; vintageId: string | null; label: BottleLabel }
  | { kind: 'create'; body: Record<string, unknown>; label: BottleLabel };
// What a bottle write sends for its link (the session wine POST / PATCH, the
// check-in POST / PATCH).
export const linkBody = (c: CatalogChoice): Record<string, unknown> =>
  c.kind === 'pick' ? { productId: c.productId, vintageId: c.vintageId } : { create: c.body };

export const COLOURS: Array<{ code: Colour; label: string }> = [
  { code: 'red', label: 'Red' },
  { code: 'white', label: 'White' },
  { code: 'rose', label: 'Rosé' },
];
export const asColour = (v: string | null | undefined): Colour | null => (v === 'red' || v === 'white' || v === 'rose' ? v : null);

// A year field + its NV chip → the add flow's `year`: absent = unknown (empty
// field), null = non-vintage (the chip, or a typed "NV" out of habit), a year.
export type YearRead = { ok: true; year?: number | null } | { ok: false };
export function readYear(nv: boolean, text: string): YearRead {
  if (nv) return { ok: true, year: null };
  const t = text.trim();
  if (!t) return { ok: true };
  const v = normalizeVintageText(t);
  if (v === 'NV') return { ok: true, year: null };
  // The server's range (lib/catalogWrite.ts validateYear): 1900 to the current year.
  if (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= maxYear()) return { ok: true, year: Number(v) };
  return { ok: false };
}
// Read at each check, not at load: an app left open over New Year takes the new year.
export const maxYear = (): number => new Date().getUTCFullYear();
export const yearInvalid = (): string => `Type a year between 1900 and ${maxYear()}, or tap NV.`;

// The optional alcohol %: '' = none; a comma is a decimal point; 0 to 25.
export type AbvRead = { ok: true; abv?: number } | { ok: false };
export function readAbv(text: string): AbvRead {
  const t = text.trim().replace(',', '.');
  if (!t) return { ok: true };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return { ok: false };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 25 ? { ok: true, abv: n } : { ok: false };
}
export const ABV_INVALID = 'Alcohol must be between 0 and 25 %.';

const yearText = (y: number | null | undefined) => (y === undefined ? '' : y === null ? 'NV' : String(y));

// A picked wine's year (Simon's one field, ADR-0009): a year the wine already
// has is that year, any other is added, empty = year unknown. `pending` while
// the wine's years are still loading (nothing to decide yet).
export type YearFate =
  | { fate: 'invalid' }
  | { fate: 'pending' }
  | { fate: 'unknown' }
  | { fate: 'listed'; vintageId: string; year: number | null }
  | { fate: 'added'; year: number | null };
export function yearFate(vintages: VintageHit[] | null, read: YearRead): YearFate {
  if (!read.ok) return { fate: 'invalid' };
  if (!('year' in read)) return { fate: 'unknown' };
  if (vintages === null) return { fate: 'pending' };
  const hit = vintages.find((v) => v.year === read.year);
  return hit ? { fate: 'listed', vintageId: hit.id, year: read.year ?? null } : { fate: 'added', year: read.year ?? null };
}
// The line under the year field after typing (wording ruled 2026-11-21 after
// the review's proposals: "2019 is in the catalogue." / "2019 is added on
// save."); nothing while it is empty or still loading.
export function yearLine(f: YearFate): string | null {
  if (f.fate !== 'listed' && f.fate !== 'added') return null;
  const what = f.year === null ? 'Non-vintage' : String(f.year);
  return f.fate === 'listed' ? `${what} is in the catalogue.` : `${what} is added on save.`;
}

// The choice for a picked wine. The alcohol % only travels with a year that
// will be added (an existing entry is never edited from here, spec § 3).
export function pickedChoice(product: ProductHit, vintages: VintageHit[] | null, nv: boolean, yearInput: string, abvInput: string): { choice: CatalogChoice } | { error: string } | { pending: true } {
  const f = yearFate(vintages, readYear(nv, yearInput));
  const label = (year: string): BottleLabel => ({ name: product.name, producer: product.producerName, year, colour: asColour(product.colour), sparkling: product.sparkling });
  if (f.fate === 'invalid') return { error: yearInvalid() };
  if (f.fate === 'pending') return { pending: true };
  if (f.fate === 'unknown') return { choice: { kind: 'pick', productId: product.id, vintageId: null, label: label('') } };
  if (f.fate === 'listed') return { choice: { kind: 'pick', productId: product.id, vintageId: f.vintageId, label: label(yearText(f.year)) } };
  const abv = readAbv(abvInput);
  if (!abv.ok) return { error: ABV_INVALID };
  return { choice: { kind: 'create', body: { productId: product.id, year: f.year, ...(abv.abv !== undefined ? { abv: abv.abv } : {}) }, label: label(yearText(f.year)) } };
}

// A new wine (a new producer, or a new wine under a picked one): producer +
// name + a colour or Sparkling (a sparkling rosé is both), then the optional
// year, alcohol %, grapes, region and country.
export type NewWineDraft = {
  producer: { id: string; name: string } | { id: null; name: string };
  name: string;
  colour: Colour | null;
  sparkling: boolean;
  nv: boolean;
  year: string;
  abv: string;
  grapes: string;
  region: string;
  country: string; // ISO-2, '' = unset
};
export const NAME_MISSING = 'Give the wine a name.';
export const KIND_MISSING = 'Choose a colour, or Sparkling.';
export function newWineChoice(d: NewWineDraft): { choice: CatalogChoice } | { error: string } {
  const name = d.name.trim();
  const producerName = d.producer.name.trim();
  if (!name || !producerName) return { error: NAME_MISSING };
  if (!d.colour && !d.sparkling) return { error: KIND_MISSING };
  const y = readYear(d.nv, d.year);
  if (!y.ok) return { error: yearInvalid() };
  const abv = readAbv(d.abv);
  if (!abv.ok) return { error: ABV_INVALID };
  const grapes = d.grapes.split(',').map((g) => g.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    ...(d.producer.id ? { producerId: d.producer.id } : { producer: { name: producerName } }),
    product: {
      name,
      ...(d.colour ? { colour: d.colour } : {}),
      ...(d.sparkling ? { sparkling: true } : {}),
      ...(grapes.length ? { grapes } : {}),
      ...(d.region.trim() ? { region: d.region.trim() } : {}),
      ...(d.country ? { country: d.country } : {}),
    },
    ...('year' in y ? { year: y.year } : {}),
    ...(abv.abv !== undefined ? { abv: abv.abv } : {}),
  };
  return { choice: { kind: 'create', body, label: { name, producer: producerName, year: 'year' in y ? yearText(y.year) : '', colour: d.colour, sparkling: d.sparkling } } };
}

// A bottle write's answer, read for the freeze rule (the web's ChosenWine
// rule): once a write MAY have landed (a 2xx, or no definite answer: a lost
// request, a timeout, a 5xx), the choice is frozen and a retry re-sends the
// same id with the same choice, never an edited `create` (that would mint a
// second entry). Only a definite refusal (a 4xx) keeps the form editable.
export type WriteOutcome = 'landed' | 'refused' | 'unknown';
export function writeOutcome(status: number | null): WriteOutcome {
  if (status !== null && status >= 200 && status < 300) return 'landed';
  if (status !== null && status >= 400 && status < 500) return 'refused';
  return 'unknown';
}

// Where the screen's back (the bar's arrow, the edge swipe, Android's back)
// goes while the picker is past its first step (ruled 2026-11-22: back steps
// through the picker before it leaves the page). One step at a time: a new
// wine's fields → that producer's wines (a NEW producer: the producer search)
// → the producer search → the one search field; a picked wine → the list it
// was picked from; an edit's search → the bottle kept as it was. 'none' = the
// back leaves the page.
export type BackStep = 'none' | 'keep' | 'unpick' | 'wines' | 'producer' | 'search';
export function backStep(p: {
  frozen: boolean; editing: boolean; changing: boolean; mode: 'find' | 'new';
  picked: boolean; producer: 'listed' | 'new' | null; creating: boolean;
}): BackStep {
  if (p.frozen || (p.editing && !p.changing)) return 'none';
  if (p.mode === 'find') return p.picked ? 'unpick' : p.editing ? 'keep' : 'none';
  if (p.creating && p.producer) return p.producer === 'listed' ? 'wines' : 'producer';
  if (p.picked) return 'wines';
  return p.producer ? 'producer' : 'search';
}
