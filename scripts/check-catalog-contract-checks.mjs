#!/usr/bin/env node
// ── Catalog contract CHECK-constraint gate ─────────────────────────────────
//
// WHY THIS EXISTS. The shapes of the five catalog tables are a VERSIONED IMPORT
// CONTRACT (docs/dev/proposals/wine-catalog.md § Catalog write ownership). For
// most of that section's life "shape" was never defined, and it read as
// columns-and-types — so `20260725220000` § 3 swapped four CHECK predicates from
// `btrim(x) <> ''` to `catalog_fold_v1(x) <> ''` with no surface, no version
// bump, and nothing on either side that would have noticed.
//
// 🔒 THAT CHANGE WAS AN AVAILABILITY CHANGE, NOT A MATCHING ONE. A stricter
// predicate makes rows NON-INSERTABLE, not merely non-matching. Because an
// import batch is one all-or-nothing transaction, a single name nobody edited
// can roll back the whole batch. That is the failure this gate exists to stop.
//
// ⚠️ THIS IS THE THIRD TIME IN THIS WORKSTREAM THE MECHANISM WAS A COMMENT.
// `catalog_fold_v1`'s never-edit-a-v1-body rule is a comment. The both-sides-
// together fold rule is a comment. Both were correct and neither was enforced.
// The catalog-maintenance side independently designed this same mechanism (a
// committed `pg_get_constraintdef` snapshot diffed in CI with an explicit
// accepted-divergence list) before seeing ours, which is about as good as
// evidence gets that it is the right shape.
//
// WHAT IT DOES. Reads every CHECK on the five contract tables from a REAL
// migrated database and diffs it byte-for-byte against the committed snapshot
// at prisma/catalog-contract-checks.json. Any added, removed, or altered
// predicate fails the build.
//
// 🔒 IT DIFFS STRUCTURAL CONSTRAINTS TOO. The rejection-surface test decides
// whether a change is a CONTRACT EVENT (announce + version bump); it does not
// decide whether the gate watches. Drift is drift. Scoping the gate to
// contract-only constraints would make the snapshot negotiable per change,
// which is the same defeat the fold handshake avoids by putting the array
// helper on the wire even where it backs no column.
//
// Usage:
//   DATABASE_URL=postgres://…/catalog_test node scripts/check-catalog-contract-checks.mjs
//   DATABASE_URL=…                          node scripts/check-catalog-contract-checks.mjs --write
//
// `--write` REGENERATES the snapshot from the database. It is how you record a
// deliberate change; it is never run in CI. `scope` values are preserved across
// a regenerate (they are a human judgement, not a database fact) and a
// newly-appearing constraint is written with scope `UNCLASSIFIED`, which the
// gate then rejects until somebody classifies it.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PrismaClient } from '@prisma/client'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = join(root, 'prisma', 'catalog-contract-checks.json')

// The five tables named in § Catalog write ownership. `wines`' two link columns
// are contract surface as well, but they carry no CHECK of their own — the
// composite-FK + `vintage_id IS NULL OR product_id IS NOT NULL` rules live on
// `wines`, which is not a catalog table and is covered by check-schema's own
// integration suite.
const TABLES = ['producers', 'wine_products', 'wine_vintages', 'product_producers', 'product_eans']

const write = process.argv.includes('--write')

// 🔒 Read the constraints THE SAME WAY the snapshot was generated:
// `pg_get_constraintdef`, which normalises the predicate to Postgres' own
// canonical spelling. That is what makes the comparison meaningful — a
// cosmetic reformat in the migration SQL produces an IDENTICAL definition here
// (Postgres reparses and reprints), so the gate fires on SEMANTIC change and
// not on whitespace in a .sql file. The inverse of the fold handshake, which
// deliberately compares raw source text because THERE byte-identity is the
// contract.
const QUERY = `
  SELECT c.conrelid::regclass::text AS "table",
         c.conname                  AS "name",
         pg_get_constraintdef(c.oid) AS "definition"
  FROM pg_constraint c
  WHERE c.conrelid::regclass::text = ANY($1::text[])
    AND c.contype = 'c'
  ORDER BY 1, 2
`

