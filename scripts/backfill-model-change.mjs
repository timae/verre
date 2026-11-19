#!/usr/bin/env node
// Catalogue model change, expand step: re-run the migration's backfill
// (docs/dev/proposals/wine-catalog-model-change.md § 6a pass criteria, § 8a.0;
// build plan step 2, run in step 8 item 6). The migration backfills at deploy,
// but the previous release keeps serving until its instances are gone and writes
// rows the backfill has not seen: a `spark` bottle with `sparkling = false`, a
// bottle whose type its PATCH changed (it mirrors `style`, never the snapshot), a
// `nonalc` one with no abv, a bookmark with no snapshot and no moment. Run this
// once no old instance is left.
//
//   DATABASE_URL=… node scripts/backfill-model-change.mjs                          # dry run
//   DATABASE_URL=… node scripts/backfill-model-change.mjs --apply --expect-db <host>/<db> # write
//
// 🔒 The steps are READ FROM THE MIGRATION (scripts/lib/modelChangeBackfill.mjs),
// never retyped here, and the script REFUSES unless that file's sha256 is the
// checksum the database recorded when it applied the migration: an edited block,
// or a checkout on another branch, never runs against prod. One transaction, with
// wines and bookmarks locked against writes for its length (milliseconds on
// prod), so a live craving cannot collide with the link step mid-run; the dry run
// rolls it back. Every step but `snapshot` is fill-only; `snapshot` re-derives
// colour / sparkling where they no longer derive to `style` (ruled, § 8a.0). A
// second --apply reports 0 everywhere.
//
// It REPORTS, and never changes, two things a human decides:
//   - unlinked bottles whose abv contradicts their style (abv 0 on a bottle whose
//     type an old instance changed away from alcohol-free, or `nonalc` with an abv
//     other than 0);
//   - bookmarks left unlinked although their bottle is linked, because the owner
//     already has a bookmark of that wine (the conversion merges them, § 5: keep
//     the visible row, else the earlier one).
// stdout: one JSON object (counts and row ids only; never names or notes). stderr:
// the target before connecting. Exit 0 = ran (dry run or applied), 1 = refused or
// error, 2 = usage.
import { argValue, boundTransaction, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'
import { expandMigrationIdentity, readBackfillSteps } from './lib/modelChangeBackfill.mjs'

const SCRIPT = 'backfill-model-change'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectDb = argValue(args, '--expect-db')
const known = new Set(['--apply', '--expect-db', expectDb])
if (args.some(a => !known.has(a)) || expectDb === null || (apply && !expectDb)) {
  console.error('usage: backfill-model-change.mjs [--apply --expect-db <host>/<database>]')
  process.exit(2)
}
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb)
const { createPrismaClient } = await import('./lib/prismaClient.mjs')
const steps = readBackfillSteps()
const migration = expandMigrationIdentity()
const ROLLBACK = Symbol('dry run')
const prisma = createPrismaClient()
const out = { mode: apply ? 'apply' : 'dry-run', database: null, bounds: null, migration: migration.name, steps: {}, report: {} }
let refused = null
try {
  await prisma.$transaction(async (tx) => {
    Object.assign(out, await boundTransaction(tx, { apply, expectDb }))
    const rec = await tx.$queryRawUnsafe(
      `SELECT checksum FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, migration.name)
    if (rec.length !== 1) throw Object.assign(new Error(`${migration.name} is not applied on this database`), { refused: true })
    if (rec[0].checksum !== migration.sha256) {
      throw Object.assign(new Error(`this checkout's ${migration.name}/migration.sql is not the file the database applied (sha256 differs): check out the release commit`), { refused: true })
    }
    await tx.$executeRawUnsafe(`LOCK TABLE public.wines, public.bookmarks IN SHARE ROW EXCLUSIVE MODE`)
    for (const s of steps) out.steps[s.name] = await tx.$executeRawUnsafe(s.sql)
    const abv = await tx.$queryRawUnsafe(`
      SELECT id FROM public.wines
       WHERE category = 'wine' AND product_id IS NULL
         AND ((style = 'nonalc' AND abv IS DISTINCT FROM 0) OR (style IS DISTINCT FROM 'nonalc' AND abv = 0))
       ORDER BY id`)
    const unlinked = await tx.$queryRawUnsafe(`
      SELECT b.id FROM public.bookmarks b JOIN public.wines w ON w.id = b.wine_id
       WHERE b.product_id IS NULL AND w.product_id IS NOT NULL ORDER BY b.id`)
    const [left] = await tx.$queryRawUnsafe(`
      SELECT (SELECT count(*) FROM public.wines WHERE origin IS NULL)::int AS "originNull",
             (SELECT count(*) FROM public.bookmarks WHERE wine_id IS NOT NULL AND name IS NULL)::int AS "bookmarkNoSnapshot",
             (SELECT count(*) FROM public.bookmarks WHERE source_session_id IS NULL)::int AS "bookmarkNoMoment"`)
    out.report = { abvContradictsStyle: abv.map(r => r.id), bookmarksLeftUnlinked: unlinked.map(r => r.id), ...left }
    if (!apply) throw ROLLBACK
  }, { timeout: 600_000, maxWait: 10_000 })
} catch (e) {
  if (e !== ROLLBACK) {
    refused = e?.refused ? String(e.message) : `error: ${errText(e)}`
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
