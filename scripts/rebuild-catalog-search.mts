#!/usr/bin/env -S npx tsx
// Catalogue search: the drift report (default) and the rebuild (--apply). Run
// after EVERY catalogue load (a load writes producers / products behind our back:
// its new wines are unfindable until this runs) and on release day once the
// previous release's instances are gone (they mint without docs). Catalogue
// model change step 7b; docs/dev/deployment.md § Catalogue search.
//
//   DATABASE_URL=… npx tsx scripts/rebuild-catalog-search.mts                                   # drift report
//   DATABASE_URL=… npx tsx scripts/rebuild-catalog-search.mts --apply --expect-db <host>/<db>   # rebuild
//
// 🔒 The rebuild is the migration's own `@recipe:catalog-search-build` block
// (scripts/lib/catalogSearchRebuild.mjs), never retyped here, and the script
// REFUSES unless that file's sha256 is the checksum the database recorded. One
// transaction under the exclusive catalog-search advisory lock; it never
// truncates and never deletes a word; searches are not blocked (about 10 s on the
// full catalogue, dev DB 2026-11-21). The dry run takes the same lock and rolls
// back. Then ANALYZE. A second --apply reports 0 changed docs. ⚠️ Run --apply
// after every load WHATEVER the report says: a load that only changes statuses
// (an entry rejected) shows up only as `staleWordCounts` (words whose typo
// eligibility a rebuild would flip), never as a different doc.
// stdout: one JSON object (counts and ids only, never names). stderr: the target.
// Exit 0 = ran, 1 = refused or error, 2 = usage.
import { argValue, boundTransaction, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'
import { catalogSearchDrift, rebuildCatalogSearch, searchMigrationIdentity } from './lib/catalogSearchRebuild.mjs'
import type { Prisma } from '@prisma/client'
type Tx = Prisma.TransactionClient

const SCRIPT = 'rebuild-catalog-search'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectDb = argValue(args, '--expect-db')
const known = new Set(['--apply', '--expect-db', expectDb])
if (args.some(a => !known.has(a)) || expectDb === null || (apply && !expectDb)) {
  console.error('usage: rebuild-catalog-search.mts [--apply --expect-db <host>/<database>]')
  process.exit(2)
}
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb)
const { createPrismaClient } = await import('./lib/prismaClient.mjs')
const migration = searchMigrationIdentity()
const ROLLBACK = Symbol('dry run')
const prisma = createPrismaClient()
const out: Record<string, unknown> = { mode: apply ? 'apply' : 'dry-run', database: null, bounds: null, migration: migration.name }
let refused: string | null = null
try {
  const t0 = performance.now()
  await prisma.$transaction(async (tx: Tx) => {
    Object.assign(out, await boundTransaction(tx, { apply, expectDb }))
    const rec = await tx.$queryRawUnsafe<{ checksum: string }[]>(
      `SELECT checksum FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, migration.name)
    if (rec.length !== 1) throw Object.assign(new Error(`${migration.name} is not applied on this database`), { refused: true })
    if (rec[0].checksum !== migration.sha256) {
      throw Object.assign(new Error(`this checkout's ${migration.name}/migration.sql is not the file the database applied (sha256 differs): check out the release commit`), { refused: true })
    }
    // The full catalogue's stage step runs for seconds: a longer statement bound.
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '300s'`)
    out.drift = await catalogSearchDrift(tx)
    if (!apply) throw ROLLBACK
  }, { timeout: 600_000, maxWait: 10_000 })
  if (apply) {
    await prisma.$transaction(async (tx: Tx) => {
      await boundTransaction(tx, { apply, expectDb })
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '300s'`)
      out.steps = await rebuildCatalogSearch(tx)
    }, { timeout: 600_000, maxWait: 10_000 })
    await prisma.$executeRawUnsafe('ANALYZE catalog_search_docs, catalog_search_producer_docs, catalog_search_words')
  }
  out.ms = Math.round(performance.now() - t0)
} catch (e) {
  if (e !== ROLLBACK) {
    refused = (e as { refused?: boolean })?.refused ? String((e as Error).message) : `error: ${errText(e)}`
    process.exitCode = 1
  }
} finally {
  await prisma.$disconnect()
}
if (refused) {
  console.error(`${SCRIPT}: ${refused} (rolled back: nothing written, unless the error came at COMMIT itself)`)
  out.refused = refused
}
console.log(JSON.stringify(out))
