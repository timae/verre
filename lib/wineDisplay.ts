// What a line-up bottle SHOWS on the web (catalogue model change step 4):
// its catalogue entry when linked (merges followed, server-side), else its
// own snapshot (a legacy or purged bottle). Pure, client-safe. A blind row has
// `entry: null` and a blanked snapshot, so it shows its "Wine N" placeholder.
import { kindToken, isNonAlcoholic, type KindToken } from '@verre/core'
import type { CatalogEntry } from '@/lib/catalogEntries'

type Shown = {
  name: string; producer?: string; vintage?: string | null; grape?: string; region?: string; country?: string
  colour?: string | null; sparkling?: boolean; abv?: number | null; entry?: CatalogEntry | null
}

export function entryYear(e: Pick<CatalogEntry, 'vintageId' | 'year'>): string {
  return e.vintageId === null ? '' : e.year === null ? 'NV' : String(e.year)
}

export function wineShown(w: Shown): {
  name: string; producer: string; vintage: string; grape: string; region: string; country: string
  kind: KindToken; abv: number | null; alcoholFree: boolean
} {
  const e = w.entry ?? null
  const abv = w.abv ?? null
  return {
    name: e?.name ?? w.name,
    producer: e?.producer ?? w.producer ?? '',
    vintage: e ? entryYear(e) : w.vintage ?? '',
    grape: e ? e.grapes.join(', ') : w.grape ?? '',
    region: (e ? e.region : w.region) ?? '',
    country: (e ? e.country : w.country) ?? '',
    kind: kindToken(w),
    abv,
    alcoholFree: isNonAlcoholic(abv),
  }
}

// "13.5 %" (never rounded to 0: a delivered 0.5 stays "0.5 %").
export function abvLabel(abv: number | null | undefined): string {
  if (typeof abv !== 'number' || !Number.isFinite(abv)) return ''
  return `${String(Math.round(abv * 100) / 100)} %`
}
