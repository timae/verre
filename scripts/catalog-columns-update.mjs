#!/usr/bin/env node
// The catalogue flush's COLUMNS FILE (file 2), loaded after the release
// migration (docs/dev/proposals/wine-catalog-model-change.md § 1 contract v3,
// § 7 catalogue flush; build plan step 2, run in step 8 item 4).
//
// The catalogue-maintenance side delivers the three new `wine_products` columns
// (origin `country`, `description`, `vinification`) as a separate file because
// the columns do not exist on prod until the release. Its ids are the
// replacement's (file 1), so it loads only on top of that, and the manifest says
// which catalogue it was built on.
//
//   DATABASE_URL=… node scripts/catalog-columns-update.mjs --manifest <m.json> --file <f.copy>                          # dry run
//   DATABASE_URL=… node scripts/catalog-columns-update.mjs --manifest <m.json> --file <f.copy> --apply --expect-db <host>/<db> # write
//
// The file: COPY text format (tab-separated, NULL as \N), one row per product
// with at least one value, columns exactly id, country, description,
// vinification, sorted by id COLLATE "C". The manifest (the handover manifest's
// shape; ours to propose, adapt it to the real one):
//   { "contentDigest": { "version": "cd1", "tables": { "wine_products": { "rows": N, "digest": "<hex>" } } },
//     "tables": [ { "table": "wine_products", "columns": ["id","country","description","vinification"],
//                   "rows": N, "bytes": B, "sha256": "<hex>" } ],
//     "builtOn": { "version": "cd1", "wine_products": { "rows": P, "digest": "<hex>" } } }
// `contentDigest` is computed like the handover's cd1: sha256 of the row count, a
// newline, then every row as json_build_array(id, country, description,
// vinification)::text, newline-joined, ordered by id COLLATE "C". It is recomputed
// HERE IN POSTGRES over the rows as decoded, so it proves the decode read what the
// other side hashed. `builtOn` is file 1's own cd1 digest of wine_products (the
// handover manifest's contentDigest.tables.wine_products), recomputed over the
// live table: a file 2 built on another catalogue build is refused.
//
// REFUSES, writing nothing, unless every check passes: bytes, sha256 and row
// count as the manifest says; both digests; every line decodes to four fields,
// ids strictly ascending, each row with a value; every code in the 249-code list;
// every text as the contract has it (the scrub character set and trimmed, NFC, not
// blank through catalog_fold_v1, at most 1000 characters); every id an existing
// product; every column it writes still NULL and not named in curator_locked (fill
// NULL only: a \N in the file leaves the column as it is). Then ONE UPDATE whose
// affected-row count must equal the file's row count, or it rolls back.
// The DRY RUN reads only (no lock, no UPDATE: it counts what the update would
// touch). --apply locks wine_products against writes (SHARE ROW EXCLUSIVE; reads
// and search go on) for the transaction, about 16 s for a full file on the
// rehearsal; run it in the quiet window, then VACUUM (FULL, ANALYZE) wine_products
// (the UPDATE rewrites every row it fills). A re-run after an --apply is refused
// (the targets are no longer NULL).
// stdout: one JSON object (counts, the database, at most 10 example ids per
// refusal). stderr: the target before connecting. Exit 0 = passed (dry run) or
// applied, 1 = refused or error (nothing written), 2 = usage.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { argValue, boundTransaction, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'
import { COUNTRY_CODES } from '../packages/core/src/countries.ts'
import { scrub } from '../packages/core/src/textScrub.ts'

const SCRIPT = 'catalog-columns-update'
const COLUMNS = ['id', 'country', 'description', 'vinification']
const TEXT_MAX = 1000
const DIGEST_MAX_BYTES = 536870912 // cd1 yields no digest above this (load-post.sql)
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const manifestPath = argValue(args, '--manifest'), filePath = argValue(args, '--file'), expectDb = argValue(args, '--expect-db')
const known = new Set(['--apply', '--manifest', '--file', '--expect-db', manifestPath, filePath, expectDb])
if (!manifestPath || !filePath || expectDb === null || (apply && !expectDb) || args.some(a => !known.has(a))) {
  console.error('usage: catalog-columns-update.mjs --manifest <manifest.json> --file <file.copy> [--apply --expect-db <host>/<database>]')
  process.exit(2)
}
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb)

const out = { mode: apply ? 'apply' : 'dry-run', database: null, bounds: null, rows: 0, writes: {}, refused: null }
const REFUSED = Symbol('refused'), ROLLBACK = Symbol('dry run')
const refuse = (reason, examples) => { out.refused = { reason, ...(examples?.length ? { examples: examples.slice(0, 10) } : {}) }; throw REFUSED }

