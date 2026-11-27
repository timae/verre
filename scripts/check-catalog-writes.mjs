#!/usr/bin/env node
// CI census: every WRITE of the catalogue rows the bottle search indexes
// (producers, wine_products, product_producers) and of the search tables
// themselves (catalog_search_docs, catalog_search_producer_docs,
// catalog_search_words) goes through lib/catalogWrite.ts (catalogue model
// change step 7b, ruling 6).
//
// Why: the search docs are kept current by OUR writes, in the same transaction
// as the row they describe (a renamed wine, a new producer). A write elsewhere
// leaves a doc saying something the catalogue no longer says: the read joins the
// catalogue live, so a stale doc can never SHOW a removed or renamed wine, but
// it can fail to FIND one. One chokepoint beats discipline; this makes "does the
// new write re-index?" a reviewed question. Writers outside the app (a
// catalogue load, psql) are what the rebuild and its drift report are for
// (scripts/rebuild-catalog-search.mts); migrations are out of scope.
//
// A CENSUS, not a deny-list: every site the matchers find outside the module is
// compared with the expected list below, with the reason it may write.
//
// What counts as a write:
//  1. Raw SQL: INSERT INTO / UPDATE / DELETE FROM / COPY / TRUNCATE / MERGE INTO
//     one of the tables (optionally `public.`-qualified or quoted).
//  2. A Prisma write on one of their delegates (`.producer.create(` …,
//     createMany / updateMany / upsert / delete / deleteMany included).
//  3. A NESTED relation write into the catalogue (`product: { create: …` and
//     the like inside another model's data).
//
// KNOWN LIMITS (a text census): a delegate held in a variable, SQL assembled in
// another file, a table name built from a string.
//
// Run: node scripts/check-catalog-writes.mjs   (exits 1 on any difference)
//      node scripts/check-catalog-writes.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ALLOWED = ['lib/catalogWrite.ts']
// file → the number of write sites expected there, and why each may write.
const EXPECTED = {
  // The columns file's guarded update (the catalogue-maintenance side's file 2):
  // country / description / vinification only, never a searched column (not a
  // name, not the region), so no doc can go stale through it.
  'scripts/catalog-columns-update.mjs': 1,
}

