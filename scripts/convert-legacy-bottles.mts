// The catalogue model change's CONVERSION of the legacy bottles (spec § 6; release 0.2.0 runbook 2.2 / 4.17):
// every bottle that predates the catalogue gets the verdict a person ruled for it. Input = the ruled verdict list
// (operator-local, it names prod rows: never committed) and the delivery's merged.csv / removed.csv.
//
//   DATABASE_URL=… REDIS_URL=… DATABASE_CONNECTION_LIMIT=2 [S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_REGION=…] \
//   npx tsx scripts/convert-legacy-bottles.mts \
//     --verdicts <list.csv> --merged <merged.csv> --removed <removed.csv> --fallback-adder <users.id> --out <dir>   # dry run
//   … the same --apply --expect-db <host>/<database>                                                            # write
//
// Verdicts (column `verdict`): `link` (column `target`: "<product id> …", optional `vintage_id`), `mint` (a new
// producer and wine; `producer_same_as` = another mint row whose new producer it shares), `producer+mint` (target:
// "<producer id> …", a new wine under it), `same-as:<row id>` (that row's entry), `leave` (kept unlinked),
// `drop` (deleted). The bottle's year (column `vintage`): empty / "(no vintage)" = the wine without a year, "NV" =
// the NV vintage, else the year; a year the entry lacks is ADDED (provisional, ruled 2026-11-18). Every new entry
// goes through lib/catalogWrite.ts (search docs, a review item) and shows as added by the person who added the
// bottle (`u:` and the account still there), else by --fallback-adder (ruled 2026-11-26). A linked bottle and the
// cravings sourced from it show the ENTRY's name, producer and type (the snapshot from the entry, as every link;
// ruled 2026-11-26); a craving colliding with one of the same wine keeps the visible row, else the earlier one.
//
// REFUSES, writing nothing: an unlinked bottle not on the list (the list is stale: give it a verdict); a row
// without a ruled verdict; a target missing, not linkable, or on merged.csv / removed.csv; a bottle to delete
// that something references now (rule 2: never as a side effect); a year that is no catalogue year; file 2 neither
// applied nor abandoned (--without-file2: its `builtOn` digest dies at our first mint); a Postgres-backed moment
// whose cached line-up the warm-up has not stamped (its reconciliation would copy the cache over our links: run
// warm-lineups first); a bottle that moved moments meanwhile; a bottle edited since the ruling (name, producer or
// year); any statement whose row count is not the list's. Before connecting: REDIS_URL (and, for --apply, the S3
// variables) not in the SHELL environment (never the checkout's .env: the cache guard would pass on the wrong
// Redis, the photo reclaim would do nothing); a malformed list (a missing column, a bottle twice, a producer_same_as
// that is not another mint row); an --out holding a mint list already.
// SKIPS and reports: a listed bottle deleted since, or linked since (its owner linked it).
//
// 🔒 ONE transaction, locks in the order every live writer uses (account deletion, the catalogue purge): every
// affected moment's advisory lock + live row (withSessionLocks, code order), then the bottles FOR UPDATE (id
// order), then the craving owners (lockCravings), then the catalogue rows the mints touch (lib/catalogWrite.ts's
// own order). RECORD-FIRST: links are written to the rows, each touched moment's lineup_revision bumped (a NULL
// one stays NULL: the next rebuild publishes from the record), and after COMMIT each moment's cached line-up is
// re-projected (refreshLineup, best effort: a reader with a stale stamp refreshes anyway); the publication generation
// of every locked moment is bumped before the first write (a writer without the Redis lease). After COMMIT, each
// step on its own (a failure there says COMMITTED, never "rolled back"): the files first (mint-list.csv and
// flagged-links.csv for the catalogue side, unreclaimed-photos.txt for a photo outside the bucket), the new search
// words, the deleted bottles' photos (capture → commit → reclaim; only a photo nothing else references).
// The dry run runs everything and rolls back. A second --apply changes nothing.
// stdout: one JSON object (counts, ids of skipped rows; never a person). Exit 0 = ran, 1 = refused / error, 2 = usage.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argValue, boundTransaction, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'

