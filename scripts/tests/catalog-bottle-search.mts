#!/usr/bin/env -S npx tsx
// Catalogue model change, step 7b: the every-word bottle search and the
// producer search on Verre's own search docs (lib/catalogSearch.ts
// `searchBottles` / `searchProducers`; migration 20261121180000_catalog_search;
// writers lib/catalogWrite.ts; rebuild scripts/lib/catalogSearchRebuild.mjs).
// Plan `.local/catalog-model-change/step7b-plan.md` r8 § 6. Real Postgres, the
// real module, the real writers; a fixture shaped like the cases that started
// this (five Pichlers, "christoph pichler" finding 20 Christophs and no Pichler).
//
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/tests/catalog-bottle-search.mts
//
// Never against a shared database: it seeds, merges and deletes catalogue rows
// (all marked: producers by website https://b7.test, raw seeds by an id prefix
// `b7s`) and runs the rebuild over the whole catalogue.
import { createPrismaClient } from '../lib/prismaClient.mjs'
import { rebuildCatalogSearch, catalogSearchDrift, readSearchRecipe, CATALOG_SEARCH_LOCK as REBUILD_LOCK } from '../lib/catalogSearchRebuild.mjs'
import {
  searchBottles, searchProducers, similarProducers, SEARCH_FILLERS, SEARCH_MAX_WORDS, SEARCH_MAX_CHARS, FALLBACK_NDOC,
  __everyWordForTests as T,
} from '../../lib/catalogSearch.ts'
import {
  createProducer, createProduct, indexProduct, indexProducer, lockForSearchDoc, publishSearchWords, addWords, SearchLockRetry,
  CATALOG_SEARCH_LOCK, yearMax, YEAR_MIN,
} from '../../lib/catalogWrite.ts'
import { MERGE_DEPTH_CAP } from '../../lib/catalogEntries.ts'
import { answerCatalogSearch } from '../../lib/catalogSearchAnswer.ts'
import { prisma as app } from '../../lib/prisma.ts'
import type { Prisma } from '@prisma/client'
type Tx = Prisma.TransactionClient
// EXPLAIN (FORMAT JSON) nodes.
type PlanNode = { 'Node Type'?: string; 'Index Name'?: string; 'Relation Name'?: string; 'Order By'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] }
// The drift report (scripts/lib/catalogSearchRebuild.mjs).
type Drift = { missingDocs: number; differentDocs: number; staleDocs: number; missingProducerDocs: number; differentProducerDocs: number; staleProducerDocs: number; staleWordCounts: number; sample: string[] }

const db = createPrismaClient()
let failures = 0, passes = 0
function ok(cond: unknown, label: string) {
  if (cond) { passes++; console.log(`  ✓ ${label}`) } else { failures++; console.log(`  ✗ ${label}`) }
}
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  ok(a === e, a === e ? label : `${label}\n      expected ${e}\n      actual   ${a}`)
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function gate() { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { wait: () => p, open } }

// Statements the app's own client sends (one round trip each).
async function statements<R>(fn: () => Promise<R>): Promise<{ n: number; r: R }> {
  let n = 0
  type Raw = (...a: unknown[]) => unknown
  const client = app as unknown as { $queryRawUnsafe: Raw; $queryRaw: Raw }
  const unsafe = client.$queryRawUnsafe, tagged = client.$queryRaw
  client.$queryRawUnsafe = (...a) => { n++; return unsafe.apply(app, a) }
  client.$queryRaw = (...a) => { n++; return tagged.apply(app, a) }
  try { const r = await fn(); return { n, r } } finally { client.$queryRawUnsafe = unsafe; client.$queryRaw = tagged }
}
const counted = statements

const MARK = 'https://b7.test'
const producers = new Map<string, string>()
const products = new Map<string, string>()

async function cleanup() {
  const prods = `SELECT pp.product_id FROM product_producers pp JOIN producers p ON p.id = pp.producer_id WHERE p.website LIKE '${MARK}%' OR p.id LIKE 'b7s%'`
  for (const s of [
    `DELETE FROM wine_vintages WHERE product_id IN (${prods}) OR product_id LIKE 'b7s%'`,
    `UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE id IN (${prods}) OR id LIKE 'b7s%'`,
    `DELETE FROM catalog_search_docs WHERE product_id IN (${prods}) OR product_id LIKE 'b7s%'`,
    `DELETE FROM wine_products WHERE id IN (${prods}) OR id LIKE 'b7s%'`,
    `UPDATE producers SET status = 'provisional', links_to = NULL WHERE website LIKE '${MARK}%' OR id LIKE 'b7s%'`,
    `DELETE FROM catalog_search_producer_docs WHERE producer_id IN (SELECT id FROM producers WHERE website LIKE '${MARK}%' OR id LIKE 'b7s%')`,
    `DELETE FROM producers WHERE website LIKE '${MARK}%' OR id LIKE 'b7s%'`,
    `DELETE FROM catalog_search_words WHERE word IN ('kelerbergx', 'morgenrot', 'morgengrau', 'nachtblau', 'abendgrau', 'vergessen')`,
  ]) await db.$executeRawUnsafe(s)
}

// The REAL writers (createProducer / createProduct index their docs in the
// mint's transaction), then the words published after the COMMIT, as the app's
// transaction owners do.
async function mint(producer: string, name: string, opts: { region?: string; vintages?: [number, string][] } = {}): Promise<string> {
  let tx0: Tx | null = null
  const id = await app.$transaction(async (tx) => {
    tx0 = tx
    let pid = producers.get(producer)
    if (!pid) { pid = (await createProducer({ name: producer, website: MARK }, null, tx)).id; producers.set(producer, pid) }
    const p = await createProduct({ name, producerId: pid, region: opts.region }, null, [], tx)
    for (const [year, status] of opts.vintages ?? []) {
      await tx.$executeRawUnsafe(`INSERT INTO wine_vintages (id, product_id, year, status, curator_locked, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}', now(), now())`,
        `b7v${p.id.slice(0, 10)}${year}`, p.id, year, status)
    }
    return p.id
  })
  await publishSearchWords(tx0)
  products.set(`${producer}|${name}`, id)
  return id
}
const P = (producer: string, name: string) => products.get(`${producer}|${name}`)!
const ids = (r: { results: { id: string }[] }) => r.results.map(x => x.id)
const bottles = (q: string, limit = 20) => searchBottles(q, { limit })

// Raw seeds (no writer), docs by the rebuild, as after a catalogue load.
async function seed(prefix: string, n: number, opts: { name: (g: number) => string; producer?: (g: number) => string; region?: (g: number) => string | null; status?: (g: number) => string; scope?: (g: number) => string }) {
  const rows = Array.from({ length: n }, (_, k) => k + 1)
  await app.$transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      await tx.$executeRawUnsafe(`INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
        SELECT x.id, x.name, 'confirmed', '{}', now(), now() FROM unnest($1::text[], $2::text[]) AS x(id, name)`,
        chunk.map(g => `b7s${prefix}p${String(g).padStart(5, '0')}`), chunk.map(g => (opts.producer ?? (() => `Seedhaus ${prefix} ${g}`))(g)))
      await tx.$executeRawUnsafe(`INSERT INTO wine_products (id, name, category, scope, status, region, grapes, curator_locked, created_at, updated_at)
        SELECT x.id, x.name, 'wine', x.scope, x.status, x.region, '{}', '{}', now(), now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(id, name, scope, status, region)`,
        chunk.map(g => `b7s${prefix}w${String(g).padStart(5, '0')}`), chunk.map(opts.name),
        chunk.map(g => opts.scope?.(g) ?? 'shared'), chunk.map(g => opts.status?.(g) ?? 'confirmed'), chunk.map(g => opts.region?.(g) ?? null))
      await tx.$executeRawUnsafe(`INSERT INTO product_producers (product_id, producer_id, role, created_at)
        SELECT 'b7s${prefix}w' || lpad(g::text, 5, '0'), 'b7s${prefix}p' || lpad(g::text, 5, '0'), 'lead', now() FROM unnest($1::int[]) g`, chunk)
    }
  }, { timeout: 120_000 })
}
async function rebuild() {
  await app.$transaction(tx => rebuildCatalogSearch(tx), { timeout: 120_000 })
  await db.$executeRawUnsafe('ANALYZE catalog_search_docs, catalog_search_producer_docs, catalog_search_words')
}

