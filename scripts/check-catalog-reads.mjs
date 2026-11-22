#!/usr/bin/env node
// CI census: every READ of the catalogue (wine_products, wine_vintages,
// producers, product_producers, product_eans) goes through the ONE merge
// resolver (lib/catalogEntries.ts) or the one matcher (lib/catalogSearch.ts),
// catalogue model change § 8b (decided in build step 4).
//
// Why: merges never rewrite (a merge points one entry at another and destroys
// nothing), so every read must follow `links_to` before it shows or counts
// anything, and forgetting it FAILS SILENTLY: the same wine twice on a
// profile, a name already merged away, an average missing half its ratings.
// One resolver beats discipline at each call site; this census makes "did the
// new read resolve merges?" a reviewed question instead of a hope.
//
// A CENSUS, not a deny-list: every site the matchers find outside the two
// modules is compared with the expected list below (with the reason it may
// read raw rows), so a new read fails the build until it is reviewed and
// listed, or moved behind the resolver.
//
// What counts as a read:
//  1. Raw SQL naming a catalogue table after FROM / JOIN.
//  2. A Prisma read on a catalogue delegate (`.wineProduct.findMany(` …).
//  3. A Prisma relation read INTO the catalogue from another model: the
//     `product` / `catalogVintage` relations of Wine and Bookmark inside a
//     select / include.
// Writes are lib/catalogWrite.ts's (its own chokepoint).
//
// KNOWN LIMITS (a text census): a delegate held in a variable, SQL assembled
// in another file, a table name built from a string.
//
// Run: node scripts/check-catalog-reads.mjs   (exits 1 on any difference)
//      node scripts/check-catalog-reads.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ALLOWED = ['lib/catalogEntries.ts', 'lib/catalogSearch.ts']
// file → the number of read sites expected there, and why each may read rows.
const EXPECTED = {
  // The mint chokepoint's validation reads: resolveCatalogLink checks a
  // caller-supplied id is a real, linkable row (status, scope, the vintage's
  // product). A tombstone is REFUSED there (link to the survivor), so nothing
  // it reads is shown or counted.
  // The hard purge's reference clearing (catalogue model change § 5a, step
  // 5): the purged entity's own rows deleted and the product's vintages
  // listed to purge them first; nothing shown or counted.
  // The search docs (step 7b): the row rule's locks (a lead's chain FOR SHARE,
  // products FOR NO KEY UPDATE) and the doc built from the rows it describes
  // (indexProducer / indexProduct). A doc keeps a tombstone lead's own name AND
  // its effective survivor's (both searchable; the read resolves the match),
  // so it reads the chain raw on purpose; nothing shown or counted.
  'lib/catalogWrite.ts': 16,
  // The search rebuild's drift report (step 7b): whether a doc's source row
  // still exists; existence only, nothing shown or counted.
  'scripts/lib/catalogSearchRebuild.mjs': 3,
  // The add flow's branch checks before a mint (the product of branch 2, its
  // existing year, the producer of branch 3, the collaborators): status
  // checks that refuse a tombstone; nothing displayed.
  'lib/catalogAddFlow.ts': 4,
  // sanitizeForRecord: whether a cached bottle's link still names a row (a
  // purged one is unlinked before the strict copy); existence only.
  'lib/occurrences.ts': 2,
  // Operator tools: the columns file's guarded update (file 2) checks its
  // target catalogue by digest and id; never a display read.
  'scripts/catalog-columns-update.mjs': 2,
}

