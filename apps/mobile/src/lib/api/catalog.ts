import { apiFetch } from '../apiFetch';

// The catalogue searches the bottle picker reads (README: `/api/catalog/search`
// and the moment's `/api/session/:code/catalog/search`, the same three kinds and
// answers). Inside a moment the picker asks the moment's route (whoever may add
// bottles there); a check-in asks the global one. Producer first: the wine
// search needs a `producerId` (a server capacity rule).

export type CatalogScope = { code: string } | null;
export type ProducerHit = { id: string; name: string; country: string | null; region: string | null };
export type ProductHit = { id: string; name: string; colour: string | null; sparkling: boolean; region: string | null; producerId: string; producerName: string };
export type VintageHit = { id: string; year: number | null };

// A search that didn't answer. `off` = the catalogue is switched off (a 404:
// the kill switch, ADR-0009); the message is the line shown at the search.
export class CatalogSearchError extends Error {
  reason: 'off' | 'busy' | 'failed';
  constructor(reason: 'off' | 'busy' | 'failed') {
    super(reason === 'off' ? 'Adding bottles is unavailable right now.' : reason === 'busy' ? 'Too many searches. Wait a moment.' : 'Search failed. Try again.');
    this.reason = reason;
  }
}

async function ask<T>(scope: CatalogScope, qs: string): Promise<{ results: T[]; more: boolean }> {
  const base = scope ? `/api/session/${encodeURIComponent(scope.code)}/catalog/search` : '/api/catalog/search';
  const res = await apiFetch(`${base}?${qs}`).catch(() => null);
  if (!res) throw new CatalogSearchError('failed');
  if (res.status === 404) throw new CatalogSearchError('off');
  if (res.status === 429) throw new CatalogSearchError('busy');
  if (!res.ok) throw new CatalogSearchError('failed');
  const j = (await res.json().catch(() => null)) as { results?: T[]; more?: boolean } | null;
  return { results: j?.results ?? [], more: !!j?.more };
}

export const searchProducers = (scope: CatalogScope, q: string) =>
  ask<ProducerHit>(scope, `kind=producer&q=${encodeURIComponent(q)}`).then((r) => r.results);
// Under 3 characters the server lists the producer's wines A to Z (`more` =
// there are more than it sent: type to narrow).
export const searchProducts = (scope: CatalogScope, producerId: string, q: string) =>
  ask<ProductHit>(scope, `kind=product&producerId=${encodeURIComponent(producerId)}&q=${encodeURIComponent(q)}`);
export const listVintages = (scope: CatalogScope, productId: string) =>
  ask<VintageHit>(scope, `kind=vintages&productId=${encodeURIComponent(productId)}`).then((r) => r.results);
