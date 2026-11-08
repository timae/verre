#!/usr/bin/env node
// ── Session-record CHECK-constraint gate ────────────────────────────────────
//
// `prisma migrate diff` is blind to CHECK predicates, and the session record
// carries one that the redis-rehydration design depends on
// (docs/dev/proposals/redis-rehydration.md § 4.3): `ratings_session_rater_known`
// — a session rating always names its rater, a live user or the (deleted
// user, session) tombstone key. Account deletion is structured around that
// refusal; dropping or loosening it would let a rating lose its rater with
// every test still green. Sibling of check-catalog-contract-checks.mjs, much
// smaller: the tables below are not an import contract, so only the CHECK
// bodies are compared.
//
// Reads a REAL migrated database and diffs every CHECK constraint on the
// session-record tables byte-for-byte against prisma/session-record-checks.json.
// Any addition, removal or alteration fails the build.
//
// Usage:
//   DATABASE_URL=postgres://…/<throwaway> node scripts/check-session-record-checks.mjs
//   DATABASE_URL=…                         node scripts/check-session-record-checks.mjs --write
//
// `--write` REGENERATES the snapshot (how a deliberate change is recorded;
// never run in CI).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPrismaClient } from './lib/prismaClient.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = join(root, 'prisma', 'session-record-checks.json')
const TABLES = ['ratings', 'sessions', 'session_members', 'session_bans', 'session_tombstones']

const prisma = createPrismaClient()
try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT c.conrelid::regclass::text AS "table", c.conname AS name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.contype = 'c' AND c.conrelid::regclass::text = ANY($1::text[])
     ORDER BY 1, 2`, TABLES)
  const live = Object.fromEntries(rows.map(r => [`${r.table}.${r.name}`, r.def]))
  if (process.argv.includes('--write')) {
    writeFileSync(SNAPSHOT, JSON.stringify({
      _readme: 'CHECK constraints on the session-record tables, as pg_get_constraintdef prints them. Diffed by scripts/check-session-record-checks.mjs in check-schema.yml. Regenerate with --write only for a deliberate change.',
      tables: TABLES,
      checks: live,
    }, null, 2) + '\n')
    console.log(`wrote ${Object.keys(live).length} CHECK constraint(s) to ${SNAPSHOT}`)
  } else {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    if (JSON.stringify(snap.tables) !== JSON.stringify(TABLES)) throw new Error('snapshot table list differs from the script — regenerate deliberately')
    const problems = []
    for (const [key, def] of Object.entries(snap.checks)) {
      if (!(key in live)) problems.push(`missing: ${key} (${def})`)
      else if (live[key] !== def) problems.push(`altered: ${key}\n    snapshot: ${def}\n    database: ${live[key]}`)
    }
    for (const key of Object.keys(live)) if (!(key in snap.checks)) problems.push(`added: ${key} (${live[key]})`)
    if (problems.length) {
      console.error(`FAIL session-record CHECK constraints differ from prisma/session-record-checks.json:\n  ${problems.join('\n  ')}`)
      process.exitCode = 1
    } else {
      console.log(`ok  ${Object.keys(live).length} session-record CHECK constraint(s) match the snapshot`)
    }
  }
} finally {
  await prisma.$disconnect()
}
