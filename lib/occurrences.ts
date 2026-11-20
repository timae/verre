import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import { sessionLockKey, LockLost } from '@/lib/sessionLock'
import { nanoid } from 'nanoid'
import { ContractNeedsLease, type Fence, type MutationCtx } from '@/lib/sessionMutation'
import type { WineMeta } from '@/lib/session'
import { loadEntries, entryKey, type EntrySnapshot } from '@/lib/catalogEntries'

// Occurrence persistence (docs/dev/proposals/wine-catalog-model-change.md § 8a;
// build step 3). In a Postgres-backed moment the RECORD decides every bottle
// write: the occurrence rows are read FOR UPDATE under the contract's locks,
// written, and `sessions.lineup_revision` is bumped in the same transaction
// (the contract's row lock, `bumpLineup`); after COMMIT the cached line-up is
// a projection FROM THE RECORD, stamped with that revision in the sibling key
// `s:{C}:wrev` (projectLineup). A failed Postgres write fails the request.
// Redis-only moments keep `mutateWines` as their authority (no record, no
// revision).
//
// 🔒 NULL revision = NOT RECONCILED (review r1 B3). Every moment promoted before
// this release starts NULL, and its cache may hold a bottle whose old
// best-effort mirror failed (cache-only) or lack one whose DELETE mirror failed
// (record-only). The first contract that meets NULL reconciles both ways
// (reconcileLineup), then stamps 1. Only a non-NULL revision may REPLACE a
// cache from the record.
//
// 🔒 The cached line-up keeps the OLD shape until the contract step (§ 8a.0,
// review r2): an old instance's rate / bookmark POST mirrors the whole cached
// array into the record strictly during the rollout. The projection is
// recordLineup's WineMeta, nothing more: no colour / sparkling / abv / origin
// in the blob (the backfill re-run rewrites those without bumping, step 3's
// "non-bumping writer": a blob that never carries them cannot disagree with
// the record at an equal revision). `type` IS the stored `style`.
//
// Every write keeps three properties the old mirror relies on, or its next
// pass over a new-projected blob would rewrite rows (scripts/tests
// occurrence-persistence.mts § 7): empty strings stored as NULL (its `cut`),
// `revealed_at` at millisecond precision (a JS Date, never NOW()), positions
// contiguous 0..n-1 (it writes the array index).

type Db = Prisma.TransactionClient | typeof prisma

// A client-minted occurrence id (nanoid shape). Legacy ids (13-digit
// timestamps) stay readable; only this shape can be created.
const CLIENT_ID = /^[A-Za-z0-9_-]{21}$/
export const isClientOccurrenceId = (v: unknown): v is string => typeof v === 'string' && CLIENT_ID.test(v)

// The snapshot a style token derives to (spec § 1 field table; the SAME rule as
// the expand migration's `snapshot` backfill step): red / white / rose → that
// colour; spark → sparkling, colour unknown; nonalc and anything else →
// neither. abv: nonalc → 0 (what the alcohol-free choice meant, § 0.2).
export function snapshotOf(style: string | null | undefined): { colour: string | null; sparkling: boolean } {
  return { colour: style === 'red' || style === 'white' || style === 'rose' ? style : null, sparkling: style === 'spark' }
}

// SQL of the same rule, for statements that set `style`: the pair is rewritten
// only when it no longer derives to the new token (so a pair the token cannot
// express, a sparkling rosé from a catalogue link, survives an unrelated edit).
// `w` is the row being updated, `style` the new token expression.
function snapshotSets(style: Prisma.Sql): Prisma.Sql {
  const derivesTo = Prisma.sql`(CASE WHEN w.sparkling THEN 'spark' WHEN w.colour IN ('red', 'white', 'rose') THEN w.colour END)
    IS NOT DISTINCT FROM (CASE WHEN ${style} IN ('red', 'white', 'rose', 'spark') THEN ${style} END)`
  return Prisma.sql`
    colour = CASE WHEN ${derivesTo} THEN w.colour ELSE (CASE WHEN ${style} IN ('red', 'white', 'rose') THEN ${style} END) END,
    sparkling = CASE WHEN ${derivesTo} THEN w.sparkling ELSE (${style} IS NOT DISTINCT FROM 'spark') END,
    abv = CASE WHEN w.abv IS NULL AND ${style} IS NOT DISTINCT FROM 'nonalc' THEN 0 ELSE w.abv END`
}

const cut = (v: string | undefined | null, n: number) => (v ? v.slice(0, n) : null)
const revealedDate = (v: string | null | undefined) => (v ? new Date(v) : null)

// ── Reading the record ──────────────────────────────────────────────────────

