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

// 🔒 A HAND-MAINTAINED LIST IS A SILENT-MISS SURFACE. This one names what to
// watch, so a NEW catalog table is not merely unwatched — it is unwatched while
// the gate prints a confident `ok`.
//
// ⚠️ MEASURED (2026-08-11): adding a sixth table with a rejection-shaped CHECK
// (`product_awards`, `CHECK (score BETWEEN 0 AND 100)`) left the gate reporting
// "ok 22 catalog CHECK constraints" and exiting 0. Nothing anywhere said a new
// contract-shaped table had appeared.
//
// Raised by the catalog-maintenance side finding the identical shape in their
// reachability audit — a hand-written probe list meant a constraint added
// tomorrow would never be probed while the audit printed "ALL n PROBES
// REFUSED". Their rule, and it is the better one: **assert a relationship the
// DATABASE maintains, not a number a HUMAN maintains.**
//
// ⚠️ Pure FK-reachability was tried and REJECTED as the definition: it finds
// `product_awards` correctly but also drags in `wines`, which is deliberately
// out of scope (its rules live in the integration suite). So the curated list
// stays — it encodes a judgement the database cannot make — and the check below
// makes an ADDITION to that surface loud instead of silent. The list is still
// authored; it is no longer trusted.
const KNOWN_NON_CATALOG = ['wines']
const CANDIDATE_QUERY = `
  SELECT DISTINCT c.conrelid::regclass::text AS "table"
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.confrelid::regclass::text = ANY($1::text[])
    AND NOT (c.conrelid::regclass::text = ANY($2::text[]))
  ORDER BY 1
`

// 🔒 OUR HALF OF A CROSS-SIDE PRECONDITION, and it was guarded by a COMMENT.
//
// The maintenance side holds 6,455 rows carrying styles we do not define (2,409
// `dessert`, 4,046 `fortified`), excluded from their export *until this
// vocabulary grows*. The ordering is OURS-THEN-THEIRS: this set grows first,
// then they release. Their tripwire fires when it sees the growth — i.e. AFTER
// we have shipped it. Nothing on our side fired BEFORE.
//
// ⚠️ MEASURED (2026-08-12): inserting `wine/dessert` passed the contract gate
// (exit 0) and the full schema-invariant suite (133/133). The only guard was
// prose on the `CategoryStyle` model.
//
// ⚠️ THE MIRROR OF WHAT THEY FOUND THE SAME DAY: they were watching the
// precondition WE hold and had nothing on the one THEY hold. We had the same
// blind spot pointing the other way. **Each side instrumented the other's
// half.** When a precondition is yours, being able to see the other side's
// tripwire is not coverage.
//
// This asserts the vocabulary matches what was last approved — the same
// pin-shape as the constraint snapshot, and it fails on ANY change, including a
// removal or a relabel, because all of those are cross-side events too.
const STYLE_VOCAB_QUERY = `
  SELECT category, style FROM category_styles ORDER BY category, style
`

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

// 🔒 A CONSTRAINT'S REACH DEPENDS ON ITS COLUMNS' TYPES, not only its predicate.
//
// ⚠️ MEASURED (2026-08-11): narrowing `wine_products.abv` from `numeric(4,2)` to
// `numeric(3,2)` drops the type ceiling from 99.99 to 9.99, which turns
// `abv <= 25` into an UNREACHABLE clause — no value that fits the column can
// violate it. The predicate text is byte-identical, so the snapshot compared
// equal and the gate reported green.
//
// This is the third instance of one pattern in this workstream: the recorded
// artifact names something whose MEANING lives elsewhere (predicate → function
// body, generated column → fold body, constraint → column type). Recording the
// type closes the last one.
//
// 🔒 "Can this fire?" is a different question from "does this pass?" — an
// unreachable constraint never fails, so no test suite goes red and nothing
// draws attention to it. The catalog-maintenance side shipped a `<= 100` ABV
// fence that could never fire for exactly this reason, and so would we have.
//
// Resolved via `conkey`, so it covers varchar narrowing too (a
// `varchar(255)` → `varchar(10)` silently shrinks the accepted set).
const COLTYPE_QUERY = `
  SELECT c.conrelid::regclass::text            AS "table",
         c.conname                             AS "name",
         a.attname                             AS "column",
         format_type(a.atttypid, a.atttypmod)  AS "type"
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid::regclass::text = ANY($1::text[])
    AND c.contype = 'c'
  ORDER BY 1, 2, 3
`

function key(c) {
  return `${c.table}.${c.name}`
}

