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
  return stripped(sql).split(';').map(s => s.trim()).filter(Boolean)
}

// 🔒 THE WRAPPER MUST BE POSITIONAL, NOT MERELY PRESENT.
//
// ⚠️ The first version of this gate tested `/^\s*BEGIN\s*;/im` — multiline, so
// it proved only that the token appeared on SOME line. Measured (Codex review,
// 2026-08-12): a migration running `ALTER TABLE … ;` BEFORE `BEGIN` and another
// AFTER `COMMIT` passed as "transactional", with both stray statements
// executing unprotected. That is the gate's own stated contract — "open with
// BEGIN and end with COMMIT" — failing on its own terms.
//
// A gate written while thinking specifically about atomicity, and it verified
// less than it claimed. The class does not stop applying to the code you write
// while thinking about the class.
//
// So: BEGIN must be the FIRST top-level statement, COMMIT the LAST, and there
// must be exactly one of each — anything else leaves statements outside the
// transaction or nests wrappers ambiguously.
function wrapperShape(statements) {
  const begins = statements.filter(s => /^BEGIN$/i.test(s)).length
  const commits = statements.filter(s => /^COMMIT$/i.test(s)).length
  return {
    begins,
    commits,
    firstIsBegin: /^BEGIN$/i.test(statements[0] ?? ''),
    lastIsCommit: /^COMMIT$/i.test(statements[statements.length - 1] ?? ''),
  }
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

// 🔒 A GRANDFATHER ENTRY IS ONLY VALID IF THE MIGRATION PREDATES THE GATE.
// ⚠️ The list being "closed" was a COMMENT, and a comment cannot stop an append
// — measured: adding a new name to the set made the gate pass. Enforced now by
// a cutoff: every grandfathered migration was applied before this gate existed,
// so a name that sorts at or after the cutoff cannot legitimately be on the
// list no matter who typed it. The prefix is the Prisma timestamp, so a string
// compare is a date compare.
const GRANDFATHER_CUTOFF = '20260726'

for (const name of dirs) {
  let sql
  try {
    sql = readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8')
  } catch {
    // ⚠️ ABSENCE IS A FAILURE, NOT AN EXEMPTION. The directory listing is the
    // authoritative input, so a directory whose SQL cannot be read means this
    // gate did not inspect a migration — indistinguishable, on a green run,
    // from having inspected it and found it correct.
    problems.push({ name, kind: 'UNREADABLE' })
    continue
  }
  const statements = topLevelStatements(sql)

  // A single statement is atomic by definition; a wrapper adds nothing.
  if (statements.length <= 1) { exempt++; continue }

  if (GRANDFATHERED.has(name)) {
    if (name >= GRANDFATHER_CUTOFF) {
      problems.push({ name, kind: 'ILLEGITIMATE-GRANDFATHER' })
      continue
    }
    grandfathered++
    continue
  }

  checked++

  // 🔒 CONCURRENTLY EXEMPTS ONLY ITS OWN STATEMENTS, NOT THE FILE.
  // ⚠️ Measured: one `CREATE INDEX CONCURRENTLY` previously exempted a file that
  // also ran an unwrapped `ALTER TABLE` and `DROP TABLE`. The constraint is that
  // a concurrent build cannot run INSIDE a transaction — which makes such a file
  // unable to be atomic at all, so it must contain nothing else that needs
  // protection.
  const concurrent = statements.filter(s => /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s))
  if (concurrent.length > 0) {
    const others = statements.filter(s => !/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s))
    if (others.length > 0) {
      problems.push({ name, kind: 'CONCURRENT-MIXED', extra: others.length })
    } else {
      exempt++
      checked--
    }
    continue
  }

  const shape = wrapperShape(statements)
  if (!shape.firstIsBegin || !shape.lastIsCommit || shape.begins !== 1 || shape.commits !== 1) {
    problems.push({ name, kind: 'NOT-WRAPPED', statements: statements.length, shape })
  }
}

if (problems.length === 0) {
  console.log(`ok  ${checked} multi-statement migration(s) are transactional (${exempt} exempt: single-statement or CONCURRENTLY; ${grandfathered} grandfathered pre-gate — list is CLOSED)`)
  process.exit(0)
}

console.error('FAIL: migration atomicity.\n')
for (const p of problems) {
  console.error(`  ${p.kind}  ${p.name}`)
  if (p.kind === 'NOT-WRAPPED') {
    const s = p.shape
    console.error(`     ${p.statements} top-level statements; first=BEGIN:${s.firstIsBegin} last=COMMIT:${s.lastIsCommit} (${s.begins} BEGIN, ${s.commits} COMMIT)`)
    console.error('     BEGIN must be the FIRST statement and COMMIT the LAST — a token')
    console.error('     somewhere in the file leaves statements outside the transaction.')
  }
  if (p.kind === 'UNREADABLE') {
    console.error('     migration.sql could not be read. A directory the gate cannot inspect')
    console.error('     is a failure, not an exemption — a green run would be a lie.')
  }
  if (p.kind === 'CONCURRENT-MIXED') {
    console.error(`     CREATE INDEX CONCURRENTLY plus ${p.extra} other statement(s).`)
    console.error('     A concurrent build cannot run inside a transaction, so this file')
    console.error('     cannot be atomic — split it: the concurrent index alone, and the')
    console.error('     rest in its own wrapped migration.')
  }
  if (p.kind === 'ILLEGITIMATE-GRANDFATHER') {
    console.error(`     on the grandfather list but sorts at/after the ${GRANDFATHER_CUTOFF} cutoff.`)
    console.error('     The list covers migrations applied BEFORE this gate existed; a newer')
    console.error('     one has not been applied anywhere, so wrap the file instead.')
  }
  console.error('')
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
