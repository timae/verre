import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { scrub, cleanCountry, cleanUrl } from '@/lib/textSafe'
import { assertAbv } from '@/lib/catalogWrite'

// ── catalogEntries: THE catalogue read for display, and THE merge resolver ──
//
// 🔒 Merges never rewrite: a merge points one entry at another (`links_to`,
// status 'linked') and destroys nothing, so every read must FOLLOW the pointer
// before it shows or counts anything (catalogue model change § 8b). Forgetting
// it fails silently (the same wine twice on a profile, a name already merged
// away), so there is ONE resolver and every catalogue read goes through this
// module or lib/catalogSearch.ts (which uses `resolveEffectiveIds` from here).
// CI census: scripts/check-catalog-reads.mjs lists every statement outside the
// two that reads the catalogue tables.
//
// The line-up's `entry` key (lib/session.ts wineToWire), the snapshot a link
// writes (`snapshotFromEntry`), and a copied link ("had a sip",
// `linkableLink`) all come from here.

type Db = Prisma.TransactionClient | typeof prisma

// Reads resolve chains transitively with a VISITED SET and a DEPTH CAP, so
// corrupt data (a cycle that slipped past the write-side guards) fails safely
// instead of looping forever. `links_to <> id` and the `(status = 'linked') =
// (links_to IS NOT NULL)` CHECKs make a self-link or a pointerless tombstone
// impossible, but a longer cycle is not structurally excluded.
export const MERGE_DEPTH_CAP = 10

type MergeTable = 'producers' | 'wine_products' | 'wine_vintages'

// Each round follows one hop for every id still pointing somewhere; then each
// starting id walks to the end of its chain, bounded by the same cap. Ids that
// are not tombstones resolve to themselves. Callers run it ONLY when a row they
// hold is `linked` (anything else resolves to itself by the CHECK): the common
// read is one statement, not two.
export async function resolveEffectiveIds(table: MergeTable, ids: string[], db: Db = prisma): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  let frontier = [...new Set(ids)]
  const seen = new Set(frontier)
  const chain = new Map<string, string>()
  for (let depth = 0; depth < MERGE_DEPTH_CAP && frontier.length; depth++) {
    const rows = await db.$queryRawUnsafe<{ id: string; links_to: string | null }[]>(
      `SELECT id, links_to FROM ${table} WHERE id = ANY($1)`,
      frontier,
    )
    const next: string[] = []
    for (const r of rows) {
      if (!r.links_to) continue
      chain.set(r.id, r.links_to)
      if (!seen.has(r.links_to)) { seen.add(r.links_to); next.push(r.links_to) }
    }
    frontier = next
  }
  for (const id of ids) {
    let cur = id
    const walked = new Set([cur])
    for (let i = 0; i < MERGE_DEPTH_CAP; i++) {
      const nxt = chain.get(cur)
      if (!nxt || walked.has(nxt)) break
      walked.add(nxt)
      cur = nxt
    }
    out.set(id, cur)
  }
  return out
}

// What a bottle IS, as the catalogue says now (merges followed). `vintageId`
// null = a product-grain link (year unknown); set with `year: null` = the NV
// row. 🔒 Label identity throughout: a blind row replaces the whole object
// (lib/wineRedaction.ts), never field by field. `producer` is the lead
// producer's (effective) name: stored vs resolved producer counts are a
// separate contract (§ 8b) and nothing here exposes a count.
//
// ⚠️ After a PRODUCT merge the bottle's vintage stays a child of the merged-away
// product (RFC § Product × vintage merges compose), so (productId, vintageId)
// here is not always a linkable pair: a re-link goes through search, a copied
// link through `linkableLink`.
export type CatalogEntry = {
  productId: string
  vintageId: string | null
  producerId: string
  producer: string
  name: string
  year: number | null
  category: string
  colour: string | null
  sparkling: boolean
  style: string | null
  abv: number | null
  grapes: string[]
  region: string | null
  country: string | null
  description: string | null
  vinification: string | null
}

export type CatalogLink = { productId?: string | null; vintageId?: string | null }
export const entryKey = (productId: string, vintageId: string | null | undefined) => `${productId}|${vintageId ?? ''}`

