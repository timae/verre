-- Wine catalog — add GiST trigram indexes for KNN (nearest-neighbour) search.
--
-- 🔒 WHY. The GIN `<%` form was correct and DID use its index, but `<%` at
-- threshold 0.3 is NOT SELECTIVE: the candidate count scales 1:1 with the
-- catalog. Measured on PG16 against a seeded catalog:
--
--   • a "selective" multi-word producer name still admitted 25,691 rows
--     (8.5% of a 300k catalog);
--   • the cost was the HEAP RECHECK over those rows, not the index probe —
--     22 ms of a 163 ms query, and removing the scoring changed nothing;
--   • so latency grew LINEARLY with catalog size: producer search went
--     34 ms (60k) → 62 ms (150k) → 352 ms (300k).
--
-- Under concurrency it stopped being slow and became an outage: at 300k rows,
-- 50 concurrent searches produced 15 hard failures (pool timeouts) and 100
-- concurrent produced 66. Raising the pool did not help — it was CPU
-- saturation, compounded by each search holding an INTERACTIVE TRANSACTION for
-- its whole duration (needed to hold `SET LOCAL pg_trgm.word_similarity_
-- threshold`), pinning a connection per in-flight search.
--
-- A GiST KNN scan returns the nearest N rows straight from the index, so cost
-- is bounded by the LIMIT rather than by the match count. Measured on the same
-- fixture, broad query "chateau": GIN ~22 ms → GiST KNN ~0.26 ms, as a clean
-- `Index Scan … Order By: (name_folded <->> 'chateau')` with no bitmap, no
-- sort, and no recheck.
--
-- ⚠️ OPERATOR AND OPERAND ORDER MUST MATCH — and the operator alone is not the
-- rule. `<->>` and `<<->` are declared COMMUTATORS (pg_operator), so the
-- planner rewrites one into the other; what must line up is which side the
-- COLUMN is on. Measured on a 60k fixture:
--
--   column <->> query   Index Scan    ~4.9 ms   ← this migration's form
--   query  <<-> column  Index Scan    ~4.9 ms   ← the commutator, equally fine
--   column <<-> query   Seq Scan + Sort ~116 ms over 60,001 rows
--   query  <->> column  Seq Scan + Sort
--
-- The mismatched pairings return CORRECT ROWS from a full table scan, so this
-- never fails visibly — the same operand-order trap the GIN `<%`/`%>` pair had.
--
-- 🔒 SEMANTICS ARE UNCHANGED. `<->>` is exactly `1 - word_similarity`, the
-- identical metric the previous query sorted on — verified numerically:
-- 'chateu margux' vs 'Château Margaux' gives word_similarity 0.5294 and
-- distance 0.4706, and that typo still ranks the real producer FIRST (0.529)
-- ahead of the noise (0.357). The 0.3 threshold is now applied as a post-filter
-- on the handful of rows KNN returns, which preserves the "no bad matches"
-- guarantee while removing the GUC — and with it the interactive transaction.
--
-- 🔒 THE GIN INDEXES ARE REPLACED BY B-TREES, not kept. An earlier draft kept
-- GIN "for equality" (`findProducerByExactName`, the phase-5 backfill's only
-- sanctioned matcher). That reasoning does not survive measurement: a trigram
-- index is the wrong structure for `=`, and Postgres documents a plain B-tree
-- as more efficient for equality. Measured on this schema, folded-equality
-- lookup with each index forced:
--
--   B-tree   0.10 ms    2.7 MB
--   GiST     0.78 ms    8.0 MB
--   GIN      1.08 ms    8.9 MB
--
-- So GIN was 10x slower than a B-tree at 3x the size, for the one operation it
-- was being retained for. Nothing in the codebase issues a `%`/containment
-- query (grep-verified across lib/, app/, scripts/), so there is no live GIN
-- consumer at all — keeping it would be pure write amplification. If a
-- containment query is ever added, re-add GIN then, deliberately.
--
-- GiST costs ~2x a B-tree in size and more write maintenance; that is accepted
-- for the KNN ordering, whose alternative was a linear-in-catalog-size scan.
--
-- 🔒 EXPLICITLY TRANSACTIONAL. An earlier draft of this file claimed an
-- index-only migration "leaves nothing half-applied" and skipped BEGIN/COMMIT.
-- That is FALSE, and it was verified false: with two ordinary CREATE INDEX
-- statements and a failure on the second, the FIRST INDEX STAYED COMMITTED.
-- Prisma does not wrap migration files in a transaction — it is opt-in — so
-- without this a partial failure would leave production with one index present
-- and one missing, i.e. one search path fast and the other silently scanning.
--
-- ⚠️ ORDINARY `CREATE INDEX` TAKES A WRITE LOCK for the duration of the build.
-- That is acceptable ONLY because the catalog tables are empty today (phase 2
-- is gated off), which makes the build instantaneous. Measured for scale: a
-- GiST build over 500k rows takes ~6 s, and it would block writes for that
-- whole time. 🔒 If this ever needs applying to a POPULATED catalog, do NOT
-- reuse this file — use `CREATE INDEX CONCURRENTLY`, which cannot run inside a
-- transaction and therefore needs its own separately-planned deployment with a
-- `lock_timeout` and a rollback procedure.