const inScope = (f) =>
  (f.startsWith('app/') || f.startsWith('lib/') || f.startsWith('components/') || (f.startsWith('scripts/') && !f.startsWith('scripts/tests/'))) &&
  /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.startsWith('scripts/check-')

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const TABLES = 'wine_products|wine_vintages|producers|product_producers|product_eans'
const RAW = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\s*\\.\\s*)?"?(?:${TABLES})"?(?![\\w])`, 'gi')
const DELEGATE = /\.\s*(?:wineProduct|wineVintage|producer|productProducer|productEan)\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy)\s*\(/g
const RELATION = /\b(?:product|catalogVintage)\s*:\s*(?:true\b|\{\s*(?:select|include|where)\b)/g

export function readSites(source) {
  const src = stripComments(source)
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const sites = []
  for (const m of src.matchAll(RAW)) sites.push({ line: lineOf(m.index), kind: 'raw SQL' })
  for (const m of src.matchAll(DELEGATE)) sites.push({ line: lineOf(m.index), kind: 'Prisma read' })
  for (const m of src.matchAll(RELATION)) sites.push({ line: lineOf(m.index), kind: 'relation read' })
  return sites
}

// The negative control: each read idiom caught, each non-read passed.
function selfTest() {
  const must = [
    ['raw from', "prisma.$queryRaw`SELECT id, name FROM wine_products WHERE id = ${p}`"],
    ['raw join', "tx.$queryRaw`SELECT w.id FROM wines w JOIN wine_vintages v ON v.id = w.vintage_id`"],
    ['raw quoted', 'db.$queryRawUnsafe(`SELECT 1 FROM "producers" WHERE id = $1`, id)'],
    ['raw lower-case', "sql`select pp.role from product_producers pp`"],
    ['raw schema-qualified', "sql`SELECT * FROM public.wine_products`"],
    ['raw left join', "sql`SELECT b.id FROM bookmarks b LEFT JOIN producers pr ON pr.id = b.producer_id`"],
    ['delegate', "await prisma.wineProduct.findMany({ where: { id: { in: ids } } })"],
    ['tx delegate', "await tx.producer.findUnique({ where: { id } })"],
    ['vintage count', "await prisma.wineVintage.count({ where: { productId } })"],
    ['relation include', "prisma.wine.findMany({ include: { product: { select: { name: true } } } })"],
    ['relation true', "prisma.bookmark.findMany({ include: { product: true } })"],
    ['vintage relation', "prisma.wine.findFirst({ select: { catalogVintage: { select: { year: true } } } })"],
  ]
  const mustNot = [
    ['the wines table', "prisma.$queryRaw`SELECT name, producer FROM wines WHERE id = ${id}`"],
    ['a producer COLUMN', "prisma.wine.findMany({ select: { producer: true, vintage: true } })"],
    ['a comment', "// SELECT * FROM wine_products would skip the resolver"],
    ['a write', "await tx.producer.create({ data, select: { id: true } })"],
    ['an insert', "sql`INSERT INTO catalog_review_items (entity_type) VALUES ('product')`"],
    ['a wire key', "return { productId: e.productId, producer: e.producer }"],
    ['a similar table', "sql`SELECT 1 FROM producers_backup`"],
  ]
  const bad = [
    ...must.filter(([, src]) => readSites(src).length === 0).map(([n]) => `missed a read: ${n}`),
    ...mustNot.filter(([, src]) => readSites(src).length > 0).map(([n]) => `flagged a non-read: ${n}`),
  ]
  if (bad.length) { console.error('check-catalog-reads: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return must.length + mustNot.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-catalog-reads: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope).filter((f) => !ALLOWED.includes(f))
if (files.length === 0) { console.error('check-catalog-reads: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = readSites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}
const problems = []
for (const [file, sites] of Object.entries(found)) {
  const want = EXPECTED[file] ?? 0
  if (sites.length !== want) problems.push(...sites.map((s) => `  ${file}:${s.line}  ${s.kind} (expected ${want} site(s) in this file, found ${sites.length})`))
}
for (const [file, want] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`  ${file}  expected ${want} site(s), found none: update EXPECTED if the read moved`)
}
if (problems.length === 0) {
  console.log(`check-catalog-reads: OK — catalogue reads only in ${ALLOWED.join(' + ')} and ${Object.values(EXPECTED).reduce((a, b) => a + b, 0)} reviewed site(s) in ${Object.keys(EXPECTED).length} files (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-catalog-reads: FAILED — a catalogue read outside the resolver.')
console.error('Reads that show or count catalogue data go through lib/catalogEntries.ts (merges followed); list a raw read here only with its reason (spec § 8b).\n')
for (const p of problems) console.error(p)
process.exit(1)
