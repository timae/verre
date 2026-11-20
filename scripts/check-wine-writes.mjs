#!/usr/bin/env node
// CI census: every writer of a moment's bottles (the `wines` table and the
// cached line-up `s:{CODE}:wines`) is reviewed and listed here, so a new one
// cannot forget the line-up revision (catalogue model change § 8a, build step
// 3, review r1 M2). In a Postgres-backed moment the RECORD is the authority and
// `sessions.lineup_revision` is bumped in the same transaction as every bottle
// write (lib/occurrences.ts); the cached line-up is a projection stamped with it
// (`s:{C}:wrev`). A writer that changes a moment's bottles without bumping leaves
// a cache that looks current and is not, for the cache's lifetime (unlimited
// for every promoted moment).
//
// A CENSUS, not a deny-list (the scripts/check-username-writes.mjs pattern):
// every site the matchers find is compared with the expected count per file, so
// a new writer fails the build until it is reviewed and added.
//
// What counts as a write:
//  1. Raw SQL: `INSERT INTO wines`, `UPDATE wines` (also `public.wines`, quoted,
//     aliased), `DELETE FROM wines`.
//  2. A Prisma write on the wine model: `wine.create|createMany|update|
//     updateMany|upsert|delete|deleteMany(`.
//  3. The cached line-up: `.set(k.wines(` (incl. a MULTI), and a Lua script
//     whose KEYS name `k.wines(` (`keys: [ … k.wines(…) … ]`, or a
//     `keys = [ … ]` array built for one).
//
// Scope: app/, lib/, scripts/ (TypeScript and JavaScript), minus scripts/tests/
// (fixtures write rows on throwaway databases). KNOWN LIMITS (a text census): a
// key held in a variable, SQL assembled from strings in another file. The one
// named writer the text cannot see: scripts/backfill-model-change.mjs runs the
// statements of the expand migration's `@recipe:model-change-backfill` block
// (colour / sparkling / abv, never bumping): the cached line-up never carries
// those columns (lib/occurrences.ts header), so it cannot go stale on them.
//
// Run: node scripts/check-wine-writes.mjs   (exits 1 on any difference)
//      node scripts/check-wine-writes.mjs --self-test

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// file → the number of write sites expected there, and why each is right.
const EXPECTED = {
  // The record-first primitives: the reconciliation's orphaning, copyLineup
  // (strict copy), renumber, insertOccurrence (insert + two slot moves),
  // updateOccurrence, the projection script (KEYS: the line-up), and
  // syncSnapshot (the standalone check-in edit's pair; no moment). Every
  // moment caller bumps (the contract's row lock, `bumpLineup`) or stamps 1.
  'lib/occurrences.ts': 9,
  // mutateWines (the Redis-only moment's authority: no record, no revision);
  // reassignProvenance (provenance on the row, inside the reassign contract,
  // which bumps).
  'lib/session.ts': 2,
  // The rebuild's publish: the line-up NX (cold) or REPLACE (stale), stamped
  // with the record's revision in the same MULTI, + the provenance patch over a
  // current line-up; the Redis-only re-seed `[]`.
  'lib/sessionRehydrate.ts': 4,
  // Ban-with-delete: the record's orphan UPDATE, then bumpLineupRevision.
  'lib/sessionWipe.ts': 1,
  // Account deletion: the provenance tombstone (bumps a non-NULL revision);
  // the empty-moment wipe's orphaning (the moment ends: its scrub NULLs the
  // revision); session-less orphans' provenance (no moment, no revision); the
  // d: migration's Lua (KEYS: the line-up; the record was bumped in the
  // transaction, the next read re-projects).
  'lib/accountDelete.ts': 4,
  // The create's empty line-up `[]` (NX; a logged-in create stamps 1 in the
  // same projection).
  'app/api/session/route.ts': 1,
  // The session DELETE: wines orphaned as the moment ends (the scrub NULLs
  // the revision).
  'app/api/session/[code]/route.ts': 1,
  // The bottle DELETE (record-first, the contract bumps).
  'app/api/session/[code]/wines/[wineId]/route.ts': 1,
  // The photo: record-first, the contract bumps.
  'app/api/session/[code]/wines/[wineId]/image/route.ts': 1,
  // Reveal / hide one bottle: record-first, the contract bumps.
  'app/api/session/[code]/wines/[wineId]/reveal/route.ts': 2,
  // Reorder: record-first, the contract bumps.
  'app/api/session/[code]/wines/reorder/route.ts': 1,
  // Reveal-all / hide-all: record-first, the contract bumps.
  'app/api/session/[code]/wines/reveal-all/route.ts': 1,
  'app/api/session/[code]/wines/hide-all/route.ts': 1,
  // A standalone check-in's occurrence (no moment, no revision): the create
  // (INSERT-only on the client id) and the edit.
  'app/api/checkins/route.ts': 1,
  'app/api/checkins/[id]/route.ts': 1,
  // Operator scripts: the session photo re-key (record-first under the
  // contract, bumps, projects); the user photo re-key (bumps every touched
  // moment's non-NULL revision in the same transaction); the release-B
  // position backfill (bumps a non-NULL revision); the photo re-key's
  // moment-less rows (no live moment).
  'scripts/rekey-session-images.mts': 2,
  'scripts/rekey-user-images.mts': 1,
  'scripts/backfill-lineup-positions.mts': 1,
}

