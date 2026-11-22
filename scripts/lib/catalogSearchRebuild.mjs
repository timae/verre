// The catalogue search rebuild (catalogue model change step 7b): the migration's
// `@recipe:catalog-search-build` block, read from the migration itself so there is
// ONE spelling of it. The migration runs it at deploy (tables empty);
// `rebuildCatalogSearch` re-runs it (scripts/rebuild-catalog-search.mts after every
// catalogue load and on release day, the suites on their fixtures, phase 4's
// import path); `catalogSearchDrift` is the dry run: what a rebuild would change.
//
// 🔒 It never TRUNCATEs (ACCESS EXCLUSIVE would queue every search behind it):
// docs whose words differ are upserted, docs whose source is gone deleted (in a
// fresh statement AFTER the upserts), words inserted with ndoc refreshed, and a
// word is NEVER deleted online (a stale word at worst skips a typo lookup; pruning
// is a separate operator step). One transaction, so readers never see docs
// without their words.
//
// 🔒 COORDINATION: the EXCLUSIVE catalog-search advisory lock is the first lock
// the rebuild's transaction takes (lib/catalogWrite.ts CATALOG_SEARCH_LOCK: phase
// 3's re-index writers and phase 4's imports take the SHARED form first, so a
// curator never re-indexes from a source a rebuild is halfway through). Mints take
// none for their docs (they only insert a new key); their word publication after
// COMMIT takes the shared form (lib/catalogWrite.ts addWords), so it never
// interleaves with a rebuild's word steps.
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations')
export const SEARCH_MIGRATION_SUFFIX = '_catalog_search'
// The same string as lib/catalogWrite.ts CATALOG_SEARCH_LOCK (pinned by
// scripts/tests/catalog-bottle-search.mts).
export const CATALOG_SEARCH_LOCK = 'verre:catalog-search'

export function searchMigrationPath() {
  const dirs = readdirSync(MIGRATIONS).filter(d => d.endsWith(SEARCH_MIGRATION_SUFFIX))
  if (dirs.length !== 1) throw new Error(`expected exactly one migration *${SEARCH_MIGRATION_SUFFIX}, found ${dirs.length}`)
  return join(MIGRATIONS, dirs[0], 'migration.sql')
}

/** The migration's name and the sha256 Prisma records for it (_prisma_migrations.checksum). */
export function searchMigrationIdentity(path = searchMigrationPath()) {
  return { name: basename(dirname(path)), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** @returns {{ name: string, sql: string }[]} the recipe's steps, in order */
export function readSearchRecipe(path = searchMigrationPath()) {
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf('-- @recipe:catalog-search-build\n')
  const end = text.indexOf('-- @endrecipe', start)
  if (start < 0 || end < 0) throw new Error(`no @recipe:catalog-search-build block in ${path}`)
  const steps = text.slice(start, end).split(/^-- @step /m).slice(1).map(chunk => {
    const nl = chunk.indexOf('\n')
    return { name: chunk.slice(0, nl).trim(), sql: chunk.slice(nl + 1).replace(/^\s*--.*$/gm, '').trim() }
  })
  for (const s of steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.name)) throw new Error(`bad step name ${JSON.stringify(s.name)}`)
    if (!s.sql.endsWith(';') || s.sql.slice(0, -1).includes(';')) throw new Error(`step ${s.name} must be exactly one statement`)
  }
  const names = steps.map(s => s.name).join(',')
  if (names !== 'stage-products,stage-producers,stage-words,words,orphan-words,docs,producer-docs,gone-docs,gone-producer-docs') {
    throw new Error(`the recipe's steps changed (${names}): update scripts/lib/catalogSearchRebuild.mjs with it`)
  }
  return steps
}

async function lockAndStage(tx, steps) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CATALOG_SEARCH_LOCK}'))`)
  const out = {}
  for (const s of steps.filter(x => x.name.startsWith('stage-'))) out[s.name] = await tx.$executeRawUnsafe(s.sql)
  return out
}

/**
 * The rebuild, inside the caller's transaction (give it a long `timeout`: about
 * 10 s on the full catalogue, dev DB 2026-11-21). Returns each step's row count.
 * Run `ANALYZE catalog_search_docs, catalog_search_producer_docs, catalog_search_words`
 * after the COMMIT.
 */
