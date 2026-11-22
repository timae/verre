import { apiFetch } from '../apiFetch';

// The catalogue searches the bottle picker reads (README: `/api/catalog/search`
// and the moment's `/api/session/:code/catalog/search`, the same kinds and
// answers). Inside a moment the picker asks the moment's route (whoever may add
// bottles there); a check-in asks the global one.
//   kind=bottle    the one field (ADR-0010): producer, wine, region and year in
//                  any order; every typed word must match; one row per wine with
//                  the carried `year`
//   kind=producer  "Add Wine to Catalogue"'s producer field, the same every-word rule
//   kind=product   a chosen producer's wines (the server needs its `producerId`)
//   kind=vintages  a picked wine's years
// 🔒 The envelope travels whole (step 7b, Codex r2 P2): `more` (the server
// stopped early: type more) and `tooLong` (refused, over 16 words or 200
// characters) reach the controller (lib/bottleSearch.ts), so the picker never
// offers "Add Wine to Catalogue" on a list that never searched.

export type CatalogScope = { code: string } | null;
export type ProducerHit = { id: string; name: string; country: string | null; region: string | null };
export type ProductHit = { id: string; name: string; colour: string | null; sparkling: boolean; region: string | null; producerId: string; producerName: string };
// A wine from the one field: `year` = the typed year, CARRIED (shown on the row,
// filled into the year field on a pick); null when none was typed or the wine's
// own name holds that number.
export type BottleHit = ProductHit & { year: number | null };
export type VintageHit = { id: string; year: number | null };
// `exact` (kind=producer): a listed producer carries exactly the typed name, as
// the database folds names ("Strass" = "Straß"); "Add Producer" is offered only
// without one.
export type SearchAnswer<T> = { results: T[]; more: boolean; tooLong: boolean; exact?: boolean; close?: boolean };

// A search that didn't answer. `off` = the catalogue is switched off (a 404:
// the kill switch, ADR-0009); the message is the line shown at the search.
export class CatalogSearchError extends Error {
  reason: 'off' | 'busy' | 'failed';
  constructor(reason: 'off' | 'busy' | 'failed') {
    super(reason === 'off' ? 'Adding bottles is unavailable right now.' : reason === 'busy' ? 'Too many searches. Wait a moment.' : 'Search failed. Try again.');
    this.reason = reason;
  }
}

async function ask<T>(scope: CatalogScope, qs: string): Promise<SearchAnswer<T>> {
  const base = scope ? `/api/session/${encodeURIComponent(scope.code)}/catalog/search` : '/api/catalog/search';
  const res = await apiFetch(`${base}?${qs}`).catch(() => null);
  if (!res) throw new CatalogSearchError('failed');
  if (res.status === 404) throw new CatalogSearchError('off');
  if (res.status === 429) throw new CatalogSearchError('busy');
  if (!res.ok) throw new CatalogSearchError('failed');
  const j = (await res.json().catch(() => null)) as { results?: T[]; more?: boolean; tooLong?: boolean; exact?: boolean; close?: boolean } | null;
  if (!j || !Array.isArray(j.results)) throw new CatalogSearchError('failed');
  return { results: j.results, more: !!j.more, tooLong: !!j.tooLong, exact: !!j.exact, close: !!j.close };
}

export const searchBottles = (scope: CatalogScope, q: string) =>
  ask<BottleHit>(scope, `kind=bottle&q=${encodeURIComponent(q)}`);
export const searchProducers = (scope: CatalogScope, q: string) =>
  ask<ProducerHit>(scope, `kind=producer&q=${encodeURIComponent(q)}`);
// Under 3 characters the server lists the producer's wines A to Z (`more` =
// there are more than it sent: type to narrow).
export const searchProducts = (scope: CatalogScope, producerId: string, q: string) =>
  ask<ProductHit>(scope, `kind=product&producerId=${encodeURIComponent(producerId)}&q=${encodeURIComponent(q)}`);
export const listVintages = (scope: CatalogScope, productId: string) =>
  ask<VintageHit>(scope, `kind=vintages&productId=${encodeURIComponent(productId)}`).then((r) => r.results);
