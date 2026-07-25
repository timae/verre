-- Wine catalog — fix the fold ORDER: lower LAST, not first.
--
-- 🔒 THE DEFECT. `f_unaccent(text)` is `unaccent(...)` with no `lower()`, and
-- the phase-1 generated columns call `f_unaccent(lower(col))` — i.e. they
-- lowercase BEFORE unaccenting. Some unaccent expansions PRODUCE CAPITALS, so
-- lowercasing first lets uppercase survive into the supposedly-folded value.
-- Verified on this schema (PG16):
--
--   f_unaccent(lower('Toro Loco®'))  →  'toro loco(R)'    ← capital R survives
--   lower(f_unaccent('Toro Loco®'))  →  'toro loco(r)'
--   f_unaccent(lower('Cuvée № 5'))   →  'cuvee No 5'      ← capital N survives
--   lower(f_unaccent('Cuvée № 5'))   →  'cuvee no 5'
--
-- So the folded columns are NOT fully case-folded, which is the one job a fold
-- has. The concrete failure, also verified — two spellings of the same wine:
--
--   f_unaccent(lower('Cuvée № 5')) = f_unaccent(lower('Cuvee No 5'))  →  FALSE
--   lower(f_unaccent('Cuvée № 5')) = lower(f_unaccent('Cuvee No 5'))  →  TRUE
--
-- ⚠️ Scope, stated precisely so this isn't over- or under-read: TRIGRAM SEARCH
-- IS UNAFFECTED — pg_trgm lowercases internally, so `%>`/`<%` and
-- word_similarity() already behaved. What breaks is every EXACT-EQUALITY,
-- prefix, or dedupe comparison ON A FOLDED COLUMN: those are case-sensitive
-- today and treat the two spellings above as distinct entries. That directly
-- hits `findProducerByExactName` (lib/catalogSearch.ts) and, more importantly,
-- the phase-5 LEGACY BACKFILL, which is exact-match-only by design (RFC
-- § Legacy backfill) — a fold that silently fails to match is precisely the
-- thing that would leave rows unlinked forever, or split one identity in two.
--
-- 🔒 WHY NOW. This is a generated-column expression change, so it REWRITES all
-- five folded columns. The catalog tables are empty (phase 2 is gated off and
-- nothing has been imported), so the rewrite is free. After the first fill it
-- is an expensive, locking rewrite of the largest tables in the schema. Cheap
-- now, costly later — so it lands before the first catalog fill.
--
-- ⚠️ DEPLOY NOTE — read before merging this to `main`. Deplo.io runs
-- `prisma migrate deploy` automatically on deploy, so MERGE == APPLY. That is
-- safe here only while `producers` and `wine_products` are EMPTY: this drops
-- and re-adds columns, which takes an ACCESS EXCLUSIVE lock and rewrites the
-- table. Confirm both are empty in the target environment before merging
-- (`SELECT count(*) FROM producers; SELECT count(*) FROM wine_products;`). If
-- either is populated, this needs a maintenance window, not an ordinary deploy.
-- No other table is touched, and no `wines` row is modified — the wines link
-- columns are ordinary nullable columns, not generated ones.
--
-- Implementation note: a generated column's expression cannot be ALTERed in
-- place, so each is DROPped and re-ADDed. Dropping a column takes its indexes
-- with it, hence the trgm GIN indexes are recreated below — omitting that
-- would silently return the catalog search to a seq scan, which is the
-- documented never-fails-visibly trap (see the phase-1 migration § 3).

-- 🔒 EXPLICITLY TRANSACTIONAL. Prisma runs each migration file WITHOUT wrapping
-- it in a transaction — that is opt-in, by writing BEGIN/COMMIT yourself (the
-- same thing `20260514193014_rewire_phase1_5_partial_unique` and
-- `20260515011038_rewire_phase2_data` do in this repo). Without it, this file
-- replaces a function, drops five generated columns and two indexes, then
-- recreates them across separate statements — so a failure part-way through
-- would COMMIT the drops and leave production with columns and indexes missing
-- while the previous release keeps serving traffic. The "a failed migration
-- fails the deploy" story protects the RELEASE, not the DATABASE. All of this
-- is DDL, which Postgres executes transactionally, so the whole file either
-- applies or leaves the schema untouched.
BEGIN;