BEGIN;

-- 📋 OPERATOR STEP FIRST: confirm both catalog tables are empty and no
-- long-running transaction is touching them — `docs/dev/deployment.md`
-- § PRE-DEPLOY CHECK. The assertion below is the BACKSTOP for a skipped
-- check, not a substitute: it fires at DEPLOY time, which costs a failed
-- release and a P3009-blocked pipeline.
--
-- 🔒 ENFORCED PREFLIGHT, not a note to the operator. The empty-table
-- assumption above is what makes the plain CREATE INDEX safe, so it is
-- asserted here rather than left to whoever runs the deploy. The lock is taken
-- BEFORE the check so a concurrent insert cannot land between the assertion and
-- the DDL.
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
      'catalog is not empty (producers=%, wine_products=%) — this migration performs SIX index operations under ACCESS EXCLUSIVE and would block writes for the entire build. The duration on a populated table is UNMEASURED. Use CREATE INDEX CONCURRENTLY in a separately-planned deployment (see docs/dev/deployment.md, PRE-DEPLOY CHECK).',
      n_prod, n_wp;
  END IF;
END $$;

CREATE INDEX "producers_name_folded_gist_idx"
  ON "producers" USING gist ("name_folded" gist_trgm_ops);

CREATE INDEX "wine_products_name_folded_gist_idx"
  ON "wine_products" USING gist ("name_folded" gist_trgm_ops);

-- Equality lookups (findProducerByExactName / the phase-5 legacy backfill).
--
-- 🔒 COVERING, not a bare B-tree on name_folded — and the difference is the
-- whole point. A bare B-tree still needs a heap fetch for `id`/`status`, which
-- made it look no better than GiST to the planner: measured on a 60k fixture,
-- the REAL query kept choosing GiST (0.544 ms, 130 buffers) even with the
-- B-tree present. Including the columns the query actually returns turns it
-- into an INDEX ONLY SCAN with ZERO heap fetches — 0.125 ms and 4 buffers.
--
-- ⚠️ This is why a forced-index benchmark is not sufficient evidence: forcing
-- proved the B-tree COULD be fast, while the planner went on choosing GiST for
-- the query as written. The shipped index has to win on its own.
DROP INDEX "producers_name_folded_trgm_idx";
DROP INDEX "wine_products_name_folded_trgm_idx";
CREATE INDEX "producers_name_folded_idx"
  ON "producers" ("name_folded", "id") INCLUDE ("status");
CREATE INDEX "wine_products_name_folded_idx"
  ON "wine_products" ("name_folded", "id") INCLUDE ("status");

COMMIT;
