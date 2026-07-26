#!/usr/bin/env node
// Detects a migration file edited AFTER it was applied.
//
// 🔒 WHY THIS EXISTS: `prisma migrate status` and `prisma migrate deploy` BOTH
// report success in that situation — measured, not assumed. Only `migrate dev`
// catches it, and that path is local-only (it demands a reset). So on any
// shared/staging/prod database there is no first-party command that answers
// "do the applied migrations still say what they said?".
//
//   DATABASE_URL=postgres://… node scripts/check-migration-checksums.mjs
//
// Exit 0 = every applied migration matches its recorded checksum.
// Exit 1 = at least one mismatch, or a recorded migration whose file is gone.
//
// Pending local migrations are reported separately and are NOT a failure —
// they are the normal "not deployed yet" state, not corruption.
//
// ⚠️ Node's crypto, not `sha256sum` (absent on macOS by default). Joined by
// migration_name, never by output order.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations')
const prisma = new PrismaClient()

// Prisma checksums the migration.sql bytes with sha256, hex-encoded.
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')

const onDisk = new Map(
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(MIGRATIONS, e.name, 'migration.sql')))
    .map(e => [e.name, hash(join(MIGRATIONS, e.name, 'migration.sql'))]))

const rows = await prisma.$queryRawUnsafe(`
  SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM _prisma_migrations ORDER BY started_at`)

const mismatched = [], missingFile = [], notApplied = [], rolledBack = []
for (const r of rows) {
  // A rolled-back or never-finished row does not describe applied state, so its
  // checksum is not a claim about the current database. Reported, not failed.
  if (r.rolled_back_at || !r.finished_at) { rolledBack.push(r.migration_name); continue }
  const disk = onDisk.get(r.migration_name)
  if (!disk) { missingFile.push(r.migration_name); continue }
  if (disk !== r.checksum) mismatched.push({ name: r.migration_name, recorded: r.checksum, disk })
}
const recorded = new Set(rows.map(r => r.migration_name))
for (const name of onDisk.keys()) if (!recorded.has(name)) notApplied.push(name)

for (const m of mismatched) {
  console.error(`EDITED AFTER APPLY  ${m.name}\n  recorded ${m.recorded}\n  on disk  ${m.disk}`)
}
for (const n of missingFile) console.error(`FILE MISSING        ${n} (applied, but no migration.sql)`)
for (const n of rolledBack) console.log(`rolled back/unfinished  ${n} (not checked)`)
for (const n of notApplied) console.log(`pending                 ${n} (not applied here — normal)`)

const bad = mismatched.length + missingFile.length
console.log(bad === 0
  ? `\nOK — ${rows.length - rolledBack.length} applied migrations match their recorded checksums.`
  : `\nFAIL — ${bad} problem(s).`)
await prisma.$disconnect()
process.exit(bad === 0 ? 0 : 1)