const SCRIPT = 'convert-legacy-bottles'
const args = process.argv.slice(2)
const apply = args.includes('--apply'), withoutFile2 = args.includes('--without-file2')
const opt = (n: string) => argValue(args, n)
const [listPath, mergedPath, removedPath, fallbackRaw, outDir, expectDb] = ['--verdicts', '--merged', '--removed', '--fallback-adder', '--out', '--expect-db'].map(opt)
const known = new Set(['--apply', '--without-file2', '--verdicts', '--merged', '--removed', '--fallback-adder', '--out', '--expect-db', listPath, mergedPath, removedPath, fallbackRaw, outDir, expectDb])
if (!listPath || !mergedPath || !removedPath || !fallbackRaw || !/^\d+$/.test(fallbackRaw) || !outDir || expectDb === null || (apply && !expectDb) || args.some(a => !known.has(a))) {
  console.error(`usage: ${SCRIPT}.mts --verdicts <csv> --merged <csv> --removed <csv> --fallback-adder <users.id> --out <dir> [--without-file2] [--apply --expect-db <host>/<db>]`)
  process.exit(2)
}
// 🔒 Redis and (for --apply) S3 from the SHELL, read before targetFromEnv loads the checkout's .env: lib/redis.ts
// falls back to localhost and the photo reclaim does nothing without S3, so a dev .env must never stand in for prod
// (review r1 P1: the unstamped-cache guard would pass vacuously on the wrong Redis).
const shellRedis = process.env.REDIS_URL
const S3_VARS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']
const shellS3 = S3_VARS.every(v => !!process.env[v])
if (!shellRedis) { console.error(`${SCRIPT}: REDIS_URL is not set in the environment (refusing the checkout's .env)`); process.exit(2) }
if (apply && S3_VARS.some(v => !process.env[v])) { console.error(`${SCRIPT}: --apply needs ${S3_VARS.join(', ')} in the environment (it deletes the orphans' photos after COMMIT)`); process.exit(2) }
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb!)
if (process.env.REDIS_URL !== shellRedis) { console.error(`${SCRIPT}: REDIS_URL changed while loading the environment`); process.exit(2) }
console.error(`${SCRIPT}: redis ${new URL(shellRedis).host}${apply ? `, s3 ${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}` : ''}`)
const fallbackAdder = Number(fallbackRaw)
// The output files: writable, and never over a mint list already written (it is the record a re-run can't rebuild).
const mintPath = join(outDir, 'mint-list.csv'), flaggedPath = join(outDir, 'flagged-links.csv'), photosPath = join(outDir, 'unreclaimed-photos.txt'), allPhotosPath = join(outDir, 'deleted-bottles-photos.txt')
if (apply) {
  try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, '.write-test'), ''); rmSync(join(outDir, '.write-test')) } catch (e) { console.error(`${SCRIPT}: --out ${outDir} is not writable (${errText(e)})`); process.exit(2) }
  if (existsSync(mintPath) && statSync(mintPath).size > 0) { console.error(`${SCRIPT}: ${mintPath} exists: keep it (it records a run's mints), give --out another folder`); process.exit(2) }
}

const { prisma } = await import('../lib/prisma.ts')
const { redis, k } = await import('../lib/redis.ts')
const { withSessionLocks, bumpGeneration } = await import('../lib/sessionMutation.ts')
const { createProducer, createProduct, createVintage, publishSearchWords, isCatalogYear } = await import('../lib/catalogWrite.ts')
const { loadEntries, snapshotFromEntry, entryKey } = await import('../lib/catalogEntries.ts')
const { relinkOccurrence, bumpLineupRevision, reclaimablePhotos } = await import('../lib/occurrences.ts')
const { lockCravings, afterRelink } = await import('../lib/cravings.ts')
const { refreshLineup } = await import('../lib/sessionRehydrate.ts')
const { reclaimImagesNow } = await import('../lib/engagementCascade.ts')
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