type WineRow = {
  id: string; name: string; producer: string | null; vintage: string | null; grape: string | null; style: string | null
  image_url: string | null; description: string | null; region: string | null; country: string | null
  vinification: string | null; purchase_url: string | null; revealed_at: Date | null
  added_by_identity_id: string | null; added_by_display_name: string | null; product_id: string | null; vintage_id: string | null
}

function toMeta(w: WineRow): WineMeta {
  const out: WineMeta = {
    id: w.id, name: w.name, producer: w.producer ?? '', vintage: (w.vintage ?? '').trim(), grape: w.grape ?? '',
    type: w.style ?? '', image: '', imageUrl: w.image_url ?? '',
    revealedAt: w.revealed_at ? w.revealed_at.toISOString() : null,
    productId: w.product_id, vintageId: w.vintage_id,
  }
  if (w.description) out.description = w.description
  if (w.region) out.region = w.region
  if (w.country) out.country = w.country
  if (w.vinification) out.vinification = w.vinification
  if (w.purchase_url) out.purchaseUrl = w.purchase_url
  if (w.added_by_identity_id) out.addedByIdentityId = w.added_by_identity_id
  if (w.added_by_display_name) out.addedByDisplayName = w.added_by_display_name
  return out
}

const WINE_COLUMNS = Prisma.sql`id, name, producer, vintage, grape, style, image_url, description, region, country, vinification,
  purchase_url, revealed_at, added_by_identity_id, added_by_display_name, product_id, vintage_id`

// The record's line-up, in pour order — the ONE projection (rebuild, refresh,
// every writer's echo and cache write).
export async function recordLineup(db: Db, sessionId: number): Promise<WineMeta[]> {
  const rows = await db.$queryRaw<WineRow[]>`
    SELECT ${WINE_COLUMNS} FROM wines WHERE session_id = ${sessionId} ORDER BY position NULLS LAST, created_at, id`
  return rows.map(toMeta)
}

// One occurrence of this moment, locked for the writer's decision; null when it
// is not (or no longer) part of the moment.
export async function lockOccurrence(tx: Prisma.TransactionClient, sessionId: number, id: string): Promise<WineMeta | null> {
  const rows = await tx.$queryRaw<WineRow[]>`
    SELECT ${WINE_COLUMNS} FROM wines WHERE id = ${id} AND session_id = ${sessionId} FOR UPDATE`
  return rows[0] ? toMeta(rows[0]) : null
}

// The record's SNAPSHOT kind and abv of these bottles of a live moment (the
// line-up wire, Codex r1): the cached line-up never carries them (its old shape,
// § 8a.0), and its `type` cannot say a sparkling rosé or an abv, so a bottle
// whose entry is gone (purged) would lose its alcohol-free mark. One primary-
// key read; an empty map for a Redis-only moment (no record: the token decides).
// 🔒 Read AFTER the line-up it decorates, so it carries the row's LINK and its
// REVEAL STATE too: the caller uses a snapshot only while both equal the served
// row's (Codex r2, r3). A host hiding a bottle between the line-up read and
// this one (and re-linking it, or re-picking the same wine, which refreshes its
// snapshot from the entry) would otherwise decorate a row served as revealed
// with what is now hidden. The snapshot CAN change under an unchanged link (a
// re-pick refreshes it; copyLineup and the backfill re-derive the pair), but
// then it still describes the wine the served row names; a changed reveal
// state is what would turn it into hidden information, and that drops it.
export type BottleSnapshot = { colour: string | null; sparkling: boolean; abv: number | null; productId: string | null; vintageId: string | null; revealedAt: string | null }
export async function readSnapshots(code: string, ids: string[]): Promise<Map<string, BottleSnapshot>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ id: string; colour: string | null; sparkling: boolean; abv: Prisma.Decimal | null; product_id: string | null; vintage_id: string | null; revealed_at: Date | null }[]>`
    SELECT w.id, w.colour, w.sparkling, w.abv, w.product_id, w.vintage_id, w.revealed_at FROM wines w
      JOIN sessions s ON s.id = w.session_id AND s.code = ${code} AND s.deleted_at IS NULL
     WHERE w.id = ANY(${ids}::text[])`
  return new Map(rows.map(r => [r.id, {
    colour: r.colour, sparkling: r.sparkling, abv: r.abv === null ? null : Number(r.abv),
    productId: r.product_id, vintageId: r.vintage_id, revealedAt: r.revealed_at ? r.revealed_at.toISOString() : null,
  }]))
}

// The snapshot of THIS served bottle, or undefined (no record, or the record's
// link or reveal state moved since the served line-up was read: the row then
// falls back to its cached token and its entry, as it was served).
export function snapshotFor(w: WineMeta, snapshots: Map<string, BottleSnapshot>): BottleSnapshot | undefined {
  const s = snapshots.get(w.id)
  return s && s.productId === (w.productId ?? null) && s.vintageId === (w.vintageId ?? null) && s.revealedAt === (w.revealedAt ?? null) ? s : undefined
}

