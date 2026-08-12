#!/usr/bin/env node
// ── Migration atomicity gate ───────────────────────────────────────────────
//
// 🔒 PRISMA DOES NOT WRAP MIGRATION SQL IN A TRANSACTION. Measured, not
// assumed: a file whose third statement fails leaves the first two COMMITTED.
// So a multi-statement migration without an explicit BEGIN/COMMIT can leave a
// HALF-APPLIED SCHEMA — a table created and seeded while its constraints are
// absent, or one of two mutually-dependent functions altered.
//
// ⚠️ That also contradicts the operational story in prisma/CLAUDE.md ("the
// migration succeeds or the deploy is rolled back"). Rolling back the DEPLOY
// does not undo already-committed DDL. The rollback story is only true for
// migrations that are individually atomic.
//
// ⚠️ WHY THIS GATE EXISTS (Codex review, 2026-08-12): two migrations shipped on
// this branch without wrappers while the four catalog migrations immediately
// preceding them all had one — and CI passed, because the existing check only
// proves the chain applies cleanly on a fresh database. Success on the happy
// path says nothing about failure atomicity. The catalog-maintenance side had
// already built the equivalent gate; the side actually applying these
// migrations to production had not.
//
// WHAT IT CHECKS. Every migration with more than one top-level statement must
// open with BEGIN and end with COMMIT.
//
// 🔒 SINGLE-STATEMENT MIGRATIONS ARE EXEMPT, and that is not laziness: one
// statement is atomic by definition in Postgres, so a wrapper adds nothing.
// Requiring it anyway would train people to add ceremony rather than think
// about atomicity — and a rule that fires on cases where it does not matter
// gets suppressed on the cases where it does.
//
// ⚠️ CONCURRENT INDEX BUILDS CANNOT RUN IN A TRANSACTION. `CREATE INDEX
// CONCURRENTLY` errors inside BEGIN/COMMIT, so such a migration is exempt and
// must instead be a single statement or carry its own recovery note. The
// exemption is named explicitly rather than left to whoever hits it first.
//
//   node scripts/check-migration-transactions.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations')

// Strip line comments and dollar-quoted bodies before counting statements: a
// `DO $$ … $$` block contains semicolons that are not statement terminators,
// and every catalog migration uses them.
function stripped(sql) {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, '$$$$')
    .replace(/^\s*--.*$/gm, '')
}

function topLevelStatements(sql) {
  return stripped(sql).split(';').map(s => s.trim()).filter(Boolean).length
}

// 🔒 GRANDFATHERED: migrations applied BEFORE this gate existed.
//
// ⚠️ 18 of them, including the 82-statement `20260725090000_wine_catalog_schema`.
// They are NOT exempt because they are acceptable — they carry exactly the risk
// this gate describes. They are exempt because **editing an applied migration is
// forbidden** (prisma/CLAUDE.md § Editing a migration after it has been applied:
// the edit is invisible to `migrate status` and `migrate deploy`, so the repo
// would silently stop describing what production ran). Retrofitting a wrapper
// would be a worse defect than the one it fixes.
//
// 🔒 THIS LIST IS CLOSED. Nothing may be added to it. A new migration that
// fails this gate has not been applied anywhere yet — so the fix is to wrap the
// file, never to append its name here. If you are reading this while tempted to
// add an entry, that is the moment the gate is being defeated.
const GRANDFATHERED = new Set([
  '20260503010556_baseline',
  '20260504120000_add_social_feed',
  '20260505000000_add_checkin_tags',
  '20260505120000_align_social_feed_fk_cascade',
  '20260506210504_expand_session_code_to_varchar16',
  '20260510011022_quarter_stars_score_decimal',
  '20260511120000_privacy_visibility_tiers',
  '20260511141330_kickban_wine_added_by',
  '20260511150000_user_mute',
  '20260511160000_user_block',
  '20260514183437_rewire_phase1_schema',
  '20260514214124_rewire_phase2_session_nullability',
  '20260516125827_rewire_phase4_drop_checkins',
  '20260601105146_add_user_sessions',
  '20260609150104_native_auth_schema',
  '20260609195038_native_auth_int_pks',
  '20260705120000_moments_search_unaccent',
  '20260725090000_wine_catalog_schema',
])

const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

if (dirs.length === 0) {
  // ⚠️ NOT a pass — an empty migrations directory means this gate verified
  // nothing, which is indistinguishable from every migration being correct.
  console.error('FAIL: no migrations found. Is prisma/migrations populated?')
  process.exit(1)
}

const problems = []
let checked = 0
let exempt = 0
let grandfathered = 0

for (const name of dirs) {
  let sql
  try {
    sql = readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8')
  } catch {
    continue
  }
  const body = stripped(sql)
  if (/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body)) {
    exempt++
    continue
  }
  const statements = topLevelStatements(sql)
  if (statements <= 1) { exempt++; continue }
  if (GRANDFATHERED.has(name)) { grandfathered++; continue }
  checked++
  const hasBegin = /^\s*BEGIN\s*;/im.test(body)
  const hasCommit = /^\s*COMMIT\s*;/im.test(body)
  if (!hasBegin || !hasCommit) {
    problems.push({ name, statements, hasBegin, hasCommit })
  }
}

if (problems.length === 0) {
  console.log(`ok  ${checked} multi-statement migration(s) are transactional (${exempt} exempt: single-statement or CONCURRENTLY; ${grandfathered} grandfathered pre-gate — list is CLOSED)`)
  process.exit(0)
}

console.error('FAIL: multi-statement migrations without an explicit transaction.\n')
for (const p of problems) {
  console.error(`  ${p.name}`)
  console.error(`     ${p.statements} top-level statements, BEGIN=${p.hasBegin}, COMMIT=${p.hasCommit}`)
}
console.error('')
console.error('  🔒 Prisma does NOT wrap migration SQL. A failure partway through commits')
console.error('     everything before it, leaving a half-applied schema that no gate on this')
console.error('     branch would recognise as wrong. Wrap the file in BEGIN; … COMMIT;')
console.error('     (`prisma migrate resolve --rolled-back` is only truthful for atomic files.)')
console.error('')
console.error('     Exempt: a single statement (atomic already), or CREATE INDEX')
console.error('     CONCURRENTLY (cannot run inside a transaction).')
process.exit(1)