// Column types a constraint depends on, as stable comparable strings.
function colTypesFor(rows, k) {
  return rows
    .filter(r => key(r) === k)
    .map(r => `${r.column}:${r.type}`)
    .sort()
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
  let live, deps, genCols, colTypes, candidates, styleVocab
  try {
    // 🔒 PIN THE SEARCH_PATH BEFORE READING ANYTHING. Two distinct hazards, and
    // the second was only found by staging the first.
    //
    // 1. ⚠️ `pg_get_constraintdef` schema-qualifies a referenced object ONLY
    //    when it is not on the search_path, so the SAME constraint prints
    //    differently depending on the connection's vantage point. Measured
    //    here: under `search_path = pg_catalog`, five constraints render as
    //    `public.catalog_fold_v1(...)` rather than `catalog_fold_v1(...)` —
    //    all five function-backed ones, a different md5 each, with nothing in
    //    the database changed. Reported by the catalog-maintenance side, who
    //    hit it comparing a replayed scratch schema against live (2026-08-11).
    //
    // 2. ⚠️ Every query here filters on `conrelid::regclass::text = ANY(…)`
    //    with BARE table names, and `regclass::text` qualifies for exactly the
    //    same reason — under a foreign search_path it yields `public.producers`
    //    and matches NOTHING. Measured: the gate then reported "no CHECK
    //    constraints found" and exited 1. That is a fail-CLOSED outcome (the
    //    non-vacuity guard catching it), so it was never a silent pass — but it
    //    fails for a reason that has nothing to do with drift.
    //
    // `public` alone, not the `"$user", public` default: that default carries a
    // per-role component, so the same command could render differently for two
    // users of the same database.
    await prisma.$executeRawUnsafe('SET search_path = public')
    live = await prisma.$queryRawUnsafe(QUERY, TABLES)
    deps = await prisma.$queryRawUnsafe(DEPS_QUERY, TABLES)
    genCols = genColRows(await prisma.$queryRawUnsafe(GENCOL_QUERY, TABLES))
    colTypes = await prisma.$queryRawUnsafe(COLTYPE_QUERY, TABLES)
    candidates = await prisma.$queryRawUnsafe(
      CANDIDATE_QUERY, [...TABLES, 'categories'], [...TABLES, ...KNOWN_NON_CATALOG])
    styleVocab = (await prisma.$queryRawUnsafe(STYLE_VOCAB_QUERY))
      .map(r => `${r.category}/${r.style}`)
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
      const t = colTypesFor(colTypes, k)
      const depsMoved = p?.predicateDeps !== undefined &&
                        JSON.stringify(p.predicateDeps) !== JSON.stringify(d)
      // A type narrowing can silently shrink a bound's reach, so it re-opens
      // the rejection-surface question exactly like a predicate edit does.
      const typesMoved = p?.columnTypes !== undefined &&
                         JSON.stringify(p.columnTypes) !== JSON.stringify(t)
      const moved = p && (p.definition !== c.definition || depsMoved || typesMoved)
      if (moved) reclassify.push(k)
      return {
        table: c.table,
        name: c.name,
        scope: !p || moved ? 'UNCLASSIFIED' : p.scope,
        ...(isFoldDependent(d) ? { foldDependent: true } : {}),
        definition: c.definition,
        ...(t.length ? { columnTypes: t } : {}),
        ...(d.length ? { predicateDeps: d } : {}),
      }
    })
    // A contract-scoped constraint that moved is a version event. Surfaced
    // here, at the moment the snapshot is regenerated, because that is when a
    // human is present — not in CI, where the answer would only be "somebody
    // should have."
    const wasContract = reclassify.filter(k => prior.get(k)?.scope === 'contract')
    snapshot.generatedColumns = genCols
    snapshot.styleVocabulary = styleVocab
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
    // Column types first: a narrowing can make an unchanged predicate stop
    // being able to fire, which no amount of predicate comparison reveals.
    const liveTypes = colTypesFor(colTypes, k)
    const snapTypes = s.columnTypes ?? (liveTypes.length ? null : [])
    if (snapTypes === null) {
      problems.push({ kind: 'COLTYPES-UNRECORDED', k, scope: s.scope, live: liveTypes.join(', ') })
      continue
    }
    if (JSON.stringify(liveTypes) !== JSON.stringify(snapTypes)) {
      problems.push({
        kind: 'COLUMN-TYPE-CHANGED', k, scope: s.scope,
        was: snapTypes.join(', '), live: liveTypes.join(', '),
      })
      continue
    }
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

  // 🔒 Our half of the cross-side precondition — see STYLE_VOCAB_QUERY.
  // Absent is a FAILURE, not a pass: a snapshot with no record leaves the
  // vocabulary unverified, which is the state this check exists to end.
  if (snapshot.styleVocabulary === undefined) {
    problems.push({
      kind: 'STYLE-VOCAB-UNRECORDED', k: '(category_styles)',
      live: `${styleVocab.length} pair(s) present, none recorded`,
    })
  } else if (JSON.stringify(snapshot.styleVocabulary) !== JSON.stringify(styleVocab)) {
    problems.push({
      kind: 'STYLE-VOCABULARY-CHANGED', k: '(category_styles)',
      was: snapshot.styleVocabulary.join(', '),
      live: styleVocab.join(', '),
    })
  }

  // 🔒 Did a table join the catalog spine without joining the watch list?
  // Asked of the database rather than trusted to TABLES — see the note there.
  // A new table is reported, never silently skipped; resolving it is a
  // judgement (watch it, or add it to KNOWN_NON_CATALOG with a reason).
  for (const c of candidates) {
    problems.push({ kind: 'UNWATCHED-CATALOG-TABLE', k: c.table })
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
    // ⚠️ THE CAVEAT LIVES IN THE SUCCESS MESSAGE, not only in this header.
    // Adopted from the maintenance side (2026-08-11): a caveat only a
    // maintainer reads protects nobody reading output, and "everything
    // matches" reads far stronger than what this gate actually verifies.
    //
    // 🔒 What it means: the database matches WHAT A HUMAN LAST APPROVED (this
    // snapshot). NOT that the database matches what the MIGRATIONS say — an
    // out-of-band ALTER plus a matching snapshot regenerate passes here and
    // leaves prod diverged from its own migration history. That gap needs a
    // REPLAY (re-apply migrations into a scratch schema, diff against live),
    // which we do not have. See the RFC § A pin is not a replay.
    console.log(`ok  ${live.length} catalog CHECK constraints + ${genCols.length} generated columns match the committed snapshot`)
    console.log('    (= matches what was last approved, NOT that the DB matches the migrations —')
    console.log('     an out-of-band ALTER + a matching regenerate passes this gate)')
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

  if (problems.some(p => p.kind === 'STYLE-VOCABULARY-CHANGED')) {
    console.error('  🔒 THE STYLE VOCABULARY CHANGED — THIS IS A CROSS-SIDE EVENT.')
    console.error('     The catalog-maintenance side holds 6,455 rows carrying styles we do')
    console.error('     not define (2,409 dessert, 4,046 fortified), excluded from their')
    console.error('     export UNTIL this set grows. Growing it releases them.')
    console.error('     ⚠️ ORDERING IS OURS-THEN-THEIRS: this ships first, then their filter.')
    console.error('     ANNOUNCE before deploying, then regenerate with --write.')
    console.error('     (Their tripwire fires when it SEES this — i.e. after we ship it.')
    console.error('      This one fires before, which is the half we were missing.)\n')
  }
  if (problems.some(p => p.kind === 'UNWATCHED-CATALOG-TABLE')) {
    console.error('  🔒 A TABLE REFERENCES THE CATALOG SPINE BUT IS NOT WATCHED.')
    console.error('     Its constraints are contract surface by the same argument as the')
    console.error('     five in TABLES, and nothing is diffing them. Either add it to')
    console.error('     TABLES and regenerate, or to KNOWN_NON_CATALOG with a stated reason.')
    console.error('     ⚠️ Do NOT resolve this by deleting the check: a hand-maintained list')
    console.error('     that is never questioned is how a new table stays unwatched while')
    console.error('     the gate prints ok.\n')
  }

  const fnHit = problems.some(p => p.kind === 'PREDICATE-FN-CHANGED')
  if (fnHit) {
    console.error('  ⚠️ A PREDICATE FUNCTION changed while the constraint text stayed identical.')
    console.error('     The accepted payload set moved even though the CHECK reads the same.')
    console.error('     This is the failure mode `pg_get_constraintdef` alone cannot see.\n')
  }
  if (problems.some(p => p.kind === 'COLUMN-TYPE-CHANGED')) {
    console.error('  ⚠️ A CONSTRAINED COLUMN\'S TYPE changed while its predicate stayed identical.')
    console.error('     A narrowing can make a bound UNREACHABLE — no value that fits the')
    console.error('     column can violate it, so the constraint silently stops firing while')
    console.error('     every test stays green. Ask "can this fire?", not "does this pass?":')
    console.error('     insert a value just past the bound and confirm the CONSTRAINT NAME')
    console.error('     appears in the error, not a type overflow.\n')
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
