// Catalogue fixtures for the suites that add a bottle (catalogue model change
// step 4: every new bottle links, so a suite picks an entry instead of typing
// a name). Mints through the real chokepoint (lib/catalogWrite.ts), as an
// IMPORT would (addedBy null: no review item), in one transaction each.
//
//   const e = await mintEntry({ producer: 'Domaine X', name: 'Cuvée Y', colour: 'red', year: 2019 })
//   await postWine(code, actor, { id, ...pick(e) })
import { prisma } from '../../../lib/prisma.ts'
import { createProducer, createProduct, createVintage } from '../../../lib/catalogWrite.ts'

export type Entry = { producerId: string; productId: string; vintageId: string | null; name: string; producer: string; year: number | null | undefined }
export type EntrySpec = {
  producer: string
  name: string
  colour?: 'red' | 'white' | 'rose' | null
  sparkling?: boolean
  // The product's abv; `vintageAbv` the vintage's.
  abv?: number | null
  vintageAbv?: number | null
  // absent = no vintage row (a product-grain pick); null = the NV row.
  year?: number | null
  grapes?: string[]
  region?: string
  // The wine's origin (ISO code).
  country?: string
  producerId?: string
}

// A legacy `type` token → the catalogue's pair.
export function kindOf(type: string): { colour: 'red' | 'white' | 'rose' | null; sparkling: boolean } {
  if (type === 'spark') return { colour: null, sparkling: true }
  if (type === 'red' || type === 'white' || type === 'rose') return { colour: type, sparkling: false }
  return { colour: null, sparkling: false }
}

export async function mintEntry(spec: EntrySpec): Promise<Entry> {
  return prisma.$transaction(async (tx) => {
    const producerId = spec.producerId ?? (await createProducer({ name: spec.producer }, null, tx)).id
    const product = await createProduct({
      name: spec.name, producerId, colour: spec.colour ?? undefined, sparkling: spec.sparkling,
      abv: spec.abv ?? null, grapes: spec.grapes, region: spec.region, country: spec.country,
    }, null, [], tx)
    const vintage = 'year' in spec && spec.year !== undefined
      ? await createVintage(product.id, spec.year, null, spec.vintageAbv ?? null, tx)
      : null
    return { producerId, productId: product.id, vintageId: vintage?.id ?? null, name: spec.name, producer: spec.producer, year: spec.year }
  })
}

// The wine-POST / check-in body of a pick.
export const pick = (e: Entry) => ({ productId: e.productId, vintageId: e.vintageId })

// The common case of the old suites: a bottle named `name` of a legacy type
// (`red`, `white`, `rose`, `spark`, `nonalc`), under its own producer.
let seq = 0
export async function entryFor(name: string, type = 'red', opts: Partial<EntrySpec> = {}): Promise<Entry> {
  return mintEntry({ producer: opts.producer ?? `Fixture Producer ${++seq}`, name, ...kindOf(type), ...(type === 'nonalc' ? { abv: 0 } : {}), ...opts })
}

// ── The adapter for the suites written before step 4 ────────────────────────
//
// Their bottles are typed (`{ name, type, producer?, vintage?, grape? }`, a
// check-in's `wineName`). Every new bottle now links, and the snapshot is the
// entry's, so a typed bottle becomes a freshly minted entry carrying exactly
// those values plus its pick: the suites' name / producer / year assertions
// keep their meaning. Applied in each suite's `call()` to the four bottle
// writes only:
//   • a POST that types a bottle (no link, no create, not "had a sip");
//   • a PATCH that carries a NAME (the old whole-form edit): re-linked to a
//     fresh entry with the form's values, which is what the old free-text edit
//     stored. A PATCH without a name (a purchase link, a photo, a session
//     rating's `wineId`) is left as it is: identity text alone is ignored.
// A body with no usable name is left as it is, so the bad-input tests still
// reach the route's own refusal.
// A check-in's `country` is the VENUE's (its wine's origin is `wineCountry`),
// a session bottle's `country` the wine's origin.
const IDENTITY_KEYS = ['name', 'wineName', 'producer', 'vintage', 'type', 'grape', 'region', 'wineRegion', 'wineCountry']
function yearOf(v: unknown): number | null | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (/^\d{4}$/.test(t)) return Number(t)
  if (/^n\.?\s?v\.?$/i.test(t) || /^non[- ]?vintage$/i.test(t)) return null
  return undefined
}
export async function linkLegacy(method: string, path: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const b = body as Record<string, unknown>
  if ('productId' in b || 'vintageId' in b || 'create' in b) return body
  const bare = path.split('?')[0]
  const post = method === 'POST' && (/^\/api\/session\/[^/]+\/wines$/.test(bare) || bare === '/api/checkins')
  const patch = method === 'PATCH' && (/^\/api\/session\/[^/]+\/wines\/[^/]+$/.test(bare) || /^\/api\/checkins\/\d+$/.test(bare))
  if (!post && !patch) return body
  if (post && b.copyFromCheckinId !== undefined) return body
  if (patch && 'wineId' in b) return body
  const name = typeof b.name === 'string' ? b.name : typeof b.wineName === 'string' ? b.wineName : null
  if (!name || !name.replace(/[\u0000-\u001f​-‏‪-‮⁠-⁯﻿]/g, '').trim()) return body
  const type = typeof b.type === 'string' ? b.type : 'red'
  const year = yearOf(b.vintage)
  const producer = typeof b.producer === 'string' && b.producer.trim() ? b.producer : `Fixture Producer ${++seq}`
  const region = typeof b.region === 'string' && b.region.trim() ? b.region : typeof b.wineRegion === 'string' && b.wineRegion.trim() ? b.wineRegion : undefined
  const checkin = bare.startsWith('/api/checkins')
  const origin = checkin ? b.wineCountry : b.country
  const country = typeof origin === 'string' && /^[A-Za-z]{2}$/.test(origin.trim()) ? origin.trim().toUpperCase() : undefined
  const e = await mintEntry({
    producer, name: name.slice(0, 255), ...kindOf(type), ...(type === 'nonalc' ? { abv: 0 } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(typeof b.grape === 'string' && b.grape.trim() ? { grapes: [b.grape.trim().slice(0, 64)] } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
  })
  const rest = Object.fromEntries(Object.entries(b).filter(([k]) => !IDENTITY_KEYS.includes(k) && (checkin || k !== 'country')))
  return { ...rest, ...pick(e) }
}