// One bottle of a live moment by code, unlocked (a route's early check when its
// cached line-up lacks it: a cache behind the record must not 404 it).
export async function readOccurrence(code: string, id: string): Promise<WineMeta | null> {
  const rows = await prisma.$queryRaw<WineRow[]>`
    SELECT ${Prisma.raw('w.id, w.name, w.producer, w.vintage, w.grape, w.style, w.image_url, w.description, w.region, w.country, w.vinification, w.purchase_url, w.revealed_at, w.added_by_identity_id, w.added_by_display_name, w.product_id, w.vintage_id')}
      FROM wines w JOIN sessions s ON s.id = w.session_id AND s.code = ${code} AND s.deleted_at IS NULL
     WHERE w.id = ${id}`
  return rows[0] ? toMeta(rows[0]) : null
}

// ── Reconciliation (NULL = not reconciled) ──────────────────────────────────

// Inside a contract (`ctx.row` read FOR UPDATE under the advisory lock): when
// the revision is NULL, reconcile the record with a PRESENT cache both ways —
// record rows of this moment the cache does not list are ORPHANED first
// (`session_id = NULL`, ratings kept: a DELETE whose mirror failed left them;
// `origin` keeps them session occurrences), then the cached bottles are copied
// in strictly (copyCachedLineup) — then stamp 1. With no usable cache, stamp 1
// from the record. Mutates `ctx.row.lineupRevision`. What follows COMMIT rides
// on `ctx.after` and the contract runs it (lib/sessionMutation.ts): the
// orphaned rows' photos under the D8 predicate (no rating, no bookmark, no live
// row, no rating image uses the URL), and the rating keys of re-minted ids.
// Needs no Redis lease to READ the cache (every lineup writer holds the
// advisory lock this runs under), but re-minted ids need one to move their
// rating keys: without a lease it throws ContractNeedsLease (the contract
// re-runs once with the lock). `defer` (the rebuild, which publishes before its
// COMMIT): with ids KNOWN to need a re-mint, leave the moment unreconciled for
// the next read (an id lost to a race during the copy is still re-minted).
export async function reconcileLineup(
  tx: Prisma.TransactionClient, ctx: MutationCtx, { defer = false }: { defer?: boolean } = {},
): Promise<number | null> {
  const row = ctx.row!
  if (row.lineupRevision !== null) return row.lineupRevision
  const prep = await prepareCachedLineup(tx, row.id, await redis.get(k.wines(row.code)))
  if (prep !== null) {
    const { clean, renames } = prep
    if (renames.size && (defer || !ctx.fence)) {
      if (defer) return null
      throw new ContractNeedsLease(row.code)
    }
    const orphaned = await tx.$queryRaw<{ image_url: string | null }[]>`
      UPDATE wines SET session_id = NULL
       WHERE session_id = ${row.id} AND NOT (id = ANY(${clean.map(w => w.id)}::text[]))
      RETURNING image_url`
    const urls = orphaned.map(o => o.image_url).filter((u): u is string => !!u)
    if (urls.length) {
      ctx.after.reclaim.push(...(await tx.$queryRaw<{ u: string }[]>`
        SELECT u FROM unnest(${urls}::text[]) AS u
         WHERE NOT EXISTS (SELECT 1 FROM wines w WHERE w.image_url = u
                             AND (w.session_id IS NOT NULL
                                  OR EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id)
                                  OR EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = w.id)
                                  OR EXISTS (SELECT 1 FROM blind_saves bs WHERE bs.wine_id = w.id)))
           AND NOT EXISTS (SELECT 1 FROM rating_images ri WHERE ri.image_url = u)`).map(r => r.u))
    }
    await copyCachedLineup(tx, ctx, row.id, prep)
  }
  await renumber(tx, row.id)
  await tx.$executeRaw`UPDATE sessions SET lineup_revision = 1 WHERE id = ${row.id}`
  row.lineupRevision = 1
  return 1
}

// A cached line-up made ready for the record (reconciliation and promotion):
// parsed tolerantly (null = unusable), cleaned of what the record's
// constraints would refuse, and its foreign ids given fresh ones.
export async function prepareCachedLineup(tx: Prisma.TransactionClient, sessionId: number, raw: string | null): Promise<{ clean: WineMeta[]; renames: Map<string, string> } | null> {
  const cached = parseLineup(raw)
  if (cached === null) return null
  const clean = await sanitizeForRecord(tx, cached)
  return { clean, renames: await foreignIds(tx, sessionId, clean.map(w => w.id)) }
}

