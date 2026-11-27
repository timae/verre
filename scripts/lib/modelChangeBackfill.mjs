// The catalogue model change's backfill (wine-catalog-model-change.md § 1, § 5,
// § 6; build step 2), read from the expand migration itself so there is ONE
// spelling of it: the migration runs it at deploy, scripts/backfill-model-change.mjs
// re-runs it once the previous release's instances are gone, and
// scripts/tests/model-change-expand-section.mjs drives it on fixtures.
//
// The block sits between `-- @recipe:model-change-backfill` and `-- @endrecipe`
// in the migration; each step is ONE statement headed `-- @step <name>`. Every
// step but `snapshot` is fill-only (it writes a column only where it is still
// unwritten); `snapshot` re-derives colour / sparkling where they no longer derive
// to `style` (ruled, spec § 8a.0). So a re-run changes exactly what an old writer
// left meanwhile and a second re-run changes nothing. The refusal before the
// schema changes is `-- @recipe:model-change-refusal` (readRecipe).
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations')
export const EXPAND_SUFFIX = '_catalog_model_change_expand'

export function expandMigrationPath() {
  const dirs = readdirSync(MIGRATIONS).filter(d => d.endsWith(EXPAND_SUFFIX))
  if (dirs.length !== 1) throw new Error(`expected exactly one migration *${EXPAND_SUFFIX}, found ${dirs.length}`)
  return join(MIGRATIONS, dirs[0], 'migration.sql')
}

/** The migration's name and the sha256 Prisma records for it (_prisma_migrations.checksum). */
export function expandMigrationIdentity(path = expandMigrationPath()) {
  return { name: basename(dirname(path)), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** A `-- @recipe:<name>` … `-- @endrecipe` block of the expand migration, verbatim. */
export function readRecipe(name, path = expandMigrationPath()) {
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf(`-- @recipe:${name}\n`)
  const end = text.indexOf('-- @endrecipe', start)
  if (start < 0 || end < 0) throw new Error(`no @recipe:${name} block in ${path}`)
  return text.slice(start, end)
}

/** @returns {{ name: string, sql: string }[]} the steps, in order */
export function readBackfillSteps(path = expandMigrationPath()) {
  const steps = readRecipe('model-change-backfill', path).split(/^-- @step /m).slice(1).map(chunk => {
    const nl = chunk.indexOf('\n')
    const sql = chunk.slice(nl + 1).replace(/^\s*--.*$/gm, '').trim()
    return { name: chunk.slice(0, nl).trim(), sql }
  })
  for (const s of steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.name)) throw new Error(`bad step name ${JSON.stringify(s.name)}`)
    // One statement per step: its affected-row count is the step's count.
    if (!s.sql.endsWith(';') || s.sql.slice(0, -1).includes(';')) throw new Error(`step ${s.name} must be exactly one statement`)
  }
  if (!steps.length) throw new Error('the backfill block has no steps')
  return steps
}