// 🔒 A PREDICATE'S MEANING IS NOT IN ITS TEXT WHEN IT CALLS A FUNCTION.
// `pg_get_constraintdef` records the CALL, not the callee's body — so replacing
// a helper changes the accepted payload set while the definition stays
// byte-identical and this gate stays green.
//
// ⚠️ MEASURED, not theorised (2026-08-11): `CREATE OR REPLACE FUNCTION
// gtin_check_digit_ok` returning a constant `true` made `product_eans` accept
// check-digit-invalid barcodes — permanent identity keys — while
// `product_eans_check_digit` reprinted CHARACTER-FOR-CHARACTER and the gate
// reported "ok 22 constraints match". That is precisely the silent contract
// change this gate exists to stop, one level down.
//
// The fold has a dedicated identity handshake because it is shared across two
// systems; `gtin_check_digit_ok` had NO equivalent at all. Hashing every
// function a contract CHECK depends on covers both, and covers the next helper
// automatically.
//
// 🔒 RESOLVED VIA `pg_depend`, never by parsing the predicate text. A token
// scan would miss a function called from inside another function, mis-handle
// operators, and break on quoting — and it would fail OPEN (finding no
// dependency looks identical to having none). `pg_depend` is what Postgres
// itself uses to refuse `DROP FUNCTION` while a constraint needs it, so it is
// authoritative by construction.
//
// `pg_get_functiondef` (not `prosrc`) for the same reason the fold handshake
// uses it: it covers signature, return type, volatility, STRICT and PARALLEL
// SAFE, any of which changes behaviour without touching the body.
const DEPS_QUERY = `
  SELECT c.conrelid::regclass::text     AS "table",
         c.conname                      AS "name",
         p.oid::regprocedure::text      AS "function",
         md5(pg_get_functiondef(p.oid)) AS "bodyHash"
  FROM pg_constraint c
  JOIN pg_depend d ON d.objid = c.oid
                  AND d.classid = 'pg_constraint'::regclass
                  AND d.refclassid = 'pg_proc'::regclass
  JOIN pg_proc p ON p.oid = d.refobjid
  WHERE c.conrelid::regclass::text = ANY($1::text[])
    AND c.contype = 'c'
  ORDER BY 1, 2, 3
`

// 🔒 GENERATED COLUMNS HAVE THE SAME BLIND SPOT AS CHECKS, one object type over.
//
// ⚠️ Raised by the catalog-maintenance side (2026-08-11) and REPRODUCED HERE:
// `generation_expression` records `catalog_fold_v1((name)::text)` — the CALL.
// Replace the fold body and the expression stays byte-identical while every
// subsequently-written row is keyed differently. Measured: after swapping the
// body, `Château X` stored `name_folded = 'CHÂTEAU X'` instead of
// `chateau x`. That is `producers.name_folded` — the producer matching key for
// the whole catalog — silently re-keyed on next write.
//
// Four of the five folded columns are also covered incidentally (the four
// fold-backed CHECKs share `catalog_fold_v1`), but `grapes_folded` uses
// `catalog_fold_arr_v1`, which NO check references. Relying on the incidental
// overlap would leave that one uncovered and the rest covered by accident.
//
// Same `pg_depend` resolution as the CHECK path, via `pg_attrdef` — a generated
// column's dependency is recorded with the attrdef as dependent, not the column.
const GENCOL_QUERY = `
  SELECT c.relname                       AS "table",
         a.attname                       AS "column",
         pg_get_expr(ad.adbin, ad.adrelid) AS "expression",
         p.oid::regprocedure::text       AS "function",
         md5(pg_get_functiondef(p.oid))  AS "bodyHash"
  FROM pg_attrdef ad
  JOIN pg_class c ON c.oid = ad.adrelid
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  JOIN pg_depend d ON d.objid = ad.oid
                  AND d.classid = 'pg_attrdef'::regclass
                  AND d.refclassid = 'pg_proc'::regclass
  JOIN pg_proc p ON p.oid = d.refobjid
  WHERE a.attgenerated <> ''
    AND c.relname = ANY($1::text[])
  ORDER BY 1, 2, 4
`

function key(c) {
  return `${c.table}.${c.name}`
}