type ProductRow = {
  id: string; name: string; category: string; style: string | null; colour: string | null; sparkling: boolean
  abv: Prisma.Decimal | null; grapes: string[]; region: string | null; country: string | null
  description: string | null; vinification: string | null; status: string
  producer_id: string; producer_name: string; producer_status: string
}
type VintageRow = { id: string; product_id: string; year: number | null; abv: Prisma.Decimal | null; grapes: string[]; grapes_override: boolean; status: string }
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))

const PRODUCT_COLS = `wp.id, wp.name, wp.category, wp.style, wp.colour, wp.sparkling, wp.abv, wp.grapes, wp.region, wp.country,
  wp.description, wp.vinification, wp.status, pr.id AS producer_id, pr.name AS producer_name, pr.status AS producer_status`
// 🔒 `scope = 'shared'` only: a future `owned` entry is not public catalogue
// data and must never render on a bottle (it reads as no entry: the snapshot).
const PRODUCT_FROM = `wine_products wp
  JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
  JOIN producers pr ON pr.id = pp.producer_id`
const SHARED = `wp.scope = 'shared'`

// The entries of these links, keyed by `entryKey` of the STORED link. A link
// whose product row is gone (a hard purge nulls the link; a cached guest
// bottle may still carry an id) is simply absent: the caller shows the
// snapshot. Statements: one when nothing is merged (products + lead producers
// + vintages), plus one per merged grain.
export async function loadEntries(links: CatalogLink[], db: Db = prisma): Promise<Map<string, CatalogEntry>> {
  const out = new Map<string, CatalogEntry>()
  const pairs = new Map<string, { p: string; v: string | null }>()
  for (const l of links) if (typeof l.productId === 'string' && l.productId) pairs.set(entryKey(l.productId, l.vintageId), { p: l.productId, v: typeof l.vintageId === 'string' && l.vintageId ? l.vintageId : null })
  if (!pairs.size) return out
  const pids = [...new Set([...pairs.values()].map(x => x.p))]
  const vids = [...new Set([...pairs.values()].map(x => x.v).filter((v): v is string => !!v))]
  const rows = await db.$queryRawUnsafe<(ProductRow & { kind: 'p' } | VintageRow & { kind: 'v' })[]>(
    `SELECT 'p' AS kind, ${PRODUCT_COLS}, NULL::text AS product_id, NULL::int AS year, false AS grapes_override
       FROM ${PRODUCT_FROM} WHERE wp.id = ANY($1) AND ${SHARED}
     UNION ALL
     SELECT 'v', v.id, NULL, NULL, NULL, NULL, false, v.abv, v.grapes, NULL, NULL, NULL, NULL, v.status, NULL, NULL, NULL,
            v.product_id, v.year, v.grapes_override
       FROM wine_vintages v WHERE v.id = ANY($2)`,
    pids, vids,
  )
  const products = new Map<string, ProductRow>()
  const vintages = new Map<string, VintageRow>()
  for (const r of rows) {
    if (r.kind === 'p') products.set(r.id, r as ProductRow)
    else vintages.set(r.id, r as VintageRow)
  }
  // Follow the merges, only where a row is a tombstone.
  const effProduct = await followMerges('wine_products', [...products.values()], products, db, async (ids) =>
    db.$queryRawUnsafe<ProductRow[]>(`SELECT ${PRODUCT_COLS} FROM ${PRODUCT_FROM} WHERE wp.id = ANY($1) AND ${SHARED}`, ids))
  const effVintage = await followMerges('wine_vintages', [...vintages.values()], vintages, db, async (ids) =>
    db.$queryRawUnsafe<VintageRow[]>(`SELECT id, product_id, year, abv, grapes, grapes_override, status FROM wine_vintages WHERE id = ANY($1)`, ids))
  const mergedProducers = [...new Set([...products.values()].filter(p => p.producer_status === 'linked').map(p => p.producer_id))]
  const effProducer = mergedProducers.length ? await resolveEffectiveIds('producers', mergedProducers, db) : new Map<string, string>()
  const producerNames = new Map<string, string>()
  if (effProducer.size) {
    for (const r of await db.$queryRawUnsafe<{ id: string; name: string }[]>(`SELECT id, name FROM producers WHERE id = ANY($1)`, [...new Set(effProducer.values())])) producerNames.set(r.id, r.name)
  }
  for (const [key, { p, v }] of pairs) {
    const product = products.get(effProduct.get(p) ?? p)
    if (!product) continue
    const vintage = v ? vintages.get(effVintage.get(v) ?? v) : undefined
    const producerId = effProducer.get(product.producer_id) ?? product.producer_id
    out.set(key, {
      productId: product.id,
      vintageId: vintage?.id ?? null,
      producerId,
      producer: producerNames.get(producerId) ?? product.producer_name,
      name: product.name,
      year: vintage ? vintage.year : null,
      category: product.category,
      colour: product.colour,
      sparkling: product.sparkling,
      style: product.style,
      abv: num(vintage?.abv ?? null) ?? num(product.abv),
      grapes: vintage?.grapes_override ? vintage.grapes : product.grapes,
      region: product.region,
      country: product.country,
      description: product.description,
      vinification: product.vinification,
    })
  }
  return out
}