export async function rebuildCatalogSearch(tx, path = searchMigrationPath()) {
  const steps = readSearchRecipe(path)
  const out = await lockAndStage(tx, steps)
  for (const s of steps.filter(x => !x.name.startsWith('stage-'))) out[s.name] = await tx.$executeRawUnsafe(s.sql)
  return out
}

/**
 * The DRIFT REPORT (the rebuild's dry run): docs missing, stale (their source is
 * gone) or different (names, lead, region) from what the catalogue says now,
 * words the list lacks, and words whose typo eligibility a rebuild would flip
 * (`staleWordCounts`: a status-only change shows only there). Orphan words (in
 * the list, in no doc) are not counted: run --apply after every load anyway.
 * Writes nothing but its temp tables; roll the transaction back.
 */
export async function catalogSearchDrift(tx, path = searchMigrationPath(), sample = 5) {
  const steps = readSearchRecipe(path)
  const staged = await lockAndStage(tx, steps)
  const [c] = await tx.$queryRawUnsafe(`
    SELECT
      (SELECT count(*) FROM catalog_search_stage s WHERE NOT EXISTS (SELECT 1 FROM catalog_search_docs d WHERE d.product_id = s.product_id))::int AS "missingDocs",
      (SELECT count(*) FROM catalog_search_stage s JOIN catalog_search_docs d ON d.product_id = s.product_id
        WHERE (d.producer_words, d.survivor_words, d.name_words, d.region_words) IS DISTINCT FROM (s.producer_words, s.survivor_words, s.name_words, s.region_words))::int AS "differentDocs",
      (SELECT count(*) FROM catalog_search_docs d WHERE NOT EXISTS (SELECT 1 FROM wine_products wp WHERE wp.id = d.product_id))::int AS "staleDocs",
      (SELECT count(*) FROM catalog_search_stage_producers s WHERE NOT EXISTS (SELECT 1 FROM catalog_search_producer_docs d WHERE d.producer_id = s.producer_id))::int AS "missingProducerDocs",
      (SELECT count(*) FROM catalog_search_stage_producers s JOIN catalog_search_producer_docs d ON d.producer_id = s.producer_id
        WHERE d.tsv IS DISTINCT FROM array_to_tsvector(s.words))::int AS "differentProducerDocs",
      (SELECT count(*) FROM catalog_search_producer_docs d WHERE NOT EXISTS (SELECT 1 FROM producers p WHERE p.id = d.producer_id))::int AS "staleProducerDocs",
      (SELECT count(*) FROM catalog_search_stage_words s
        WHERE NOT EXISTS (SELECT 1 FROM catalog_search_words w WHERE w.word = s.word COLLATE "C"))::int AS "missingWords",
      (SELECT count(*) FROM catalog_search_stage_words s JOIN catalog_search_words w ON w.word = s.word COLLATE "C"
        WHERE (s.ndoc = 0) <> (w.ndoc = 0))::int AS "staleWordCounts"`)
  // Ids only (never names): which rows a rebuild would touch.
  const ids = await tx.$queryRawUnsafe(`
    (SELECT 'missing' AS kind, s.product_id AS id FROM catalog_search_stage s
      WHERE NOT EXISTS (SELECT 1 FROM catalog_search_docs d WHERE d.product_id = s.product_id) ORDER BY 2 LIMIT ${sample})
    UNION ALL
    (SELECT 'different', s.product_id FROM catalog_search_stage s JOIN catalog_search_docs d ON d.product_id = s.product_id
      WHERE (d.producer_words, d.survivor_words, d.name_words, d.region_words) IS DISTINCT FROM (s.producer_words, s.survivor_words, s.name_words, s.region_words) ORDER BY 2 LIMIT ${sample})
    UNION ALL
    (SELECT 'stale', d.product_id FROM catalog_search_docs d WHERE NOT EXISTS (SELECT 1 FROM wine_products wp WHERE wp.id = d.product_id) ORDER BY 2 LIMIT ${sample})`)
  return { staged, ...c, sample: ids.map(r => `${r.kind}:${r.id}`) }
}
