// A bottle's kind and its alcohol (catalogue model change § 0.2, step 4).
// Pure; shared web ↔ native.
//
// 🔒 THE ABV IS THE FACT; "alcohol-free" is DERIVED from it (Simon, 2026-11-19):
// abv ≤ 0.5 reads as non-alcoholic (the EU / Swiss / US class of de-alcoholised
// wine), and the value is still shown with it ("0.5 %"), never rounded to 0.
// Every reader that decides "alcohol-free" goes through `isNonAlcoholic`, never
// `abv === 0` and never a `nonalc` style token alone (a legacy alcohol-free
// bottle reads as abv 0: what the old picker meant).
export const NON_ALCOHOLIC_MAX_ABV = 0.5

export function isNonAlcoholic(abv: number | null | undefined): boolean {
  return typeof abv === 'number' && Number.isFinite(abv) && abv <= NON_ALCOHOLIC_MAX_ABV
}

// The legacy style token (`wines.style`, the cached line-up's `type`) as the
// catalogue's pair: red / white / rose → that colour; spark → sparkling, colour
// unknown; nonalc and anything else → neither. The SAME rule as the expand
// migration's snapshot backfill and lib/occurrences.ts snapshotOf.
export function kindOfStyle(style: string | null | undefined): { colour: 'red' | 'white' | 'rose' | null; sparkling: boolean } {
  return {
    colour: style === 'red' || style === 'white' || style === 'rose' ? style : null,
    sparkling: style === 'spark',
  }
}

// The one display token for a bottle's mark (icon, accent colour): sparkling
// wins, then the colour, then alcohol-free; '' when nothing is known (an
// imported entry with no colour: never a guessed colour).
export type KindToken = 'spark' | 'red' | 'white' | 'rose' | 'nonalc' | ''
export function kindToken(b: { colour?: string | null; sparkling?: boolean | null; abv?: number | null }): KindToken {
  if (b.sparkling) return 'spark'
  if (b.colour === 'red' || b.colour === 'white' || b.colour === 'rose') return b.colour
  if (isNonAlcoholic(b.abv)) return 'nonalc'
  return ''
}