// One comparable line per generated column: expression + every function it
// depends on, hashed. Sorted so the ordering is stable across dumps.
function genColRows(rows) {
  const byCol = new Map()
  for (const r of rows) {
    const k = `${r.table}.${r.column}`
    if (!byCol.has(k)) byCol.set(k, { column: k, expression: r.expression, deps: [] })
    byCol.get(k).deps.push(`${r.function}=${r.bodyHash}`)
  }
  return [...byCol.values()]
    .map(v => ({ ...v, deps: v.deps.sort() }))
    .sort((a, b) => a.column.localeCompare(b.column))
}

// Deps for one constraint, as a stable comparable string.
function depsFor(rows, k) {
  return rows
    .filter(r => key(r) === k)
    .map(r => `${r.function}=${r.bodyHash}`)
    .sort()
}

// 🔒 DERIVED FROM THE DEPENDENCIES, never a carried flag.
//
// ⚠️ This was a real bug, found by staging a failure for a behaviour that had
// only been reasoned about: `foldDependent` used to be copied from the prior
// snapshot entry and DROPPED whenever the constraint changed. So editing a
// fold-dependent CHECK silently removed its marker, and the next change to it
// no longer printed the fold-divergence warning — the gate losing a safety
// property while staying green. Deriving it means the marker cannot desync from
// the thing it describes, and a NEW fold-backed constraint gets it for free.
function isFoldDependent(depStrings) {
  return depStrings.some(d => d.startsWith('catalog_fold_'))
}

