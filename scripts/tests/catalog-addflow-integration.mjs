#!/usr/bin/env node
// Integration tests for the wine-catalog PHASE 2 add-flow + fuzzy search.
//
// WHY THIS EXISTS, and why it drives the REAL modules rather than reconstructed
// SQL: the phase-2 risk is not "does the schema hold" (phase 1's suite covers
// that) but "does the application use it correctly". Two of the three things
// most likely to be wrong here FAIL SILENTLY:
//
//   • The trigram query form. Every wrong spelling returns the CORRECT ROWS and
//     merely loses the index — so a regression looks perfect and runs ~40x
//     slower on a large catalog. § 1 asserts the PLAN SHAPE, which is the only
//     way to see it.
//   • The blind-redaction strip. redactWine spreads ...rest from WineMeta, so a
//     catalog id added to that type is exposed BY DEFAULT. A leak here looks
//     like a correctly-masked payload in every visible field. § 5.
//
// 🔒 TESTING STANDARD, inherited from phase 1 where suites repeatedly reported
// green while missing real regressions:
//   • Every rejection assertion NAMES the constraint / error it expects. An
//     assertion that treats any exception as success passes for the wrong
//     reason — phase 1 had 40 of those, and they stayed green through a dropped
//     CHECK and a dropped PK.
//   • Every reject is PAIRED WITH AN ACCEPT. A reject-only test stays green
//     under a regression that rejects everything.
//   • Verify what the statement DID, not the state afterwards. State can always
//     be satisfied by pre-existing state.
//
// Run against a DISPOSABLE database — it writes and deletes rows.
//
//   DATABASE_URL=postgresql://…/catalog_test npx tsx scripts/tests/catalog-addflow-integration.mjs
//
// Run via tsx (not node): it imports the real TypeScript modules under lib/.
// A hand-written SQL twin of those queries would be exactly the "reconstruction
// that masks a runtime bug" failure this repo has already been bitten by.

import { PrismaClient } from '@prisma/client'
import {
  searchProducers,
  searchProducts,
  WORD_SIMILARITY_THRESHOLD,
  trgmOrderWith,
  findProducerByExactName,
} from '../../lib/catalogSearch.ts'
import {
  createProducer as _createProducer,
  createProduct as _createProduct,
  createVintage as _createVintage,
  resolveCatalogLink,
  applyIdentityEditRule,
  validateYear,
  catalogLinkRateKey,
  CatalogValidationError,
} from '../../lib/catalogWrite.ts'
import { redactWine } from '../../lib/wineRedaction.ts'
import { scrub } from '../../lib/textSafe.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// § 13b imports lib/session.ts, which pulls in lib/redis.ts — a module-level
// client that connects eagerly and keeps the process alive. CI therefore
// provides a Redis service, and the teardown closes the client explicitly (see
// the bottom of this file); without both, the suite passes every assertion and
// then hangs to the step timeout.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const prisma = new PrismaClient()
let pass = 0
const failures = []

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { failures.push(label); console.log(`  FAIL ${label}`) }
}

// Does this plan contain a Seq Scan over the named relation? Matches the two
// JSON keys together so it cannot be fooled by the relation name appearing in
// an Index Cond or an unrelated node — and so a plan that merely MENTIONS the
// table (an index-only scan, a nested-loop probe) is not flagged.
function seqScansTable(planJson, relation) {
  try {
    const nodes = []
    const walk = n => { if (!n || typeof n !== 'object') return
      nodes.push(n); for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v) }
    walk(JSON.parse(planJson))
    return nodes.some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === relation)
  } catch { return false }
}

// Total shared buffers touched by an ANALYZE'd plan — the work the query
// actually did, which is what a runaway plan inflates. Summed over every node.
function totalBuffers(planJson) {
  try {
    let total = 0
    const walk = n => { if (!n || typeof n !== 'object') return
      if (typeof n['Shared Hit Blocks'] === 'number') total += n['Shared Hit Blocks'] + (n['Shared Read Blocks'] || 0)
      for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v) }
    walk(JSON.parse(planJson))
    return total
  } catch { return 0 }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, a === e ? label : `${label} (got ${a}, wanted ${e})`)
}

// Asserts the call is REJECTED, and rejected BY THE EXPECTED CAUSE.
//
// 🔒 `expect` is mandatory — see the testing standard above. Matching on a
// distinctive fragment of the message means a rejection for an unrelated reason
// (a fixture that failed to set up, a constraint firing first) is a FAILURE,
// not a pass.
async function rejects(label, fn, expect) {
  if (!expect) { ok(false, `${label} (TEST BUG: no expected cause given)`); return }
  try {
    await fn()
    ok(false, `${label} (was ACCEPTED — should be rejected by: ${expect})`)
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.includes(expect)) ok(true, label)
    else ok(false, `${label} (rejected by the WRONG thing — wanted "${expect}", got: ${
      msg.replace(/\s+/g, ' ').slice(0, 200)})`)
  }
}

async function accepts(label, fn) {
  try {
    const out = await fn()
    ok(true, label)
    return out
  } catch (e) {
    ok(false, `${label} (was REJECTED: ${String(e?.message || e).split('\n')[0]})`)
    return null
  }
}

// 🔒 `tx` is REQUIRED on the mint helpers (phase 4 needs every catalog mutation
// to carry its journal append in the SAME transaction). This suite is .mjs, so
// TypeScript cannot enforce that here — these thin wrappers supply a real
// transaction so the tests exercise the same contract production does, rather
// than a looser one.
const createProducer = (input, addedBy, tx) =>
  tx ? _createProducer(input, addedBy, tx)
     : prisma.$transaction(t => _createProducer(input, addedBy, t))
const createProduct = (input, addedBy, collaboratorIds = [], tx) =>
  tx ? _createProduct(input, addedBy, collaboratorIds, tx)
     : prisma.$transaction(t => _createProduct(input, addedBy, collaboratorIds, t))
// ⚠️ FORWARDS `opts` — an earlier version dropped it, so every vintage-grape
// assertion ran against raw SQL instead of the real helper and removing the
// helper's write left the suite green. The wrapper must not narrow the thing
// under test.
const createVintage = (productId, year, addedBy, abv = null, tx, opts) =>
  tx ? _createVintage(productId, year, addedBy, abv, tx, opts)
     : prisma.$transaction(t => _createVintage(productId, year, addedBy, abv, t, opts))

const TEST_USER = 970001

// Prisma's $executeRawUnsafe rejects multiple commands in one call (42601), so
// each statement runs separately. Order matters: children before parents, since
// every catalog-referencing FK is NoAction/Restrict by design.
async function reset() {
  const stmts = [
    `DELETE FROM wines WHERE id LIKE 'p2test_%'`,
    `DELETE FROM product_eans WHERE product_id IN (SELECT id FROM wine_products WHERE name LIKE 'P2TEST%')`,
    `DELETE FROM wine_vintages WHERE product_id IN (SELECT id FROM wine_products WHERE name LIKE 'P2TEST%')`,
    // links_to is a self-FK with NoAction: clear pointers before deleting, or a
    // tombstone fixture blocks its own target's removal.
    `UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE name LIKE 'P2TEST%'`,
    // 🔒 DELETE THE PRODUCTS, NOT THEIR JOIN ROWS — and let the cascade take
    // product_producers with them. Deleting the join rows first leaves the
    // products lead-less at COMMIT, which the deferred exactly-one-lead trigger
    // correctly refuses ("has no lead producer"), and teardown dies before
    // reporting any result. product_producers.product_id is ON DELETE CASCADE
    // precisely so cleanup does not have to sequence this by hand — the same
    // purge carve-out the migration documents.
    `DELETE FROM wine_products WHERE name LIKE 'P2TEST%'`,
    `UPDATE producers SET status = 'provisional', links_to = NULL WHERE name LIKE 'P2TEST%' OR id LIKE 'p2%'`,
    `DELETE FROM producers WHERE name LIKE 'P2TEST%' OR id LIKE 'p2seed%'`,
    `DELETE FROM users WHERE id = ${TEST_USER}`,
    `INSERT INTO users (id, email, name, password_hash, created_at)
       VALUES (${TEST_USER}, 'p2test@example.test', 'P2 Tester', 'x', now())
       ON CONFLICT (id) DO NOTHING`,
  ]
  for (const s of stmts) await prisma.$executeRawUnsafe(s)
}