// COPY text format, one field: `\N` alone is NULL; backslash escapes decode to
// BYTES (octal and hex escapes may build a multi-byte character), then UTF-8.
// ignoreBOM keeps a U+FEFF that starts a field (the default would drop it).
const ESC = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const isOct = c => c >= 0x30 && c <= 0x37
const isHex = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
function decodeField(buf) {
  if (buf.length === 2 && buf[0] === 0x5c && buf[1] === 0x4e) return null
  const bytes = []
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c !== 0x5c) { bytes.push(c); continue }
    const n = buf[++i]
    if (n === undefined) throw new Error('a field ends in a lone backslash')
    const ch = String.fromCharCode(n)
    if (ch in ESC) bytes.push(ESC[ch])
    else if (isOct(n)) {
      let v = n - 0x30
      for (let k = 0; k < 2 && isOct(buf[i + 1]); k++) v = v * 8 + (buf[++i] - 0x30)
      bytes.push(v & 0xff)
    } else if (ch === 'x' && isHex(buf[i + 1])) {
      let s = String.fromCharCode(buf[++i])
      if (isHex(buf[i + 1])) s += String.fromCharCode(buf[++i])
      bytes.push(parseInt(s, 16))
    } else if (ch === 'N') throw new Error('\\N inside a field')
    else bytes.push(n)
  }
  return utf8.decode(Uint8Array.from(bytes))
}

function readFile(bytes) {
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) throw new Error('the file does not end in a newline')
  const rows = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue
    const line = bytes.subarray(start, i)
    start = i + 1
    if (line.includes(0x0d)) throw new Error(`line ${rows.length + 1}: a raw carriage return`)
    const fields = []
    let f = 0
    for (let j = 0; j <= line.length; j++) if (j === line.length || line[j] === 0x09) { fields.push(line.subarray(f, j)); f = j + 1 }
    if (fields.length !== COLUMNS.length) throw new Error(`line ${rows.length + 1}: ${fields.length} fields, expected ${COLUMNS.length}`)
    rows.push(fields.map(decodeField))
  }
  return rows
}

const digestSql = (rowSql, from) => `
  SELECT n, octet_length(s) AS bytes,
         CASE WHEN octet_length(s) <= ${DIGEST_MAX_BYTES} THEN encode(sha256(convert_to(s, 'UTF8')), 'hex') END AS digest
    FROM (SELECT count(*)::int AS n, count(*)::text || E'\\n' || coalesce(string_agg(
                 json_build_array(${rowSql})::text, E'\\n' ORDER BY t.id COLLATE "C"), '') AS s
            FROM ${from} t) x`