const inScope = (f) =>
  (f.startsWith('app/') || f.startsWith('lib/') || (f.startsWith('scripts/') && !f.startsWith('scripts/tests/'))) &&
  /\.(ts|tsx|mts|mjs|js)$/.test(f) && f !== 'scripts/check-wine-writes.mjs'

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
// SQL comments inside template literals (`-- …` to the end of the line).
const stripSqlComments = (src) => src.replace(/--[^\n`]*/g, (m) => ' '.repeat(m.length))

const T = String.raw`(?:public\s*\.\s*)?"?wines"?(?![\w"])`
const RAW = [
  new RegExp(String.raw`\bINSERT\s+INTO\s+${T}`, 'gi'),
  new RegExp(String.raw`\bUPDATE\s+${T}`, 'gi'),
  new RegExp(String.raw`\bDELETE\s+FROM\s+${T}`, 'gi'),
]
const PRISMA = /\bwine\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g
const REDIS_SET = /\.set\(\s*k\.wines\(/g
const LUA_KEYS = /keys\s*(?::|=)\s*\[[^\]]*k\.wines\(/g

export function writeSites(source) {
  const src = stripSqlComments(stripComments(source))
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const sites = []
  for (const re of RAW) for (const m of src.matchAll(re)) sites.push({ line: lineOf(m.index), kind: 'raw SQL' })
  for (const m of src.matchAll(PRISMA)) sites.push({ line: lineOf(m.index), kind: 'Prisma write' })
  for (const m of src.matchAll(REDIS_SET)) sites.push({ line: lineOf(m.index), kind: 'cached line-up SET' })
  for (const m of src.matchAll(LUA_KEYS)) sites.push({ line: lineOf(m.index), kind: 'Lua script on the cached line-up' })
  return sites
}

// The negative control: each write idiom must be caught, each read passed.
function selfTest() {
  const must = [
    ['raw insert', "await tx.$executeRaw`INSERT INTO wines (id, name) VALUES (${a}, ${b})`"],
    ['aliased insert', "tx.$queryRaw`INSERT INTO wines AS w (id) VALUES (${a}) ON CONFLICT (id) DO NOTHING`"],
    ['raw update', "await prisma.$executeRaw`UPDATE wines SET name = ${n} WHERE id = ${id}`"],
    ['aliased update', "tx.$executeRaw`UPDATE wines w SET position = 1 FROM o WHERE w.id = o.id`"],
    ['quoted schema update', 'tx.$executeRaw`UPDATE public."wines" SET image_url = ${u}`'],
    ['raw delete', "tx.$executeRaw`DELETE FROM wines WHERE id = ${id}`"],
    ['multi-line update', "tx.$executeRaw`\n  UPDATE\n    wines SET session_id = NULL`"],
    ['prisma create', "await tx.wine.create({ data: { id, name } })"],
    ['prisma update', "await tx.wine.update({ where: { id }, data: { name } })"],
    ['prisma deleteMany', "prisma.wine.deleteMany({ where: { sessionId } })"],
    ['lineup set', "await redis.set(k.wines(code), JSON.stringify(x), { XX: true })"],
    ['lineup set in a multi', "m.set(k.wines(code), '[]', { NX: true, EX: ttl })"],
    ['lua on the lineup', "await redis.eval(SCRIPT, { keys: [lockKey, k.wines(code), k.wrev(code)], arguments: [] })"],
    ['lua keys built first', "const keys = [sessionLockKey(c), k.meta(c), k.wines(c)]\nawait redis.eval(S, { keys, arguments })"],
  ]
  const mustNot = [
    ['select', "tx.$queryRaw`SELECT id FROM wines WHERE session_id = ${s}`"],
    ['join', "tx.$queryRaw`SELECT 1 FROM ratings r JOIN wines w ON w.id = r.wine_id`"],
    ['catalogue table', "tx.$executeRaw`UPDATE wine_products SET name = ${n}`"],
    ['vintages table', "tx.$executeRaw`INSERT INTO wine_vintages (id) VALUES (${i})`"],
    ['update another table that names wines', "tx.$executeRaw`UPDATE sessions SET x = 1 WHERE id IN (SELECT session_id FROM wines)`"],
    ['lineup read', "const raw = await redis.get(k.wines(code))"],
    ['lineup mget', "await redis.mGet([k.meta(code), k.wines(code)])"],
    ['prisma read', "await prisma.wine.findUnique({ where: { id } })"],
    ['wineProduct write', "await tx.wineProduct.create({ data })"],
    ['a comment', "// await tx.$executeRaw`UPDATE wines SET name = 1`"],
    ['a SQL comment', "tx.$executeRaw`\n  -- UPDATE wines is done elsewhere\n  SELECT 1`"],
  ]
  const bad = [
    ...must.filter(([, src]) => writeSites(src).length === 0).map(([n]) => `missed a write: ${n}`),
    ...mustNot.filter(([, src]) => writeSites(src).length > 0).map(([n]) => `flagged a read: ${n}`),
  ]
  if (bad.length) { console.error('check-wine-writes: SELF-TEST FAILED\n  ' + bad.join('\n  ')); process.exit(1) }
  return must.length + mustNot.length
}

const cases = selfTest()
if (process.argv.includes('--self-test')) { console.log(`check-wine-writes: self-test OK (${cases} cases)`); process.exit(0) }

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter(inScope)
if (files.length === 0) { console.error('check-wine-writes: ERROR — 0 in-scope files. Run from the repo root.'); process.exit(1) }

const found = {}
for (const file of files) {
  if (!existsSync(file)) continue
  const sites = writeSites(readFileSync(file, 'utf8'))
  if (sites.length) found[file] = sites
}
if (process.argv.includes('--list')) { for (const [f, s] of Object.entries(found)) console.log(f, s.map(x => `${x.line}:${x.kind}`).join(', ')); process.exit(0) }

const problems = []
for (const [file, sites] of Object.entries(found)) {
  const want = EXPECTED[file] ?? 0
  if (sites.length !== want) problems.push(...sites.map((s) => `  ${file}:${s.line}  ${s.kind} (expected ${want} site(s) in this file, found ${sites.length})`))
}
for (const [file, want] of Object.entries(EXPECTED)) {
  if (!found[file]) problems.push(`  ${file}  expected ${want} site(s), found none: update EXPECTED if the writer moved`)
}

if (problems.length === 0) {
  console.log(`check-wine-writes: OK — ${Object.values(EXPECTED).reduce((a, b) => a + b, 0)} reviewed bottle-write sites in ${Object.keys(EXPECTED).length} files (${files.length} files scanned, self-test ${cases} cases)`)
  process.exit(0)
}
console.error('check-wine-writes: FAILED — a new or moved writer of a moment\'s bottles.')
console.error('In a Postgres-backed moment it must bump sessions.lineup_revision in the same transaction (lib/occurrences.ts; catalogue model change § 8a), then be listed here.\n')
for (const p of problems) console.error(p)
process.exit(1)