// ── the inputs ────────────────────────────────────────────────────────────────
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++ } else if (ch === '"') q = false; else f += ch; continue }
    if (ch === '"') q = true
    else if (ch === ',') { row.push(f); f = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x !== '')) rows.push(row); row = [] }
    else f += ch
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  const [head, ...body] = rows
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
const out = {
  mode: apply ? 'apply' : 'dry-run', database: null as string | null, bounds: null as string | null,
  counts: { listed: 0, linked: 0, producersMinted: 0, productsMinted: 0, vintagesMinted: 0, dropped: 0, kept: 0, bookmarksMoved: 0, bookmarksMerged: 0, moments: 0, photosToReclaim: 0 },
  skipped: { deletedSince: 0, linkedSince: 0, ids: [] as string[] }, files: null as null | Record<string, string>, refused: null as null | { reason: string; examples?: string[] },
  committed: false, afterCommit: [] as string[], photosNotReclaimable: null as number | null,
}
const REFUSED = Symbol('refused'), ROLLBACK = Symbol('dry run')
const refuse = (reason: string, examples?: string[]): never => { out.refused = { reason, ...(examples?.length ? { examples: examples.slice(0, 10) } : {}) }; throw REFUSED }

let list: Record<string, string>[], merged: Record<string, string>[], removed: Record<string, string>[]
try {
  [list, merged, removed] = [listPath, mergedPath, removedPath].map(p => parseCsv(readFileSync(p!, 'utf8')))
} catch (e) { console.error(`${SCRIPT}: cannot read the inputs (${errText(e)})`); process.exit(2) }
// The inputs' shape (review r1 P3: a wrong header failed open): the lists by their header names, ids nanoid-shaped,
// every list id once.
const ID = /^[A-Za-z0-9_-]{21}$/
const headerOf = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/)[0].split(',').map(h => h.trim())
const shape = (rows: Record<string, string>[], cols: string[], idCols: string[], name: string, path: string) => {
  if (cols.some(c => !headerOf(path).includes(c))) { console.error(`${SCRIPT}: ${name} lacks the columns ${cols.join(', ')}`); process.exit(2) }
  const bad = rows.filter(r => idCols.some(c => !ID.test(r[c])))
  if (bad.length) { console.error(`${SCRIPT}: ${name}: ${bad.length} row(s) without a catalogue id`); process.exit(2) }
}
shape(merged, ['entity', 'loser_id', 'survivor_id'], ['loser_id', 'survivor_id'], 'merged.csv', mergedPath)
shape(removed, ['entity', 'id'], ['id'], 'removed.csv', removedPath)
if (!list.length || ['id', 'verdict', 'target', 'vintage', 'vintage_id', 'producer', 'name', 'style', 'producer_same_as', 'mint_producer_name'].some(c => !(c in list[0]))) {
  console.error(`${SCRIPT}: the verdict list lacks a column (id, verdict, target, vintage, vintage_id, producer, name, style, producer_same_as, mint_producer_name)`); process.exit(2)
}
const dupes = list.map(r => r.id).filter((id, i, a) => a.indexOf(id) !== i)
if (dupes.length) { console.error(`${SCRIPT}: the verdict list names a bottle twice: ${[...new Set(dupes)].slice(0, 10).join(' ')}`); process.exit(2) }
const stale = new Map<string, string>() // catalogue id → why it cannot be a target
for (const m of merged) stale.set(m.loser_id, `merged into ${m.survivor_id} (merged.csv)`)
for (const r of removed) stale.set(r.id, 'removed (removed.csv)')
const byId = new Map(list.map(r => [r.id, r]))
// producer_same_as (review r1 P2): only another `mint` row of the list, which names no producer_same_as itself.
const badShare = list.filter(r => r.verdict === 'mint' && r.producer_same_as && (byId.get(r.producer_same_as)?.verdict !== 'mint' || !!byId.get(r.producer_same_as)?.producer_same_as)) // read on mint rows only
if (badShare.length) { console.error(`${SCRIPT}: producer_same_as must name another mint row of the list that shares no producer itself: ${badShare.map(r => r.id).slice(0, 10).join(' ')}`); process.exit(2) }
const first = (s: string) => s.trim().split(/\s+/)[0] ?? ''
type Entry = { kind: 'product'; productId: string; vintageId: string | null } | { kind: 'mint'; root: string; producerId: string | null; producerRoot: string }
function entryOf(r: Record<string, string>, seen = new Set<string>()): Entry {
  if (seen.has(r.id)) refuse(`same-as rows form a loop at ${r.id}`)
  seen.add(r.id)
  const v = r.verdict
  if (v === 'link') return { kind: 'product', productId: first(r.product_id || r.target), vintageId: r.vintage_id || null }
  if (v === 'producer+mint') return { kind: 'mint', root: r.id, producerId: first(r.target), producerRoot: r.id }
  if (v === 'mint') return { kind: 'mint', root: r.id, producerId: null, producerRoot: r.producer_same_as || r.id }
  if (v.startsWith('same-as:')) {
    const a = byId.get(v.slice(8))
    if (!a) refuse(`row ${r.id} is the same wine as ${v.slice(8)}, which is not on the list`)
    return entryOf(a!, seen)
  }
  return refuse(`row ${r.id} has no ruled verdict (${v || 'empty'})`)
}
// The bottle's year: undefined = the wine without a year, null = NV, else the year.
function yearOf(r: Record<string, string>): number | null | undefined {
  const t = r.vintage.trim()
  if (t === '' || t === '(no vintage)') return undefined
  if (t.toUpperCase() === 'NV') return null
  const n = Number(t)
  if (!/^\d{4}$/.test(t) || !isCatalogYear(n)) refuse(`row ${r.id}: "${t}" is no catalogue year (rule it as the wine without a year)`)
  return n
}
const STYLE: Record<string, { colour: string | null; sparkling: boolean }> = {
  red: { colour: 'red', sparkling: false }, white: { colour: 'white', sparkling: false }, rose: { colour: 'rose', sparkling: false }, spark: { colour: null, sparkling: true },
}