// Tombstones among `held` → their survivors (fetched into `into`). Returns
// stored id → effective id for the tombstones only.
async function followMerges<T extends { id: string; status: string }>(
  table: MergeTable, held: T[], into: Map<string, T>, db: Db, fetch: (ids: string[]) => Promise<T[]>,
): Promise<Map<string, string>> {
  const tombstones = held.filter(r => r.status === 'linked').map(r => r.id)
  if (!tombstones.length) return new Map()
  const eff = await resolveEffectiveIds(table, tombstones, db)
  const missing = [...new Set(eff.values())].filter(id => !into.has(id))
  if (missing.length) for (const r of await fetch(missing)) into.set(r.id, r)
  return eff
}

// The snapshot a link writes on the occurrence (spec § 1: written at link time
// from the entry and its lead producer, never from the body's free text).
// `type` is the legacy token the cached line-up keeps until build step 9
// (derived from the PAIR only: a link always rewrites `style`, spec § 8a.0; the
// alcohol-free fact is the abv). Grape, region and the origin country are copied
// as display history (a purged entry still renders; the badges count grapes).
export type EntrySnapshot = {
  name: string; producer: string; vintage: string; type: string
  colour: string | null; sparkling: boolean; abv: number | null
  grape: string; region: string; country: string
}
export function snapshotFromEntry(e: CatalogEntry): EntrySnapshot {
  return {
    name: e.name,
    producer: e.producer,
    vintage: e.vintageId === null ? '' : e.year === null ? 'NV' : String(e.year),
    type: e.sparkling ? 'spark' : e.colour ?? '',
    colour: e.colour,
    sparkling: e.sparkling,
    abv: e.abv,
    grape: e.grapes.join(', ').slice(0, 255),
    region: e.region ?? '',
    country: e.country ?? '',
  }
}