const inScope = (f) =>
  (f.startsWith('app/') || f.startsWith('lib/') || f.startsWith('components/') || (f.startsWith('scripts/') && !f.startsWith('scripts/tests/'))) &&
  /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.startsWith('scripts/check-')

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const TABLES = 'producers|wine_products|product_producers|catalog_search_docs|catalog_search_producer_docs|catalog_search_words'
const T = `(?:"?public"?\\s*\\.\\s*)?"?(?:${TABLES})"?(?![\\w])`
const RAW = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|COPY|MERGE\\s+INTO)\\s+(?:ONLY\\s+)?${T}|\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(?:[\\w."]+\\s*,\\s*)*${T}`, 'gi')
const DELEGATE = /\.\s*(?:producer|wineProduct|productProducer|catalogSearchDoc|catalogSearchProducerDoc|catalogSearchWord)\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g
const NESTED = /\b(?:product|producer|producers|products|tombstones|target|wineProduct)\s*:\s*\{\s*(?:create|createMany|connectOrCreate|upsert|update|updateMany|delete|deleteMany)\s*:/g

export function writeSites(source) {
  const src = stripComments(source)
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const sites = []
  for (const m of src.matchAll(RAW)) sites.push({ line: lineOf(m.index), kind: 'raw SQL' })
  for (const m of src.matchAll(DELEGATE)) sites.push({ line: lineOf(m.index), kind: 'Prisma write' })
  for (const m of src.matchAll(NESTED)) sites.push({ line: lineOf(m.index), kind: 'nested write' })
  return sites
}

// The negative control: each write idiom caught, each non-write passed.
function selfTest() {
  const must = [
    ['raw insert', "tx.$executeRaw`INSERT INTO producers (id, name) VALUES (${id}, ${n})`"],
    ['raw update', "prisma.$executeRawUnsafe(`UPDATE wine_products SET name = $1 WHERE id = $2`, n, id)"],
    ['raw delete', "tx.$executeRaw`DELETE FROM product_producers WHERE product_id = ${id}`"],
    ['schema-qualified', "sql`UPDATE public.producers SET region = ${r}`"],
    ['quoted', 'sql`INSERT INTO "wine_products" (id) VALUES ($1)`'],
    ['quoted schema', 'sql`UPDATE "public"."wine_products" SET name = $1 WHERE id = $2`'],
    ['lower-case', "sql`delete from catalog_search_docs where product_id = ${id}`"],
    ['update only', "sql`UPDATE ONLY producers SET name = 'x'`"],
    ['copy', "sql`COPY wine_products FROM STDIN`"],
    ['truncate', "sql`TRUNCATE catalog_search_words`"],
    ['truncate list', "sql`TRUNCATE TABLE other_table, public.catalog_search_producer_docs`"],
    ['merge', "sql`MERGE INTO producers p USING x ON p.id = x.id WHEN MATCHED THEN UPDATE SET name = x.name`"],
    ['search words insert', "sql`INSERT INTO catalog_search_words (word, ndoc) VALUES ('a', 1)`"],
    ['delegate create', "await tx.producer.create({ data })"],
    ['delegate update', "await prisma.wineProduct.update({ where: { id }, data: { name } })"],
    ['delegate updateMany', "await tx.wineProduct.updateMany({ where: {}, data: { region } })"],
    ['delegate upsert', "await tx.productProducer.upsert({ where, create, update })"],
    ['delegate delete', "await tx.producer.delete({ where: { id } })"],
    ['delegate createMany', "await t.productProducer.createMany({ data })"],
    ['search delegate', "await prisma.catalogSearchDoc.deleteMany({})"],
    ['nested create', "prisma.bookmark.create({ data: { product: { create: { name: 'x' } } } })"],
    ['nested connectOrCreate', "prisma.bookmark.update({ data: { product: { connectOrCreate: { where, create } } } })"],
    ['nested producers', "tx.wineProduct.create({ data: { producers: { create: [{ producerId }] } } })"],
  ]
  const mustNot = [
    ['a read', "prisma.$queryRaw`SELECT id FROM producers WHERE id = ${id}`"],
    ['an update of bookmarks', "tx.$executeRaw`UPDATE bookmarks SET product_id = NULL WHERE id = ${id}`"],
    ['a join in an update', "sql`UPDATE bookmarks b SET name = p.name FROM wine_products p WHERE p.id = b.product_id`"],
    ['a delegate read', "await tx.producer.findUnique({ where: { id } })"],
    ['a producer column', "prisma.bookmark.update({ where: { id }, data: { producer: 'x' } })"],
    ['a connect', "prisma.bookmark.update({ data: { product: { connect: { id } } } })"],
    ['a comment', "// UPDATE producers SET name = 'x' would skip the doc"],
    ['a similar table', "sql`INSERT INTO producers_backup (id) VALUES (1)`"],
    ['for update', "sql`SELECT id FROM wine_products WHERE id = ANY($1) FOR NO KEY UPDATE`"],
    ['the review items', "sql`DELETE FROM catalog_review_items WHERE entity_id = ${id}`"],
  ]
  const bad = [
    ...must.filter(([, src]) => writeSites(src).length === 0).map(([n]) => `missed a write: ${n}`),
    ...mustNot.filter(([, src]) => writeSites(src).length > 0).map(([n]) => `flagged a non-write: ${n}`),
  ]
  if (bad.length) { console.error('check-catalog-writes: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return must.length + mustNot.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-catalog-writes: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope).filter((f) => !ALLOWED.includes(f))
if (files.length === 0) { console.error('check-catalog-writes: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = writeSites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}
const problems = []
for (const [file, sites] of Object.entries(found)) {
  const want = EXPECTED[file] ?? 0
  if (sites.length !== want) problems.push(...sites.map((s) => `  ${file}:${s.line}  ${s.kind} (expected ${want} site(s) in this file, found ${sites.length})`))
}
for (const [file, want] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`  ${file}  expected ${want} site(s), found none: update EXPECTED if the write moved`)
}
if (problems.length === 0) {
  console.log(`check-catalog-writes: OK — catalogue and search writes only in ${ALLOWED.join(' + ')} and ${Object.values(EXPECTED).reduce((a, b) => a + b, 0)} reviewed site(s) in ${Object.keys(EXPECTED).length} files (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-catalog-writes: FAILED — a catalogue or search write outside lib/catalogWrite.ts.')
console.error('Writes of producers / wine_products / product_producers keep the search docs current there (in the same transaction); list a write here only with its reason (step 7b).\n')
for (const p of problems) console.error(p)
process.exit(1)
