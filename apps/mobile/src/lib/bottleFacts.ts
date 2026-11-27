import { isNonAlcoholic } from '@verre/core';

// What a bottle's details show of its catalogue facts (ADR-0009). Pure (units
// in scripts/tests/catalog-choice-units.ts).

// The Alcohol row: "13.5 %", or "Alcohol-Free · 0.5 %" at 0.5 % or less (the
// value always shown, never rounded to 0: spec § 0.2); null without an abv (a
// blind row has none).
export function alcoholText(abv: number | null | undefined): string | null {
  if (typeof abv !== 'number' || !Number.isFinite(abv) || abv < 0) return null;
  const value = `${Number(abv.toFixed(2))} %`;
  return isNonAlcoholic(abv) ? `Alcohol-Free · ${value}` : value;
}

// A linked bottle's origin and grapes are its catalogue wine's (merges
// followed); the bottle's own copy is the fallback (an unlinked old bottle).
type Entryish = { region: string | null; country: string | null; grapes: string[] } | null | undefined;
export function bottleOrigin(entry: Entryish, own: { region?: string | null; country?: string | null }): { region: string; country: string } {
  return { region: (entry ? entry.region : own.region) ?? '', country: (entry ? entry.country : own.country) ?? '' };
}
export function bottleGrapes(entry: Entryish, own: string | null | undefined): string {
  return entry ? entry.grapes.join(', ') : own ?? '';
}