// A stored link made LINKABLE for a new bottle ("had a sip" copies its
// source's link): the effective product, and the effective vintage when it is
// still that product's, else the product's own vintage of the same year, else
// product grain. null when nothing linkable is left (purged, or rejected).
export async function linkableLink(link: CatalogLink, db: Db = prisma): Promise<{ productId: string; vintageId: string | null } | null> {
  if (!link.productId) return null
  const productId = (await resolveEffectiveIds('wine_products', [link.productId], db)).get(link.productId)!
  const p = (await db.$queryRaw<{ status: string; scope: string }[]>`SELECT status, scope FROM wine_products WHERE id = ${productId}`)[0]
  if (!p || !LINKABLE.includes(p.status) || p.scope !== 'shared') return null
  if (!link.vintageId) return { productId, vintageId: null }
  const vintageId = (await resolveEffectiveIds('wine_vintages', [link.vintageId], db)).get(link.vintageId)!
  const v = (await db.$queryRaw<{ product_id: string; year: number | null; status: string }[]>`
    SELECT product_id, year, status FROM wine_vintages WHERE id = ${vintageId}`)[0]
  if (!v) return { productId, vintageId: null }
  if (v.product_id === productId && LINKABLE.includes(v.status)) return { productId, vintageId }
  const same = (await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM wine_vintages WHERE product_id = ${productId} AND year IS NOT DISTINCT FROM ${v.year}
       AND status = ANY(${LINKABLE}::text[])`)[0]
  return { productId, vintageId: same?.id ?? null }
}
const LINKABLE = ['provisional', 'confirmed', 'archived']

// The vintage lookup (both search routes, spec § 2): the vintages of this
// product, ids and years only, NV included. `productId` is resolved through
// merges first (a pick from an old list names the survivor's years). null =
// not a product anyone may link (unknown, rejected, not shared): the caller
// answers the generic denial. 🔒 The statuses a PICK accepts (`LINKABLE`:
// archived included), so the lookup and a pick never disagree about an id
// (security review r1: they did for an archived product, which told it).
// ⚠️ After a PRODUCT merge, a year that exists only under the merged-away
// product is not listed here (its vintages stay children of the tombstone, RFC
// § Product × vintage merges compose), so adding it again under the survivor
// mints a second row of that year: phase 3's merge screens decide whether the
// lookup should list the tombstones' years too.
export async function productVintages(productId: string, db: Db = prisma): Promise<{ id: string; year: number | null }[] | null> {
  const eff = (await resolveEffectiveIds('wine_products', [productId], db)).get(productId)!
  const p = (await db.$queryRaw<{ status: string; scope: string }[]>`SELECT status, scope FROM wine_products WHERE id = ${eff}`)[0]
  if (!p || !LINKABLE.includes(p.status) || p.scope !== 'shared') return null
  return db.$queryRaw<{ id: string; year: number | null }[]>`
    SELECT id, year FROM wine_vintages
     WHERE product_id = ${eff} AND status = ANY(${LINKABLE}::text[])
     ORDER BY year DESC NULLS FIRST, id`
}

// Is this `create` the caller's own retry on a bottle it already created this
// entry for (lib/catalogLink.ts applyRelink)? 🔒 True only when the mint would
// produce EXACTLY what the bottle already carries: the current product (and a
// new producer) minted by `userId`, and every field the body can set equal to
// what is stored, compared after the mint's own normalisation (lib/catalogWrite
// `createProducer` / `createProduct` / `createVintage`, lib/catalogAddFlow): the
// product's name, category, style, colour, sparkling, grapes, region, origin;
// the producer (its id, or a new one's name, country, region, website); the
// collaborators; the year or its absence; the vintage's grapes override; the
// abv where the mint puts it (the vintage's when a year is given, else the
// product's). A body the mint would REFUSE is never a replay (the mint gives
// its 400). Review r2: names + year only swallowed a correction (red → white);
// Codex r1: leaving the vintage grapes / collaborators / a website unmodelled
// made an identical retry of such a create mint twice. (On a bottle hidden
// from the caller a create is refused before this runs: the replay answer
// would tell which hidden bottle is which wine.) A branch-2 body (`productId`
// + year) is never a replay here: it links an existing vintage idempotently.
export async function isReplayedCreate(
  db: Db, current: CatalogLink, body: Record<string, unknown>, userId: number,
): Promise<boolean> {
  if (!current.productId || body.productId !== undefined) return false
  if (body.producerId !== undefined && (typeof body.producerId !== 'string' || !body.producerId)) return false
  const product = body.product
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false
  const pf = product as Record<string, unknown>
  if (pf.abv !== undefined) return false   // the mint refuses an abv inside product
  // A body the mint would refuse is never a replay (Codex r2: 25.001 rounded
  // to a stored 25 answered 200 where the mint answers 400).
  try { assertAbv(body.abv) } catch { return false }
  const txt = (v: unknown) => (typeof v === 'string' ? (scrub(v) ?? '').trim() : '')
  const opt = (v: unknown, max = 255) => txt(v).slice(0, max) || null
  const code = (v: unknown) => cleanCountry(txt(v).slice(0, 64)) || null
  const grapes = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(g => txt(g).slice(0, 64)).filter(Boolean))].slice(0, 24) : [])
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v) * 100) / 100)
  const category = typeof pf.category === 'string' ? (pf.category.trim() || 'wine') : 'wine'
  // The kind as the mint stores it, or undefined where the mint would refuse.
  const colour = pf.colour === undefined || pf.colour === null ? null : ['red', 'white', 'rose'].includes(pf.colour as string) ? pf.colour as string : undefined
  const sparkling = pf.sparkling === undefined ? false : typeof pf.sparkling === 'boolean' ? pf.sparkling : undefined
  const style = pf.style === undefined || pf.style === null ? null
    : typeof pf.style !== 'string' ? undefined
    : category !== 'wine' ? opt(pf.style, 64)
    : ['dessert', 'fortified'].includes(pf.style) ? pf.style : undefined
  if (colour === undefined || sparkling === undefined || style === undefined) return false
  if (category === 'wine' && colour === null && !sparkling) return false   // the type is required
  const collaborators = body.collaboratorIds === undefined ? [] : body.collaboratorIds
  if (!Array.isArray(collaborators) || collaborators.some(c => typeof c !== 'string' || !c)) return false
  const row = (await db.$queryRaw<{
    name: string; added_by: number | null; category: string; colour: string | null; sparkling: boolean; style: string | null; grapes: string[]
    region: string | null; country: string | null; abv: Prisma.Decimal | null
    producer_id: string; producer_name: string; producer_added_by: number | null; producer_country: string | null; producer_region: string | null
    producer_website: string | null; collaborators: string[]
  }[]>`
    SELECT wp.name, wp.added_by, wp.category, wp.colour, wp.sparkling, wp.style, wp.grapes, wp.region, wp.country, wp.abv,
           pr.id AS producer_id, pr.name AS producer_name, pr.added_by AS producer_added_by, pr.country AS producer_country,
           pr.region AS producer_region, pr.website AS producer_website,
           ARRAY(SELECT c.producer_id FROM product_producers c WHERE c.product_id = wp.id AND c.role = 'collaborator' ORDER BY c.producer_id) AS collaborators
      FROM wine_products wp
      JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
      JOIN producers pr ON pr.id = pp.producer_id
     WHERE wp.id = ${current.productId}`)[0]
  if (!row || row.added_by !== userId) return false
  if (txt(pf.name) !== row.name || category !== row.category || colour !== row.colour || sparkling !== row.sparkling
    || style !== row.style || grapes(pf.grapes).join('\u0000') !== row.grapes.join('\u0000')
    || opt(pf.region) !== row.region || code(pf.country) !== row.country) return false
  if (typeof body.producerId === 'string') { if (body.producerId !== row.producer_id) return false }
  else {
    const p = body.producer
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false
    const pp = p as Record<string, unknown>
    if (row.producer_added_by !== userId || txt(pp.name) !== row.producer_name || code(pp.country) !== row.producer_country
      || opt(pp.region) !== row.producer_region || (cleanUrl(pp.website).slice(0, 512) || null) !== row.producer_website) return false
  }
  const wantCollab = [...new Set(collaborators as string[])].filter(c => c !== row.producer_id).sort()
  if (wantCollab.join('\u0000') !== row.collaborators.join('\u0000')) return false
  const abv = num(body.abv)
  const hasVg = body.vintageGrapes !== undefined
  if (!('year' in body)) return !hasVg && !current.vintageId && abv === (row.abv === null ? null : Number(row.abv))
  if (!current.vintageId || row.abv !== null) return false
  if (hasVg && (!Array.isArray(body.vintageGrapes) || body.vintageGrapes.some(g => typeof g !== 'string' || !txt(g)))) return false
  const vg = hasVg ? [...new Set((body.vintageGrapes as string[]).map(g => txt(g).slice(0, 64)))] : []
  if (vg.length > 24) return false
  const v = (await db.$queryRaw<{ year: number | null; abv: Prisma.Decimal | null; grapes: string[]; grapes_override: boolean }[]>`
    SELECT year, abv, grapes, grapes_override FROM wine_vintages WHERE id = ${current.vintageId}`)[0]
  return !!v && v.year === (body.year ?? null) && abv === (v.abv === null ? null : Number(v.abv))
    && v.grapes_override === hasVg && v.grapes.join('\u0000') === vg.join('\u0000')
}