// The prepared line-up copied in strictly (copyLineup) under its new ids, then
// VERIFIED: every listed bottle must now be a row of this moment (recheck r2: a
// check-in claiming a cached id can commit between the id check and the copy;
// it takes no session lock). A bottle that lost that race is re-minted again,
// up to three rounds, else the request fails (never a silent drop). The rating
// keys of re-minted ids are COPIED to the new id now, fenced (the lease holds
// until after COMMIT), and the old keys deleted after COMMIT (ctx.after): a
// failure on either side loses no rating. What it can leave (named, review r3,
// r4): a rolled-back copy (a failed COMMIT, or a contract that re-mints and then
// refuses, e.g. a rate addressed to the old id: 404, until the next read
// reconciles), or an old key whose delete failed, under a bottle id the line-up
// lacks; the ratings read lists it, the clients show ratings per listed bottle
// only, and it lives as long as the moment's keys do. The record's own session
// ratings on a moved id (an old rate POST that rated a foreign row through a
// skipped mirror) move with the bottle; a BOOKMARK made that way stays on the
// foreign row (it has no moment column to attribute it by: named residual).
export async function copyCachedLineup(tx: Prisma.TransactionClient, ctx: MutationCtx, sessionId: number, { clean, renames }: { clean: WineMeta[]; renames: Map<string, string> }): Promise<void> {
  const ids = new Map(clean.map(w => [w.id, renames.get(w.id) ?? w.id]))
  for (let round = 0; ; round++) {
    await copyLineup(tx, sessionId, clean.map(w => ({ ...w, id: ids.get(w.id)! })))
    const want = [...ids.values()]
    const landed = new Set((await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM wines WHERE id = ANY(${want}::text[]) AND session_id = ${sessionId}`).map(r => r.id))
    const lost = [...ids].filter(([, id]) => !landed.has(id))
    if (lost.length === 0) break
    // A re-mint needs the lease (its rating keys move): re-run with the lock.
    if (!ctx.fence) throw new ContractNeedsLease(ctx.code)
    if (round === 2) throw new Error(`${ctx.code}: ${lost.length} cached bottle(s) could not be copied in (an id taken meanwhile)`)
    for (const [orig] of lost) ids.set(orig, nanoid())
  }
  const moved = [...ids].filter(([orig, id]) => orig !== id)
  for (const [orig, id] of moved) {
    await tx.$executeRaw`UPDATE ratings SET wine_id = ${id} WHERE session_id = ${sessionId} AND wine_id = ${orig}`
  }
  if (moved.length && ctx.fence) ctx.after.dropKeys.push(...await copyRatingKeys(ctx.fence, moved))
}

// The cached ids the record holds for ANOTHER row (another moment's bottle, a
// check-in, an orphan): copying them would silently drop the bottle (the copy
// never re-attaches a foreign row), so each gets a fresh id (security review
// r1: a taster could claim a guest moment's ids in the record first and make
// its bottles vanish at promotion). old → new.
export async function foreignIds(tx: Prisma.TransactionClient, sessionId: number, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM wines WHERE id = ANY(${ids}::text[]) AND session_id IS DISTINCT FROM ${sessionId}`
  return new Map(rows.map(r => [r.id, nanoid()]))
}

// A cached blob, tolerant of an old or damaged shape (review r1: a value the
// strict copy cannot write would make the moment fail on every request): not a
// JSON array → null (unusable: nothing is orphaned or copied from it); entries
// without a usable id or name dropped; a duplicate id keeps its first entry;
// missing optional keys read as absent, a missing `type` as no style.
export function parseLineup(raw: string | null): WineMeta[] | null {
  if (raw === null) return null
  let list: unknown
  try { list = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(list)) return null
  const seen = new Set<string>()
  const out: WineMeta[] = []
  for (const w of list as Partial<WineMeta>[]) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,21}$/.test(w.id)) continue
    if (typeof w.name !== 'string' || !w.name.replace(/\u0000/g, '').trim() || seen.has(w.id)) continue
    seen.add(w.id)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    out.push({
      ...w, id: w.id, name: w.name, producer: str(w.producer), vintage: str(w.vintage), grape: str(w.grape),
      type: str(w.type), image: str(w.image), imageUrl: str(w.imageUrl),
    })
  }
  return out
}