const { createPrismaClient } = await import('./lib/prismaClient.mjs')
const prisma = createPrismaClient()
try {
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) { refuse(`the manifest is not readable JSON (${e.message})`) }
  const entry = Array.isArray(manifest.tables) && manifest.tables.length === 1 ? manifest.tables[0] : null
  const digest = manifest.contentDigest?.version === 'cd1' ? manifest.contentDigest.tables?.wine_products : null
  const builtOn = manifest.builtOn?.version === 'cd1' ? manifest.builtOn.wine_products : null
  if (!entry || entry.table !== 'wine_products' || JSON.stringify(entry.columns) !== JSON.stringify(COLUMNS)) {
    refuse(`the manifest must describe one table, wine_products, with the columns ${COLUMNS.join(', ')}`)
  }
  if (!digest || !/^[0-9a-f]{64}$/.test(digest.digest ?? '') || digest.rows !== entry.rows) refuse('the manifest carries no cd1 digest for the file (or its row count disagrees)')
  if (!builtOn || !/^[0-9a-f]{64}$/.test(builtOn.digest ?? '') || !Number.isInteger(builtOn.rows)) refuse('the manifest does not say which catalogue it was built on (builtOn: file 1\'s cd1 digest of wine_products)')
  const bytes = readFileSync(filePath)
  if (bytes.length !== entry.bytes) refuse(`the file is ${bytes.length} bytes, the manifest says ${entry.bytes}`)
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) refuse('the file\'s sha256 is not the manifest\'s')
  let rows
  try { rows = readFile(bytes) } catch (e) { refuse(`the file does not decode: ${e.message}`) }
  if (rows.length !== entry.rows) refuse(`the file has ${rows.length} rows, the manifest says ${entry.rows}`)
  out.rows = rows.length
  const bad = (pred) => rows.filter(pred).map(r => r[0] ?? '(null id)')
  let ex = bad(r => r[0] === null || r[0].length === 0 || r[0].length > 21)
  if (ex.length) refuse('an id is empty or longer than 21 characters', ex)
  ex = rows.filter((r, i) => i > 0 && Buffer.compare(Buffer.from(rows[i - 1][0]), Buffer.from(r[0])) >= 0).map(r => r[0])
  if (ex.length) refuse('ids are not strictly ascending by byte order (sorted by id COLLATE "C", no repeats)', ex)
  ex = bad(r => r.slice(1).every(v => v === null))
  if (ex.length) refuse('a row carries no value', ex)
  ex = bad(r => r[1] !== null && !COUNTRY_CODES.has(r[1]))
  if (ex.length) refuse('a country is not one of the 249 codes (uppercase ISO 3166-1 alpha-2)', ex)
  ex = bad(r => r.slice(2).some(v => v !== null && [...v].length > TEXT_MAX))
  if (ex.length) refuse(`a text is longer than ${TEXT_MAX} characters`, ex)
  ex = bad(r => r.slice(2).some(v => v !== null && (v.normalize('NFC') !== v || scrub(v) !== v)))
  if (ex.length) refuse('a text is not as the contract has it (NFC, trimmed, none of the characters scrub removes)', ex)
  for (const [i, col] of COLUMNS.entries()) if (i) out.writes[col] = rows.filter(r => r[i] !== null).length

  await prisma.$transaction(async (tx) => {
    Object.assign(out, await boundTransaction(tx, { apply, expectDb }))
    if (apply) await tx.$executeRawUnsafe(`LOCK TABLE public.wine_products IN SHARE ROW EXCLUSIVE MODE`)
    const [live] = await tx.$queryRawUnsafe(digestSql(
      't.id, t.name, t.category, t.style, t.colour, t.sparkling, t.abv, t.grapes, t.region, t.scope, t.status, t.links_to, t.curator_locked, t.added_by, t.curated_by',
      'public.wine_products'))
    if (live.n !== builtOn.rows || live.digest !== builtOn.digest) {
      refuse(`this catalogue is not the one the file was built on (wine_products: ${live.n} rows, cd1 ${live.digest ?? 'too large'}; the manifest: ${builtOn.rows} rows, ${builtOn.digest})`)
    }
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE _catalog_columns (id text PRIMARY KEY, country text, description text, vinification text) ON COMMIT DROP`)
    for (let i = 0; i < rows.length; i += 20_000) {
      const chunk = rows.slice(i, i + 20_000)
      await tx.$executeRawUnsafe(
        `INSERT INTO _catalog_columns SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])`,
        ...COLUMNS.map((_, c) => chunk.map(r => r[c])))
    }
    const [d] = await tx.$queryRawUnsafe(digestSql('t.id, t.country, t.description, t.vinification', '_catalog_columns'))
    if (d.digest === null) refuse(`the file's rows are too large for a cd1 digest (${d.bytes} bytes; cd1 stops at ${DIGEST_MAX_BYTES})`)
    if (d.digest !== digest.digest) refuse('the content digest of the decoded rows is not the manifest\'s (cd1)')
    const blank = await tx.$queryRawUnsafe(`
      SELECT id FROM _catalog_columns
       WHERE public.catalog_fold_v1(description) = '' OR public.catalog_fold_v1(vinification) = '' ORDER BY id LIMIT 10`)
    if (blank.length) refuse('a text is blank once folded (catalog_fold_v1)', blank.map(r => r.id))
    const unknown = await tx.$queryRawUnsafe(`
      SELECT c.id FROM _catalog_columns c WHERE NOT EXISTS (SELECT 1 FROM public.wine_products p WHERE p.id = c.id) ORDER BY c.id LIMIT 10`)
    if (unknown.length) refuse('an id is not a product in this catalogue', unknown.map(r => r.id))
    const taken = await tx.$queryRawUnsafe(`
      SELECT c.id FROM _catalog_columns c JOIN public.wine_products p ON p.id = c.id
       WHERE (c.country IS NOT NULL AND (p.country IS NOT NULL OR 'country' = ANY (p.curator_locked)))
          OR (c.description IS NOT NULL AND (p.description IS NOT NULL OR 'description' = ANY (p.curator_locked)))
          OR (c.vinification IS NOT NULL AND (p.vinification IS NOT NULL OR 'vinification' = ANY (p.curator_locked)))
       ORDER BY c.id LIMIT 10`)
    if (taken.length) refuse('a column this file fills already holds a value or is locked by a curator (fill NULL only; a re-run is refused)', taken.map(r => r.id))
    if (!apply) throw ROLLBACK
    const n = await tx.$executeRawUnsafe(`
      UPDATE public.wine_products p
         SET country      = coalesce(c.country, p.country),
             description  = coalesce(c.description, p.description),
             vinification = coalesce(c.vinification, p.vinification)
        FROM _catalog_columns c
       WHERE p.id = c.id
         AND (c.country IS NULL OR p.country IS NULL)
         AND (c.description IS NULL OR p.description IS NULL)
         AND (c.vinification IS NULL OR p.vinification IS NULL)`)
    if (n !== rows.length) refuse(`the update changed ${n} rows, the file has ${rows.length}`)
  }, { timeout: 600_000, maxWait: 10_000 })
} catch (e) {
  if (e !== ROLLBACK) {
    if (e !== REFUSED) out.refused = { reason: e?.refused ? String(e.message) : `error: ${errText(e)}` }
    process.exitCode = 1
  }
} finally {
  await prisma.$disconnect()
}
if (out.refused) console.error(`${SCRIPT}: refused: ${out.refused.reason} (rolled back: nothing written, unless the error came at COMMIT itself)`)
console.log(JSON.stringify(out))