let txRef: Tx | null = null
const reclaim: string[] = [], touched = new Map<string, number>() // code → createdAt
const mintRows: string[] = [], flagRows: string[] = []
try {
  await prisma.$transaction(async (tx) => {
    txRef = tx
    Object.assign(out, await boundTransaction(tx, { apply, expectDb }))
    if (!withoutFile2) {
      const [f2] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM wine_products WHERE country IS NOT NULL OR description IS NOT NULL OR vinification IS NOT NULL`
      if (!f2.n) refuse('file 2 is not applied (no product carries an origin): apply it first, or pass --without-file2 to abandon it (our first mint ends it)')
    }
    const listed = list.map(r => r.id)
    out.counts.listed = listed.length
    // 1. the moments of every legacy or listed bottle, locked in code order
    const seenRows = await tx.$queryRaw<{ code: string | null }[]>`
      SELECT DISTINCT s.code FROM wines w JOIN sessions s ON s.id = w.session_id
       WHERE (w.product_id IS NULL OR w.id = ANY(${listed}::text[])) AND s.code IS NOT NULL AND s.deleted_at IS NULL`
    const locked = await withSessionLocks(tx, seenRows.map(r => r.code!))
    const moments = new Map([...locked.values()].flatMap(m => (m ? [[m.id, m] as const] : [])))
    const revs = await tx.$queryRaw<{ id: number; code: string; rev: number | null }[]>`
      SELECT id, code, lineup_revision AS rev FROM sessions WHERE id = ANY(${[...moments.keys()]}::int[])`
    const unstamped: string[] = []
    for (const m of revs) if (m.rev === null && (await redis.exists(k.wines(m.code)))) unstamped.push(`session ${m.id}`)
    if (unstamped.length) refuse(`${unstamped.length} moment(s) hold a cached line-up the warm-up has not stamped: run warm-lineups --apply first`, unstamped)
    // 2. the bottles, FOR UPDATE, in id order
    const bottles = await tx.$queryRaw<{ id: string; session_id: number | null; product_id: string | null; added_by_identity_id: string | null; name: string | null; producer: string | null; vintage: string | null }[]>`
      SELECT id, session_id, product_id, added_by_identity_id, name, producer, vintage FROM wines
       WHERE product_id IS NULL OR id = ANY(${listed}::text[]) ORDER BY id FOR UPDATE`
    const moved = bottles.filter(b => b.session_id !== null && !moments.has(b.session_id)).map(b => b.id)
    if (moved.length) refuse('a bottle is in a moment this run did not lock (it moved, or was added, meanwhile): run again', moved)
    const unlisted = bottles.filter(b => b.product_id === null && !byId.has(b.id)).map(b => b.id)
    if (unlisted.length) refuse(`${unlisted.length} unlinked bottle(s) not on the list: the list is stale, give them a verdict`, unlisted)
    const bottle = new Map(bottles.map(b => [b.id, b]))
    const active: Record<string, string>[] = []
    for (const r of list) {
      const b = bottle.get(r.id)
      if (!b) { out.skipped.deletedSince++; out.skipped.ids.push(r.id); continue }
      if (b.product_id !== null) { out.skipped.linkedSince++; out.skipped.ids.push(r.id); continue }
      active.push(r)
    }
    // A verdict is for the bottle AS RULED (review r1 P2): one edited since (name, producer, year) is ruled again.
    const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/^\(no vintage\)$/, '')
    const drifted = active.filter(r => { const b = bottle.get(r.id)!; return norm(b.name) !== norm(r.name) || norm(b.producer) !== norm(r.producer) || norm(b.vintage) !== norm(r.vintage) })
    if (drifted.length) refuse(`${drifted.length} bottle(s) changed (name, producer or year) since the ruling: rule them again`, drifted.map(r => r.id))
    const toLink = active.filter(r => r.verdict !== 'leave' && r.verdict !== 'drop')
    const drops = active.filter(r => r.verdict === 'drop').map(r => r.id)
    out.counts.kept = active.filter(r => r.verdict === 'leave').length
    // A same-as row shares the ENTRY, never the other row's year (its own vintage_id, else its own year).
    const plan = new Map(toLink.map(r => {
      const e = entryOf(r)
      const entry = e.kind === 'product' && r.verdict.startsWith('same-as:') ? { ...e, vintageId: r.vintage_id || null } : e
      return [r.id, { entry, year: entry.kind === 'product' && entry.vintageId ? undefined : yearOf(r) }] as const
    }))
    // 3. the targets: present, linkable, on neither list
    const pids = [...new Set([...plan.values()].flatMap(p => (p.entry.kind === 'product' ? [p.entry.productId] : [])))]
    const vids = [...new Set([...plan.values()].flatMap(p => (p.entry.kind === 'product' && p.entry.vintageId ? [p.entry.vintageId] : [])))]
    const prids = [...new Set([...plan.values()].flatMap(p => (p.entry.kind === 'mint' && p.entry.producerId ? [p.entry.producerId] : [])))]
    const onLists = [...pids, ...vids, ...prids].filter(id => stale.has(id))
    if (onLists.length) refuse(`a target is on the delivery's lists (${stale.get(onLists[0])}): the list is stale`, onLists)
    const LINKABLE = ['confirmed', 'provisional']
    const found = new Map((await tx.$queryRaw<{ id: string; status: string; product_id: string | null }[]>`
      SELECT id, status, NULL::text AS product_id FROM wine_products WHERE id = ANY(${pids}::text[])
      UNION ALL SELECT id, status, product_id FROM wine_vintages WHERE id = ANY(${vids}::text[])
      UNION ALL SELECT id, status, NULL FROM producers WHERE id = ANY(${prids}::text[])`).map(x => [x.id, x]))
    const bad = [...pids, ...vids, ...prids].filter(id => !found.has(id) || !LINKABLE.includes(found.get(id)!.status))
    if (bad.length) refuse('a target does not exist or is not linkable (merged, rejected or archived)', bad)
    const wrongParent = [...plan.values()].flatMap(p => (p.entry.kind === 'product' && p.entry.vintageId && found.get(p.entry.vintageId)!.product_id !== p.entry.productId ? [p.entry.vintageId] : []))
    if (wrongParent.length) refuse('a target vintage belongs to another product', wrongParent)
    // 4. the bottles to delete: referenced by nothing, re-read now
    const referenced = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM wines w WHERE w.id = ANY(${drops}::text[])
         AND (w.session_id IS NOT NULL OR EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id)
              OR EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = w.id) OR EXISTS (SELECT 1 FROM blind_saves s WHERE s.wine_id = w.id))`
    if (referenced.length) refuse('a bottle to delete is referenced now (a moment, a rating or a craving): rule it again', referenced.map(r => r.id))
    // 5. the craving owners, after every session lock
    const ids = toLink.map(r => r.id)
    const owners = (await tx.$queryRaw<{ u: number }[]>`
      SELECT user_id AS u FROM bookmarks WHERE wine_id = ANY(${ids}::text[]) UNION SELECT user_id FROM blind_saves WHERE wine_id = ANY(${ids}::text[])`).map(r => r.u)
    await lockCravings(tx, owners)
    // the owners' cravings (afterRelink may delete one of theirs OUTSIDE the list on a collision: review r1 P3)
    const ownersCravings = async () => (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE user_id = ANY(${owners}::int[])`)[0].n
    const bookmarksBefore = await ownersCravings()
    // 6. the adders: the bottle's account while it exists, else the fallback
    const accounts = new Set((await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM users WHERE id = ANY(${[...new Set([fallbackAdder, ...bottles.flatMap(b => (/^u:\d+$/.test(b.added_by_identity_id ?? '') ? [Number(b.added_by_identity_id!.slice(2))] : []))])]}::int[])`).map(u => u.id))
    if (!accounts.has(fallbackAdder)) refuse(`--fallback-adder ${fallbackAdder} is no account`)
    const adderOf = (id: string) => { const a = bottle.get(id)?.added_by_identity_id ?? ''; const n = /^u:\d+$/.test(a) ? Number(a.slice(2)) : NaN; return accounts.has(n) ? n : fallbackAdder }
    // The publication generation of every locked moment, before the first durable write (the contract's rule for a
    // writer without the Redis lease: a rebuild that read the record before us cannot publish over the links;
    // review r1 P3). --apply only: the dry run writes nothing to Redis.
    if (apply) {
      for (const m of moments.values()) await bumpGeneration(m.code, null)
      await tx.$queryRaw`SELECT 1`
    }
    // 7. the mints: producers (shared by producer_same_as), wines (one per root), then every year an entry lacks
    const newProducer = new Map<string, string>(), newProduct = new Map<string, string>()
    for (const r of toLink) {
      const p = plan.get(r.id)!.entry
      if (p.kind !== 'mint' || p.root !== r.id) continue
      let producerId = p.producerId
      if (!producerId) {
        producerId = newProducer.get(p.producerRoot) ?? null
        if (!producerId) {
          const pr = byId.get(p.producerRoot) ?? r
          producerId = (await createProducer({ name: pr.mint_producer_name || pr.producer, country: pr.mint_country || undefined, region: pr.mint_region || undefined }, adderOf(pr.id), tx)).id
          newProducer.set(p.producerRoot, producerId)
          mintRows.push(['producer', producerId, pr.mint_producer_name || pr.producer, '', '', ''].map(csvCell).join(','))
        }
      }
      const s = STYLE[r.style] ?? { colour: null, sparkling: false }
      const productId = (await createProduct({
        name: r.name, producerId, category: 'wine', colour: s.colour, sparkling: s.sparkling, abv: r.style === 'nonalc' ? 0 : null,
        region: r.mint_region || undefined, country: r.mint_country || undefined, grapes: r.mint_grapes ? r.mint_grapes.split(';').map(g => g.trim()).filter(Boolean) : undefined,
      }, adderOf(r.id), [], tx)).id
      newProduct.set(r.id, productId)
      mintRows.push(['product', productId, r.name, producerId, '', ''].map(csvCell).join(','))
    }
    out.counts.producersMinted = newProducer.size
    out.counts.productsMinted = newProduct.size
    const linkOf = new Map<string, { productId: string; vintageId: string | null }>()
    const yearIds = new Map<string, string>()
    for (const r of toLink) {
      const { entry, year } = plan.get(r.id)!
      if (entry.kind === 'mint' && !newProduct.has(entry.root)) refuse(`row ${r.id} shares the new wine of ${entry.root}, which this run does not create (deleted or linked since): rule it again`)
      const productId = entry.kind === 'product' ? entry.productId : newProduct.get(entry.root)!
      let vintageId = entry.kind === 'product' ? entry.vintageId : null
      if (!vintageId && year !== undefined) {
        const key = `${productId}|${year ?? 'nv'}`
        vintageId = yearIds.get(key) ?? null
        if (!vintageId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vintage:${productId}:${year ?? 'nv'}`}))` // the add flow's lock (lib/catalogAddFlow.ts)
          const [have] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM wine_vintages WHERE product_id = ${productId} AND year IS NOT DISTINCT FROM ${year}`
          if (have && !LINKABLE.includes(have.status)) refuse(`the ${year ?? 'NV'} vintage of ${productId} is ${have.status}`, [have.id])
          vintageId = have?.id ?? (await createVintage(productId, year, adderOf(r.id), null, tx)).id
          if (!have) { out.counts.vintagesMinted++; mintRows.push(['vintage', vintageId, '', '', productId, year === null ? 'NV' : String(year)].map(csvCell).join(',')) }
          yearIds.set(key, vintageId)
        }
      }
      linkOf.set(r.id, { productId, vintageId })
    }
    // 8. the links: the bottle, then the cravings sourced from it
    const entries = await loadEntries([...linkOf.values()], tx)
    const sessionsTouched = new Set<number>()
    for (const r of [...toLink].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const link = linkOf.get(r.id)!, b = bottle.get(r.id)!
      const e = entries.get(entryKey(link.productId, link.vintageId))
      if (!e) refuse(`no entry for ${link.productId}/${link.vintageId ?? '-'}`)
      if ((await relinkOccurrence(tx, b.session_id, r.id, link, snapshotFromEntry(e!))) !== 1) refuse(`the link of ${r.id} changed no row`)
      await afterRelink(tx, r.id)
      out.counts.linked++
      if (b.session_id !== null) sessionsTouched.add(b.session_id)
      if (r.file1_flag) flagRows.push([e!.productId, e!.vintageId ?? '', e!.name, e!.producer, r.producer, r.name, r.vintage, r.file1_flag].map(csvCell).join(','))
    }
    out.counts.bookmarksMoved = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE wine_id = ANY(${ids}::text[])`)[0].n
    out.counts.bookmarksMerged = bookmarksBefore - (await ownersCravings())
    // 9. the deletes: capture the photos nothing else references, delete, assert the count
    const photos = (await reclaimablePhotos(tx, drops)).map(p => p.imageUrl)
    if (photos.length) reclaim.push(...(await tx.$queryRaw<{ u: string }[]>`
      SELECT u FROM unnest(${photos}::text[]) AS u
       WHERE NOT EXISTS (SELECT 1 FROM wines w WHERE w.image_url = u AND NOT (w.id = ANY(${drops}::text[])))
         AND NOT EXISTS (SELECT 1 FROM rating_images ri WHERE ri.image_url = u)
         AND NOT EXISTS (SELECT 1 FROM users x WHERE u IN (x.image_url, x.cover_photo_url, x.tile_impressions_url, x.tile_moments_url, x.tile_cravings_url,
                                                         x.tile_impressions_own_url, x.tile_moments_own_url, x.tile_cravings_own_url))`).map(x => x.u))
    out.counts.photosToReclaim = reclaim.length
    // a photo outside this bucket can't be deleted from here (an old endpoint): listed in --out, never silently kept
    const prefix = `${process.env.S3_ENDPOINT ?? ''}/${process.env.S3_BUCKET ?? ''}/`
    out.photosNotReclaimable = shellS3 ? reclaim.filter(u => !u.startsWith(prefix)).length : null // meaningless without the shell's S3
    const gone = await tx.$executeRaw`
      DELETE FROM wines w WHERE w.id = ANY(${drops}::text[]) AND w.session_id IS NULL AND w.product_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id) AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = w.id)
         AND NOT EXISTS (SELECT 1 FROM blind_saves s WHERE s.wine_id = w.id)`
    if (gone !== drops.length) refuse(`the delete removed ${gone} bottles, the list has ${drops.length}`)
    out.counts.dropped = gone
    // 10. the moments: every one whose line-up changed bumps (NULL stays NULL)
    for (const id of sessionsTouched) {
      await bumpLineupRevision(tx, id)
      const m = moments.get(id)!
      touched.set(m.code, m.createdAt?.getTime() ?? 0)
    }
    out.counts.moments = sessionsTouched.size
    if (out.counts.linked !== toLink.length) refuse(`linked ${out.counts.linked} bottles, the list has ${toLink.length}`)
    if (!apply) throw ROLLBACK
  }, { timeout: 600_000, maxWait: 10_000 })
  // after COMMIT: each step on its own (review r1 P2: a failure here must never read as "rolled back"); the files
  // FIRST, they are the record nothing else can rebuild. Errors by class only (a moment code is a join credential).
  out.committed = true
  const after = async (step: string, f: () => Promise<unknown> | unknown) => {
    try { await f() } catch (e) { out.afterCommit.push(`${step}: ${(e as Error)?.constructor?.name ?? 'Error'}`) }
  }
  const mintText = ['entity,id,name,producer_id,product_id,year', ...mintRows].join('\n') + '\n'
  const flagText = ['entry_product_id,entry_vintage_id,entry_name,entry_producer,our_producer,our_name,our_vintage,note', ...flagRows].join('\n') + '\n'
  await after('files', () => {
    try {
      writeFileSync(mintPath, mintText)
      writeFileSync(flaggedPath, flagText)
      // every photo of a deleted bottle (an S3 error inside the reclaim only warns: the list survives it), and
      // those outside this bucket (never deleted from here)
      const keep = reclaim.filter(u => !u.startsWith(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/`))
      if (reclaim.length) writeFileSync(allPhotosPath, reclaim.join('\n') + '\n')
      if (keep.length) writeFileSync(photosPath, keep.join('\n') + '\n')
      out.files = { mints: mintPath, flagged: flaggedPath, ...(reclaim.length ? { deletedBottlesPhotos: allPhotosPath } : {}), ...(keep.length ? { unreclaimedPhotos: photosPath } : {}) }
    } catch (e) {
      console.error(`${SCRIPT}: the files could not be written; the mint list and the flagged links follow, keep them:\n${mintText}\n${flagText}`)
      throw e
    }
  })
  await after('search words', () => publishSearchWords(txRef))
  if (reclaim.length) await after('photo reclaim', () => reclaimImagesNow(reclaim))
  for (const [code, createdAt] of touched) {
    await after('line-up refresh', async () => { if (await redis.exists(k.wines(code))) await refreshLineup(code, createdAt || undefined) })
  }
  if (out.afterCommit.length) process.exitCode = 1
} catch (e) {
  if (e !== ROLLBACK) {
    if (e !== REFUSED) out.refused = { reason: `error: ${errText(e)}` }
    process.exitCode = 1
  }
} finally {
  await prisma.$disconnect()
  await redis.quit().catch(() => {})
}
if (out.refused) console.error(`${SCRIPT}: refused: ${out.refused.reason} (rolled back: nothing written, unless the error came at COMMIT itself)`)
if (out.committed && out.afterCommit.length) console.error(`${SCRIPT}: COMMITTED; after the commit these steps failed: ${out.afterCommit.join('; ')} (a line-up refreshes on its next read; words wait for the next search rebuild; the photos in the files)`)
console.log(JSON.stringify(out))

function csvCell(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v }