const STYLES = new Set(['red', 'white', 'spark', 'rose', 'nonalc'])
// The CHECK's own arms: `u:` digits, `a:` / `d:` + a uuid in either case.
const IDENTITY = /^(u:[0-9]+|[ad]:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

// What the record's constraints would refuse in a cached bottle, made
// writable rather than fatal: an unknown style token → no style; an adder id
// the identity CHECK refuses → no adder (the display name kept); an unparseable
// reveal time → hidden; a catalogue link whose product is gone → unlinked, a
// vintage of another product → product grain.
async function sanitizeForRecord(tx: Prisma.TransactionClient, wines: WineMeta[]): Promise<WineMeta[]> {
  const idLike = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,21}$/.test(v)
  const pids = [...new Set(wines.map(w => w.productId).filter(idLike))]
  const vids = [...new Set(wines.map(w => w.vintageId).filter(idLike))]
  const products = new Set(pids.length ? (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wine_products WHERE id = ANY(${pids}::text[])`).map(r => r.id) : [])
  const vintages = new Map(vids.length ? (await tx.$queryRaw<{ id: string; product_id: string }[]>`SELECT id, product_id FROM wine_vintages WHERE id = ANY(${vids}::text[])`).map(r => [r.id, r.product_id]) : [])
  return wines.map((w) => {
    const productId = typeof w.productId === 'string' && products.has(w.productId) ? w.productId : null
    const vintageId = productId && typeof w.vintageId === 'string' && vintages.get(w.vintageId) === productId ? w.vintageId : null
    const revealedAt = typeof w.revealedAt === 'string' && !Number.isNaN(Date.parse(w.revealedAt)) ? w.revealedAt : null
    const addedByIdentityId = typeof w.addedByIdentityId === 'string' && IDENTITY.test(w.addedByIdentityId) ? w.addedByIdentityId : undefined
    // Text the columns can hold: a string (else absent), without NUL bytes.
    const txt = (v: unknown) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : undefined)
    return {
      ...w, name: txt(w.name)!, producer: txt(w.producer) ?? '', vintage: txt(w.vintage) ?? '', grape: txt(w.grape) ?? '',
      imageUrl: txt(w.imageUrl) ?? '', description: txt(w.description), region: txt(w.region), country: txt(w.country),
      vinification: txt(w.vinification), purchaseUrl: txt(w.purchaseUrl), addedByDisplayName: txt(w.addedByDisplayName),
      type: STYLES.has(w.type) ? w.type : '', productId, vintageId, revealedAt, addedByIdentityId,
    }
  })
}

// The strict whole-array copy (reconciliation and promotion): every listed
// bottle inserted if missing (provenance on insert only, a `u:` adder whose
// users row is gone written as no adder + '[deleted]'), the content of the rest
// taken from the array, positions = array index. The update arm skips a row of
// another moment (an orphaned or foreign id is never re-attached) and a row that
// would not change. Clamped to the column widths like the old mirror, so one
// over-long field never fails the whole copy.
export async function copyLineup(tx: Prisma.TransactionClient, sessionId: number, wines: WineMeta[]): Promise<void> {
  if (wines.length === 0) return
  const adderIds = [...new Set(wines.map(w => w.addedByIdentityId).filter((id): id is string => !!id && /^u:\d{1,18}$/.test(id)).map(id => Number(id.slice(2))))]
  const liveAdders = new Set<string>()
  if (adderIds.length > 0) {
    const live = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${adderIds}::bigint[]) FOR KEY SHARE`
    for (const r of live) liveAdders.add(`u:${r.id}`)
  }
  const provenance = (w: WineMeta): [string | null, string | null] =>
    w.addedByIdentityId?.startsWith('u:') && !liveAdders.has(w.addedByIdentityId)
      ? [null, '[deleted]']
      : [w.addedByIdentityId ?? null, w.addedByDisplayName?.slice(0, 64) ?? null]
  // A linked bottle's pair and abv come from its entry (a guest moment's picks
  // reach the record here, at promotion): the cached `type` cannot say a
  // sparkling rosé or an abv. 🔒 The entry's pair is taken only while it still
  // DERIVES to the cached token (race review r1: an entry changed between the
  // pick and the promotion must not leave `style` white beside sparkling true;
  // every statement that sets `style` keeps the pair derived from it). Written
  // on INSERT only; an existing row keeps its pair unless the token no longer
  // derives to it (snapshotSets).
  const entries = await loadEntries(wines, tx)
  const rows = wines.map((w, i) => {
    const style = cut(w.type, 64)
    const e = w.productId ? entries.get(entryKey(w.productId, w.vintageId)) : undefined
    const derives = (c: string | null, sp: boolean) => (sp ? 'spark' : c) === (style === 'red' || style === 'white' || style === 'rose' || style === 'spark' ? style : null)
    const snap = e && derives(e.colour, e.sparkling) ? { colour: e.colour, sparkling: e.sparkling } : snapshotOf(style)
    const abv = e ? e.abv : style === 'nonalc' ? 0 : null
    return Prisma.sql`(
      ${w.id}, ${sessionId}, 'session', ${w.name.slice(0, 255)}, ${cut(w.producer, 255)}, ${cut(w.vintage, 4)}, ${cut(w.grape, 255)},
      ${style}, ${snap.colour}, ${snap.sparkling}, ${abv}::numeric,
      ${w.imageUrl || null}, ${cut(w.description, 1000)}, ${cut(w.region, 255)},
      ${cut(w.country, 2)}, ${cut(w.vinification, 1000)}, ${cut(w.purchaseUrl, 1000)},
      ${revealedDate(w.revealedAt)}::timestamptz, ${provenance(w)[0]}, ${provenance(w)[1]},
      ${w.productId || null}, ${w.vintageId || null}, ${i}::int)`
  })
  await tx.$executeRaw`
    INSERT INTO wines AS w (id, session_id, origin, name, producer, vintage, grape, style, colour, sparkling, abv, image_url, description,
                       region, country, vinification, purchase_url, revealed_at, added_by_identity_id,
                       added_by_display_name, product_id, vintage_id, position)
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, producer = EXCLUDED.producer, vintage = EXCLUDED.vintage,
      grape = EXCLUDED.grape, style = EXCLUDED.style, ${snapshotSets(Prisma.sql`EXCLUDED.style`)},
      image_url = EXCLUDED.image_url, description = EXCLUDED.description, region = EXCLUDED.region, country = EXCLUDED.country,
      vinification = EXCLUDED.vinification, purchase_url = EXCLUDED.purchase_url,
      revealed_at = EXCLUDED.revealed_at, product_id = EXCLUDED.product_id,
      vintage_id = EXCLUDED.vintage_id, position = EXCLUDED.position
    WHERE w.session_id = EXCLUDED.session_id
      AND (w.name, w.producer, w.vintage, w.grape, w.style, w.image_url,
           w.description, w.region, w.country, w.vinification, w.purchase_url,
           w.revealed_at, w.product_id, w.vintage_id, w.position)
          IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.producer, EXCLUDED.vintage, EXCLUDED.grape, EXCLUDED.style,
           EXCLUDED.image_url, EXCLUDED.description, EXCLUDED.region, EXCLUDED.country,
           EXCLUDED.vinification, EXCLUDED.purchase_url, EXCLUDED.revealed_at, EXCLUDED.product_id,
           EXCLUDED.vintage_id, EXCLUDED.position)`
}

// Positions contiguous 0..n-1 in pour order (NULLs last, then by creation),
// touching only rows whose position moves.
export async function renumber(tx: Prisma.TransactionClient, sessionId: number): Promise<void> {
  await tx.$executeRaw`
    UPDATE wines w SET position = (o.rank - 1)::int
      FROM (SELECT id, row_number() OVER (ORDER BY position NULLS LAST, created_at, id) AS rank
              FROM wines WHERE session_id = ${sessionId}) o
     WHERE w.id = o.id AND w.position IS DISTINCT FROM (o.rank - 1)::int`
}

// A revision bump outside a contract's row read (a writer that may or may not
// touch the line-up: the ban-wipe, account deletion, the operator scripts).
// Leaves NULL as NULL: a writer that cannot reconcile never marks a moment
// reconciled. Returns the new revision (null when NULL or no row).
export async function bumpLineupRevision(tx: Prisma.TransactionClient, sessionId: number): Promise<number | null> {
  const rows = await tx.$queryRaw<{ lineup_revision: number | null }[]>`
    UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${sessionId} RETURNING lineup_revision`
  return rows[0]?.lineup_revision ?? null
}

// ── The record-first writes ─────────────────────────────────────────────────

// Create: INSERT-only, never an upsert (spec § 8a "Create is INSERT-only"). On
// conflict the existing row is returned to the caller's decision: 'mine' when
// it is this moment's and this adder's (a retry), 'conflict' otherwise (409).
// `at` = the 0-based slot for a host's one-shot position (shifting the rest),
// else appended. Provenance: a `u:` adder whose users row is gone (an account
// deletion committed meanwhile) is written as no adder + '[deleted]'.
export async function insertOccurrence(
  tx: Prisma.TransactionClient, sessionId: number, w: WineMeta, at: number | null, entry?: EntrySnapshot,
): Promise<'inserted' | 'mine' | 'conflict'> {
  let adder = w.addedByIdentityId ?? null, adderName = w.addedByDisplayName?.slice(0, 64) ?? null
  if (adder && /^u:\d{1,18}$/.test(adder)) {
    const live = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${Number(adder.slice(2))} FOR KEY SHARE`
    if (!live[0]) { adder = null; adderName = '[deleted]' }
  }
  const style = cut(w.type, 64)
  // A link's snapshot carries the entry's own pair and abv (a sparkling rosé,
  // 13.5 %); without one (legacy shapes) they derive from the token.
  const snap = entry ? { colour: entry.colour, sparkling: entry.sparkling } : snapshotOf(style)
  const abv = entry ? entry.abv : style === 'nonalc' ? 0 : null
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO wines (id, session_id, origin, name, producer, vintage, grape, style, colour, sparkling, abv, image_url, description,
                       region, country, vinification, purchase_url, revealed_at, added_by_identity_id,
                       added_by_display_name, product_id, vintage_id, position)
    VALUES (${w.id}, ${sessionId}, 'session', ${w.name.slice(0, 255)}, ${cut(w.producer, 255)}, ${cut(w.vintage, 4)}, ${cut(w.grape, 255)},
            ${style}, ${snap.colour}, ${snap.sparkling}, ${abv}::numeric,
            ${w.imageUrl || null}, ${cut(w.description, 1000)}, ${cut(w.region, 255)},
            ${cut(w.country, 2)}, ${cut(w.vinification, 1000)}, ${cut(w.purchaseUrl, 1000)},
            ${revealedDate(w.revealedAt)}::timestamptz, ${adder}, ${adderName}, ${w.productId || null}, ${w.vintageId || null}, NULL)
    ON CONFLICT (id) DO NOTHING
    RETURNING id`
  if (!inserted[0]) {
    const existing = await tx.$queryRaw<{ session_id: number | null; added_by_identity_id: string | null }[]>`
      SELECT session_id, added_by_identity_id FROM wines WHERE id = ${w.id}`
    const e = existing[0]
    return e && e.session_id === sessionId && !!w.addedByIdentityId && e.added_by_identity_id === w.addedByIdentityId ? 'mine' : 'conflict'
  }
  // Appended: NULL sorts last (then by creation), so renumbering gives it n.
  // A host's slot: the rest from that slot move down by one first.
  if (at !== null) {
    await tx.$executeRaw`UPDATE wines SET position = position + 1 WHERE session_id = ${sessionId} AND position >= ${at}::int AND id <> ${w.id}`
    await tx.$executeRaw`UPDATE wines SET position = ${at}::int WHERE id = ${w.id}`
  }
  await renumber(tx, sessionId)
  return 'inserted'
}

// A RE-LINK (catalogue model change step 4): the link and the WHOLE snapshot
// from the new entry in one statement (spec § 8a.0: a link always rewrites
// `style` from the entry's pair; the pair and the abv are the entry's own).
// Provenance, reveal state, the photo and the bottle's own notes are never
// written here.
export async function relinkOccurrence(
  tx: Prisma.TransactionClient, sessionId: number | null, id: string,
  link: { productId: string; vintageId: string | null }, s: EntrySnapshot,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE wines SET name = ${s.name.slice(0, 255)}, producer = ${cut(s.producer, 255)}, vintage = ${cut(s.vintage, 4)},
      grape = ${cut(s.grape, 255)}, style = ${cut(s.type, 64)}, colour = ${s.colour}, sparkling = ${s.sparkling}, abv = ${s.abv}::numeric,
      region = ${cut(s.region, 255)}, country = ${cut(s.country, 2)}, product_id = ${link.productId}, vintage_id = ${link.vintageId}
     WHERE id = ${id} AND session_id IS NOT DISTINCT FROM ${sessionId}`
}

// The bottle's OWN fields (ruled 2026-11-20: "About" and vinification stay on
// the bottle, like the purchase link): only those this request sent, written
// against the row as it stands (an omitted field keeps what is stored NOW,
// never a pre-read: the interleaved-PATCH rule).
export type BottleNotes = { description?: string; vinification?: string; purchaseUrl?: string }
export async function editOccurrenceNotes(tx: Prisma.TransactionClient, sessionId: number | null, id: string, n: BottleNotes): Promise<void> {
  const sets: Prisma.Sql[] = []
  if (n.description !== undefined) sets.push(Prisma.sql`description = ${cut(n.description, 1000)}`)
  if (n.vinification !== undefined) sets.push(Prisma.sql`vinification = ${cut(n.vinification, 1000)}`)
  if (n.purchaseUrl !== undefined) sets.push(Prisma.sql`purchase_url = ${cut(n.purchaseUrl, 1000)}`)
  if (!sets.length) return
  await tx.$executeRaw`UPDATE wines SET ${Prisma.join(sets, ', ')} WHERE id = ${id} AND session_id IS NOT DISTINCT FROM ${sessionId}`
}

// The cached (old-shape) bottle carrying a link's snapshot: the Redis-only
// moment's write, and the POST echo.
export function withSnapshot(w: WineMeta, link: { productId: string; vintageId: string | null }, s: EntrySnapshot): WineMeta {
  return {
    ...w, name: s.name, producer: s.producer, vintage: s.vintage, grape: s.grape, type: s.type,
    region: s.region || undefined, country: s.country || undefined,
    productId: link.productId, vintageId: link.vintageId,
  }
}

// ── The projection ──────────────────────────────────────────────────────────

// The line-up + its stamp in ONE fenced step, after COMMIT: written only while
// the caller's lease holds and only over a PRESENT line-up (XX KEEPTTL — an
// evicted key is the rebuild's to recreate, NX); the stamp takes the line-up's
// TTL. -1 = lease lost (thrown), 0 = cold (nothing written), 1 = written.
const PROJECT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local ttl = redis.call('PTTL', KEYS[2])
if ttl == -2 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'KEEPTTL')
if ttl >= 0 then redis.call('SET', KEYS[3], ARGV[3], 'PX', math.max(ttl, 1)) else redis.call('SET', KEYS[3], ARGV[3]) end
return 1`

export async function projectLineup(fence: Fence, lineup: WineMeta[], revision: number): Promise<boolean> {
  const r = Number(await fence.client.eval(PROJECT_SCRIPT, {
    keys: [sessionLockKey(fence.code), k.wines(fence.code), k.wrev(fence.code)],
    arguments: [fence.token, JSON.stringify(lineup), String(revision)],
  }))
  if (r < 0) throw new LockLost(fence.code)
  return r === 1
}

// The record's line-up state of a live moment for a caller without a grant
// read (a guest): one read by the unique code. undefined = no live row
// (Redis-only). `createdAt` binds it to an incarnation (Codex r1).
export async function readLineupState(code: string): Promise<{ sessionId: number; revision: number | null; createdAt: number | null } | undefined> {
  const rows = await prisma.$queryRaw<{ id: number; lineup_revision: number | null; created_at: Date | null }[]>`
    SELECT id, lineup_revision, created_at FROM sessions WHERE code = ${code} AND deleted_at IS NULL`
  const r = rows[0]
  return r ? { sessionId: Number(r.id), revision: r.lineup_revision, createdAt: r.created_at ? r.created_at.getTime() : null } : undefined
}

// The rating keys of re-minted ids follow their bottle: copied now (fenced, one
// Lua step per batch: GET + SET with the source's PTTL), the old keys returned
// for the contract to delete after COMMIT.
const COPY_KEYS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
for i = 2, #KEYS, 2 do
  local v = redis.call('GET', KEYS[i])
  if v then
    local t = redis.call('PTTL', KEYS[i])
    if t > 0 then redis.call('SET', KEYS[i + 1], v, 'PX', t) else redis.call('SET', KEYS[i + 1], v) end
  end
end
return 1`

export async function copyRatingKeys(fence: Fence, moved: [string, string][]): Promise<string[]> {
  const { scanKeys } = await import('@/lib/redis')
  const to = new Map(moved)
  const old: string[] = []
  const pairs: string[] = []
  // One scan of the moment's rating keys (review r3), grouped by bottle id.
  for (const key of await scanKeys(`s:${fence.code}:r:*`)) {
    const from = key.slice(key.lastIndexOf(':') + 1)
    const target = to.get(from)
    if (target) { old.push(key); pairs.push(key, key.slice(0, -from.length) + target) }
  }
  for (let i = 0; i < pairs.length; i += 200) {
    const r = Number(await fence.client.eval(COPY_KEYS_SCRIPT, { keys: [sessionLockKey(fence.code), ...pairs.slice(i, i + 200)], arguments: [fence.token] }))
    if (r < 0) throw new LockLost(fence.code)
  }
  return old
}

// 🔒 Wine-photo retention (D8, ruled 2026-11-10): a bottle's photo may be
// reclaimed only while NO rating, NO craving sourced from it (a bookmark's
// `wine_id`) and NO blind save of it (it counts as a craving once revealed)
// references the bottle: the surviving ratings, feed posts, profile
// tiles and Cravings still show it (and it will feed the catalogue's pictures;
// only a moderator removes such a photo). ONE predicate for every path that
// reclaims a moment's wine photos (the moment DELETE, account deletion): give
// it the bottle ids, or a moment's id for all of its bottles.
export async function reclaimablePhotos(db: Db, scope: string[] | { sessionId: number }): Promise<{ id: string; imageUrl: string }[]> {
  const where = Array.isArray(scope) ? Prisma.sql`w.id = ANY(${scope}::text[])` : Prisma.sql`w.session_id = ${scope.sessionId}`
  if (Array.isArray(scope) && !scope.length) return []
  const rows = await db.$queryRaw<{ id: string; image_url: string }[]>`
    SELECT w.id, w.image_url FROM wines w
     WHERE ${where} AND w.image_url IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id)
       AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = w.id)
       AND NOT EXISTS (SELECT 1 FROM blind_saves bs WHERE bs.wine_id = w.id)`
  return rows.map(r => ({ id: r.id, imageUrl: r.image_url }))
}