async function main() {
  console.log('\ncatalogue model change step 7b — every-word bottle search\n')
  await cleanup()
  // Whatever an earlier suite left (raw seeds, deleted rows) is reconciled first,
  // so the drift check below is about THIS suite's writes.
  await rebuild()

  // ══════════════════════════════════════════════════════════════════════
  console.log('§ 1 — the tokeniser, the fillers, the shared constants')
  const words = async (t: string) => (await db.$queryRawUnsafe<{ w: string[] }[]>(`SELECT public.catalog_search_words_v1(public.catalog_fold_v1($1)) AS w`, t))[0].w
  eq(await words('F.X. Pichler'), ['fx', 'pichler'], 'dots dropped: "F.X." is one word "fx"')
  eq(await words('Pichler-Krutzler'), ['pichler', 'krutzler'], 'a hyphen splits')
  eq(await words("Kellerberg's „Smaragd“"), ['kellerbergs', 'smaragd'], 'apostrophes dropped, quotes split')
  eq(await words('Λήμνια Γη'), ['λημνια', 'γη'], 'Greek keeps its words (pg_c_utf8 [[:alnum:]])')
  eq(await words('Шато Тамань 2019'), ['шато', 'тамань', '2019'], 'Cyrillic and digits keep theirs')
  eq((await db.$queryRawUnsafe<{ w: string[] }[]>(`SELECT public.catalog_search_words_v1(NULL) AS w`))[0].w, [], 'NULL → no words')
  eq(await words('  ,, --  '), [], 'only separators → no words')
  for (const f of SEARCH_FILLERS) {
    const [r] = await db.$queryRawUnsafe<{ fold: string; w: string[] }[]>(`SELECT public.catalog_fold_v1($1) AS fold, public.catalog_search_words_v1(public.catalog_fold_v1($1)) AS w`, f)
    if (r.fold !== f || r.w.length !== 1 || r.w[0] !== f) ok(false, `filler "${f}" is its own fold and one token (${r.fold}, ${JSON.stringify(r.w)})`)
  }
  ok(true, `every one of the ${SEARCH_FILLERS.length} fillers is its own catalog_fold_v1 and one token of the tokeniser`)
  eq(CATALOG_SEARCH_LOCK, REBUILD_LOCK, 'the catalog-search advisory lock key is one string (lib/catalogWrite.ts = the rebuild)')
  eq(MERGE_DEPTH_CAP, 10, 'MERGE_DEPTH_CAP is the 10 hops the SQL walks (migration recipe, lockForSearchDoc, indexProduct)')
  const recipe = readSearchRecipe()
  ok(recipe.some(s => s.sql.includes('w.depth < 10')), 'the recipe walks the same 10 hops')

  console.log('\n§ 1b — the planner (pure)')
  const tok = (w: string, i: number, o: Partial<{ ndoc: number | null; pre: boolean; near: (string | { word: string; ndoc: number })[] }> = {}) =>
    ({ i, w, ndoc: 'ndoc' in o ? o.ndoc! : 1, pre: o.pre ?? true, near: (o.near ?? []).map(x => (typeof x === 'string' ? { word: x, ndoc: 1 } : x)) })
  const plan = (...ws: string[]) => T.planQuery(ws.map((w, i) => tok(w, i + 1)), true)!
  eq(plan('pichler', 'kellerberg', '2019').year, 2019, 'a typed year is the year')
  eq(plan('pichler', 'kellerberg', '2019').required.map(g => g.token.w), ['pichler', 'kellerberg'], '… and leaves the required words')
  eq(plan('pichler', String(YEAR_MIN - 1)).year, null, `${YEAR_MIN - 1} stays a word`)
  eq(plan('pichler', String(YEAR_MIN)).year, YEAR_MIN, `${YEAR_MIN} is a year`)
  eq(plan('pichler', String(yearMax())).year, yearMax(), 'next year is a year')
  eq(plan('pichler', String(yearMax() + 1)).year, null, 'the year after next stays a word')
  eq(plan('2018', 'pichler', '2019').year, 2019, 'the LAST year-like word is the year')
  eq(plan('2019').year, null, 'a query that is only a year keeps it as a word')
  eq(plan('2019').required.map(g => g.token.w), ['2019'], '… a required word')
  eq(plan('pichler', 'kellerberg', 'x').required.map(g => g.token.w), ['pichler', 'kellerberg'], 'a one-letter last word is ignored while other words exist')
  eq(plan('pichler', 'kellerberg').required[1].alts[0], { word: 'kellerberg', typos: 0, prefix: true }, 'the last word is a prefix, its literal first')
  const unknown = T.planQuery([tok('pichler', 1), tok('kellerberx', 2, { ndoc: null, pre: false, near: ['kellerberg', 'keller'] })], true)!
  eq(unknown.required[1].alts[0], { word: 'kellerberx', typos: 0, prefix: true }, '🔒 the typed word is its own alternative even when the word list lacks it')
  eq(unknown.required[1].alts.slice(1).map(a => a.word), ['kellerberg'], '… typo alternatives on top (same first letter, OSA within budget)')
  eq(plan('weingut', 'pichler').optional.map(g => g.token.w), ['weingut'], 'a filler is optional')
  eq(plan('pichler', 'weing').optional.map(g => g.token.w), ['weing'], 'a half-typed last filler (≥ 3 letters) is optional')
  eq(plan('pichler', 'we').optional.map(g => g.token.w), [], '… not under 3 letters')
  const typoFiller = T.planQuery([tok('weingutt', 1, { ndoc: null, near: ['weingut'] }), tok('pichler', 2)], true)!
  eq(typoFiller.optional.map(g => g.token.w), ['weingutt'], '"weingutt": a typo that resolves to a filler is optional (decided after typo resolution)')
  const fillersOnly = plan('chateau', '2019')
  eq([fillersOnly.year, fillersOnly.required.map(g => g.token.w), fillersOnly.optional.length], [2019, ['chateau'], 0], '"chateau 2019": every word a filler → the fillers are required')
  eq(plan('domaine').required.map(g => g.token.w), ['domaine'], '"domaine" alone searches for it')
  eq([plan('chateau', '20').required.map(g => g.token.w), plan('chateau', '20').optional.map(g => g.token.w)], [['chateau'], ['20']], 'only FILLERS are promoted: "chateau 20" keeps the half-typed year a boost (Codex)')
  eq([plan('domaine', 'nv').required.map(g => g.token.w), plan('domaine', 'nv').optional.map(g => g.token.w)], [['domaine'], ['nv']], '… and "domaine nv" keeps "nv" a boost')
  eq(plan('testard', 'nv').optional.map(g => g.token.w), ['nv'], '"nv" is a boost, never required (bottles)')
  eq(T.planQuery([tok('testard', 1), tok('nv', 2)], false)!.required.map(g => g.token.w), ['testard', 'nv'], '… a plain word for producers')
  eq(T.typoAlternatives(tok('riesling', 1, { near: ['reisling', 'rieslings', 'riesl', 'kiesling', 'rieslingx'] })).map(a => [a.word, a.typos]),
    [['reisling', 1], ['rieslings', 1], ['rieslingx', 1]], 'typo alternatives: a swap counts one (OSA), same first letter only (kiesling out), riesl too far')
  ok(T.typoAlternatives(tok('riesling', 1, { near: ['reisling', 'kiesling', 'riesl'] })).every(a => a.word !== 'kiesling'), 'a different first letter is never a typo alternative')
  ok(T.typoAlternatives(tok('brut', 1, { near: ['bruts', 'brat', 'bru'] })).every(a => a.typos <= 1), 'a 4–7 letter word allows one edit')
  eq(T.typoAlternatives(tok('2019', 1, { near: ['2018', '2009'] })), [], 'numbers take no typo alternatives')
  eq(T.typoAlternatives(tok('abc', 1, { near: ['abd'] })), [], 'under 4 letters, no typos')
  eq(T.typoAlternatives(tok('reisling', 1, { near: [{ word: 'reislinga', ndoc: 1 }, { word: 'reislingb', ndoc: 1 }, { word: 'riesling', ndoc: 900 }, { word: 'reislingc', ndoc: 1 }] }))[0]?.word, 'riesling',
    'at equal typos the word MORE docs hold comes first (junk words next to "riesling" never crowd it out)')
  eq(plan('pichler', 'kellerberg', '20').optional.map(g => g.token.w), ['20'], 'a half-typed year as the last word ("…20") is optional, not a required prefix')
  eq(plan('pichler', 'kellerberg', '201').required.map(g => g.token.w), ['pichler', 'kellerberg'], '… "…201" too')
  eq(plan('pichler', 'kellerberg', '18').required.map(g => g.token.w), ['pichler', 'kellerberg', '18'], '… but "18" starts no year in range: a word')
  const kell20 = plan('pichler', 'kell', '20')
  eq([kell20.required.map(g => [g.token.w, g.alts[0].prefix]), kell20.optional.map(g => g.token.w)], [[['pichler', false], ['kell', true]], ['20']],
    'the word still being typed is the last NON-NUMERIC word: "pichler kell 20" keeps "kell" a prefix (re-review)')
  eq(plan('rieslin', '12').required.map(g => [g.token.w, g.alts[0].prefix]), [['rieslin', true], ['12', true]], '… "rieslin 12": "rieslin" a prefix, and the number typed last a prefix too')
  eq(plan('12', 'rieslin').required.map(g => [g.token.w, g.alts[0].prefix]), [['12', false], ['rieslin', true]], '… a number typed earlier is a whole word')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 2 — saturation seeds (raw, docs by the rebuild, as a catalogue load), then the fixture')
  // Inserted FIRST, so in heap order they come before the fixture's docs: an arm
  // that limits before checking eligibility, or a tier that is missing, loses the
  // fixture's wines to these.
  await seed('cuv', 430, { name: g => `Cuvee Seed${g}` })
  await seed('rsl', 430, { name: g => `Riesling Seed${g}` })
  await seed('qrz', 300, { name: g => `Quarzit Seed${g}`, status: g => (g % 3 === 0 ? 'rejected' : g % 3 === 1 ? 'archived' : 'confirmed'), scope: g => (g % 3 === 2 ? 'owned' : 'shared') })
  await seed('glm', 420, { name: g => `Wein ${g}`, producer: g => `Glimmerhof ${g}` })
  await seed('rjx', 420, { name: g => `Kiesel Seed${g}` })
  await db.$executeRawUnsafe(`UPDATE producers SET status = 'rejected' WHERE id LIKE 'b7srjxp%'`)
  await rebuild()
  // Stale docs: no product behind them (a doc the read must never serve).
  await db.$executeRawUnsafe(`INSERT INTO catalog_search_docs (product_id, producer_words, name_words, region_words, tsv_name, tsv)
    SELECT 'b7sstale' || g, '{}', '{quarzit,stale}', '{}', array_to_tsvector('{quarzit,stale}'::text[]), array_to_tsvector('{quarzit,stale}'::text[]) FROM generate_series(1, 150) g`)

  await mint('F.X. Pichler', 'Dürnsteiner Kellerberg Grüner Veltliner Smaragd', { region: 'Wachau', vintages: [[2019, 'confirmed'], [2017, 'archived']] })
  await mint('F.X. Pichler', 'Loibner Berg Riesling', { region: 'Wachau' })
  await mint('Pichler-Krutzler', 'Kellerberg Riesling', { region: 'Wachau', vintages: [[2016, 'rejected'], [2013, 'confirmed']] })
  await mint('Pichler-Krutzler', 'Rothenberg Riesling', { region: 'Wachau' })
  await mint('Rudi Pichler', 'Riesling Federspiel', { region: 'Wachau' })
  await mint('Weingut Pichler', 'Grüner Veltliner Klassik', { region: 'Kremstal' })
  await mint('Josef Pichler', 'Kellerberg Selection', { region: 'Kremstal' })
  await mint('Christoph Hoch', 'Kellerberg Weiss', { region: 'Kremstal' })
  await mint('Christoph Steinmann', 'Riesling Hommage', { region: 'Franken' })
  await mint('Rheinberg Kellerei', 'Kellerberg Rosé', { region: 'Rheinhessen' })
  await mint('Κτήμα Λήμνος', 'Λημνία Γη', { region: 'Lemnos' })
  await mint('Шато Тамань', 'Каберне Резерв', { region: 'Krasnodar' })
  await mint('Château Margaux', 'Pavillon Rouge', { region: 'Margaux' })
  await mint('Château Margaux', 'Château Margaux Grand Vin', { region: 'Margaux' })
  await mint('Château Palmer', 'Alter Ego', { region: 'Margaux' })
  await mint('Weingut Marx', 'Mosel Riesling Trocken', { region: 'Mosel' })
  await mint('Dr. Loosen', 'Erdener Treppchen Kabinett', { region: 'Mosel' })
  await mint('Rotberg', 'Cuvée 2000', { region: 'Pfalz' })
  await mint('Rotberg', 'Cuvée Prestige', { region: 'Pfalz', vintages: [[2000, 'confirmed']] })
  await mint('Domaine', 'Rouge Classique', { region: 'Rhône' })
  await mint('Domaine Quix', 'Riesling Tradition', { region: 'Alsace', vintages: [[2019, 'confirmed']] })
  await mint('Testard', 'Brut NV', { region: 'Champagne' })
  await mint('Testard', 'Brut Rosé', { region: 'Champagne' })
  await mint('Hofgut Mittl', 'Pichlar Reserve', { region: 'Steiermark' })
  await mint('Fels Kellerei', 'Fels Weiss', { region: 'Quarzit Hang' })
  await mint('Fels Kellerei', 'Quarzit Echt', { region: 'Steiermark' })
  await mint('Sauer', 'Weiss vom Ufer', { region: 'Kalmus Ufer' })
  await mint('Fels Kellerei', 'Kiesel Echt', { region: 'Steiermark' })
  await mint('Penfold Haus', 'Bin 389 Cabernet Shiraz', { region: 'Barossa' })
  await mint('Weingut Straß', 'Grauburgunder', { region: 'Baden' })
  await mint('Lindenhof', 'Kabinett Alt', { region: 'Wachau' })
  await mint('Lindenhof', 'Wachauer Kabinett', { region: 'Wachau' })
  await mint('Junk Haus', 'Verworfen Rot', { region: 'Nirgendwo' })
  await db.$executeRawUnsafe(`UPDATE producers SET status = 'rejected' WHERE id = $1`, producers.get('Junk Haus'))
  // A linked vintage (a merged-away year) never counts as the wine having it.
  await db.$executeRawUnsafe(`INSERT INTO wine_vintages (id, product_id, year, status, links_to, curator_locked, created_at, updated_at)
    VALUES ($1, $2::text, 2015, 'linked', (SELECT id FROM wine_vintages WHERE product_id = $2::text AND year = 2013), '{}', now(), now())`, 'b7vlinked2015', P('Pichler-Krutzler', 'Kellerberg Riesling'))

  const KELLERBERG = [P('F.X. Pichler', 'Dürnsteiner Kellerberg Grüner Veltliner Smaragd'), P('Pichler-Krutzler', 'Kellerberg Riesling'), P('Josef Pichler', 'Kellerberg Selection')]
  const PICHLER_WINES = [...products.entries()].filter(([k]) => /^(F\.X\. Pichler|Pichler-Krutzler|Rudi Pichler|Weingut Pichler|Josef Pichler)\|/.test(k)).map(([, v]) => v)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 3 — every typed word must match, any order, prefix, typos')
  let r = await counted(() => bottles('christoph pichler'))
  eq(r.r.results, [], '"christoph pichler" → nothing (no row holds both): "+ New Wine"')
  ok(r.n <= 4, `… in at most 4 statements (sent ${r.n})`)
  ok(sameSet(ids(await bottles('pichler kellerberg')), KELLERBERG), '"pichler kellerberg" → exactly the Pichler Kellerberg wines (no Rheinberg Kellerei, no Christoph Hoch)')
  ok(sameSet(ids(await bottles('kellerberg pichler')), KELLERBERG), '… any order')
  ok(sameSet(ids(await bottles('pichler kellerb')), KELLERBERG), '… the last word a prefix')
  ok(sameSet(ids(await bottles('pichlr kellerberg')), KELLERBERG), '… a typo in a 4–7 letter word (pichlr)')
  eq((await bottles('pichler kellerberg')).results.map(x => x.score), [1, 1, 1], '`score` = the share of typed words the row holds exactly: both → 1')
  eq((await bottles('pichlr kellerberg')).results.map(x => x.score), [0.5, 0.5, 0.5], '… one of two typed exactly (the other a typo) → 0.5')
  eq((await bottles('pichler kellerberg 2019')).results.find(x => x.id === KELLERBERG[0])?.score, 1, '… the year counts when the row has it (3 of 3)')
  eq((await bottles('pichler kellerberg 2019')).results.find(x => x.id === KELLERBERG[2])?.score, 0.667, '… and not when it is only carried (2 of 3)')
  ok(sameSet(ids(await bottles('pichler kellerberg 20')), KELLERBERG) && sameSet(ids(await bottles('pichler kellerberg 201')), KELLERBERG), 'a half-typed year keeps the list (review 2026-11-21)')
  ok(sameSet(ids(await bottles('pichler kell 20')), ids(await bottles('pichler kell'))) && ids(await bottles('pichler kell')).length >= 3, '… also while the word before it is unfinished ("pichler kell 20", re-review)')
  eq(ids(await bottles('penfold bin 38')), [P('Penfold Haus', 'Bin 389 Cabernet Shiraz')], 'a number still being typed ("bin 38" of "bin 389") keeps the list (re-review round 2)')
  const kb = (await T.readWords('pichler kellerb 2019', null)).find(t => t.w === 'kellerb')!
  eq([kb.pre, kb.near.length], [true, 0], 'the prefix check is for the PLAN\'s last word (before a trailing year): no needless typo lookup')
  eq((await bottles('pichler kellerberg')).more, false, '`more` stays false for a list that fits')
  ok(sameSet(ids(await bottles('pichler kelerbreg')), KELLERBERG), '… two typos in an 8+ letter last word (kelerbreg)')
  ok(sameSet(ids(await bottles('pichler kellerberg x')), KELLERBERG), '… a one-letter last word ignored')
  ok(sameSet(ids(await bottles('fx pichler')), [P('F.X. Pichler', 'Dürnsteiner Kellerberg Grüner Veltliner Smaragd'), P('F.X. Pichler', 'Loibner Berg Riesling')]), '"fx pichler" → F.X. Pichler\'s wines')
  ok(sameSet(ids(await bottles('f.x. pichler')), ids(await bottles('fx pichler'))), '"f.x. pichler" = "fx pichler"')
  r = await counted(() => bottles('rudi pichlar'))
  eq(ids(r.r), [P('Rudi Pichler', 'Riesling Federspiel')], '"rudi pichlar": a typo that is ANOTHER doc\'s word (pichlar) is corrected by the empty fallback')
  eq(r.n, 4, '… 4 statements (words, candidates, then both again)')
  ok(FALLBACK_NDOC > 0, `the fallback reads words held by at most ${FALLBACK_NDOC} docs`)
  ok(sameSet(ids(await bottles('λημνα γη')), [P('Κτήμα Λήμνος', 'Λημνία Γη')]), 'a Greek typo (λημνα) on this database\'s ctype')
  ok(sameSet(ids(await bottles('тамань каберне')), [P('Шато Тамань', 'Каберне Резерв')]), 'Cyrillic words match')

  console.log('\n§ 3b — fillers optional, region searchable, the tiers')
  ok(sameSet(ids(await bottles('weingut pichler kellerberg')), KELLERBERG), '"weingut pichler kellerberg": the filler is optional')
  let res = await bottles('pichler weing')
  eq(res.results[0]?.id, P('Weingut Pichler', 'Grüner Veltliner Klassik'), '"pichler weing": a half-typed filler ranks the producer that has it first')
  ok(sameSet(ids(res), PICHLER_WINES), '… and never empties the list (every Pichler wine)')
  res = await bottles('weingutt pichler')
  eq(res.results[0]?.id, P('Weingut Pichler', 'Grüner Veltliner Klassik'), '"weingutt pichler": a typo\'d filler is optional and still ranks')
  ok(sameSet(ids(res), PICHLER_WINES), '… every Pichler wine')
  res = await bottles('domaine')
  ok(res.results.length > 0 && res.results.every(x => /domaine/i.test(`${x.producerName} ${x.name}`)), '"domaine" alone: only rows holding it')
  ok(ids(res).includes(P('Domaine', 'Rouge Classique')), '… a producer that is only a filler word is found')
  ok(sameSet(ids(await bottles('pichler kellerberg wachau')), KELLERBERG.slice(0, 2)), '"pichler kellerberg wachau": the region is a word (Josef Pichler is in Kremstal)')
  res = await bottles('chateau margaux')
  ok(sameSet(ids(res).slice(0, 2), [P('Château Margaux', 'Pavillon Rouge'), P('Château Margaux', 'Château Margaux Grand Vin')]), '"chateau margaux": Château Margaux\'s own wines first')
  ok(ids(res).includes(P('Château Palmer', 'Alter Ego')), '… a Margaux-region wine of another château after them')
  res = await bottles('mosel')
  eq(res.results[0]?.id, P('Weingut Marx', 'Mosel Riesling Trocken'), '"mosel": the name match before the region-only match')
  ok(ids(res).includes(P('Dr. Loosen', 'Erdener Treppchen Kabinett')), '… the region-only match still listed')

  console.log('\n§ 3c — the year')
  res = await bottles('pichler kellerberg 2019')
  ok(sameSet(ids(res), KELLERBERG), 'a typed year is never required (every Kellerberg wine shows)')
  eq(res.results[0]?.id, KELLERBERG[0], '… the wine that HAS the year first')
  ok(res.results.every(x => x.year === 2019), '… every row carries it (picking fills the year field)')
  eq((await bottles('pichler kellerberg 2017')).results[0]?.id, KELLERBERG[0], 'an ARCHIVED vintage counts (the lookup\'s statuses)')
  eq((await bottles('pichler kellerberg')).results[0]?.id, KELLERBERG[2], 'baseline: with no year, the fewest untyped words first (Josef Pichler)')
  eq((await bottles('pichler kellerberg 2016')).results[0]?.id, KELLERBERG[2], 'a REJECTED vintage does not count (Pichler-Krutzler\'s 2016 does not lift it)')
  eq((await bottles('pichler kellerberg 2015')).results[0]?.id, KELLERBERG[2], 'a LINKED vintage does not count')
  res = await bottles('cuvee 2000')
  eq(res.results[0]?.id, P('Rotberg', 'Cuvée 2000'), '"cuvee 2000": the wine NAMED 2000 first, among 430 other cuvées (arm y)')
  eq(res.results[0]?.year, null, '… and 2000 is not carried onto it (its own name holds it)')
  res = await bottles('rotberg cuvee 2000')
  eq(res.results.map(x => [x.id, x.year]), [[P('Rotberg', 'Cuvée 2000'), null], [P('Rotberg', 'Cuvée Prestige'), 2000]], '"rotberg cuvee 2000": the named one first, the one that HAS the vintage carries it')
  eq((await bottles('domaine cuvee 2000')).results[0]?.id, P('Rotberg', 'Cuvée 2000'), '"domaine cuvee 2000": the year tier keeps fillers out (Rotberg has no "domaine")')
  eq((await bottles('domaine riesling 2019')).results[0]?.id, P('Domaine Quix', 'Riesling Tradition'), '"domaine riesling 2019": the filler tier holds without the year (430 other rieslings)')
  ok(ids(await bottles('chateau 20')).includes(P('Château Margaux', 'Pavillon Rouge')), '"chateau 20": a Château wine with no word starting "20" still shows (Codex)')
  res = await bottles('chateau 2019')
  ok(res.results.length > 0 && res.results.every(x => x.year === 2019 && /ch[aâ]teau/i.test(`${x.producerName} ${x.name}`)), '"chateau 2019": the filler searched, the year carried')
  eq((await bottles('pichler 2019 kellerberg')).results[0]?.id, KELLERBERG[0], 'the year anywhere in the query')
  res = await bottles('lindenhof wachau')
  eq(res.results[0]?.id, P('Lindenhof', 'Wachauer Kabinett'), 'a full word in the region and a prefix in the name both count (the row holding more ranks first)')
  eq(ids(await bottles('junk haus')), [], '🔒 a REJECTED producer\'s name finds none of its wines')
  eq(ids(await bottles('verworfen rot')), [], '… nor does the wine\'s own name (a junk verdict has left the catalogue)')
  eq(ids(await bottles('kiesel')), [P('Fels Kellerei', 'Kiesel Echt')], '… 420 wines of rejected producers never hide a live one')
  {
    const kp = T.planQuery(await T.readWords('kiesel', null), true)!
    const kc = T.bottleCandidatesSql(kp)
    const raw = await app.$queryRawUnsafe<{ producerStatus: string }[]>(kc.sql, ...kc.args)
    eq(raw.filter(r => r.producerStatus === 'rejected').length, 0, '… checked INSIDE each arm, before its limit: the candidates statement returns none of them')
  }
  res = await bottles('riesling seed1')
  ok(res.results.length === 20 && res.more, `more than 20 live matches, none of the 401 caps hit: \`more\` (${res.results.length} shown)`)
  res = await bottles('testard nv')
  eq(res.results.map(x => x.id), [P('Testard', 'Brut NV'), P('Testard', 'Brut Rosé')], '"nv" ranks the NV wine first and is never required')

  console.log('\n§ 3d — caps: refused, never cut')
  const sixteen = ['pichler', 'kellerberg', ...Array(SEARCH_MAX_WORDS - 2).fill('pichler')].join(' ')
  res = await bottles(sixteen)
  ok(!res.tooLong && sameSet(ids(res), KELLERBERG), `${SEARCH_MAX_WORDS} words answer`)
  res = await bottles(`${sixteen} pichler`)
  eq([res.tooLong, res.results], [true, []], `${SEARCH_MAX_WORDS + 1} words are refused (tooLong)`)
  const long = 'pichler '.repeat(Math.ceil((SEARCH_MAX_CHARS + 1) / 8)).trim()
  r = await counted(() => bottles(long))
  eq([r.r.tooLong, r.r.results, r.n], [true, [], 0], `over ${SEARCH_MAX_CHARS} characters is refused before any statement (never sliced)`)
  eq((await bottles('pi')).results, [], 'under 3 characters: nothing')

  console.log('\n§ 3e — the word list never decides whether a wine is found')
  await rebuild()
  const wordsBefore = (await db.$queryRawUnsafe<{ word: string; ndoc: number }[]>(`SELECT word, ndoc FROM catalog_search_words WHERE word IN ('kellerberg','pichler','josef','selection','kremstal')`))
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word IN ('kellerberg','pichler','josef','selection','kremstal')`)
  ok(sameSet(ids(await bottles('pichler kellerberg')), KELLERBERG), 'words missing from the list (publication failed) still match')
  ok(sameSet(ids(await bottles('josef pichler kellerberg selection')), [KELLERBERG[2]]), '… four missing words too')
  await db.$executeRawUnsafe(`INSERT INTO catalog_search_words (word, ndoc) SELECT x.word, x.ndoc FROM unnest($1::text[], $2::int[]) AS x(word, ndoc)`, wordsBefore.map(w => w.word), wordsBefore.map(w => w.ndoc))
  await db.$executeRawUnsafe(`INSERT INTO catalog_search_words (word, ndoc) VALUES ('kelerbergx', 1)`)
  r = await counted(() => bottles('pichler kelerberg'))
  ok(sameSet(ids(r.r), KELLERBERG), 'a stale prefix word (kelerbergx) does not block the correction of "kelerberg" (fallback)')
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'kelerbergx'`)
  // Junk words minted next to "riesling" (one doc each) never crowd it out of a
  // typo's alternatives, and a word only REJECTED entries hold steers nothing.
  await db.$executeRawUnsafe(`INSERT INTO catalog_search_words (word, ndoc) SELECT 'reisling' || chr(96 + g), 1 FROM generate_series(1, 9) g ON CONFLICT DO NOTHING`)
  ok(ids(await bottles('rudi reisling')).includes(P('Rudi Pichler', 'Riesling Federspiel')), 'nine junk words nearer to "reisling" than "riesling": the typo still finds the Riesling')
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word ~ '^reisling[a-i]$'`)
  eq((await db.$queryRawUnsafe<{ ndoc: number }[]>(`SELECT ndoc FROM catalog_search_words WHERE word = 'verworfen'`))[0]?.ndoc, 0, 'the rebuild counts LIVE docs only: a word only a rejected producer\'s wine holds counts 0')
  ok(!(await T.readWords('verworfem kabinett', null))[0].near.some(n => n.word === 'verworfen'), '… and is never offered as a typo alternative')
  const toks = await T.readWords('qzvx qzvy qzvw qzvk pichler', null)
  eq(toks.map(t => t.near.length > 0), [true, true, true, false, false], 'the typo lookup runs for at most the first 3 unknown words, never for a known one')
  ok(toks.slice(0, 3).every(t => t.near.length <= 30), '… at most 30 nearest words each')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 4 — live eligibility, saturation, the arms')
  res = await bottles('quarzit')
  ok(sameSet(ids(res), [P('Fels Kellerei', 'Quarzit Echt'), P('Fels Kellerei', 'Fels Weiss')]),
    'SATURATION: 300 rejected / archived / owned / live-seed docs + 150 stale docs, the eligible wines (a regional match included) still returned')
  const qrzLive = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM wine_products WHERE id LIKE 'b7sqrz%' AND status = 'confirmed' AND scope = 'shared'`))[0].n
  eq(qrzLive, 0, 'the quarzit seeds are all excluded (rejected, archived or owned)')
  ok(!ids(await bottles('quarzit stale')).length, 'a stale doc (no product behind it) is never served')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 5 — merges resolve at read time (tombstones written raw: no writer before phase 3)')
  const alderReserve = await mint('Alder Hof', 'Reserve Speciale')
  const birchSelection = await mint('Birch Hof', 'Selection Maison')
  const ulme = [await mint('Ulme Kellerei', 'Vieux Grand'), await mint('Ulme Kellerei', 'Vieux Grand Clos Extra')]
  const ulmeSurvivor = await mint('Ulme Kellerei', 'Grand Cru Maison')
  const ulmeOther = await mint('Ulme Kellerei', 'Vieux Grand Reserve')
  const tann = await mint('Tannberg', 'Cuvée 2000', { vintages: [[2000, 'confirmed']] })
  const tannSurvivor = await mint('Tannberg', 'Grand Vin', { vintages: [[2000, 'confirmed']] })
  const secret = await mint('Ulme Kellerei', 'Geheim Blend')
  const open = await mint('Ulme Kellerei', 'Offen Blend')
  const kalmusBrut = await mint('Sauer', 'Kalmus Brut')
  const kalmusTomb = await mint('Sauer', 'Kalmus Bruut')
  const kalmusArch = await mint('Sauer', 'Kalmus Classic')
  const glimmerSurvivor = (await app.$transaction(tx => createProducer({ name: 'Glimmer Estate Main', website: MARK }, null, tx))).id
  const glimmerAlias = (await app.$transaction(tx => createProducer({ name: 'Glimmerhof', website: MARK }, null, tx))).id
  // The merges, as a phase-3 writer would: the row rule, the source rows, then
  // the affected docs re-indexed (lib/CLAUDE.md § phase 3 rule).
  await app.$transaction(async (tx) => {
    const alder = producers.get('Alder Hof')!, birch = producers.get('Birch Hof')!
    await lockForSearchDoc(tx, [alder, birch, producers.get('Ulme Kellerei')!, producers.get('Tannberg')!, producers.get('Sauer')!, glimmerAlias, glimmerSurvivor],
      [alderReserve, birchSelection, ...ulme, ulmeSurvivor, tann, tannSurvivor, secret, open, kalmusTomb, kalmusArch], [alder, glimmerAlias])
    await tx.$executeRawUnsafe(`UPDATE producers SET status = 'linked', links_to = $2 WHERE id = $1`, alder, birch)
    await tx.$executeRawUnsafe(`UPDATE producers SET status = 'linked', links_to = $2 WHERE id = $1`, glimmerAlias, glimmerSurvivor)
    for (const [from, to] of [[alderReserve, birchSelection], [ulme[0], ulmeSurvivor], [ulme[1], ulmeSurvivor], [tann, tannSurvivor], [secret, open], [kalmusTomb, kalmusArch]]) {
      await tx.$executeRawUnsafe(`UPDATE wine_products SET status = 'linked', links_to = $2 WHERE id = $1`, from, to)
    }
    await tx.$executeRawUnsafe(`UPDATE wine_products SET scope = 'owned' WHERE id = $1`, secret)
    await tx.$executeRawUnsafe(`UPDATE wine_products SET status = 'archived' WHERE id = $1`, kalmusArch)
    for (const id of [alderReserve, birchSelection]) await indexProduct(tx, id)
    await indexProducer(tx, alder)
  })
  res = await bottles('alder reserve')
  eq(res.results.map(x => [x.id, x.producerId, x.producerName]), [[birchSelection, producers.get('Birch Hof'), 'Birch Hof']],
    'COMPOSED merges: "alder reserve" (Alder → Birch, Reserve → Selection) finds Reserve\'s own doc, resolves to Selection, effective producer reported')
  eq(ids(await bottles('birch reserve')), [birchSelection], 'the survivor\'s name + a loser\'s wine finds it (the doc carries the survivor\'s words)')
  eq(ids(await bottles('reserve speciale')), [birchSelection], 'a merged-away product\'s name finds the survivor')
  eq((await searchProducers('alder hof')).results.map(x => x.id), [producers.get('Birch Hof')], 'a merged-away producer\'s name finds the survivor (producer search)')
  res = await bottles('vieux grand')
  eq(ids(res).slice(0, 2), [ulmeSurvivor, ulmeOther], 'the BEST alias\'s rank survives the de-dup (Vieux Grand, not Vieux Grand Clos Extra)')
  res = await bottles('tannberg cuvee 2000')
  eq(res.results.map(x => [x.id, x.year]), [[tannSurvivor, null]], '"Cuvée 2000" merged into "Grand Vin": the year decision is the MATCHED row\'s (2000 not carried)')
  ok(!ids(await bottles('geheim blend')).includes(open), 'an OWNED alias never matches, whatever its survivor')
  res = await bottles('kalmus')
  ok(ids(res).includes(P('Sauer', 'Weiss vom Ufer')) && !res.more, 'a few tombstones whose survivors are excluded neither suppress arm (c) (the regional match shows) nor set `more`')
  ok(ids(await bottles('kalmus bruut')).includes(kalmusBrut), 'an exact-word tombstone with an archived survivor is dropped AFTER resolution, so the fallback still corrects "bruut"')
  eq((await searchProducers('glimmerhof')).results[0]?.id, glimmerSurvivor, 'an exact merged producer alias outside the candidate cap (420 Glimmerhof N) is kept by the exact arm and resolved')

  console.log('\n§ 5b — mixed saturation: tombstones + live rows in one arm')
  // Exactly 401 docs named "nebelung": 398 live + 3 tombstones, so arm (b) holds
  // all of them; its 401 must not count the tombstones as live rows.
  await seed('neb', 398, { name: g => `Nebelung Seed${g}` })
  await seed('nbt', 3, { name: g => `Nebelung Tomb${g}` })
  await seed('nbs', 3, { name: g => `Survivor ${g}`, status: () => 'archived' })
  await rebuild()
  for (let g = 1; g <= 3; g++) await db.$executeRawUnsafe(`UPDATE wine_products SET status = 'linked', links_to = $2 WHERE id = $1`, `b7snbtw0000${g}`, `b7snbsw0000${g}`)
  await mint('Nebelhaus', 'Fass', { region: 'Nebelung Tal' })
  const nebPlan = T.planQuery(await T.readWords('nebelung', null), true)!
  const nebSql = T.bottleCandidatesSql(nebPlan)
  const nebRows = await app.$queryRawUnsafe<{ nb: number; nc: number }[]>(nebSql.sql, ...nebSql.args)
  eq(nebRows[0].nb, 401, 'arm (b) hit its limit')
  ok(nebRows[0].nc > 0, `… and arm (c) RAN (${nebRows[0].nc} rows): 3 of the 401 are tombstones, so (b) does not hold 401 live rows`)
  const linkedInB = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM wine_products WHERE id LIKE 'b7snbt%' AND status = 'linked'`))[0].n
  eq(linkedInB, 3, 'three tombstones among them')
  ok((await bottles('nebelung')).more, '`more`: the server stopped early')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 6 — the writers keep the docs current')
  let inTx: number | null = null
  let txOf: Tx | null = null
  const fresh = await app.$transaction(async (tx) => {
    txOf = tx
    const pid = (await createProducer({ name: 'Zwielicht Weinhaus', website: MARK }, null, tx)).id
    producers.set('Zwielicht Weinhaus', pid)
    const id = (await createProduct({ name: 'Morgenrot Spätlese', producerId: pid, region: 'Nahe' }, null, [], tx)).id
    inTx = (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM catalog_search_docs WHERE product_id = $1 AND tsv_name @@ '''morgenrot'' & ''zwielicht'''::tsquery`, id))[0].n
    ok(!(await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM catalog_search_words WHERE word = 'morgenrot'`)).length, 'a mint\'s words are not published before its COMMIT')
    return id
  })
  eq(inTx, 1, 'a mint\'s doc exists in its OWN transaction (findable the moment it commits)')
  eq(ids(await bottles('zwielicht morgenrot')), [fresh], '… and after the COMMIT')
  await publishSearchWords(txOf)
  ok((await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM catalog_search_words WHERE word = 'morgenrot'`)).length === 1, '… its new words published after it (publishSearchWords)')
  let rolled: Tx | null = null
  await app.$transaction(async (tx) => {
    rolled = tx
    const pid = (await createProducer({ name: 'Abendgrau Kellerei', website: MARK }, null, tx)).id
    await createProduct({ name: 'Nachtblau', producerId: pid }, null, [], tx)
    throw new Error('rollback')
  }).catch(() => {})
  ok(!(await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM catalog_search_docs d JOIN wine_products wp ON wp.id = d.product_id WHERE wp.name = 'Nachtblau'`)).length, 'a rolled-back mint leaves no doc')
  void rolled
  // The bottle routes' and the check-ins' transaction owners publish too (static
  // pins: each owner calls publishSearchWords after its $transaction).
  const { readFileSync } = await import('node:fs')
  for (const f of ['lib/sessionMutation.ts', 'app/api/checkins/route.ts', 'app/api/checkins/[id]/route.ts', 'lib/catalogAddFlow.ts']) {
    ok(/publishSearchWords\(/.test(readFileSync(f, 'utf8')), `${f} publishes a mint's words after its COMMIT`)
  }
  // Concurrent publications with overlapping new words: sorted inserts, no 40P01.
  const pool = Array.from({ length: 40 }, (_, i) => `ueberlapp${i}`)
  const shuffled = () => [...pool].sort(() => Math.random() - 0.5).slice(0, 30)
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => addWords(shuffled())))
  eq(results.filter(x => x.status === 'rejected').length, 0, 'eight concurrent word publications with overlapping words: no deadlock, no error')
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word LIKE 'ueberlapp%'`)
  // A word at 0 (no live doc held it) is lifted to 1 by a new mint's words, so
  // the typo lookup offers it again at once.
  await db.$executeRawUnsafe(`INSERT INTO catalog_search_words (word, ndoc) VALUES ('zzwiederda', 0) ON CONFLICT (word) DO UPDATE SET ndoc = 0`)
  await addWords(['zzwiederda'])
  eq((await db.$queryRawUnsafe<{ ndoc: number }[]>(`SELECT ndoc FROM catalog_search_words WHERE word = 'zzwiederda'`))[0]?.ndoc, 1, 'a mint\'s word that sat at 0 is lifted to 1 (offered as a typo again)')
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'zzwiederda'`)
  // A word publication never waits long on a rebuild holding the same new word.
  {
    await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'zzschwebend'`)
    const held = gate(), started = gate()
    const holder = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO catalog_search_words (word, ndoc) VALUES ('zzschwebend', 1)`)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    const t0 = performance.now()
    const r2 = await Promise.race([addWords(['zzschwebend']).then(() => 'ok', () => 'gave up'), sleep(6000).then(() => 'still waiting')])
    const waited = performance.now() - t0
    held.open(); await holder.catch(() => {})
    ok(r2 === 'gave up' && waited < 4000, `a publication blocked by an uncommitted insert of its word gives up after the lock timeout (${waited.toFixed(0)} ms), it does not wait for the holder`)
    await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'zzschwebend'`)
  }
  // A publication never runs inside a rebuild (the shared catalog-search lock):
  // during one it gives up after the lock timeout instead of interleaving.
  {
    const held = gate(), started = gate()
    const reb = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CATALOG_SEARCH_LOCK}'))`)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    const t0 = performance.now()
    const r3 = await Promise.race([addWords(['zzwaehrend']).then(() => 'published', () => 'gave up'), sleep(6000).then(() => 'still waiting')])
    const waited = performance.now() - t0
    held.open(); await reb.catch(() => {})
    ok(r3 === 'gave up' && waited < 4000, `a word publication during a rebuild waits for its lock and gives up (${r3}, ${waited.toFixed(0)} ms): it never interleaves with the rebuild's word steps`)
    await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'zzwaehrend'`)
  }
  // A mint's publication never locks a COMMON word's row (only new or zero-count
  // words reach the INSERT's conflict path): a row held elsewhere never stalls it.
  {
    const held = gate(), started = gate()
    const lockHolder = app.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT word FROM catalog_search_words WHERE word = 'pichler' FOR UPDATE`)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    const t0 = performance.now()
    const r4 = await Promise.race([addWords(['pichler', 'zzneuwort']).then(() => 'published', () => 'gave up'), sleep(6000).then(() => 'still waiting')])
    const waited = performance.now() - t0
    held.open(); await lockHolder.catch(() => {})
    const got = (await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM catalog_search_words WHERE word = 'zzneuwort'`)).length
    ok(r4 === 'published' && got === 1 && waited < 1500, `a publication with a common word whose row is locked elsewhere goes through at once (${r4}, ${waited.toFixed(0)} ms)`)
    await db.$executeRawUnsafe(`DELETE FROM catalog_search_words WHERE word = 'zzneuwort'`)
  }
  // A user's mint against that user's account deletion: no deadlock (the
  // mint takes the user row before the producer row).
  {
    const [u] = await db.$queryRawUnsafe<{ id: number }[]>(`INSERT INTO users (name, email) VALUES ('B7 Gone', $1) RETURNING id`, `b7gone-${Date.now()}@local.test`)
    const pid = (await app.$transaction(tx => createProducer({ name: 'Ulmenhof Gone', website: MARK }, u.id, tx))).id
    const blocker = gate(), blocking = gate()
    // A table lock pauses the mint at its product INSERT, after its first locks.
    const hold = app.$transaction(async (tx) => { await tx.$executeRawUnsafe('LOCK TABLE wine_products IN SHARE MODE'); blocking.open(); await blocker.wait() }, { timeout: 30_000 })
    await blocking.wait()
    let mintErr: unknown = null, delErr: unknown = null
    const mintP = app.$transaction(tx => createProduct({ name: 'Ulmenwein', producerId: pid }, u.id, [], tx), { timeout: 30_000 }).catch(e => { mintErr = e })
    await sleep(300)
    const delP = db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, u.id).catch(e => { delErr = e })
    await sleep(300)
    blocker.open()
    await Promise.all([hold, mintP, delP])
    const msg = (e: unknown) => String((e as Error | null)?.message ?? '')
    ok(!msg(mintErr).includes('40P01') && !msg(delErr).includes('deadlock') && !msg(mintErr).includes('deadlock'), `a user's mint vs that user's account deletion: no deadlock (${msg(mintErr).slice(0, 60) || 'mint ok'} / ${msg(delErr).slice(0, 60) || 'delete ok'})`)
    await db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, u.id).catch(() => {})
  }
  // A purge deletes the doc.
  const purged = await mint('Zwielicht Weinhaus', 'Vergessen')
  const { purgeProduct } = await import('../../lib/catalogWrite.ts')
  await app.$transaction(tx => purgeProduct(tx, purged), { timeout: 30_000 })
  eq((await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM catalog_search_docs WHERE product_id = $1`, purged)).length, 0, 'a purged product\'s doc is gone')

  console.log('\n§ 6b — rebuild ≡ the incremental state (docs only)')
  await db.$executeRawUnsafe(`DELETE FROM catalog_search_docs WHERE product_id LIKE 'b7sstale%'`)
  // The tombstones above were written raw and only the Alder / Birch docs
  // re-indexed (the rest keep their own words: a product merge changes no doc).
  const driftOf = () => app.$transaction(async (tx) => { throw Object.assign(new Error('rollback'), { d: await catalogSearchDrift(tx) }) }, { timeout: 120_000 })
    .catch((e: { d?: Drift }) => { if (!e.d) throw e; return e.d })
  const drift = await driftOf()
  eq([drift.missingDocs, drift.differentDocs, drift.staleDocs, drift.missingProducerDocs, drift.differentProducerDocs, drift.staleProducerDocs],
    [0, 0, 0, 0, 0, 0], 'every doc the writers wrote is what a rebuild would write (the drift report is clean)')
  // A raw rename (an outside writer) shows up as drift, then the rebuild fixes it.
  await db.$executeRawUnsafe(`UPDATE wine_products SET name = 'Morgengrau Spätlese' WHERE id = $1`, fresh)
  const drift2 = await driftOf()
  eq([drift2.differentDocs, drift2.sample.includes(`different:${fresh}`)], [1, true], 'an outside rename is reported by the drift report (ids only)')
  eq(ids(await bottles('zwielicht morgengrau')), [], '… and is not findable by its new name until the rebuild (never a wrong wine: the read joins live)')
  eq((await bottles('zwielicht morgenrot')).results.map(x => x.name), ['Morgengrau Spätlese'], '… its old words still find it, under the LIVE name')
  await rebuild()
  eq(ids(await bottles('zwielicht morgengrau')), [fresh], 'after the rebuild the new name finds it')
  // A status-only change (an entry rejected behind our back) changes no doc,
  // only which words may steer a typo: `staleWordCounts`.
  const lonely = await mint('Einsiedel Hof', 'Einzelstueck Weiss')
  await rebuild()
  await db.$executeRawUnsafe(`UPDATE wine_products SET status = 'rejected' WHERE id = $1`, lonely)
  const drift3 = await driftOf() as Drift & { staleWordCounts: number }
  ok(drift3.staleWordCounts >= 1 && drift3.differentDocs === 0, `a rejection behind our back: no new different doc, the drift report counts the words it affects (${drift3.staleWordCounts})`)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 7 — paused schedules (the row rule)')
  // A producer rename the way phase 3 will write one: the producer FOR UPDATE,
  // its products listed in a FRESH statement after the wait, locked, the source
  // changed, the docs recomputed.
  async function renameProducer(tx: Tx, pid: string, name: string, between?: () => Promise<void>) {
    await lockForSearchDoc(tx, [pid], [], [pid])
    const prods = (await tx.$queryRawUnsafe<{ product_id: string }[]>(`SELECT product_id FROM product_producers WHERE producer_id = $1 AND role = 'lead'`, pid)).map(x => x.product_id)
    await lockForSearchDoc(tx, [], prods)
    await tx.$executeRawUnsafe(`UPDATE producers SET name = $2 WHERE id = $1`, pid, name)
    for (const id of prods) await indexProduct(tx, id)
    await indexProducer(tx, pid)
    if (between) await between()
  }
  const wordsOf = async (id: string) => (await db.$queryRawUnsafe<{ w: string[] }[]>(`SELECT producer_words AS w FROM catalog_search_docs WHERE product_id = $1`, id))[0]?.w
  for (const order of ['rename first', 'mint first'] as const) {
    const pid = (await app.$transaction(tx => createProducer({ name: `Ahorn ${order === 'rename first' ? 'Eins' : 'Zwei'}`, website: MARK }, null, tx))).id
    const held = gate(), started = gate()
    let minted = ''
    let err: unknown = null
    if (order === 'rename first') {
      const a = app.$transaction(tx => renameProducer(tx, pid, 'Eiche Neu', async () => { started.open(); await held.wait() }), { timeout: 20_000 })
      await started.wait()
      let bDone = false
      const b = app.$transaction(tx => createProduct({ name: 'Linde', producerId: pid }, null, [], tx), { timeout: 20_000 }).then(x => { bDone = true; minted = x.id })
      await sleep(400)
      ok(!bDone, 'rename first: the mint WAITS on the renamed producer (FOR SHARE vs FOR UPDATE)')
      held.open()
      await Promise.all([a, b]).catch(e => { err = e })
    } else {
      const b = app.$transaction(async (tx) => { const x = await createProduct({ name: 'Linde', producerId: pid }, null, [], tx); minted = x.id; started.open(); await held.wait() }, { timeout: 20_000 })
      await started.wait()
      let aDone = false
      const a = app.$transaction(tx => renameProducer(tx, pid, 'Eiche Neu'), { timeout: 20_000 }).then(() => { aDone = true })
      await sleep(400)
      ok(!aDone, 'mint first: the rename WAITS on the mint\'s FOR SHARE')
      held.open()
      await Promise.all([a, b]).catch(e => { err = e })
    }
    eq(err, null, `${order}: both commit`)
    eq(await wordsOf(minted), ['eiche', 'neu'], `${order}: the new wine's doc carries the RENAMED producer (no stale doc)`)
  }
  // The mint's OWN lock (FOR SHARE on its lead) is what protects it from a
  // writer that holds only the lock a plain UPDATE takes (FOR NO KEY UPDATE, which
  // the foreign key's KEY SHARE does not wait for): the UPDATE first, then its
  // products listed and re-indexed, all before the mint could commit.
  {
    const pid = (await app.$transaction(tx => createProducer({ name: 'Ahorn Drei', website: MARK }, null, tx))).id
    const held = gate(), started = gate()
    let minted = ''
    const a = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE producers SET name = 'Eiche Neu' WHERE id = $1`, pid)
      const prods = (await tx.$queryRawUnsafe<{ product_id: string }[]>(`SELECT product_id FROM product_producers WHERE producer_id = $1 AND role = 'lead'`, pid)).map(x => x.product_id)
      for (const id of prods) await indexProduct(tx, id)
      await indexProducer(tx, pid)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    const b = app.$transaction(tx => createProduct({ name: 'Linde', producerId: pid }, null, [], tx), { timeout: 20_000 }).then(x => { minted = x.id })
    await sleep(400)
    held.open()
    await Promise.all([a, b])
    eq(await wordsOf(minted), ['eiche', 'neu'], 'a plain UPDATE of the lead (no row rule on its side): the mint\'s own FOR SHARE waits for it, so its doc carries the new name')
  }
  // A merge chain that moves while its rows are being locked: the writer must
  // not lock the newly found (lower-sorted) row after a higher one; it is told
  // to retry (Codex 2026-11-21).
  {
    await db.$executeRawUnsafe(`INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at) VALUES ('b7slocka', 'Lock A', 'confirmed', '{}', now(), now()), ('b7slockb', 'Lock B', 'confirmed', '{}', now(), now()) ON CONFLICT DO NOTHING`)
    const held = gate(), started = gate()
    const merge = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM producers WHERE id = 'b7slockb' FOR UPDATE`)
      await tx.$executeRawUnsafe(`UPDATE producers SET status = 'linked', links_to = 'b7slocka' WHERE id = 'b7slockb'`)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    let outcome = ''
    const rename = app.$transaction(tx => lockForSearchDoc(tx, ['b7slockb'], [], ['b7slockb']), { timeout: 20_000 })
      .then(() => { outcome = 'locked out of order' }, (e: unknown) => { outcome = e instanceof SearchLockRetry ? 'retry' : `error ${(e as Error).message}` })
    await sleep(300)
    held.open()
    await Promise.all([merge, rename])
    eq(outcome, 'retry', 'a chain that moved during the wait (B merged into A, A < B): SearchLockRetry, never A locked after B')
    await db.$executeRawUnsafe(`UPDATE producers SET status = 'confirmed', links_to = NULL WHERE id = 'b7slockb'`)
  }
  // A chain REPLACED during the wait (Codex r2): 1 → 5 becomes 1 → 3 while the
  // writer waits on 1; it locked 1 and 5, so 3 could only come after 5.
  {
    await db.$executeRawUnsafe(`INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at) VALUES
      ('b7slk3', 'Lock 3', 'confirmed', '{}', now(), now()), ('b7slk5', 'Lock 5', 'confirmed', '{}', now(), now()) ON CONFLICT DO NOTHING`)
    await db.$executeRawUnsafe(`INSERT INTO producers (id, name, status, links_to, curator_locked, created_at, updated_at) VALUES
      ('b7slk1', 'Lock 1', 'linked', 'b7slk5', '{}', now(), now()) ON CONFLICT DO NOTHING`)
    const held = gate(), started = gate()
    const remerge = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM producers WHERE id = 'b7slk1' FOR UPDATE`)
      await tx.$executeRawUnsafe(`UPDATE producers SET links_to = 'b7slk3' WHERE id = 'b7slk1'`)
      started.open(); await held.wait()
    }, { timeout: 20_000 })
    await started.wait()
    let outcome = ''
    const writer = app.$transaction(tx => lockForSearchDoc(tx, ['b7slk1'], []), { timeout: 20_000 })
      .then(() => { outcome = 'locked out of order' }, (e: unknown) => { outcome = e instanceof SearchLockRetry ? 'retry' : `error ${(e as Error).message}` })
    await sleep(300)
    held.open()
    await Promise.all([remerge, writer])
    eq(outcome, 'retry', 'a chain replaced during the wait (1 → 5 became 1 → 3): SearchLockRetry, never 3 locked after 5')
    await db.$executeRawUnsafe(`UPDATE producers SET status = 'confirmed', links_to = NULL WHERE id = 'b7slk1'`)
  }
  for (const order of ['product edit first', 'producer rename first'] as const) {
    const pid = (await app.$transaction(tx => createProducer({ name: `Kastanie ${order.length}`, website: MARK }, null, tx))).id
    const xid = (await app.$transaction(tx => createProduct({ name: 'Alt Name', producerId: pid }, null, [], tx))).id
    const editProduct = (tx: Tx, between?: () => Promise<void>) => (async () => {
      await lockForSearchDoc(tx, [pid], [xid])
      await tx.$executeRawUnsafe(`UPDATE wine_products SET name = 'Neu Name' WHERE id = $1`, xid)
      await indexProduct(tx, xid)
      if (between) await between()
    })()
    const held = gate(), started = gate()
    let err: unknown = null
    const first = order === 'product edit first'
      ? app.$transaction(tx => editProduct(tx, async () => { started.open(); await held.wait() }), { timeout: 20_000 })
      : app.$transaction(tx => renameProducer(tx, pid, 'Buche Neu', async () => { started.open(); await held.wait() }), { timeout: 20_000 })
    await started.wait()
    const second = order === 'product edit first'
      ? app.$transaction(tx => renameProducer(tx, pid, 'Buche Neu'), { timeout: 20_000 })
      : app.$transaction(tx => editProduct(tx), { timeout: 20_000 })
    await sleep(300)
    held.open()
    await Promise.all([first, second]).catch(e => { err = e })
    eq(String((err as Error | null)?.message ?? '').includes('40P01') ? 'deadlock' : err, null, `${order}: both complete, no 40P01`)
    const doc = (await db.$queryRawUnsafe<{ p: string[]; n: string[] }[]>(`SELECT producer_words AS p, name_words AS n FROM catalog_search_docs WHERE product_id = $1`, xid))[0]
    eq([doc.p, doc.n], [['buche', 'neu'], ['neu', 'name']], `${order}: the one doc both feed carries BOTH changes`)
  }
  // A curator (shared lock first, then its row), a rebuild (exclusive) and an
  // import ending with a rebuild (exclusive at entry): no cycle.
  {
    const pid = producers.get('Testard')!
    const held = gate(), started = gate()
    const curator = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext('${CATALOG_SEARCH_LOCK}'))`)
      await lockForSearchDoc(tx, [pid], [], [pid])
      started.open(); await held.wait()
    }, { timeout: 30_000 })
    await started.wait()
    const reb = app.$transaction(tx => rebuildCatalogSearch(tx), { timeout: 60_000 })
    const imp = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CATALOG_SEARCH_LOCK}'))`)
      await tx.$queryRawUnsafe(`SELECT id FROM producers WHERE id = $1 FOR UPDATE`, pid)
    }, { timeout: 60_000 })
    await sleep(300)
    held.open()
    const all = await Promise.allSettled([curator, reb, imp])
    eq(all.map(x => x.status), ['fulfilled', 'fulfilled', 'fulfilled'], 'curator (shared first) + rebuild + import (exclusive first): all complete, no cycle')
  }
  // A rebuild in progress never blocks a search.
  {
    const held = gate(), started = gate()
    const reb = app.$transaction(async (tx) => { await rebuildCatalogSearch(tx); started.open(); await held.wait() }, { timeout: 60_000 })
    await started.wait()
    const t0 = performance.now()
    const during = await bottles('pichler kellerberg')
    const ms = performance.now() - t0
    ok(sameSet(ids(during), KELLERBERG) && ms < 2000, `a search while a rebuild holds its transaction open answers (${ms.toFixed(0)} ms)`)
    held.open(); await reb
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 8 — plans on an ANALYZEd 30k fixture, through the app\'s client')
  await seed('pln', 30000, { name: g => `Planwein ${(g * 2654435761 % 4294967296).toString(36)}`, producer: g => `Planhaus ${(g * 40503 % 65536).toString(36)}`, region: g => `Planregion${g % 300}` })
  await rebuild()
  // ⚠️ The CATALOGUE tables too: with stale statistics after the bulk seed the
  // planner believed wine_products held 23 rows and drove the arm from it,
  // probing 31,726 docs one by one (fresh CI database, 2026-11-21). A real
  // catalogue load ends with VACUUM ANALYZE (docs/dev/deployment.md), and
  // autovacuum keeps it current.
  await db.$executeRawUnsafe('VACUUM ANALYZE catalog_search_docs, catalog_search_words, wine_products, product_producers, producers')
  const planOf = async (sql: string, args: unknown[]) => JSON.stringify((await app.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, ...args))[0]['QUERY PLAN'])
  const rare = (await db.$queryRawUnsafe<{ w: string }[]>(`SELECT name_words[2] AS w FROM catalog_search_docs WHERE product_id = 'b7splnw00777'`))[0].w
  const candPlan = async (q: string) => { const p = T.planQuery(await T.readWords(q, null), true)!; const c = T.bottleCandidatesSql(p); return planOf(c.sql, c.args) }
  let pl = await candPlan(`planwein ${rare}`)
  ok(pl.includes('"Index Name":"catalog_search_docs_tsv_name_idx"') && pl.includes('Bitmap Index Scan'), 'a rare query lands on tsv_name through its GIN index (Bitmap Index Scan)')
  pl = await candPlan('planregion7')
  ok(pl.includes('"Index Name":"catalog_search_docs_tsv_idx"'), 'a region-only query lands on tsv through its GIN index (arm c)')
  pl = await candPlan('planwein')
  const allNodes = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => { out.push(n); for (const c of n.Plans ?? []) allNodes(c, out); return out }
  const seqDocs = allNodes(JSON.parse(pl)[0].Plan).filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'catalog_search_docs')
  console.log(`    (common query "planwein": ${seqDocs.length ? 'seq scan with LIMIT' : 'index'})`)
  const wplan = await planOf(T.wordsSql(false), ['planwein planhaus'])
  const knn = JSON.parse(wplan)[0]
  // The KNN = the GiST scan with an ORDER BY; the exact and prefix lookups
  // are ranges on the primary key (never the GiST).
  const find = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => { if (n['Index Name'] === 'catalog_search_words_word_gist_idx' && n['Order By']) out.push(n); for (const c of n.Plans ?? []) find(c, out); return out }
  const gistAny = (n: PlanNode): boolean => (n['Index Name'] === 'catalog_search_words_word_gist_idx' && !n['Order By']) || (n.Plans ?? []).some(gistAny)
  ok(!gistAny(knn.Plan), 'the exact and prefix lookups use the primary key, never the trigram GiST')
  const knnNodes = find(knn.Plan)
  ok(knnNodes.length > 0 && knnNodes.every(n => n['Actual Loops'] === 0), 'the typo KNN is planned but NEVER EXECUTED for known words (a one-time filter)')
  const wplan2 = JSON.parse(await planOf(T.wordsSql(false), ['planwein qzvxqzv']))[0]
  ok(find(wplan2.Plan).some(n => (n['Actual Loops'] ?? 0) > 0), '… and executed for an unknown one')
  r = await counted(() => bottles(`planwein ${rare}`))
  eq(r.n, 2, 'a search with an answer: 2 statements')
  r = await counted(() => bottles('planwein qqqqzzzz'))
  ok(r.n <= 4 && r.r.results.length === 0, `an empty answer: at most 4 statements (sent ${r.n})`)
  r = await counted(() => searchProducers('planhaus'))
  eq(r.n, 2, 'a producer search: 2 statements (step 1 recorded ONE for the old one; deliberate)')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 9 — the answer and the producer search')
  const ans = await (await answerCatalogSearch(new URLSearchParams({ kind: 'bottle', q: 'pichler kellerberg 2019' }))).json()
  ok(Array.isArray(ans.results) && ans.results.length === 3 && ans.results.every((x: Record<string, unknown>) => !('status' in x) && x.year === 2019), 'kind=bottle: rows with the carried `year`, never a `status` (ruling 3: uniformly presented)')
  eq([typeof ans.more, typeof ans.tooLong], ['boolean', 'boolean'], '… `more` and `tooLong` in the envelope')
  const pans = await (await answerCatalogSearch(new URLSearchParams({ kind: 'producer', q: 'pichler' }))).json()
  eq([typeof pans.more, typeof pans.tooLong, pans.results.every((x: Record<string, unknown>) => !('status' in x))], ['boolean', 'boolean', true], 'kind=producer: the same envelope, no status')
  const pr = await searchProducers('christoph pichler')
  eq(pr.results.filter(x => /christoph/i.test(x.name)), [], 'producer "christoph pichler" lists no Christoph (every word must match)')
  eq((await searchProducers('pichler')).results.map(x => x.name).sort(), ['F.X. Pichler', 'Josef Pichler', 'Pichler-Krutzler', 'Rudi Pichler', 'Weingut Pichler'], '"pichler" → the five Pichlers')
  eq((await searchProducers('weingut pichler')).results[0]?.name, 'Weingut Pichler', 'a filler ranks the producer that has it first')
  const strass = await searchProducers('Weingut Strass')
  eq([strass.exact, strass.results.some(x => x.name === 'Weingut Straß')], [true, true], '`exact`: the database\'s fold says "Weingut Strass" IS "Weingut Straß" (the app then offers no Add Producer; Codex)')
  eq((await searchProducers('strass')).exact, false, '… and a partial name is not exact')
  eq((await (await answerCatalogSearch(new URLSearchParams({ kind: 'producer', q: 'Weingut Strass' }))).json()).exact, true, '… carried in the kind=producer answer')
  eq((await searchProducers('domaine')).results.some(x => x.name === 'Domaine'), true, 'a producer that is only a filler is found')
  const strict = await (await answerCatalogSearch(new URLSearchParams({ kind: 'producer', q: 'Weingut Dr. Loosen GmbH' }))).json()
  const forgiving = await (await answerCatalogSearch(new URLSearchParams({ kind: 'producer', q: 'Weingut Dr. Loosen GmbH', similar: '1' }))).json()
  eq(strict.results, [], 'every word: a scanned "Weingut Dr. Loosen GmbH" finds no producer (GmbH is not in the name)')
  ok(forgiving.similar === true && forgiving.results.some((x: { name: string }) => x.name === 'Dr. Loosen'), 'the website\'s `similar=1`: the forgiving list instead (ruled 2026-11-21)')
  eq((await (await answerCatalogSearch(new URLSearchParams({ kind: 'producer', q: 'loosen', similar: '1' }))).json()).similar, undefined, '… only when every word found nothing')
  const sim = await similarProducers('Pichler Krutzler')
  ok(sim.length > 0 && sim[0].name === 'Pichler-Krutzler', 'similarProducers (the trigram KNN, kept for duplicate finding) still answers')

  if (!process.env.KEEP) { await cleanup(); await rebuild() }
  console.log(`\n${passes} passed, ${failures} failed`)
}

main()
  .catch(e => { console.error(e); failures++ })
  .finally(async () => {
    await db.$disconnect(); await app.$disconnect()
    try { const { redis } = await import('../../lib/redis.ts'); if (redis.isOpen) await redis.quit() } catch {}
    process.exit(failures ? 1 : 0)
  })