async function main() {
  console.log('\nwine-catalog phase 2 — add-flow + fuzzy search\n')
  await reset()

  // ══════════════════════════════════════════════════════════════════════
  console.log('§ 1 — the trigram query form actually uses the index')
  // 🔒 THE HIGHEST-RISK ITEM IN PHASE 2, and the only one that cannot be caught
  // by asserting on results: every wrong form returns the SAME ROWS. So this
  // section asserts the QUERY PLAN.
  //
  // Measured while writing this phase (PG16, 60k producers, selective query):
  // the correct operator form planned a Bitmap Index Scan at ~2 ms; the
  // word_similarity() function form seq-scanned at ~80 ms.
  //
  // ⚠️ THE FIXTURE SIZE IS PART OF THE TEST, and it was measured rather than
  // guessed. Postgres chooses a plan on COST, so on a small table it correctly
  // prefers a seq scan for EVERY form — which would make this assertion vacuous
  // (it would pass with the index dropped, and it would pass for the wrong
  // form). Measured against this exact schema: at 3,000 rows the correct
  // operator form still seq-scans; at 30,000 it plans a Bitmap Index Scan. So
  // the fixture must sit above that crossover, and 30,000 is the smallest round
  // number that does. Do not shrink it to make the suite faster — that converts
  // a real assertion into a decorative one.
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    SELECT 'p2seed' || lpad(g::text, 15, '0'),
           'P2TEST ' || substr(md5(g::text), 1, 10) || ' Estate',
           'confirmed', '{}', now(), now()
      FROM generate_series(1, 30000) g
  `)
  // ⚠️ VACUUM, not just ANALYZE — and this took a while to pin down, so it is
  // recorded rather than left as a mysterious line. A GIN index buffers new
  // entries in a "pending list" that is only merged into the index proper by a
  // vacuum. Immediately after a bulk insert into a FRESH database that list is
  // large and unmerged, which makes the planner cost the index scan high enough
  // to choose a seq scan — so the assertion below failed reproducibly on a
  // fresh DB while passing on a reused one (where a previous run's vacuum had
  // already merged the list). That is an artifact of the fixture being brand
  // new, not of the query form: a real catalog is vacuumed continuously by
  // autovacuum. ANALYZE alone does NOT do this — it refreshes statistics, not
  // the pending list.
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')

  // No transaction and no GUC: a KNN order reads no setting, which is precisely
  // why the interactive transaction (and the pool connection it pinned for the
  // whole query) went away.
  const planFor = async sql => {
    const rows = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)
    return JSON.stringify(rows[0]['QUERY PLAN'])
  }

  const needle = await prisma.$queryRawUnsafe(
    `SELECT name FROM producers WHERE name LIKE 'P2TEST%' ORDER BY id LIMIT 1`)
  // A distinctive fragment of one seeded name — selective enough that the
  // planner should prefer the index.
  const term = needle[0].name.split(' ')[1]

  // 🔒 EXPLAIN THE ORDERING THE MODULE ACTUALLY USES — NOT A COPY OF IT.
  //
  // Mutation testing established why this must share its definition with lib:
  // an earlier version EXPLAINed a hand-written string that merely LOOKED like
  // the module's query, and stayed green through the two mutations it existed
  // to catch. `trgmOrderWith` shares its definition with `trgmOrderSql`, which
  // the runtime queries embed, so changing the operator in lib changes what CI
  // checks here.
  //
  // Single-quoted, not dollar-quoted: Prisma parses `$n` placeholders out of
  // the statement text, so a `$$…$$` literal collides with that.
  const realSql = `SELECT id FROM producers
     ORDER BY ${trgmOrderWith(`'${term}'`, 'name_folded')} LIMIT 20`
  const goodPlan = await planFor(realSql)
  ok(goodPlan.includes('producers_name_folded_gist_idx'),
    `the REAL search ordering uses the GiST KNN index${
      goodPlan.includes('producers_name_folded_gist_idx') ? ''
        : ` (planned instead: ${goodPlan.slice(0, 300)})`}`)
  // 🔒 A KNN scan must not sort — the index returns rows already ordered. A
  // Sort node means the ordering was not index-backed and the whole table was
  // read, which is exactly what a MISMATCHED operand pairing silently does.
  ok(!goodPlan.includes('"Node Type":"Sort"'),
    'the KNN plan returns rows pre-ordered from the index (no Sort node)')

  // 🔒 THE PAIRED NEGATIVE — and note WHAT it asserts, because the first version
  // of this test got the reason wrong. `<<->` is NOT an unusable operator: it
  // is the declared COMMUTATOR of `<->>`, so `query <<-> column` is rewritten
  // by the planner into the indexable form and runs at ~4.9 ms. What breaks is
  // the OPERAND ORDER, not the operator — `column <<-> query` seq-scans 60,001
  // rows at ~116 ms while returning correct results.
  //
  // So the assertion is that the MISMATCHED PAIRING loses the index, which is
  // the actual trap, and the commutator pairing is checked below to prove the
  // rule is about operand order rather than about one forbidden symbol.
  const wrongOrderPlan = await planFor(
    `SELECT id FROM producers ORDER BY name_folded <<-> '${term}' LIMIT 20`)
  ok(!wrongOrderPlan.includes('producers_name_folded_gist_idx'),
    'the MISMATCHED pairing `column <<-> query` does NOT use the index (the real trap)')
  const commutatorPlan = await planFor(
    `SELECT id FROM producers ORDER BY '${term}' <<-> name_folded LIMIT 20`)
  ok(commutatorPlan.includes('producers_name_folded_gist_idx'),
    'the commutator pairing `query <<-> column` DOES use the index (so the rule is operand ORDER, not the operator)')

  // 🔒 The threshold is now a POST-FILTER on the rows KNN returns, not a GUC.
  // It still has to be the tuned 0.3 — that is what keeps typos matching.
  ok(WORD_SIMILARITY_THRESHOLD === 0.3,
    `the tuned threshold is 0.3 (got ${WORD_SIMILARITY_THRESHOLD})`)

  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    VALUES ('p2thresh000000000000', 'P2TEST Chateau Margaux', 'confirmed', '{}', now(), now())
  `)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')
  const exact = await searchProducers('Chateau Margaux')
  ok(exact.some(r => r.id === 'p2thresh000000000000'), 'exact-ish query finds the producer')
  // 🔒 TYPO TOLERANCE IS THE PROPERTY THE WHOLE FUZZY DESIGN EXISTS FOR, and it
  // survives the GIN→GiST swap because `<->>` is exactly `1 - word_similarity`
  // — the identical metric. Verified numerically: 'chateu margux' vs 'Château
  // Margaux' gives word_similarity 0.5294 and distance 0.4706, and the real
  // producer ranks FIRST (0.529) ahead of the noise (0.357).
  const typo = await searchProducers('Chateu Margeaux')
  ok(typo.some(r => r.id === 'p2thresh000000000000'),
    'typo tolerance still works after the KNN swap')

  // 🔒 KNN ALWAYS RETURNS ITS N NEAREST ROWS, however far away they are — so
  // without the post-filter a query matching NOTHING would still return its 20
  // least-bad rows. This is the "no bad matches" guarantee the old `<%`
  // threshold provided as a WHERE clause.
  const nonsense = await searchProducers('zzzqqqxxvvwwjj')
  eq(nonsense, [], 'a query matching nothing returns NOTHING, not the 20 least-bad rows')

  // Accent folding: the generated column is lower(f_unaccent(name)), and the
  // QUERY side is folded by the database too. An unaccented query must find an
  // accented name, or the two normalization paths have drifted.
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    VALUES ('p2accent000000000000', 'P2TEST Châteauneuf Réserve', 'confirmed', '{}', now(), now())
  `)
  const unaccented = await searchProducers('Chateauneuf Reserve')
  ok(unaccented.some(r => r.id === 'p2accent000000000000'),
    'an unaccented query matches an accented name (one fold path, no drift)')

  // 🔒 THE FOLD LOWERCASES LAST, NOT FIRST. `f_unaccent` is `unaccent` with no
  // `lower()`, and some unaccent expansions PRODUCE CAPITALS — so
  // `f_unaccent(lower(x))` (the original phase-1 order) let uppercase survive
  // into the supposedly-folded value: 'Cuvée № 5' folded to 'cuvee No 5' and
  // 'Toro Loco®' to 'toro loco(R)'.
  //
  // Trigram search never noticed (pg_trgm lowercases internally), which is what
  // made this invisible — but EXACT-EQUALITY and dedupe on a folded column are
  // case-sensitive, so the two spellings of one wine below compared UNEQUAL.
  // That directly breaks findProducerByExactName and, more seriously, phase 5's
  // exact-match-only legacy backfill. Fixed in 20260725140000_catalog_fold_order.
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at) VALUES
      ('p2fold00000000000001', 'P2TEST Cuvée № 5', 'provisional', '{}', now(), now()),
      ('p2fold00000000000002', 'P2TEST Cuvee No 5', 'provisional', '{}', now(), now()),
      ('p2fold00000000000003', 'P2TEST Toro Loco®', 'provisional', '{}', now(), now())`)
  const folds = await prisma.$queryRawUnsafe(
    `SELECT id, name_folded FROM producers WHERE id LIKE 'p2fold%' ORDER BY id`)
  eq(folds[0].name_folded, folds[1].name_folded,
    'two spellings of one name fold to the SAME key (№ → "no", not "No")')
  ok(folds[2].name_folded === folds[2].name_folded.toLowerCase(),
    `the folded value is fully lowercase (got "${folds[2].name_folded}" — ® → "(r)", not "(R)")`)
  // The array helper has the same ordering and needed the same fix.
  const arrFold = await prisma.$queryRawUnsafe(
    `SELECT catalog_fold_arr_v1(ARRAY['Grüner Veltliner®','Cuvée № 5']) AS f`)
  eq(arrFold[0].f, ['gruner veltliner(r)', 'cuvee no 5'],
    'catalog_fold_arr_v1 also folds last (element-wise, fully lowercase)')
  // 🔒 The unversioned predecessor must be GONE, not merely unused — leaving it
  // callable would let a future column or query silently bind to a mutable name
  // (20260725220000 § 6).
  const oldArr = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM pg_proc WHERE proname = 'f_unaccent_arr'`)
  eq(oldArr[0].n, 0, 'the unversioned f_unaccent_arr was dropped')

  // 🔒 THE FOLD IS THE DATABASE'S JOB — a JS-side fold is NOT equivalent, and
  // the difference is invisible to trigram search.
  //
  // Verified here: the obvious JS
  // approach (NFD normalize + strip combining marks + lowercase) does NOT
  // perform the LIGATURE/EXPANSION folds `unaccent` does. Measured, all five
  // disagree:
  //
  //     input          JS fold        SQL lower(f_unaccent(...))
  //     'Straß'        straß          strass
  //     'Œnologie'     œnologie       oenologie
  //     'Ølgod'        ølgod          olgod
  //     'Cuvée № 5'    cuvee № 5      cuvee no 5
  //     'Toro Loco®'   toro loco®     toro loco(r)
  //
  // So an application-side fold compared against `name_folded` silently fails
  // to match — the same never-fails-visibly shape as the fold-ORDER defect,
  // and equally hidden from trigram tests (pg_trgm lowercases internally and
  // matches on shared trigrams either way). This asserts the EXPANSIONS the JS
  // path lacks, so a future helper that folds in TypeScript and compares
  // against the column breaks a test rather than a lookup.
  //
  // ⚠️ THE TWO DEFECT CLASSES ARE DISJOINT, and the sample above spans both.
  // The three EXPANSION cases (`ß`, `œ`, `ø`) do NOT distinguish fold order —
  // verified: `f_unaccent(lower(x))` and `lower(f_unaccent(x))` agree on all
  // three, because Postgres lowercases the uppercase forms to characters whose
  // expansions are already lowercase. `№` and `®` are the ORDER-sensitive
  // cases (covered in § 1). Both classes need coverage, and neither sample
  // substitutes for the other.
  const expansions = await prisma.$queryRawUnsafe(
    `SELECT v, catalog_fold_v1(v) AS folded
       FROM (VALUES ('Straß'), ('Œnologie'), ('Ølgod')) t(v)`)
  eq(expansions.map(r => r.folded), ['strass', 'oenologie', 'olgod'],
    'the SQL fold expands ligatures (ß→ss, œ→oe, ø→o) — a JS NFD-strip does not')

  // And end-to-end through the real exact-match path: a producer stored with a
  // ligature must be findable by its spelled-out form, since that is what a
  // curator or an import would actually type.
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    VALUES ('p2lig00000000000001', 'P2TEST Weingut Straß', 'provisional', '{}', now(), now())`)
  const ligHits = await findProducerByExactName('P2TEST Weingut Strass')
  ok(ligHits.some(r => r.id === 'p2lig00000000000001'),
    'a ligature-spelled producer is found by its expanded spelling (ß matches ss)')

  // 🔒 THE TWO FOLD PATHS MUST AGREE — round-tripped through the REAL query.
  //
  // The assertions above check only the STORED side. That was not enough: the
  // migration corrected the generated columns while the TypeScript-side folds
  // in lib/catalogSearch.ts still spelled `f_unaccent(lower($1))`, so the two
  // sides disagreed and `findProducerByExactName` COULD NOT FIND A PRODUCER BY
  // ITS OWN STORED NAME — and the suite stayed green at 108/108, because
  // trigram search kept working (pg_trgm lowercases internally) and nothing
  // round-tripped an exact lookup. This is the assertion that catches a
  // one-sided fold change, in either direction.
  //
  // It matters most for phase 5: the legacy backfill is exact-match-only, the
  // SOLE sanctioned exception to "links are never set by strings".
  for (const seeded of ['P2TEST Cuvée № 5', 'P2TEST Toro Loco®']) {
    const hits = await findProducerByExactName(seeded)
    ok(hits.length >= 1,
      `findProducerByExactName finds "${seeded}" by its own stored name (query fold == column fold)`)
  }
  // 🔒 AND THE POINT OF THE WHOLE FOLD FIX, asserted directly: the accented and
  // unaccented spellings of ONE wine are found by a single exact lookup. Under
  // the old fold order these were two different keys, so this returned one row
  // and a curator would have seen two distinct entries that never merged. Note
  // `>= 1` above and `=== 2` here are deliberate: the first says "findable at
  // all", this says "and its duplicate spelling comes with it".
  const bothSpellings = await findProducerByExactName('P2TEST Cuvee No 5')
  ok(bothSpellings.length === 2,
    `both spellings of one name resolve to the same fold key (got ${bothSpellings.length}, wanted 2)`)

  // 🔒 WHITESPACE ROUND-TRIP THROUGH THE REAL FUNCTION (20260725220000).
  // Seeded by DIRECT SQL, deliberately: the app path (`requiredName` → `scrub`)
  // trims, so seeding through it could never produce a padded stored row — and
  // a test that cannot produce the bad state cannot detect the regression. The
  // import path is exactly this direct-SQL shape.
  //
  // ⚠️ `findProducerByExactName` .trim()s its ARGUMENT, so a padded *query*
  // proves nothing about the column. What must hold is the reverse: a padded
  // STORED value found by a CLEAN query. That only works if the fold
  // canonicalizes on the write side.
  // 🔒 `p2seed900001`, NOT `p2ws1`, and NO `ON CONFLICT` — both were review
  // findings. reset() deletes producers matching `name LIKE 'P2TEST%'` OR
  // `id LIKE 'p2seed%'`; this row's NAME begins with whitespace, so only the ID
  // predicate can reach it. With the old id the row survived teardown, and
  // `ON CONFLICT DO NOTHING` then made every later run silently reuse it —
  // a fixture that passes from pre-existing state, which is the exact failure
  // this suite's own rule forbids. A bare INSERT now fails loudly if reset broke.
  //
  // ⚠️ The LAST SIX CHARACTERS must all be DIGITS: § 1c's merge-fraction
  // fixture does `(right(id, 6))::int` over every `id LIKE 'p2seed%'` row, so
  // any non-numeric tail aborts that section with a 22P02. Both `p2seed_ws1`
  // (→ `ed_ws1`) and `p2seedws0001` (→ `ws0001`) failed this before landing on
  // `p2seed900001`; the 9-prefixed range keeps it clear of the seeded ids.
  await prisma.$executeRawUnsafe(
    `INSERT INTO producers (id,name,status) VALUES ('p2seed900001', E'  P2TEST\\u00a0Padded   Domaine \\t ', 'provisional')`)
  const [wsRow] = await prisma.$queryRawUnsafe(
    `SELECT name, name_folded FROM producers WHERE id='p2seed900001'`)
  ok(wsRow.name === '  P2TEST\u00a0Padded   Domaine \t ',
    'the padded DISPLAY value is stored verbatim (the fixture really is padded)')
  const padded = await findProducerByExactName('P2TEST Padded Domaine')
  ok(padded.some(r => r.id === 'p2seed900001'),
    'findProducerByExactName finds a WHITESPACE-PADDED stored row by its clean name')
  // 🔒 THE QUERY-OPERAND DISCRIMINATOR, and it has to be built deliberately.
  // A CLEAN query string cannot detect a reverted operand: both folds map it to
  // the same key, so `lower(f_unaccent($1))` and `catalog_fold_v1($1)` agree and
  // the mutation survives. Verified — reverting the operand left the suite at
  // 0 failures until this case existed.
  //
  // ⚠️ It must also be INTERNAL whitespace: `findProducerByExactName` .trim()s
  // its argument, so edge whitespace never reaches the SQL operand at all.
  // Doubled spaces, NBSP and tabs do, and only the versioned fold collapses them.
  const NBSP = String.fromCodePoint(0x00a0)
  for (const [label, q] of [
    ['doubled internal spaces', 'P2TEST Padded  Domaine'],
    ['an NBSP separator', `P2TEST Padded${NBSP}Domaine`],
    ['a tab separator', 'P2TEST Padded\tDomaine'],
  ]) {
    const hits = await findProducerByExactName(q)
    ok(hits.some(r => r.id === 'p2seed900001'),
      `findProducerByExactName matches through ${label} (pins the QUERY operand, not just the column)`)
  }
  // 🔒 APP/DB PARITY over the COMPLETE scrub character set — the second review
  // finding, then widened after a third: an earlier version SAMPLED 9 of the 44
  // deleted codepoints, so a mutation dropping an unsampled one (U+2069, a C0
  // control, DEL) stayed green while the comment claimed full parity.
  //
  // 🔒 The set is DERIVED from the real `scrub()` at runtime, never transcribed —
  // a hardcoded list silently stops matching the moment SCRUB_RE changes, which
  // is the exact drift this whole migration exists to prevent. Deriving it means
  // adding a character to SCRUB_RE automatically extends this test.
  //
  // ⚠️ U+0000 is excluded: PostgreSQL `text` cannot hold a NUL byte at all, so it
  // is rejected before any fold runs and there is nothing to compare.
  const SCRUB_DELETED = []
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue          // unpaired surrogates
    if (scrub(`a${String.fromCodePoint(cp)}b`) === 'ab') SCRUB_DELETED.push(cp)
  }
  ok(SCRUB_DELETED.length === 44,
    `derived the full scrub-deleted set from SCRUB_RE (got ${SCRUB_DELETED.length}, expected 44 — if this changed, SCRUB_RE changed and the migration's delete class must change WITH it)`)

  let parityOk = 0
  const parityBad = []
  for (const cp of SCRUB_DELETED) {
    const rawName = `Ch\u00e2teau${String.fromCodePoint(cp)}Margaux`
    const [r] = await prisma.$queryRawUnsafe(
      `SELECT catalog_fold_v1($1) a, catalog_fold_v1($2) b`, rawName, scrub(rawName) ?? '')
    // Both sides must agree AND both must have DELETED the character (no space):
    // agreement alone would also hold if the fold mapped it to a space and scrub
    // happened to as well, which is not the contract.
    if (r.a === r.b && r.a === 'chateaumargaux') parityOk++
    else parityBad.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}(${JSON.stringify(r.a)}/${JSON.stringify(r.b)})`)
  }
  ok(parityBad.length === 0,
    `all ${SCRUB_DELETED.length} scrub-deleted codepoints: DB fold == fold(scrub(raw)), both delete${
      parityBad.length ? ` — MISMATCHED: ${parityBad.slice(0, 6).join(' ')}` : ''}`)

  // Paired negative: ZWNJ/ZWJ are REQUIRED for Persian/Arabic/Hindi ligatures.
  // Both `scrub` and the fold must PRESERVE them — deleting would corrupt names.
  for (const [label, cp] of [['ZWNJ U+200C', 0x200c], ['ZWJ U+200D', 0x200d]]) {
    const rawName = `Ch\u00e2teau${String.fromCodePoint(cp)}Margaux`
    const [r] = await prisma.$queryRawUnsafe(
      `SELECT catalog_fold_v1($1) a, catalog_fold_v1($2) b`, rawName, scrub(rawName) ?? '')
    ok(r.a === r.b && r.a.includes(String.fromCodePoint(cp)),
      `${label} is PRESERVED by both (not deleted, not folded to a space)`)
  }

  const notPadded = await findProducerByExactName('P2TEST Padded Chateau')
  ok(notPadded.length === 0,
    'a genuinely different name still does NOT match (paired negative)')

  // 🔒 STRUCTURAL PIN on the trigram operand. The round-trips above run through
  // the DB, so they cannot see `trgmOrderSql` drifting back to a superseded
  // expression — a KNN order against the wrong fold still returns plausible
  // rows. Assert the generated SQL names the current version.
  const orderSql = trgmOrderWith(`'x'`, 'name_folded')
  ok(orderSql.includes('catalog_fold_v1'),
    `trgmOrderWith folds with catalog_fold_v1 (got: ${orderSql})`)
  ok(!/lower\s*\(\s*f_unaccent/.test(orderSql),
    'trgmOrderWith no longer uses the superseded lower(f_unaccent(...)) form')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 1d — per-vintage grape override, through the REAL helper')
  // 🔒 THE PATH THAT MATTERS: drive `createVintage` and read back through the
  // PRISMA CLIENT, not raw SQL. An earlier version asserted only over raw SQL
  // and therefore (a) could not see that Prisma collapses NULL and `{}` to `[]`
  // — which is what killed the original nullable-array design — and (b) stayed
  // green when the helper's write was removed entirely.
  const vgProd = await createProducer({ name: 'P2TEST VG Producer' }, TEST_USER)
  const vgWine = await createProduct(
    { name: 'P2TEST VG Wine', category: 'wine', scope: 'shared',
      grapes: ['Syrah', 'Grenache', 'Cinsault'], producerId: vgProd.id }, TEST_USER)
  const mkV = (year, opts) => createVintage(vgWine.id, year, TEST_USER, null, undefined, opts)
  const vInherit  = await mkV(2018)                                          // omitted
  const vInherit2 = await mkV(2019, {})                                      // opts w/o field
  const vNone     = await mkV(2020, { grapes: [] })                          // genuinely none
  const vOverride = await mkV(2021, { grapes: ['Syrah', ' Grenache '] })     // override + trim
  const vEcho     = await mkV(2022, { grapes: ['Syrah', 'Grenache', 'Cinsault'] }) // == product

  const vRows = await prisma.wineVintage.findMany({
    where: { productId: vgWine.id },
    select: { id: true, year: true, grapes: true, grapesOverride: true,
              product: { select: { grapes: true } } },
  })
  const vById = Object.fromEntries(vRows.map(r => [r.id, r]))
  const effective = r => r.grapesOverride ? r.grapes : r.product.grapes

  ok(vById[vInherit.id].grapesOverride === false
     && effective(vById[vInherit.id]).join(',') === 'Syrah,Grenache,Cinsault',
    'omitting grapes INHERITS the product, read through Prisma')
  ok(vById[vInherit2.id].grapesOverride === false,
    'an opts object WITHOUT the field also inherits (absence, not falsiness)')
  // 🔒 THE ASSERTION THE NULLABLE DESIGN COULD NOT MAKE: these two rows store
  // the SAME `[]` through Prisma and are told apart only by the flag.
  ok(JSON.stringify(vById[vInherit.id].grapes) === '[]'
     && JSON.stringify(vById[vNone.id].grapes) === '[]'
     && vById[vNone.id].grapesOverride === true
     && effective(vById[vNone.id]).length === 0,
    'inherit and "genuinely none" both read as [] but are DISTINGUISHED by the flag')
  ok(effective(vById[vOverride.id]).join(',') === 'Syrah,Grenache',
    'a real override replaces the product grapes (and normalizes whitespace)')
  // 🔒 PRESENCE DETERMINES INTENT — an override equal to the product's CURRENT
  // grapes is still an override. An earlier version normalized it back to
  // inherit as a belt against a client posting unconditionally, and that was
  // wrong twice: `[]` is truthy in JS so an explicit "genuinely none" over an
  // empty product was silently downgraded (measured), and even when it worked,
  // discarding an explicit write because it matches TODAY's product value lets a
  // later product edit silently rewrite that vintage.
  ok(vById[vEcho.id].grapesOverride === true
     && vById[vEcho.id].grapes.join(',') === 'Syrah,Grenache,Cinsault',
    'an override equal to the product is STILL an override (presence, not equality)')
  // The case the removed belt actively broke: explicit `[]` over an EMPTY product.
  const emptyProd = await createProduct(
    { name: 'P2TEST VG Empty', category: 'wine', scope: 'shared', grapes: [], producerId: vgProd.id }, TEST_USER)
  const vNoneOverEmpty = await createVintage(emptyProd.id, 2018, TEST_USER, null, undefined, { grapes: [] })
  const rNoneOverEmpty = await prisma.wineVintage.findUnique({
    where: { id: vNoneOverEmpty.id }, select: { grapes: true, grapesOverride: true } })
  ok(rNoneOverEmpty.grapesOverride === true,
    'explicit [] over an EMPTY product stays authoritative (the belt silently downgraded this)')
  // Malformed input REJECTS rather than becoming an authoritative empty — at
  // this grain, normalization-to-empty manufactures a claim nobody made.
  await rejects('a non-string vintage grape element',
    () => createVintage(vgWine.id, 2030, TEST_USER, null, undefined, { grapes: [123] }),
    'must be a string')
  await rejects('a blank vintage grape element',
    () => createVintage(vgWine.id, 2031, TEST_USER, null, undefined, { grapes: ['  '] }),
    'must not be blank')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 1b — PRODUCT search plans (scoped, unscoped, and broad)')
  // 🔒 § 1 only ever explained the PRODUCER predicate, and that gap hid a real
  // regression: an alias-resolving recursive CTE over the whole producers table
  // was joined into EVERY product search — including the unscoped path, which
  // does not even use it. Measured on this schema at 60k producers / 60k
  // products: a selective product search went from 0.16 ms to 60 ms (~385x),
  // with a Seq Scan over all 60,000 producers and ~1,130 blocks of temp-disk
  // sort spill, to return ONE row. At several hundred thousand rows that is a
  // timeout, not a slowdown — and nothing in the suite could see it, because
  // the RESULTS were correct throughout.
  //
  // So all three product shapes get plan assertions: unscoped, scoped, and a
  // broad/common-name query (the worst realistic case, where many rows match
  // and the LIMIT does the work).
  // ⚠️ ONE TRANSACTION — the products and their lead links must commit
  // together, or the deferred exactly-one-lead trigger rejects the batch at
  // COMMIT ("has no lead producer"). That is the invariant working; the same
  // rule binds the phase-4 import batches (§ Exactly one lead).
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`
      INSERT INTO wine_products (id, name, category, scope, status, grapes, curator_locked, created_at, updated_at)
      SELECT 'p2pseed' || lpad(g::text, 14, '0'),
             CASE WHEN g % 2 = 0 THEN 'P2TEST Reserve Rouge ' || substr(md5(g::text), 1, 8)
                  ELSE 'P2TEST Cuvee ' || substr(md5((g * 7)::text), 1, 10) END,
             'wine', 'shared', 'confirmed', '{}', '{}', now(), now()
        FROM generate_series(1, 30000) g`),
    prisma.$executeRawUnsafe(`
      INSERT INTO product_producers (product_id, producer_id, role, created_at)
      SELECT 'p2pseed' || lpad(g::text, 14, '0'), 'p2seed' || lpad(g::text, 15, '0'), 'lead', now()
        FROM generate_series(1, 30000) g`),
  ])
  await prisma.$executeRawUnsafe('VACUUM ANALYZE wine_products')
  await prisma.$executeRawUnsafe('VACUUM ANALYZE product_producers')

  const pTerm = (await prisma.$queryRawUnsafe(
    `SELECT name FROM wine_products WHERE name LIKE 'P2TEST Cuvee %' ORDER BY id LIMIT 1`))[0]
    .name.split(' ').pop()
  const productPlan = async (extraJoin, extraWhere) => planFor(
    `SELECT wp.id
       FROM wine_products wp
       JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
       JOIN producers pr ON pr.id = pp.producer_id ${extraJoin}
      WHERE wp.status = ANY(ARRAY['provisional','confirmed','linked'])
        AND wp.scope = 'shared' ${extraWhere}
      ORDER BY ${trgmOrderWith(`'${pTerm}'`, 'wp.name_folded')} LIMIT 20`)

  const unscopedPlan = await productPlan('', '')
  ok(unscopedPlan.includes('wine_products_name_folded_gist_idx'),
    'UNSCOPED product search uses the GiST KNN index')
  // 🔒 THE LOAD-BEARING NEGATIVE: no full pass over producers, and no temp-disk
  // sort. Either one reappearing means the alias resolution has crept back into
  // the hot path.
  ok(!seqScansTable(unscopedPlan, 'producers'),
    'UNSCOPED product search does NOT sequentially scan the producers table')
  ok(!unscopedPlan.includes('"Sort Space Type":"Disk"'),
    'UNSCOPED product search does not spill its sort to temporary disk')

  // ⚠️ The SCOPED shape deliberately does NOT assert the trgm index. Measured:
  // the planner drives from `product_producers_producer_id_idx` instead —
  // one producer has a handful of products, so fetching them by producer and
  // filtering is cheaper than a trigram scan. That is the RIGHT plan, and an
  // assertion demanding a specific index would have forced a worse one. What
  // must hold either way is the property, not the mechanism: nothing scans a
  // whole table, and nothing spills to disk.
  const scopedPlan = await productPlan('', `AND pp.producer_id = ANY(ARRAY['p2seed000000000000001'])`)
  ok(!seqScansTable(scopedPlan, 'producers') && !seqScansTable(scopedPlan, 'wine_products'),
    'SCOPED product search sequentially scans NEITHER producers NOR wine_products')
  ok(!scopedPlan.includes('"Sort Space Type":"Disk"'),
    'SCOPED product search does not spill its sort to temporary disk')

  // Broad/common name — many rows match, so the candidate set is large and the
  // LIMIT does the work. The worst realistic case, and the one where the old
  // CTE burned 661,016 buffers.
  const broadPlan = await planFor(
    `SELECT wp.id
       FROM wine_products wp
       JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
       JOIN producers pr ON pr.id = pp.producer_id
      WHERE wp.status = ANY(ARRAY['provisional','confirmed','linked'])
        AND wp.scope = 'shared'
      ORDER BY ${trgmOrderWith(`'P2TEST Reserve Rouge'`, 'wp.name_folded')} LIMIT 20`)
  // ⚠️ A broad query legitimately may hash-join the producers table — with tens
  // of thousands of matching products that is a reasonable cost decision, not
  // the pathology. Asserting "no seq scan" here would forbid a correct plan.
  // What the regression actually DID was burn 661,016 buffers to return 20
  // rows, so the honest assertion is a WORK CEILING, which is the thing that
  // hurts at several hundred thousand rows.
  //
  // Measured on this fixture after the fix: ~1,600 buffers. The 50,000 ceiling
  // is ~30x headroom for planner drift while still failing the old CTE by two
  // orders of magnitude.
  const broadBuffers = totalBuffers(broadPlan)
  ok(broadBuffers > 0 && broadBuffers < 50_000,
    `BROAD/common-name product search stays under the work ceiling (${broadBuffers} buffers; the pre-fix CTE used 661,016)`)
  ok(!broadPlan.includes('"Sort Space Type":"Disk"'),
    'BROAD/common-name product search does not spill its sort to temporary disk')

  // 🔒 AND THE SAME CEILING ON THE *REAL FUNCTION*, not on hand-written SQL.
  //
  // The three assertions above EXPLAIN query text written here, which is
  // exactly the reconstruction trap this suite has already been bitten by
  // twice: mutation testing showed that reinstating the catalog-wide recursive
  // CTE *inside searchProducts* left all of them green, because the string they
  // explain was never the string the module emits. Results stay correct under
  // that regression — only the cost explodes — so nothing else can see it.
  //
  // `pg_stat_database` counts blocks this database actually touched, so
  // sampling it around a real call measures the work the module did. Coarse (it
  // counts everything on this connection) but that only makes it CONSERVATIVE:
  // noise inflates the number, so a passing run is genuinely under the ceiling.
  // ⚠️ pg_stat_database is flushed periodically, not synchronously — sampling
  // it without forcing a flush reads a stale snapshot and reports 0 blocks,
  // which would make this assertion silently vacuous. pg_stat_force_next_flush()
  // (PG15+) pushes the backend's pending counts before each read.
  const blocksNow = async () => {
    await prisma.$executeRawUnsafe(`SELECT pg_stat_force_next_flush()`)
    return Number((await prisma.$queryRawUnsafe(
      `SELECT blks_hit + blks_read AS b FROM pg_stat_database WHERE datname = current_database()`))[0].b)
  }
  // ⚠️ THE FIXTURE MUST CONTAIN MERGED PRODUCERS, or this assertion cannot
  // fail. Measured: with almost no `links_to` set, the recursive arm terminates
  // immediately and even a catalog-wide CTE costs ~171 blocks — so the
  // mutation-test passed a KNOWN regression. With a realistic merge fraction
  // the same CTE cost 3,252,182 blocks / 517 ms at 60k rows. A performance
  // guard whose fixture never exercises the expensive path is decoration.
  await prisma.$executeRawUnsafe(`
    UPDATE producers SET status = 'linked',
           links_to = 'p2seed' || lpad(((id_num % 100) + 1)::text, 15, '0')
      FROM (SELECT id AS pid, (right(id, 6))::int AS id_num FROM producers
             WHERE id LIKE 'p2seed%') src
     WHERE producers.id = src.pid AND src.id_num > 100 AND src.id_num % 10 = 0`)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')
  await searchProducts('P2TEST Reserve Rouge')   // warm caches first
  const before = await blocksNow()
  await searchProducts('P2TEST Reserve Rouge')
  const used = (await blocksNow()) - before
  ok(used > 0 && used < 50_000,
    `the REAL searchProducts stays under a work ceiling (${used} blocks)`)

  // 🔒 AND THE STRUCTURAL GUARD, which is the one that actually bites.
  //
  // The block ceiling above is honest but WEAK AT FIXTURE SCALE: measured, the
  // catalog-wide CTE costs only ~170 blocks against 30k producers (the
  // recursive arm terminates fast and the hash join is cheap), yet the SAME
  // query cost 3,252,182 blocks and 517 ms at 60k producers / 60k products.
  // Its cost is superlinear, so a fixture small enough for CI cannot catch it
  // by measurement alone — and a fixture large enough would dominate the suite
  // runtime. Mutation testing proved this: reinstating the CTE left the
  // ceiling assertion green.
  //
  // So assert the STRUCTURE instead. `searchProducts` must not resolve merge
  // aliases by walking the whole producers table; the alias GROUP of one
  // chosen producer is resolved separately, in a bounded query. A recursive
  // CTE seeded from an unfiltered `FROM producers` is exactly the shape that
  // regressed, and it is trivially detectable in the emitted SQL.
  const emitted = []
  const sqlSpy = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  sqlSpy.$on('query', e => emitted.push(e.query))
  try {
    await sqlSpy.$executeRawUnsafe('SELECT 1')   // prove the spy is wired
    ok(emitted.length > 0, 'the query spy captures emitted SQL')
  } finally { await sqlSpy.$disconnect() }
  // Read the module's own source for the shape — the queries are built as
  // template strings, so the source IS the contract here, and this fails
  // loudly if someone reintroduces the pattern.
  //
  // ⚠️ Scoped to searchProducts' own body. `producerAliasGroup` below it uses a
  // recursive CTE too, but the CORRECT bounded one — seeded from a single id
  // and served by producers_links_to_idx. The regression is specifically a CTE
  // seeded from the UNFILTERED table, so that is what is matched.
  const searchSrc = readFileSync(join(REPO_ROOT, 'lib/catalogSearch.ts'), 'utf8')
  const fnStart = searchSrc.indexOf('export async function searchProducts')
  const productsFn = searchSrc.slice(fnStart, searchSrc.indexOf('\nasync function resolveProductMatches'))
  ok(!/WITH RECURSIVE[\s\S]{0,400}FROM\s+producers(?!\s+WHERE)/i.test(productsFn),
    'searchProducts does NOT embed a recursive CTE seeded from the WHOLE producers table (the ~385x regression shape)')

  // Clean the product fixture — later sections count rows by name prefix.
  await prisma.$executeRawUnsafe(`DELETE FROM wine_products WHERE id LIKE 'p2pseed%'`)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 2 — search excludes what must never be offered as a link target')
  // Tombstones and junk verdicts must not be selectable: linking new tasting
  // data to a `linked` row points it at an entry already merged away.
  const survivor = await createProducer({ name: 'P2TEST Survivor Estate' }, TEST_USER)
  // Two separate inserts: the tombstone carries links_to (a `linked` row
  // without a pointer is refused by producers_linked_pointer_check) while the
  // rejected row must NOT — the same CHECK is bidirectional.
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, links_to, curator_locked, created_at, updated_at)
    VALUES ('p2tomb00000000000000', 'P2TEST Survivor Estate Dup', 'linked', '${survivor.id}', '{}', now(), now())
  `)
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    VALUES ('p2rej000000000000000', 'P2TEST Survivor Estate Junk', 'rejected', '{}', now(), now())
  `)
  await prisma.$executeRawUnsafe('ANALYZE producers')
  const surv = await searchProducers('Survivor Estate')
  ok(surv.some(r => r.id === survivor.id), 'a live producer IS offered (the paired accept)')
  ok(!surv.some(r => r.id === 'p2tomb00000000000000'), 'a merge tombstone (linked) is NOT offered')
  ok(!surv.some(r => r.id === 'p2rej000000000000000'), 'a rejected producer is NOT offered')

  // 🔒 RULING 3's CONTINGENCY: add-time results must NOT carry lifecycle state.
  // The RFC accepts blind-session provisional discoverability ONLY because
  // catalog records are indistinguishable by state to end users. `provisional`
  // is a strong "recently added by a taster" proxy (imported rows land
  // `confirmed`), so exposing it would let a blind taster filter candidates
  // down to entries minted during their session — the exact capability the
  // ruling says is unavailable.
  ok(surv.every(r => r.status === undefined),
    'add-time producer results carry NO status field (RFC ruling 3 contingency)')

  // The PAIRED POSITIVE — and the first exercise of scope: 'review', which was
  // otherwise plumbed but never called by anything. Phase 3's curator surfaces
  // are its real user; without this the archived-inclusion branch ships
  // untested.
  const archivedId = 'p2arch00000000000000'
  await prisma.$executeRawUnsafe(`
    INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
    VALUES ('${archivedId}', 'P2TEST Survivor Estate Archived', 'archived', '{}', now(), now())
  `)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')
  const addScope = await searchProducers('Survivor Estate')
  const reviewScope = await searchProducers('Survivor Estate', { scope: 'review' })
  ok(!addScope.some(r => r.id === archivedId),
    'an archived producer is EXCLUDED from add-time suggestions')
  ok(reviewScope.some(r => r.id === archivedId),
    'an archived producer IS findable in the review scope (RFC lifecycle: findable / excluded)')
  ok(reviewScope.every(r => typeof r.status === 'string'),
    'review-scope results DO carry status — the field is scoped, not removed')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 2b — merge tombstones RESOLVE to their survivor')
  // 🔒 The RFC's lifecycle table says `linked` "resolves to survivor" in search
  // AND links — not that it is hidden. Excluding tombstones gets the first half
  // right and the second half wrong: searching a merged alias returned NOTHING
  // instead of the entry it was merged into, and product search scoped by
  // either the alias or the survivor id returned nothing at all (products stay
  // children of the loser — nothing re-parents on merge). Both break the moment
  // phase 3 starts merging, which is the same phase that permits public
  // release, so this cannot wait for phase 3 to discover.
  const mSurv = await createProducer({ name: 'P2TEST Merge Survivor' }, TEST_USER)
  const mLoser = await createProducer({ name: 'P2TEST Distinctive Alias Spelling' }, TEST_USER)
  const mProd = await createProduct(
    { name: 'P2TEST Merged Cuvee', producerId: mLoser.id }, TEST_USER)
  await prisma.$executeRawUnsafe(
    `UPDATE producers SET status = 'linked', links_to = '${mSurv.id}' WHERE id = '${mLoser.id}'`)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')
  const aliasHits = await searchProducers('Distinctive Alias Spelling')
  // Asserts the survivor is present and the TOMBSTONE is not — rather than a
  // total count, which would break the moment an unrelated fixture happens to
  // fuzzy-match the query.
  ok(aliasHits.some(r => r.id === mSurv.id) && !aliasHits.some(r => r.id === mLoser.id),
    `searching a merged ALIAS returns the survivor and not the tombstone (got ${JSON.stringify(aliasHits.map(r => r.name))})`)
  // Products stay children of the loser, so BOTH ids must see the same set.
  ok((await searchProducts('Merged Cuvee', { producerId: mLoser.id })).length === 1,
    'product search scoped by the ALIAS id finds the product')
  ok((await searchProducts('Merged Cuvee', { producerId: mSurv.id })).length === 1,
    'product search scoped by the SURVIVOR id finds it too (nothing re-parents on merge)')
  // 🔒 THE PAIRED NEGATIVE — scoping must still actually bite, or "resolve the
  // chain" would have degenerated into "ignore the filter".
  ok((await searchProducts('Merged Cuvee', { producerId: survivor.id })).length === 0,
    'an UNRELATED producer id still returns nothing (scoping is not disabled)')

  // 🔒 THE REPORTED PRODUCER IDENTITY MUST BE THE SURVIVOR'S, not the
  // tombstone's. Filtering by the effective producer while SELECTING `pr.id` /
  // `pr.name` from the STORED one meant the response advertised a producer that
  // no longer exists — and a caller acting on that id would link new tasting
  // data to a row already merged away. Asserting only "one product came back"
  // (which the first version of this section did) never looks at the identity.
  const underMerged = await searchProducts('Merged Cuvee', { producerId: mSurv.id })
  eq(underMerged[0]?.producerId, mSurv.id,
    'a product under a MERGED producer reports the SURVIVOR id, not the tombstone')
  eq(underMerged[0]?.producerName, 'P2TEST Merge Survivor',
    'and the survivor NAME, not the tombstone name')

  // 🔒 A merged PRODUCT alias resolves too — the product grain had the same
  // defect as the producer grain, and only the producer half was covered.
  const mProdSurv = await createProduct(
    { name: 'P2TEST Surviving Bottling', producerId: mSurv.id }, TEST_USER)
  await prisma.$executeRawUnsafe(
    `UPDATE wine_products SET status = 'linked', links_to = '${mProdSurv.id}' WHERE id = '${mProd.id}'`)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE wine_products')
  const prodAlias = await searchProducts('Merged Cuvee')
  ok(prodAlias.some(r => r.id === mProdSurv.id) && !prodAlias.some(r => r.id === mProd.id),
    `searching a merged PRODUCT alias returns the survivor, not the tombstone (got ${
      JSON.stringify(prodAlias.map(r => r.name))})`)
  // Unwind.
  await prisma.$executeRawUnsafe(
    `UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE id = '${mProd.id}'`)
  // A chain A→B→C resolves transitively to C, and is capped so corrupt data
  // fails safe rather than looping.
  const mFinal = await createProducer({ name: 'P2TEST Chain Final' }, TEST_USER)
  await prisma.$executeRawUnsafe(
    `UPDATE producers SET status = 'linked', links_to = '${mFinal.id}' WHERE id = '${mSurv.id}'`)
  await prisma.$executeRawUnsafe('VACUUM ANALYZE producers')
  const chained = await searchProducers('Distinctive Alias Spelling')
  ok(chained.some(r => r.id === mFinal.id)
     && !chained.some(r => r.id === mSurv.id || r.id === mLoser.id),
    `a merge CHAIN (A→B→C) resolves transitively to the END, skipping both intermediates (got ${JSON.stringify(chained.map(r => r.name))})`)
  // Unwind so later sections see a clean fixture set.
  await prisma.$executeRawUnsafe(
    `UPDATE producers SET status = 'provisional', links_to = NULL WHERE id IN ('${mLoser.id}','${mSurv.id}')`)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 3 — a product cannot be created without its lead producer')
  // 🔒 The deferred trigger raises at COMMIT, so a bare create ALWAYS fails.
  // This is the invariant working, and phase-2 authors meet it as a confusing
  // runtime error if they route around createProduct.
  await rejects(
    'a bare wineProduct.create (no lead link) is rejected at COMMIT',
    () => prisma.wineProduct.create({
      data: { id: 'p2nolead000000000000', name: 'P2TEST Leadless', category: 'wine',
              scope: 'shared', status: 'provisional', grapes: [], curatorLocked: [] },
    }),
    'has no lead producer',
  )
  // 🔒 THE PAIRED ACCEPT — without it this section would stay green under a
  // regression that rejected EVERY product creation.
  const prod = await accepts(
    'createProduct commits the product and its lead link in one transaction',
    () => createProduct({ name: 'P2TEST Grand Vin', producerId: survivor.id }, TEST_USER),
  )
  const leadCount = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM product_producers WHERE product_id = '${prod.id}' AND role = 'lead'`)
  eq(leadCount[0].n, 1, 'exactly one lead row exists for the new product')

  // Collaboration (add-branch 5): 2+ producer links set AT CREATION.
  const collab = await createProducer({ name: 'P2TEST Collab Partner' }, TEST_USER)
  const collabProduct = await accepts(
    'a collaboration product is created with lead + collaborator links',
    () => createProduct({ name: 'P2TEST Joint Cuvee', producerId: survivor.id }, TEST_USER, [collab.id]),
  )
  const roles = await prisma.$queryRawUnsafe(
    `SELECT role, count(*)::int AS n FROM product_producers
      WHERE product_id = '${collabProduct.id}' GROUP BY role ORDER BY role`)
  eq(roles, [{ role: 'collaborator', n: 1 }, { role: 'lead', n: 1 }],
    'the collaboration has exactly one lead and one collaborator')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 4 — scope is set explicitly, never defaulted')
  // 🔒 The column deliberately has NO default: an omitted scope must fail loudly
  // rather than silently landing 'shared' (i.e. public).
  await rejects(
    'a product insert omitting scope is rejected by NOT NULL',
    () => prisma.$executeRawUnsafe(`
      INSERT INTO wine_products (id, name, category, status, grapes, curator_locked, created_at, updated_at)
      VALUES ('p2noscope00000000000', 'P2TEST No Scope', 'wine', 'provisional', '{}', '{}', now(), now())
    `),
    'scope',
  )
  const scopeRow = await prisma.$queryRawUnsafe(
    `SELECT scope FROM wine_products WHERE id = '${prod.id}'`)
  eq(scopeRow[0].scope, 'shared', 'createProduct set scope explicitly to shared (the paired accept)')

  // An `owned` product must never surface in search — the deferred ownership
  // axis must not leak through a public query.
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`
      INSERT INTO wine_products (id, name, category, scope, status, grapes, curator_locked, created_at, updated_at)
      VALUES ('p2owned00000000000000'::varchar(21), 'P2TEST Grand Vin Owned', 'wine', 'owned', 'confirmed', '{}', '{}', now(), now())
    `)
    await tx.$executeRawUnsafe(`
      INSERT INTO product_producers (product_id, producer_id, role, created_at)
      VALUES ('p2owned00000000000000', '${survivor.id}', 'lead', now())
    `)
  })
  const prodHits = await searchProducts('Grand Vin')
  ok(prodHits.some(r => r.id === prod.id), 'a shared product IS offered (the paired accept)')
  ok(!prodHits.some(r => r.id === 'p2owned00000000000000'),
    'an owned-scope product is NOT offered in public search')

  // ⚠️ THE PRODUCT PATH NEEDS ITS OWN ASSERTIONS. § 2 above covers the same
  // three rules on the PRODUCER path only, and review showed the product half
  // was uncovered: dropping `stripAddTimeFields`, the status filter, or the
  // producerId scoping from `searchProducts` all left the suite green. Two call
  // sites, two sets of assertions — a shared rule tested on one site is tested
  // on neither.
  ok(prodHits.every(r => r.status === undefined),
    'add-time PRODUCT results carry NO status field (RFC ruling 3 contingency)')
  // Tombstone + rejected exclusion at PRODUCT grain. Uses its own fixture
  // rather than depending on § 6 (which tombstones `collabProduct` later) —
  // an assertion that relies on a fixture created in a LATER section silently
  // stops testing anything the moment sections are reordered.
  ok((await searchProducts('Joint Cuvee')).some(r => r.id === collabProduct.id),
    'a live PRODUCT is offered (the paired accept)')
  await prisma.$executeRawUnsafe(
    `UPDATE wine_products SET status = 'linked', links_to = '${prod.id}' WHERE id = '${collabProduct.id}'`)
  ok(!(await searchProducts('Joint Cuvee')).some(r => r.id === collabProduct.id),
    'a merge-tombstoned PRODUCT is NOT offered as a link target')
  // Restored so § 6 can tombstone it itself — that section asserts the LINK
  // path's rejection and sets up its own state.
  await prisma.$executeRawUnsafe(
    `UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE id = '${collabProduct.id}'`)
  // 🔒 producerId scoping. Generic product names ("Réserve", "Brut") collide
  // constantly across producers and must NEVER merge across them, so an
  // unscoped search would surface candidates that are not legitimate matches at
  // all. Both directions: scoped to the owning producer finds it, scoped to a
  // different producer does not.
  const scopedHit = await searchProducts('Grand Vin', { producerId: survivor.id })
  const scopedMiss = await searchProducts('Grand Vin', { producerId: collab.id })
  ok(scopedHit.some(r => r.id === prod.id),
    'producerId scoping finds the product under its OWN lead producer')
  ok(!scopedMiss.some(r => r.id === prod.id),
    'producerId scoping EXCLUDES the product under a different producer')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 5 — blind redaction strips the catalog ids')
  // 🔒 THE LEAK THAT LOOKS CORRECT. redactWine spreads ...rest from WineMeta, so
  // productId/vintageId flow through BY DEFAULT unless explicitly overwritten.
  // A payload missing the strip still looks perfectly masked in name, producer,
  // vintage, region — every field a reviewer would eyeball — while carrying an
  // id that resolves to the label via the deliberately-public catalog.
  const wine = {
    id: 'w1', name: 'Secret Wine', producer: 'Secret Producer', vintage: '2019',
    grape: 'Merlot', type: 'red', image: '', imageUrl: '', region: 'Pomerol',
    country: 'FR', productId: prod.id, vintageId: 'someVintageId',
  }
  const redacted = redactWine(wine, { revealed: false, isHost: false, ownsWine: false, index: 0 })
  eq(redacted.productId, null, 'redactWine nulls productId')
  eq(redacted.vintageId, null, 'redactWine nulls vintageId')
  eq(redacted.name, 'Wine 1', 'redactWine still masks the name (the field it always masked)')
  // 🔒 THE PAIRED POSITIVE: the ids must survive when the wine is NOT redacted,
  // or the "strip" could be an unconditional drop that breaks the feature.
  const revealed = redactWine(wine, { revealed: true, isHost: false, ownsWine: false, index: 0 })
  eq(revealed, null, 'a revealed wine is not redacted at all (ids flow through untouched)')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 6 — resolveCatalogLink rejects every way a body value goes wrong')
  const vintage = await createVintage(prod.id, 2019, TEST_USER)
  const otherProduct = await createProduct(
    { name: 'P2TEST Other Wine', producerId: survivor.id }, TEST_USER)

  // 🔒 EVERY catalog-contents denial returns the SAME message. Distinguishing
  // "no such id" / "owned" / "rejected" / "wrong product" would make this a
  // four-way classifier over the catalog — and these link paths are reachable
  // from the ordinary wine and check-in routes, i.e. from OUTSIDE the
  // CATALOG_PUBLIC_ENABLED fence, by any caller who can add a wine (including
  // an anonymous host of their own session). Same leak-prevention reasoning as
  // the 404-not-403 rule in app/api/CLAUDE.md.
  const DENIED = 'invalid catalog reference'
  await rejects('an unknown productId is rejected',
    () => resolveCatalogLink('p2missing00000000000', null), DENIED)
  await rejects("a vintage belonging to a DIFFERENT product is rejected",
    () => resolveCatalogLink(otherProduct.id, vintage.id), DENIED)
  await rejects('linking to a merge tombstone is rejected',
    async () => {
      await prisma.$executeRawUnsafe(`
        UPDATE wine_products SET status = 'linked', links_to = '${otherProduct.id}'
         WHERE id = '${collabProduct.id}'`)
      return resolveCatalogLink(collabProduct.id, null)
    },
    DENIED)
  await rejects('linking to an owned-scope product is rejected',
    () => resolveCatalogLink('p2owned00000000000000', null), DENIED)

  // 🔒 THE PROPERTY ITSELF, not just each case: the four denials must be
  // BYTE-IDENTICAL. Asserting them one-by-one above would still pass if one
  // message drifted to something more specific, which is exactly how a
  // classifier comes back.
  const denialMessages = []
  for (const probe of [
    () => resolveCatalogLink('p2missing00000000000', null),
    () => resolveCatalogLink(otherProduct.id, vintage.id),
    () => resolveCatalogLink(collabProduct.id, null),
    () => resolveCatalogLink('p2owned00000000000000', null),
  ]) {
    try { await probe() } catch (e) { denialMessages.push(String(e.message)) }
  }
  ok(denialMessages.length === 4 && new Set(denialMessages).size === 1,
    `all catalog-contents denials are indistinguishable (got ${JSON.stringify([...new Set(denialMessages)])})`)

  // Shape errors describe the REQUEST, not the catalog, so they stay specific —
  // they reveal nothing about which ids exist.
  await rejects('vintageId without productId is rejected (a shape error, so specific)',
    () => resolveCatalogLink(null, vintage.id), 'vintageId requires productId')
  // 🔒 A present-but-malformed id is a 400, NOT a silent clear. Coercing a
  // non-string to "no link" meant a client bug silently DELETED a valid link
  // and returned 200 — and the resulting row is indistinguishable from a legacy
  // never-linked one, which phase 5's exact-match backfill would then re-derive
  // from strings.
  await rejects('a numeric productId is rejected, not silently coerced to "no link"',
    () => resolveCatalogLink(123, null), 'productId must be a string or null')
  await rejects('an object productId is rejected',
    () => resolveCatalogLink({}, null), 'productId must be a string or null')
  // Paired accept: an explicit null IS still a legitimate clear.
  eq(await resolveCatalogLink(null, null), { productId: null, vintageId: null },
    'an explicit null clear is still accepted (only wrong TYPES are rejected)')

  // 🔒 PARTIAL LINK EDITS: omitted means KEEP, null means CLEAR, PER FIELD.
  // Without the stored-link argument, a caller sending only `{vintageId: null}`
  // — "drop to product grain, keep the product" — had the PRODUCT link
  // destroyed too, silently, with a 200: the omitted productId read as "no
  // link" instead of "unchanged".
  const stored = { productId: prod.id, vintageId: vintage.id }
  eq(await resolveCatalogLink(undefined, null, stored), { productId: prod.id, vintageId: null },
    'clearing ONLY the vintage keeps the product link (drop to product grain)')
  eq(await resolveCatalogLink(undefined, undefined, stored), stored,
    'omitting both fields keeps the stored link untouched')
  eq(await resolveCatalogLink(null, null, stored), { productId: null, vintageId: null },
    'explicitly nulling both still clears everything')
  // And a create (no stored link) is unaffected by the new argument.
  eq(await resolveCatalogLink(undefined, undefined), { productId: null, vintageId: null },
    'a create with no stored link resolves to no link')
  // 🔒 AN INHERITED VINTAGE FOLLOWS ITS PARENT. The vintage is the child grain,
  // so a stored one is meaningless once the product it belongs to is cleared or
  // swapped. Both shapes below returned a 400 for a well-formed request before
  // the guard: the first hit "vintageId requires productId", the second failed
  // the belongs-to-that-product check on a vintage of the OLD product.
  eq(await resolveCatalogLink(null, undefined, stored), { productId: null, vintageId: null },
    'clearing ONLY the product also drops the inherited vintage (unlink a wine)')
  eq(await resolveCatalogLink(otherProduct.id, undefined, stored),
    { productId: otherProduct.id, vintageId: null },
    'RE-LINKING to another product drops the inherited vintage rather than 400ing')
  // Paired negative: an EXPLICIT vintageId still wins over the drop, and is
  // still validated against the new product.
  await rejects('an explicitly-sent vintage of the WRONG product still rejects',
    () => resolveCatalogLink(otherProduct.id, vintage.id, stored), DENIED)

  // 🔒 PAIRED ACCEPTS for the whole section.
  eq(await resolveCatalogLink(prod.id, vintage.id), { productId: prod.id, vintageId: vintage.id },
    'a valid product+vintage pair is accepted')
  eq(await resolveCatalogLink(prod.id, null), { productId: prod.id, vintageId: null },
    'a product-grain link (unknown year) is accepted')
  eq(await resolveCatalogLink(null, null), { productId: null, vintageId: null },
    'no link at all is accepted')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 7 — vintage grain: NV vs unknown-year, and uniqueness')
  // 🔒 year = null is the NON-VINTAGE row EXCLUSIVELY, never "unknown". The
  // constraint is UNIQUE NULLS NOT DISTINCT, so a SECOND NV row must fail —
  // a plain compound unique would allow unlimited ones.
  const nv = await accepts('an NV vintage (year = null) is created',
    () => createVintage(prod.id, null, TEST_USER))
  // The expected fragment is the COLUMN PAIR rather than the constraint name:
  // the Prisma client reports a unique violation as "Unique constraint failed
  // on the fields: (`product_id`,`year`)" and does not surface the constraint's
  // name. Still specific — a violation of any OTHER unique constraint names
  // different columns and would fail this assertion.
  await rejects('a SECOND NV row on the same product is rejected',
    () => createVintage(prod.id, null, TEST_USER), '`product_id`,`year`')
  await rejects('a duplicate YEAR on the same product is rejected',
    () => createVintage(prod.id, 2019, TEST_USER), '`product_id`,`year`')
  // 🔒 And the same rule asserted through RAW SQL. The expected fragment is
  // `year)=(` … `null)` — the detail line Postgres emits for the conflicting
  // KEY — because that is what proves NULLS NOT DISTINCT is in force: it shows
  // a NULL year COLLIDING with an existing NULL year. Postgres treats NULLs as
  // distinct by default, so under a regression that replaced this constraint
  // with a plain compound unique the insert would SUCCEED and this assertion
  // would fail. (Prisma does not surface the constraint NAME for a 23505, so
  // matching on the name is not available here; § below re-checks the name
  // directly against the catalog.)
  await rejects('a second NV row collides on a NULL year (NULLS NOT DISTINCT is in force)',
    () => prisma.$executeRawUnsafe(`
      INSERT INTO wine_vintages (id, product_id, year, status, curator_locked, created_at, updated_at)
      VALUES ('p2nvdup00000000000000'::varchar(21), '${prod.id}', NULL, 'provisional', '{}', now(), now())`),
    'year)=(')
  // The constraint object itself, by name and by strength. Asserted separately
  // because the runtime errors above cannot name it — and a regression could
  // drop `NULLS NOT DISTINCT` while keeping the name.
  const nvConstraint = await prisma.$queryRawUnsafe(`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'wine_vintages'::regclass AND conname = 'wine_vintages_product_year_key'`)
  ok(nvConstraint.length === 1, 'the constraint wine_vintages_product_year_key exists by name')
  ok(nvConstraint[0]?.def?.includes('NULLS NOT DISTINCT'),
    `the constraint is declared NULLS NOT DISTINCT (got: ${nvConstraint[0]?.def})`)
  // Paired accept: a DIFFERENT year is fine, and the NV row still exists.
  await accepts('a different year on the same product is accepted',
    () => createVintage(prod.id, 2020, TEST_USER))
  const nvCount = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM wine_vintages WHERE product_id = '${prod.id}' AND year IS NULL`)
  eq(nvCount[0].n, 1, 'exactly one NV row survives')
  ok(nv !== null, 'the NV row was the one that was kept')

  // The plausible-year fence (route-level, tighter than the DB CHECK).
  const nextYear = new Date().getUTCFullYear() + 1
  ok(validateYear(nextYear) === nextYear, `current year + 1 (${nextYear}) is accepted`)
  await rejects('a far-future year is rejected', async () => validateYear(nextYear + 1), 'year must be between')
  await rejects('a pre-1900 year is rejected', async () => validateYear(1899), 'year must be between')
  ok(validateYear(1900) === 1900, '1900 is accepted (the paired boundary accept)')
  ok(validateYear(null) === null, 'null (the NV row) passes through validateYear')

  // The remaining input guards, each of which exists to turn a 500 into a clean
  // 400 or to bound the trigram scan. All were uncovered; a regression removing
  // any of them left the suite green.
  await rejects('an out-of-range ABV is rejected at the boundary, not by the column',
    () => createProduct({ name: 'P2TEST Strong', producerId: survivor.id, abv: 99 }, TEST_USER),
    'abv must be between 0 and 25')
  const abvOk = await createProduct(
    { name: 'P2TEST Normal ABV', producerId: survivor.id, abv: 13.5 }, TEST_USER)
  const abvRow = await prisma.$queryRawUnsafe(
    `SELECT abv::text AS abv FROM wine_products WHERE id = '${abvOk.id}'`)
  eq(abvRow[0].abv, '13.50', 'a valid ABV is stored (the paired accept; note the Decimal wire form)')
  // Country is allow-listed to ISO 3166-1 alpha-2 and uppercased; anything else
  // becomes NULL rather than a stored value every surface must defend against.
  const ctry = await createProducer(
    { name: 'P2TEST Country Codes', country: 'fr' }, TEST_USER)
  const ctryBad = await createProducer(
    { name: 'P2TEST Bad Country', country: 'FRANCE' }, TEST_USER)
  const ctryRows = await prisma.$queryRawUnsafe(
    `SELECT id, country FROM producers WHERE id IN ('${ctry.id}','${ctryBad.id}') ORDER BY id`)
  const byId = Object.fromEntries(ctryRows.map(r => [r.id, r.country]))
  eq(byId[ctry.id], 'FR', 'a valid country code is uppercased and stored')
  eq(byId[ctryBad.id], null, 'a non-ISO country collapses to NULL, not a stored junk value')
  // 🔒 ALLOW-LIST, not a shape check: 'ZZ' is two letters and not a country.
  const ctryFake = await createProducer({ name: 'P2TEST Fake Country', country: 'ZZ' }, TEST_USER)
  const fakeRow = await prisma.$queryRawUnsafe(
    `SELECT country FROM producers WHERE id = '${ctryFake.id}'`)
  eq(fakeRow[0].country, null,
    "a well-shaped but non-existent code ('ZZ') is rejected by the ISO allow-list")

  // 🔒 `website` goes through the repo's http(s)-only sanitizer, not generic
  // text normalization — otherwise a `javascript:` or `data:` scheme is stored
  // verbatim and becomes a live stored-link hazard the moment a producer page
  // renders it as an anchor.
  const sites = {
    js: await createProducer({ name: 'P2TEST Site JS', website: 'javascript:alert(1)' }, TEST_USER),
    data: await createProducer({ name: 'P2TEST Site Data', website: 'data:text/html,<script>1</script>' }, TEST_USER),
    bare: await createProducer({ name: 'P2TEST Site Bare', website: 'example.com' }, TEST_USER),
    ok: await createProducer({ name: 'P2TEST Site OK', website: 'https://example.com/x' }, TEST_USER),
  }
  const siteRows = await prisma.$queryRawUnsafe(
    `SELECT id, website FROM producers WHERE id IN (${
      Object.values(sites).map(s => `'${s.id}'`).join(',')})`)
  const site = Object.fromEntries(siteRows.map(r => [r.id, r.website]))
  eq(site[sites.js.id], null, 'a javascript: website is rejected, not stored')
  eq(site[sites.data.id], null, 'a data: website is rejected, not stored')
  // Paired accepts — the sanitizer must not reject legitimate input, and a bare
  // domain must save rather than silently disappearing.
  ok(!!site[sites.ok.id], 'an https website IS stored (the paired accept)')
  ok(site[sites.bare.id]?.startsWith('https://'),
    `a bare domain gets https:// prepended rather than silently dropped (got ${JSON.stringify(site[sites.bare.id])})`)
  // Query guards on the trigram scan: sub-trigram queries return nothing rather
  // than an arbitrary slice of the catalog, and the limit is hard-capped.
  eq(await searchProducers('ab'), [], 'a query shorter than one trigram returns nothing')
  eq(await searchProducers('   '), [], 'a blank query returns nothing')
  ok((await searchProducers('P2TEST', { limit: 9999 })).length <= 20,
    'the result limit is hard-capped regardless of the requested value')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 8 — the blank-name / empty-string trap')
  // 🔒 f_unaccent(lower('')) is '', not NULL — so every blank-named entry would
  // fold to the SAME key and fuzzy-match as an exact collision, minting one
  // shared identity where there should be none.
  await rejects('a blank producer name is rejected at the boundary',
    () => createProducer({ name: '   ' }, TEST_USER), 'producer name is required')
  await rejects('a blank product name is rejected at the boundary',
    () => createProduct({ name: '', producerId: survivor.id }, TEST_USER), 'product name is required')
  // And the DATABASE rejects it too — the boundary check is not the only guard.
  await rejects('a blank name is ALSO rejected by the database CHECK',
    () => prisma.$executeRawUnsafe(`
      INSERT INTO producers (id, name, status, curator_locked, created_at, updated_at)
      VALUES ('p2blank00000000000000'::varchar(21), '  ', 'provisional', '{}', now(), now())`),
    'producers_name_not_blank_check')
  // Paired accept: a name that merely CONTAINS spaces is fine.
  await accepts('a normal name with spaces is accepted',
    () => createProducer({ name: '  P2TEST Trimmed Name  ' }, TEST_USER))
  const trimmed = await prisma.$queryRawUnsafe(
    `SELECT name FROM producers WHERE name LIKE 'P2TEST Trimmed%'`)
  eq(trimmed[0].name, 'P2TEST Trimmed Name', 'the stored name is trimmed, not blank-padded')

  // Blank region normalizes to NULL rather than '' (it feeds region_folded).
  const blankRegion = await createProducer(
    { name: 'P2TEST Blank Region', region: '   ' }, TEST_USER)
  const rr = await prisma.$queryRawUnsafe(
    `SELECT region, region_folded FROM producers WHERE id = '${blankRegion.id}'`)
  eq(rr[0].region, null, 'a blank region normalizes to NULL, not the empty string')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 9 — the identity-changing-edit rule')
  // 🔒 An edit that changes the instance's IDENTITY must clear the link;
  // a cosmetic edit must KEEP it. Both directions, because a rule that always
  // cleared, or never cleared, would pass a one-sided test.
  const linked = { name: 'Grand Vin', producer: 'Survivor', vintage: '2019',
                   productId: prod.id, vintageId: vintage.id }
  eq(applyIdentityEditRule(linked, { description: 'lovely' }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a cosmetic edit (description only) KEEPS the link')
  eq(applyIdentityEditRule(linked, { name: 'Different Wine' }, null),
    { productId: null, vintageId: null },
    'changing the NAME clears the link')
  eq(applyIdentityEditRule(linked, { producer: 'Someone Else' }, null),
    { productId: null, vintageId: null },
    'changing the PRODUCER clears the link')
  eq(applyIdentityEditRule(linked, { vintage: '2020' }, null),
    { productId: null, vintageId: null },
    'changing the VINTAGE clears the link')
  eq(applyIdentityEditRule(linked, { name: 'grand  vin' }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a whitespace/case-only name change is NOT an identity change')
  eq(applyIdentityEditRule(linked, { name: 'Different Wine' },
      { productId: otherProduct.id, vintageId: null }),
    { productId: otherProduct.id, vintageId: null },
    'an explicit re-link WINS over the identity-change clear')
  eq(applyIdentityEditRule(linked, {}, { productId: null, vintageId: null }),
    { productId: null, vintageId: null },
    'an explicit clear is honoured')
  // 🔒 THE REAL CLIENT'S ACTUAL SHAPE. The mobile app's UpdateWineBody
  // (apps/mobile/src/lib/api/sessions.ts) resends name + producer + vintage on
  // EVERY edit, including a pure photo change — so the rule sees all three
  // identity fields present, unchanged, on an edit that changes nothing about
  // identity. If the comparison were "field present ⇒ treat as changed", every
  // photo edit from the app would silently drop a correct catalog link. Pinned
  // here because the failure would be invisible: the edit succeeds, the link
  // just quietly disappears.
  eq(applyIdentityEditRule(linked,
      { name: 'Grand Vin', producer: 'Survivor', vintage: '2019' }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a client that resends all identity fields UNCHANGED keeps the link')
  // The mirror case: the same client clearing the vintage IS an identity change.
  eq(applyIdentityEditRule(linked,
      { name: 'Grand Vin', producer: 'Survivor', vintage: '' }, null),
    { productId: null, vintageId: null },
    'clearing the vintage to empty IS an identity change and clears the link')

  // 🔒 THE COMPARISON MUST MATCH THE WRITE'S OWN NORMALIZATION. The write path
  // scrubs control/zero-width characters and canonicalizes `vintage` through
  // the shared normalizer, so comparing the RAW body value reported a change
  // where the STORED value would not actually move — silently dropping a
  // correct link on an edit that changes nothing.
  //
  // ⚠️ UPDATED: the vintage rule is no longer "truncate to 4 chars". It is
  // EXACTLY four digits or the NV token, else empty — a partial or overlong
  // value is dropped rather than sliced, because slicing invents a year the
  // user never typed. So '2019-2020' normalizes to EMPTY (not to '2019'), the
  // stored value really does move, and the link MUST clear. The earlier
  // expectation here encoded the truncating write and became wrong when the
  // contract tightened.
  eq(applyIdentityEditRule(linked, { vintage: '2019-2020' }, null),
    { productId: null, vintageId: null },
    'an overlong vintage normalizes to EMPTY, so the stored value moves and the link clears')
  // The canonicalization case that must NOT clear: 'N.V.' and 'NV' store the
  // same value, so an edit between them changes nothing.
  eq(applyIdentityEditRule({ ...linked, vintage: 'N.V.' }, { vintage: 'NV' }, null),
    { productId: prod.id, vintageId: vintage.id },
    'canonicalizing N.V. to NV stores the same value and keeps the link')
  // 🔒 `name` is REQUIRED, so the write does `scrub(name) || existing` (the
  // check-in PATCH) or rejects outright (the session path). An invalid or blank
  // name is therefore IGNORED and the stored name retained — nothing moves, so
  // the link must survive. `vintage` is optional and stores its empty value, so
  // it is deliberately NOT symmetric with this.
  eq(applyIdentityEditRule(linked, { name: '' }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a blank name is ignored by the write (falls back), so the link survives')
  eq(applyIdentityEditRule(linked, { name: 123 }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a non-string name is ignored by the write, so the link survives')
  // But a NON-STRING VINTAGE does clear: scrub() rejects it, so the write
  // stores empty. A String(v)-coercing comparator kept the link here while the
  // write blanked the vintage — blank vintage, retained vintage-grain link.
  eq(applyIdentityEditRule(linked, { vintage: 2019 }, null),
    { productId: null, vintageId: null },
    'a numeric vintage is rejected by scrub, so the write stores empty and the link clears')
  // ​ is a zero-width space: invisible in the name, removed by scrub(), so
  // the stored value is byte-identical to what's already there.
  eq(applyIdentityEditRule(linked, { name: `Grand​ Vin` }, null),
    { productId: prod.id, vintageId: vintage.id },
    'a zero-width character the write SCRUBS out is not an identity change')
  // Paired negative: a vintage change that genuinely survives canonicalization DOES
  // clear — proving the rule still bites where it should.
  eq(applyIdentityEditRule(linked, { vintage: '2021' }, null),
    { productId: null, vintageId: null },
    'a real vintage change still clears the link')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 10 — grapes: {} is unrecorded, and it is never NULL')
  // 🔒 `cardinality(NULL)` is NULL, not 0 — so a NULL-grapes row would be
  // PERMANENTLY unenrichable by the phase-4 fill. The boundary must normalize
  // missing/null to {}.
  const noGrapes = await createProduct(
    { name: 'P2TEST No Grapes', producerId: survivor.id, grapes: null }, TEST_USER)
  const g1 = await prisma.$queryRawUnsafe(
    `SELECT grapes, cardinality(grapes) AS n FROM wine_products WHERE id = '${noGrapes.id}'`)
  eq(g1[0].n, 0, 'a null incoming grapes value lands as {} with cardinality 0, not NULL')
  const withGrapes = await createProduct(
    { name: 'P2TEST With Grapes', producerId: survivor.id, grapes: ['Merlot', 'Merlot', ' Cabernet '] },
    TEST_USER)
  const g2 = await prisma.$queryRawUnsafe(
    `SELECT grapes, grapes_folded FROM wine_products WHERE id = '${withGrapes.id}'`)
  eq(g2[0].grapes, ['Merlot', 'Cabernet'], 'grapes are trimmed and de-duplicated (the paired accept)')
  eq(g2[0].grapes_folded, ['merlot', 'cabernet'], 'grapes_folded is generated element-wise')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 11 — generated columns are never written by the app')
  // 🔒 Postgres rejects any supplied value with 428C9. This asserts the app
  // could not silently drift display and fold even if it tried.
  await rejects('writing name_folded directly is rejected by Postgres',
    () => prisma.$executeRawUnsafe(
      `UPDATE producers SET name_folded = 'hacked' WHERE id = '${survivor.id}'`),
    'can only be updated to DEFAULT')
  const folded = await prisma.$queryRawUnsafe(
    `SELECT name, name_folded FROM producers WHERE id = '${survivor.id}'`)
  eq(folded[0].name_folded, 'p2test survivor estate',
    'name_folded is the database-generated fold of the display name (the paired accept)')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 12 — the wines link-state invariant')
  // Valid states are (set, set) | (set, null) | (null, null). vintage_id set
  // with product_id null is invalid, and the composite FK alone would NOT catch
  // it — MATCH SIMPLE skips whenever any column is null.
  await prisma.$executeRawUnsafe(`
    INSERT INTO wines (id, name, category, created_at)
    VALUES ('p2test_wine_ok', 'P2 Wine', 'wine', now())`)
  await accepts('a wine with (product, vintage) both set is accepted',
    () => prisma.$executeRawUnsafe(
      `UPDATE wines SET product_id = '${prod.id}', vintage_id = '${vintage.id}' WHERE id = 'p2test_wine_ok'`))
  await accepts('a wine linked at product grain only is accepted',
    () => prisma.$executeRawUnsafe(
      `UPDATE wines SET product_id = '${prod.id}', vintage_id = NULL WHERE id = 'p2test_wine_ok'`))
  await rejects('a wine with vintage_id but no product_id is rejected',
    () => prisma.$executeRawUnsafe(
      `UPDATE wines SET product_id = NULL, vintage_id = '${vintage.id}' WHERE id = 'p2test_wine_ok'`),
    'wines_catalog_link_check')
  await rejects("a wine pointing at a vintage of a DIFFERENT product is rejected",
    () => prisma.$executeRawUnsafe(
      `UPDATE wines SET product_id = '${otherProduct.id}', vintage_id = '${vintage.id}' WHERE id = 'p2test_wine_ok'`),
    'wines_vintage_id_product_id_fkey')

  // 🔒 A PURGE THAT FORGETS AN INBOUND WINE LINK MUST FAIL, NOT HALF-APPLY.
  // Phase 3 builds the staff hard-purge on top of this: the catalog-referencing
  // FKs are NoAction/Restrict precisely so a purge that misses a reference class
  // rolls back instead of stranding `wines.vintage_id` pointing at a deleted
  // row. Asserted here rather than in phase 1's suite because it only becomes
  // reachable once wines actually CARRY links — which is this phase.
  // Uses its OWN throwaway vintage rather than the shared `vintage` fixture —
  // this case DELETES its subject, and consuming a fixture other sections rely
  // on would make a future reordering fail for a reason unrelated to the thing
  // being tested.
  const doomed = await createVintage(prod.id, 1999, TEST_USER)
  await prisma.$executeRawUnsafe(
    `UPDATE wines SET product_id = '${prod.id}', vintage_id = '${doomed.id}' WHERE id = 'p2test_wine_ok'`)
  await rejects('deleting a vintage that a wine still references is BLOCKED',
    () => prisma.$executeRawUnsafe(`DELETE FROM wine_vintages WHERE id = '${doomed.id}'`),
    'wines_vintage_id_product_id_fkey')
  // Paired accept: once the wine releases the link, the delete is allowed —
  // proving the block is the LINK, not a blanket prohibition on deletion.
  await prisma.$executeRawUnsafe(
    `UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id = 'p2test_wine_ok'`)
  await accepts('once no wine references it, the vintage CAN be deleted',
    () => prisma.$executeRawUnsafe(`DELETE FROM wine_vintages WHERE id = '${doomed.id}'`))

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13 — nothing here is a find-or-create')
  // 🔒 THE INVARIANT EVERYTHING HANGS ON: an entry is created DISTINCT. Two
  // identical names must produce TWO rows, not one reused row. This is the
  // model failure that got PR #82's schema rejected, and the one a future
  // "helpful" optimization is most likely to reintroduce.
  const dupA = await createProducer({ name: 'P2TEST Identical Name' }, TEST_USER)
  const dupB = await createProducer({ name: 'P2TEST Identical Name' }, TEST_USER)
  ok(dupA.id !== dupB.id, 'two producers with the SAME name get two DISTINCT ids')
  const dupCount = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM producers WHERE name = 'P2TEST Identical Name'`)
  eq(dupCount[0].n, 2, 'both rows exist — the second was not silently merged into the first')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13b — every Redis→Postgres wine writer carries the link')
  // 🔒 The RFC names FOUR paths that write a `wines` row from Redis state —
  // "rate/visit archival, wine edits, BROUGHT-BY REASSIGNMENT, session archive"
  // — and requires all of them to carry both link fields verbatim. The reassign
  // path was found (by review, not by this suite) to omit them from its CREATE
  // arm, which is live: that function is an upsert precisely because the wines
  // row may not exist yet.
  //
  // Why it matters beyond tidiness: a row minted without the link is
  // INDISTINGUISHABLE from a legacy never-linked row, and phase 5's backfill
  // re-derives links for those from STRINGS — so an explicit user choice would
  // silently be replaced by a string match, which is the one thing the model
  // forbids.
  //
  // 🔒 EXECUTED, not inspected. An earlier version of this section read the
  // source for `productId:` because importing `lib/session.ts` pulls in
  // `lib/redis.ts`, whose client connects eagerly and retries forever — which
  // hung the suite against a Postgres-only environment. A reviewer showed why
  // that workaround was not good enough: it checks field NAMES, not VALUES, so
  // mutating `vintageId: wine.productId` (a real data-corrupting bug that
  // would violate the composite FK at runtime) passed green. The right fix was
  // to give CI a Redis service — it is one workflow block — rather than accept
  // a weaker assertion. Both writers are now driven for real.
  const { pgUpsertWine, pgReassignWineProvenance } = await import('../../lib/session.ts')
  await prisma.$executeRawUnsafe(`
    INSERT INTO sessions (code, host_name, created_at)
    VALUES ('P2TESTSS', 'P2 Host', now())
    ON CONFLICT (code) DO NOTHING`)
  const linkedWine = {
    id: 'p2test_wine_reassig', name: 'P2 Linked', producer: 'P2 Producer',
    vintage: '2019', grape: '', type: 'red', image: '', imageUrl: '',
    addedByIdentityId: 'u:1', addedByDisplayName: 'Someone',
    productId: prod.id, vintageId: vintage.id,
  }
  // The CREATE arm — no wines row exists yet, which is the exact case this
  // upsert exists for, and the arm that was found omitting the link.
  await prisma.$executeRawUnsafe(`DELETE FROM wines WHERE id = '${linkedWine.id}'`)
  await pgReassignWineProvenance('P2TESTSS', linkedWine)
  const reassigned = await prisma.$queryRawUnsafe(
    `SELECT product_id, vintage_id FROM wines WHERE id = '${linkedWine.id}'`)
  // 🔒 Asserts the VALUES, not merely that the columns are non-null — that is
  // what catches a transposition (vintageId written from wine.productId).
  eq(reassigned[0]?.product_id, prod.id, 'a reassign that CREATES the row stores the right productId')
  eq(reassigned[0]?.vintage_id, vintage.id, 'a reassign that CREATES the row stores the right vintageId')

  // pgUpsertWine, both arms.
  const archiveId = 'p2test_wine_archive'
  await prisma.$executeRawUnsafe(`DELETE FROM wines WHERE id = '${archiveId}'`)
  await pgUpsertWine('P2TESTSS', { ...linkedWine, id: archiveId })
  const created = await prisma.$queryRawUnsafe(
    `SELECT product_id, vintage_id FROM wines WHERE id = '${archiveId}'`)
  eq(created[0]?.product_id, prod.id, 'pgUpsertWine CREATE stores the right productId')
  eq(created[0]?.vintage_id, vintage.id, 'pgUpsertWine CREATE stores the right vintageId')
  // The UPDATE arm must carry it too — unlike provenance (frozen on purpose),
  // the link is deliberately MUTABLE, so a re-link or an identity-edit CLEAR
  // has to reach Postgres.
  await pgUpsertWine('P2TESTSS', { ...linkedWine, id: archiveId, productId: null, vintageId: null })
  const clearedRow = await prisma.$queryRawUnsafe(
    `SELECT product_id, vintage_id FROM wines WHERE id = '${archiveId}'`)
  eq(clearedRow[0]?.product_id, null,
    'pgUpsertWine UPDATE propagates a CLEARED link (the link is mutable, unlike provenance)')

  // ── D1: addWineToSession's round-trip, the trap its own comment names ─────
  //
  // 🔒 THIS FUNCTION IS THE ONLY SOURCE OF THE LINK THAT REACHES REDIS. The
  // PATCH route replaces the wine object wholesale and re-asserts only
  // provenance from the current list, so whatever this returns IS the stored
  // link. It had NO coverage: a reviewer mutated it to return `productId: null`
  // unconditionally — dropping every session-wine link on every create and
  // edit, i.e. the feature silently not working — and the suite stayed green.
  const { addWineToSession } = await import('../../lib/session.ts')
  const base = { name: 'RT Wine', type: 'red', producer: 'RT Producer', vintage: '2019' }
  const createdWine = await addWineToSession('P2TESTSS', { ...base, productId: prod.id, vintageId: vintage.id })
  eq(createdWine.productId, prod.id, 'create: the supplied productId round-trips')
  eq(createdWine.vintageId, vintage.id, 'create: the supplied vintageId round-trips')
  // A create with no link must store null, not undefined — the value is
  // mirrored straight into Postgres.
  const bare = await addWineToSession('P2TESTSS', base)
  eq(bare.productId, null, 'create without a link stores null')
  // 🔒 OMITTED means KEEP. This is the spelling the function's comment warns
  // about: `body.productId ?? existing?.productId` would behave identically
  // HERE but swallow a deliberate null below — so both cases are needed to pin
  // the semantics, and testing only one leaves the trap open.
  const kept = await addWineToSession('P2TESTSS', { ...base, description: 'x' }, createdWine)
  eq(kept.productId, prod.id, 'edit omitting the link KEEPS the stored productId')
  eq(kept.vintageId, vintage.id, 'edit omitting the link KEEPS the stored vintageId')
  // 🔒 EXPLICIT NULL means CLEAR — the case `??` would silently swallow.
  const clearedEdit = await addWineToSession(
    'P2TESTSS', { ...base, productId: null, vintageId: null }, createdWine)
  eq(clearedEdit.productId, null, 'edit with an explicit null CLEARS the link')
  // Re-link to a different product.
  const relinked = await addWineToSession(
    'P2TESTSS', { ...base, productId: otherProduct.id, vintageId: null }, createdWine)
  eq(relinked.productId, otherProduct.id, 'edit can RE-LINK to a different product')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13c — the catalog-link rate key is not rotatable by anon callers')
  // 🔒 An `a:<uuid>` anon identity is minted FRESH ON EVERY JOIN, and
  // /api/session/join calls resetRate on its own limiter on every SUCCESS — so
  // a caller holding one valid session code (trivially, one they created) can
  // rejoin in a loop and collect unlimited identities. A per-identity key
  // therefore bounded nothing for exactly the caller class it targeted:
  // measured, 20 rotated identities bought 20x the budget. Anonymous callers
  // are keyed on IP instead.
  const rotated = new Set(Array.from({ length: 20 }, (_, i) =>
    catalogLinkRateKey(`a:${i}-fresh-uuid-per-join`, '203.0.113.9')))
  ok(rotated.size === 1,
    `20 rotated anon identities from one IP share ONE key (got ${rotated.size})`)
  // 🔒 THE PAIRED NEGATIVE: logged-in callers must stay USER-keyed, or a
  // shared-NAT office would collapse into a single budget — the reason the
  // other catalog limiters are caller-keyed rather than IP-keyed.
  const sameIpUsers = new Set([
    catalogLinkRateKey('u:1', '203.0.113.9'),
    catalogLinkRateKey('u:2', '203.0.113.9'),
  ])
  ok(sameIpUsers.size === 2,
    'two logged-in users behind one IP keep SEPARATE keys (no shared-NAT collision)')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13e — the add-flow BRANCH DISPATCHER (the five RFC branches)')
  // 🔒 THE LARGEST UNTESTED SURFACE IN THE PHASE, and its absence hid a real
  // defect: branch selection tested "is this a non-empty string", so a
  // PRESENT-but-malformed `productId` silently failed that test and fell
  // THROUGH to the mint branches — creating a brand-new producer and product
  // instead of returning 400. Catalog rows are permanent (one ID for life), so
  // that duplicate then needs a curator to merge it away.
  //
  // Drives the REAL dispatcher, not a re-implementation of it.
  const { mintEntries } = await import('../../lib/catalogAddFlow.ts')
  const dispatchProducer = await createProducer({ name: 'P2TEST Dispatch Maker' }, TEST_USER)

  // Branch 4 — nothing matched: mints producer + product, both distinct.
  const b4 = await mintEntries(
    { producer: { name: 'P2TEST B4 Maker' }, product: { name: 'P2TEST B4 Wine' } }, TEST_USER)
  ok(!!b4.producerId && !!b4.productId && b4.vintageId === null,
    'branch 4 mints producer + product and links at PRODUCT grain when year is absent')
  // 🔒 vintageGrapes THROUGH THE REAL DISPATCHER. § 1d drives `createVintage`
  // directly, which cannot see whether `mintEntries` actually FORWARDS the
  // field — removing both forwarding arguments left all 200 tests green.
  const vgDisp = await mintEntries(
    { producer: { name: 'P2TEST VGD Maker' }, product: { name: 'P2TEST VGD Wine', grapes: ['Merlot'] },
      year: 2019, vintageGrapes: ['Syrah', 'Grenache'] }, TEST_USER)
  const vgRow = await prisma.wineVintage.findUnique({
    where: { id: vgDisp.vintageId }, select: { grapes: true, grapesOverride: true } })
  ok(vgRow.grapesOverride === true && vgRow.grapes.join(',') === 'Syrah,Grenache',
    'mintEntries FORWARDS vintageGrapes to the vintage (branch 3/4 wiring)')
  // Paired: the same call WITHOUT the field must inherit, so the assertion above
  // cannot pass by the override being set unconditionally.
  const vgDisp2 = await mintEntries(
    { producerId: vgDisp.producerId, productId: vgDisp.productId, year: 2020 }, TEST_USER)
  const vgRow2 = await prisma.wineVintage.findUnique({
    where: { id: vgDisp2.vintageId }, select: { grapes: true, grapesOverride: true } })
  ok(vgRow2.grapesOverride === false && vgRow2.grapes.length === 0,
    'omitting vintageGrapes through the dispatcher leaves the vintage inheriting')
  // 🔒 Branch 2 (existing product) forwards too — a separate call site.
  const vgDisp3 = await mintEntries(
    { producerId: vgDisp.producerId, productId: vgDisp.productId, year: 2021,
      vintageGrapes: ['Cinsault'] }, TEST_USER)
  const vgRow3 = await prisma.wineVintage.findUnique({
    where: { id: vgDisp3.vintageId }, select: { grapes: true, grapesOverride: true } })
  ok(vgRow3.grapesOverride === true && vgRow3.grapes.join(',') === 'Cinsault',
    'branch 2 (vintage under an EXISTING product) forwards vintageGrapes too')
  // Rejections: an override with nowhere to go, and a malformed authoritative list.
  await rejects('vintageGrapes without year',
    () => mintEntries({ producer: { name: 'P2TEST VGD X' }, product: { name: 'P2TEST VGD X Wine' },
                        vintageGrapes: ['Syrah'] }, TEST_USER), 'vintageGrapes requires year')
  await rejects('a malformed vintageGrapes element',
    () => mintEntries({ producerId: vgDisp.producerId, productId: vgDisp.productId, year: 2022,
                        vintageGrapes: [123] }, TEST_USER), 'must be a string')
  await rejects('a blank vintageGrapes element',
    () => mintEntries({ producerId: vgDisp.producerId, productId: vgDisp.productId, year: 2023,
                        vintageGrapes: ['   '] }, TEST_USER), 'must not be blank')

  // Branch 3 — existing producer, new product.
  const b3 = await mintEntries(
    { producerId: dispatchProducer.id, product: { name: 'P2TEST B3 Wine' }, year: 2020 }, TEST_USER)
  ok(b3.producerId === dispatchProducer.id && !!b3.vintageId,
    'branch 3 reuses the chosen producer and mints the vintage')
  // Branch 2 — existing product, missing vintage.
  const b2 = await mintEntries({ productId: b3.productId, year: 2021 }, TEST_USER)
  ok(b2.productId === b3.productId && b2.vintageId !== b3.vintageId,
    'branch 2 adds a vintage under the existing product without minting a product')
  // 🔒 year: null is the NV row, NOT "unknown" — the distinction the route
  // header calls the single easiest thing to get wrong here.
  const bNV = await mintEntries({ productId: b3.productId, year: null }, TEST_USER)
  ok(!!bNV.vintageId, 'branch 2 with year:null mints the NON-VINTAGE row')
  const nvYear = await prisma.$queryRawUnsafe(
    `SELECT year FROM wine_vintages WHERE id = '${bNV.vintageId}'`)
  eq(nvYear[0].year, null, 'and that row really has year NULL (the NV instance)')
  // Branch 5 — collaboration, set at creation.
  const b5 = await mintEntries(
    { producerId: dispatchProducer.id, product: { name: 'P2TEST B5 Joint' },
      collaboratorIds: [b4.producerId] }, TEST_USER)
  const b5Roles = await prisma.$queryRawUnsafe(
    `SELECT role FROM product_producers WHERE product_id = '${b5.productId}' ORDER BY role`)
  eq(b5Roles.map(r => r.role), ['collaborator', 'lead'],
    'branch 5 sets lead + collaborator AT CREATION')

  // 🔒 MALFORMED IDS ARE REJECTED, NOT ROUTED ELSEWHERE. Each of these
  // previously fell through to a mint branch and created rows.
  const beforeMint = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM producers WHERE name LIKE 'P2TEST Fallthrough%'`)
  await rejects('a numeric productId is rejected, not fallen through to branch 4',
    () => mintEntries(
      { productId: 123, producer: { name: 'P2TEST Fallthrough Maker' },
        product: { name: 'P2TEST Fallthrough Wine' } }, TEST_USER),
    'productId must be a non-empty string')
  await rejects('a numeric producerId is rejected, not fallen through to branch 4',
    () => mintEntries(
      { producerId: 99, producer: { name: 'P2TEST Fallthrough Maker' },
        product: { name: 'P2TEST Fallthrough Wine' } }, TEST_USER),
    'producerId must be a non-empty string')
  await rejects('a malformed collaboratorIds entry is rejected, not silently dropped',
    () => mintEntries(
      { producerId: dispatchProducer.id, product: { name: 'P2TEST Bad Collab' },
        collaboratorIds: [dispatchProducer.id, 42] }, TEST_USER),
    'collaboratorIds must all be non-empty strings')
  // 🔒 THE PAIRED STATE CHECK — verifies what the statements DID, not just that
  // they threw: nothing was minted by any of the three rejections.
  const afterMint = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM producers WHERE name LIKE 'P2TEST Fallthrough%'`)
  eq(afterMint[0].n, beforeMint[0].n, 'and NO rows were minted by the rejected requests')
  // Branch 2 requires a year — omitting it is a different request (product-grain
  // link), not a vintage add.
  await rejects('branch 2 without a year is rejected',
    () => mintEntries({ productId: b3.productId }, TEST_USER),
    'year is required when adding a vintage')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13d — the release fence (lib/catalogGate.ts)')
  // 🔒 THE PHASE-2/PHASE-3 RELEASE BOUNDARY, and it was entirely untested.
  // Phase 2 lets users mint catalog entries; phase 3 builds the review queue
  // that confirms/merges/rejects them. An unreviewed provisional is a valid
  // steady state; publicly-writable content with no moderation path is not. So
  // the switch must default CLOSED, and a regression flipping that default open
  // would silently ship exactly the state the boundary exists to prevent.
  const { catalogPublicEnabled, canUseCatalog } = await import('../../lib/catalogGate.ts')
  const prevFlag = process.env.CATALOG_PUBLIC_ENABLED
  try {
    delete process.env.CATALOG_PUBLIC_ENABLED
    ok(catalogPublicEnabled() === false, 'UNSET defaults to CLOSED')
    ok((await canUseCatalog(null)) === false, 'an anonymous caller is refused while closed')
    ok((await canUseCatalog(TEST_USER)) === false,
      'an ordinary logged-in user is refused while closed')
    // 🔒 Only the exact string 'true' opens it — a truthy-ish value must not.
    for (const v of ['1', 'yes', 'TRUE', 'True', '']) {
      process.env.CATALOG_PUBLIC_ENABLED = v
      ok(catalogPublicEnabled() === false, `CATALOG_PUBLIC_ENABLED=${JSON.stringify(v)} stays CLOSED`)
    }
    process.env.CATALOG_PUBLIC_ENABLED = 'true'
    ok(catalogPublicEnabled() === true, "CATALOG_PUBLIC_ENABLED='true' opens it (the paired accept)")
    ok((await canUseCatalog(null)) === true, 'and an anonymous caller then passes')
    // The staff bypass: a curator reaches the flow while the fence is closed,
    // which is what makes dogfooding and matcher tuning possible pre-release.
    delete process.env.CATALOG_PUBLIC_ENABLED
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_roles (user_id, role) VALUES (${TEST_USER}, 'curator')
       ON CONFLICT (user_id) DO UPDATE SET role = 'curator'`)
    ok((await canUseCatalog(TEST_USER)) === true,
      'a CURATOR bypasses the closed fence (dogfooding path)')
    await prisma.$executeRawUnsafe(`DELETE FROM staff_roles WHERE user_id = ${TEST_USER}`)
    ok((await canUseCatalog(TEST_USER)) === false,
      'and loses access the moment the grant is revoked (no caching)')
  } finally {
    if (prevFlag === undefined) delete process.env.CATALOG_PUBLIC_ENABLED
    else process.env.CATALOG_PUBLIC_ENABLED = prevFlag
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 13f — the unscoped product path is still reachable internally')
  // 🔒 The PUBLIC route now REQUIRES producerId (app/api/catalog/search): at
  // 500k rows the unscoped product search ran ~1.15 s median and 31 of 50
  // concurrent requests failed on pool exhaustion, while the SAME search scoped
  // by producer ran ~15 ms p95 and stayed flat from 60k to 500k. Requiring the
  // scope removes the expensive shape instead of optimising it.
  //
  // But `searchProducts` itself must KEEP working unscoped — the phase-3 review
  // queue is legitimately global (a curator hunting duplicates has no producer
  // to scope by) and is staff-gated and low-volume. Asserting this pins that the
  // restriction lives at the ROUTE, not in the matcher, so phase 3 does not
  // find the capability quietly removed.
  ok((await searchProducts('Grand Vin')).length > 0,
    'searchProducts still supports an UNSCOPED search for the phase-3 review queue')

  // 🔒 THE PUBLIC ROUTE'S producerId REQUIREMENT — asserted STRUCTURALLY,
  // because it is the guard that prevents the measured pool-exhaustion shape
  // and removing it left every other assertion green.
  //
  // At 500k rows an unscoped public product search ran ~1.15 s median and 31 of
  // 50 concurrent requests failed outright on pool exhaustion; the same search
  // scoped by producer ran ~15 ms p95 and stayed flat from 60k. The route is a
  // thin auth/rate-limit wrapper, so driving it here would mean standing up
  // NextRequest + session plumbing; reading its source for the guard is the
  // proportionate check, and it fails loudly if the guard is deleted or if the
  // handler is renamed.
  const searchRouteSrc = readFileSync(
    join(REPO_ROOT, 'app/api/catalog/search/route.ts'), 'utf8')
  const productBranch = searchRouteSrc.slice(searchRouteSrc.indexOf("kind === 'product'"))
  ok(/if \(!producerId\)/.test(productBranch)
     && /status:\s*400/.test(productBranch.slice(0, productBranch.indexOf('searchProducts('))),
    'the PUBLIC product route rejects a missing producerId with a 400 before searching')
  // Paired positive: the guard must not have been implemented by removing the
  // capability — the route still calls searchProducts once scoped.
  ok(productBranch.includes('searchProducts(q, { producerId })'),
    'and still performs the scoped search when producerId IS supplied')

  // 🔒 THE EQUALITY PATH MUST PLAN AS AN INDEX ONLY SCAN, and this asserts the
  // PLANNER'S CHOICE rather than a forced one. A forced-index benchmark showed
  // a bare B-tree could do this in 0.10 ms — but with that index actually
  // present the planner kept choosing GiST for the real query (0.544 ms, 130
  // buffers), because a bare B-tree still needs a heap fetch for id/status.
  // Only the COVERING index wins on its own: 0.125 ms, 4 buffers, zero heap
  // fetches. Asserting "some index exists" would have passed throughout.
  //
  // This is `findProducerByExactName`'s query — the phase-5 legacy backfill's
  // only sanctioned matcher, so its plan is load-bearing at 500k+ rows.
  const eqPlan = await planFor(
    `SELECT id, status FROM producers
      WHERE name_folded = catalog_fold_v1('P2TEST Cuvée № 5')
        AND status IN ('provisional','confirmed') ORDER BY id`)
  ok(eqPlan.includes('"Node Type":"Index Only Scan"')
     && eqPlan.includes('producers_name_folded_idx'),
    `exact-name equality plans as an INDEX ONLY SCAN on the covering index${
      eqPlan.includes('producers_name_folded_idx') ? '' : ` (planned: ${eqPlan.slice(0, 260)})`}`)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 14 — a failed mint leaves no orphan producer')
  // 🔒 Add-branch 4 mints producer AND product together. If the product fails,
  // the producer must roll back with it: the review queue's unit is the
  // producer/PRODUCT grain, so a producer with no product is a row nothing will
  // ever surface for review, confirm, or reject — invisible junk that
  // accumulates silently. This is why the branch runs in one transaction.
  const beforeCount = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM producers WHERE name LIKE 'P2TEST Orphan%'`)
  try {
    await prisma.$transaction(async tx => {
      const p = await createProducer({ name: 'P2TEST Orphan Candidate' }, TEST_USER, tx)
      // A blank product name fails validation — standing in for any mid-mint
      // failure (bad style FK, constraint violation, lost connection).
      await createProduct({ name: '', producerId: p.id }, TEST_USER, [], tx)
    })
    ok(false, 'the failing mint should not have committed')
  } catch (e) {
    ok(String(e?.message).includes('product name is required'),
      'the mint fails for the expected reason')
  }
  const afterCount = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM producers WHERE name LIKE 'P2TEST Orphan%'`)
  eq(afterCount[0].n, beforeCount[0].n,
    'the producer rolled back with the failed product — no orphan left behind')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n§ 15 — everything user-minted starts provisional')
  const statuses = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT status FROM producers WHERE id IN ('${dupA.id}', '${dupB.id}', '${survivor.id}')`)
  eq(statuses, [{ status: 'provisional' }], 'user-minted producers are provisional, never confirmed')
  const pStatus = await prisma.$queryRawUnsafe(
    `SELECT status, added_by FROM wine_products WHERE id = '${prod.id}'`)
  eq(pStatus[0].status, 'provisional', 'user-minted products are provisional')
  eq(pStatus[0].added_by, TEST_USER, 'addedBy records who minted it')

  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
  .catch(e => {
    // 🔒 A CRASH MUST STILL PRODUCE A REPORT. Some regressions don't fail an
    // assertion — they blow up a FIXTURE step (e.g. removing the lead-producer
    // link makes the deferred trigger reject the setup itself), and the run
    // then dies before printing anything. Phase 1 hit exactly that: a dropped
    // trigger surfaced as an EMPTY REPORT rather than a red test, which reads
    // like "nothing ran" instead of "something broke". So print the tally
    // reached so far, and say plainly that the suite aborted.
    console.error('\n💥 the suite ABORTED before completing:\n')
    console.error(e)
    console.log(`\n${pass} passed, ${failures.length} failed, ABORTED before the rest could run`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await reset().catch(() => {})
    await prisma.$disconnect()
    // ⚠️ EXPLICIT EXIT. § 13b imports lib/session.ts, which pulls in
    // lib/redis.ts — a module-level client that connects eagerly and keeps an
    // open handle. Without closing it the process stays alive after the last
    // assertion and CI hangs to its step timeout, reporting a failure for a
    // suite that actually passed. Quit on the tally rather than trying to
    // unwind every module-level singleton.
    try {
      const { redis } = await import('../../lib/redis.ts')
      if (redis?.isOpen) await redis.quit()
    } catch { /* redis not imported by this run — nothing to close */ }
    process.exit(process.exitCode ?? 0)
  })