async function main() {
  const prisma = new PrismaClient()
  let live, deps, genCols
  try {
    live = await prisma.$queryRawUnsafe(QUERY, TABLES)
    deps = await prisma.$queryRawUnsafe(DEPS_QUERY, TABLES)
    genCols = genColRows(await prisma.$queryRawUnsafe(GENCOL_QUERY, TABLES))
  } finally {
    await prisma.$disconnect()
  }

  if (live.length === 0) {
    // ⚠️ NOT a pass. An empty result means the migrations were never applied to
    // this database — exactly the state in which a gate that "found no
    // differences" would be reporting coverage it does not have.
    console.error('FAIL: no CHECK constraints found on the catalog tables.')
    console.error('      Is DATABASE_URL pointed at a database with the migrations applied?')
    process.exit(1)
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const committed = snapshot.constraints

  if (write) {
    // 🔒 SCOPE IS RE-EARNED WHENEVER THE PREDICATE MOVES. Carrying the old
    // scope across a CHANGED definition is the hole that made the first version
    // of this gate unsound: the rejection-surface test is a property of a
    // TRANSITION ("can a payload valid under the OLD predicate be rejected by
    // the NEW one?"), not a permanent label on a constraint. A `structural`
    // constraint that is edited into a rejecting one would have kept
    // `structural`, and `--write` would have made CI green with no human ever
    // re-applying the test. So a changed definition — or changed predicate
    // dependencies — resets the scope to UNCLASSIFIED, which the gate rejects.
    const prior = new Map(committed.map(c => [key(c), c]))
    const reclassify = []
    snapshot.constraints = live.map(c => {
      const k = key(c)
      const p = prior.get(k)
      const d = depsFor(deps, k)
      // ⚠️ An ABSENT `predicateDeps` means "this snapshot predates dependency
      // tracking", NOT "this predicate calls nothing" — so backfilling the
      // field is not a change and must not force reclassification. Only a
      // RECORDED set that differs is a real move. (Caught while regenerating:
      // treating absent as `[]` reported all five function-backed constraints
      // as contract events on the very first run, which would have taught the
      // next reader to ignore the warning.)
      const depsMoved = p?.predicateDeps !== undefined &&
                        JSON.stringify(p.predicateDeps) !== JSON.stringify(d)
      const moved = p && (p.definition !== c.definition || depsMoved)
      if (moved) reclassify.push(k)
      return {
        table: c.table,
        name: c.name,
        scope: !p || moved ? 'UNCLASSIFIED' : p.scope,
        ...(isFoldDependent(d) ? { foldDependent: true } : {}),
        definition: c.definition,
        ...(d.length ? { predicateDeps: d } : {}),
      }
    })
    // A contract-scoped constraint that moved is a version event. Surfaced
    // here, at the moment the snapshot is regenerated, because that is when a
    // human is present — not in CI, where the answer would only be "somebody
    // should have."
    const wasContract = reclassify.filter(k => prior.get(k)?.scope === 'contract')
    snapshot.generatedColumns = genCols
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`)
    console.log(`Wrote ${snapshot.constraints.length} constraints to prisma/catalog-contract-checks.json`)
    const fresh = snapshot.constraints.filter(c => c.scope === 'UNCLASSIFIED')
    if (fresh.length) {
      console.log(`\n⚠️  ${fresh.length} constraint(s) need a scope (contract | structural):`)
      for (const c of fresh) {
        const k = key(c)
        console.log(`      ${k}${reclassify.includes(k) ? '   (CHANGED — re-apply the test to the TRANSITION)' : '   (new)'}`)
      }
      console.log('\n    Rejection-surface test: can a payload valid under the OLD predicate')
      console.log('    be REJECTED under the new one? Yes → contract. See the RFC.')
    }
    if (wasContract.length) {
      console.log(`\n🔒 ${wasContract.length} CONTRACT-scoped constraint(s) changed — this is a CONTRACT EVENT:`)
      for (const k of wasContract) console.log(`      ${k}`)
      console.log(`\n    Bump "contractVersion" in the snapshot (currently ${snapshot.contractVersion}) and`)
      console.log('    ANNOUNCE the change to the catalog-maintenance side BEFORE deploy.')
      console.log('    ⚠️ Only skip the bump if no import has run yet — see the RFC\'s')
      console.log('       "how v1 was reached" table for that carve-out.')
    }
    return
  }

  const liveByKey = new Map(live.map(c => [key(c), c]))
  const snapByKey = new Map(committed.map(c => [key(c), c]))
  const problems = []

  for (const [k, c] of liveByKey) {
    const s = snapByKey.get(k)
    if (!s) {
      problems.push({ kind: 'ADDED', k, live: c.definition })
      continue
    }
    if (s.definition !== c.definition) {
      problems.push({ kind: 'CHANGED', k, scope: s.scope, was: s.definition, live: c.definition })
      continue
    }
    // The predicate text is unchanged — but a function it calls may not be.
    // This is the branch that catches a swapped `gtin_check_digit_ok` body,
    // which reprints byte-identically above.
    const liveDeps = depsFor(deps, k)
    // 🔒 ABSENT IS A FAILURE HERE, not a pass. On the --write side an absent
    // field means "predates tracking" and is backfilled; on the CHECK side the
    // same absence means this constraint's function dependencies are UNVERIFIED,
    // which is exactly the blind spot P2 identified. Defaulting to `[]` would
    // make a function-backed constraint with no recorded deps compare equal to
    // one with none at all — silently green. Regenerate to record them.
    const snapDeps = s.predicateDeps ?? (liveDeps.length ? null : [])
    if (snapDeps === null) {
      problems.push({
        kind: 'DEPS-UNRECORDED', k, scope: s.scope,
        live: liveDeps.join(', '),
      })
      continue
    }
    if (JSON.stringify(liveDeps) !== JSON.stringify(snapDeps)) {
      problems.push({
        kind: 'PREDICATE-FN-CHANGED', k, scope: s.scope,
        was: snapDeps.join(', ') || '(none recorded)',
        live: liveDeps.join(', ') || '(none)',
      })
    }
  }
  for (const [k, s] of snapByKey) {
    if (!liveByKey.has(k)) problems.push({ kind: 'REMOVED', k, scope: s.scope, was: s.definition })
  }
  // An unclassified constraint is a gate failure in its own right: --write
  // records it, a human must scope it before the build goes green again.
  for (const s of committed) {
    if (s.scope !== 'contract' && s.scope !== 'structural') {
      problems.push({ kind: 'UNCLASSIFIED', k: key(s), scope: s.scope })
    }
  }

  // Generated columns: expression AND the fold bodies behind it.
  // 🔒 Absent is a FAILURE, not a pass — same reasoning as predicateDeps. A
  // snapshot with no generatedColumns block has five unverified folded columns,
  // including the producer matching key.
  if (snapshot.generatedColumns === undefined) {
    if (genCols.length) {
      problems.push({
        kind: 'GENCOLS-UNRECORDED', k: '(generated columns)',
        live: `${genCols.length} generated column(s) present, none recorded`,
      })
    }
  } else {
    const snapCols = new Map(snapshot.generatedColumns.map(c => [c.column, c]))
    const liveCols = new Map(genCols.map(c => [c.column, c]))
    for (const [k, c] of liveCols) {
      const s = snapCols.get(k)
      if (!s) {
        problems.push({ kind: 'GENCOL-ADDED', k, live: c.expression })
        continue
      }
      if (s.expression !== c.expression) {
        problems.push({ kind: 'GENCOL-CHANGED', k, was: s.expression, live: c.expression })
      } else if (JSON.stringify(s.deps) !== JSON.stringify(c.deps)) {
        // The expression reprints identically; the fold body moved underneath.
        problems.push({
          kind: 'GENCOL-FN-CHANGED', k,
          was: s.deps.join(', '), live: c.deps.join(', '),
        })
      }
    }
    for (const [k, s] of snapCols) {
      if (!liveCols.has(k)) problems.push({ kind: 'GENCOL-REMOVED', k, was: s.expression })
    }
  }

  if (problems.length === 0) {
    console.log(`ok  ${live.length} catalog CHECK constraints + ${genCols.length} generated columns match the committed contract snapshot`)
    return
  }

  console.error('FAIL: catalog contract shape differs from the committed snapshot.\n')
  for (const p of problems) {
    if (p.kind === 'UNCLASSIFIED') {
      console.error(`  UNCLASSIFIED  ${p.k}`)
      console.error(`                scope is "${p.scope}" — must be "contract" or "structural"\n`)
      continue
    }
    console.error(`  ${p.kind}  ${p.k}${p.scope ? `  [${p.scope}]` : ''}`)
    if (p.was) console.error(`     was:  ${p.was}`)
    if (p.live) console.error(`     now:  ${p.live}`)
    console.error('')
  }

  const fnHit = problems.some(p => p.kind === 'PREDICATE-FN-CHANGED')
  if (fnHit) {
    console.error('  ⚠️ A PREDICATE FUNCTION changed while the constraint text stayed identical.')
    console.error('     The accepted payload set moved even though the CHECK reads the same.')
    console.error('     This is the failure mode `pg_get_constraintdef` alone cannot see.\n')
  }
  if (problems.some(p => p.kind === 'GENCOL-FN-CHANGED')) {
    console.error('  🔒 A FOLD BODY changed under a GENERATED COLUMN while its expression')
    console.error('     stayed identical. Every row written from now on is keyed differently')
    console.error('     — including producers.name_folded, the producer matching key.')
    console.error('     ⚠️ Postgres does NOT recompute STORED generated values, so old and')
    console.error('     new rows would disagree. A semantic fold change needs `_v2` PLUS a')
    console.error('     column rewrite; see 20260725220000 and the RFC § Fold identity.\n')
  }

  const contractHit = problems.some(p => p.scope === 'contract' || p.kind === 'ADDED')
  console.error('If the change is DELIBERATE:')
  console.error('  1. Re-run with --write against a migrated database to update the snapshot.')
  console.error('  2. RE-APPLY the rejection-surface test — --write resets a changed')
  console.error('     constraint to UNCLASSIFIED, because scope is a property of the')
  console.error('     TRANSITION, not a permanent label.')
  console.error('  3. State the reason in the PR.')
  if (contractHit) {
    console.error('')
    console.error('  🔒 A "contract"-scoped constraint changed. That is a CONTRACT EVENT:')
    console.error('     bump the contract version and ANNOUNCE IT to the catalog-maintenance')
    console.error('     side BEFORE deploy. A stricter predicate makes rows non-insertable,')
    console.error('     and an import batch is all-or-nothing — one unedited name can roll')
    console.error('     back the batch. See docs/dev/proposals/wine-catalog.md')
    console.error('     § Catalog write ownership.')
  }
  // Derived from LIVE dependencies, not from the snapshot's flag: a snapshot
  // written before the marker was derived (or by a stale tool) would otherwise
  // suppress this warning exactly when it matters.
  const foldHit = problems.some(p =>
    isFoldDependent(depsFor(deps, p.k)) || snapByKey.get(p.k)?.foldDependent)
  if (foldHit) {
    console.error('')
    console.error('  ⚠️ A fold-dependent constraint changed. Its MEANING is a function of')
    console.error('     catalog_fold_v1 being byte-identical on both sides — check the fold')
    console.error('     identity handshake, not just this predicate.')
  }
  process.exit(1)
}

main().catch(err => {
  console.error('FAIL: could not read constraints from the database.')
  console.error(err)
  process.exit(1)
})