-- 📋 OPERATOR STEP FIRST: confirm both catalog tables are empty and no
-- long-running transaction is touching them — `docs/dev/deployment.md`
-- § PRE-DEPLOY CHECK. The assertion below is the BACKSTOP for a skipped
-- check, not a substitute: it fires at DEPLOY time, which costs a failed
-- release and a P3009-blocked pipeline.
--
-- 🔒 ENFORCED PREFLIGHT — the empty-table assumption is CHECKED, not merely
-- documented above. This file drops and re-adds five generated columns, which
-- takes an ACCESS EXCLUSIVE lock and rewrites the table; that is free on an
-- empty catalog and an outage on a populated one. Telling the operator to run
-- a count first is not a control — a stale check, a forgotten step, or a row
-- inserted between the check and the deploy all defeat it. The lock is taken
-- BEFORE the assertion so nothing can land in between.
--
-- If this ever needs to run against a populated catalog it needs its own
-- maintenance plan: measured rewrite time, a `lock_timeout`, a verified
-- backup/restore, and a rollback procedure. Failing loudly here is what forces
-- that conversation instead of discovering it during a deploy.
-- 🔒 `lock_timeout` BEFORE the LOCK, or a stale reader hangs the deploy
-- INDEFINITELY. Verified: holding an ordinary read lock on `producers` left the
-- migration blocked until it was killed externally. The application's
-- `statement_timeout` does NOT apply here — `prisma migrate deploy` runs
-- outside the app's connection settings — so the fence has to be in this file.
-- A short timeout bounds the DATABASE side — the migration aborts and rolls
-- back instead of holding a lock queue open indefinitely. ⚠️ It does NOT make
-- the deploy self-recovering, and it does not name the cause: see the runbook
-- immediately below, which is what a blocked deploy actually needs.
--
-- ⚠️ IF THE LOCK TIMEOUT FIRES, THE DEPLOY IS BLOCKED UNTIL SOMEONE RUNS ONE
-- COMMAND — the schema is safe, the pipeline is not. Verified end-to-end:
--
--   1. The blocked deploy fails with a GENERIC "current transaction is aborted",
--      NOT the lock-timeout message. Don't hunt for the real cause in that
--      output — find what holds a LOCK on `producers` / `wine_products`.
--      That query must join pg_locks: a plain pg_stat_activity age filter
--      answers "what is old?", not "what touches the catalog", and returns
--      unrelated transactions. Exact query: docs/dev/deployment.md
--      § PRE-DEPLOY CHECK.
--   2. Prisma RECORDS THE MIGRATION AS FAILED. Every later deploy then aborts
--      with **P3009** ("found failed migrations") — including after the
--      blocking reader is long gone. This does not self-heal.
--   3. Recovery, after clearing the blocker:
--
--        npx prisma migrate resolve --rolled-back <this_migration_name>
--        npx prisma migrate deploy
--
--      Verified: the schema is UNDAMAGED (the BEGIN/COMMIT rolled everything
--      back), and the redeploy applies cleanly.
--
-- `--rolled-back` is correct here precisely BECAUSE this file is transactional:
-- nothing partially applied, so telling Prisma it rolled back is the truth.
-- ⚠️ Never use `--applied` — that would mark the work done without doing it.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "producers", "wine_products" IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE n_prod bigint; n_wp bigint;
BEGIN
  SELECT count(*) INTO n_prod FROM public."producers";
  SELECT count(*) INTO n_wp   FROM public."wine_products";
  IF n_prod > 0 OR n_wp > 0 THEN
    RAISE EXCEPTION
      'catalog is not empty (producers=%, wine_products=%) — dropping and re-adding the generated columns rewrites both tables under ACCESS EXCLUSIVE. Schedule this as a maintenance migration with a measured rewrite window, lock_timeout, verified backup, and a rollback plan.',
      n_prod, n_wp;
  END IF;
END $$;

-- ── 1. The array helper folds last too ─────────────────────────────────────
--
-- Same ordering bug, same fix. STRICT + the COALESCE are preserved verbatim:
-- NULL in → NULL out, and {} folds to {} rather than NULL (array_agg over zero
-- rows returns NULL), so "no grapes recorded" stays distinguishable from
-- unknown at the matching layer.
CREATE OR REPLACE FUNCTION f_unaccent_arr(text[]) RETURNS text[] AS $$
  SELECT COALESCE(array_agg(lower(f_unaccent(elem)) ORDER BY ord), '{}'::text[])
  FROM unnest($1) WITH ORDINALITY AS t(elem, ord)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- ── 2. Re-generate the folded columns with the corrected order ─────────────
ALTER TABLE "producers"
  DROP COLUMN "name_folded",
  DROP COLUMN "region_folded";

ALTER TABLE "producers"
  ADD COLUMN "name_folded"   text GENERATED ALWAYS AS (lower(f_unaccent("name")))   STORED,
  ADD COLUMN "region_folded" text GENERATED ALWAYS AS (lower(f_unaccent("region"))) STORED;

ALTER TABLE "wine_products"
  DROP COLUMN "name_folded",
  DROP COLUMN "region_folded",
  DROP COLUMN "grapes_folded";

ALTER TABLE "wine_products"
  ADD COLUMN "name_folded"   text   GENERATED ALWAYS AS (lower(f_unaccent("name")))   STORED,
  ADD COLUMN "region_folded" text   GENERATED ALWAYS AS (lower(f_unaccent("region"))) STORED,
  ADD COLUMN "grapes_folded" text[] GENERATED ALWAYS AS (f_unaccent_arr("grapes"))    STORED;

-- ── 3. Recreate the trgm GIN indexes the column drops removed ──────────────
--
-- 🔒 NOT OPTIONAL, and its absence would not fail visibly: without these the
-- catalog search still returns CORRECT ROWS and merely seq-scans the whole
-- catalog. Identical definitions to the phase-1 migration § 3; the query form
-- that uses them is documented there and in lib/catalogSearch.ts.
CREATE INDEX "producers_name_folded_trgm_idx"
  ON "producers" USING gin ("name_folded" gin_trgm_ops);
CREATE INDEX "wine_products_name_folded_trgm_idx"
  ON "wine_products" USING gin ("name_folded" gin_trgm_ops);

COMMIT;
