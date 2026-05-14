-- Rewire phase 1.5 — partial-unique swap on ratings + nullable score.
--
-- See docs/dev/proposals/rewire.md §6 phase 1.5. Three coupled changes that
-- MUST land together (otherwise either no constraint exists between the
-- old DROP and the new CREATE, or the new rate-endpoint SQL has nothing
-- to use as an ON CONFLICT arbiter):
--
--   1. Inter-deploy backfill: catch any in-session rating rows that the
--      old endpoint wrote (between phase 1 going live and this migration
--      applying) without a session_id. Wines' session_id is the source
--      of truth — copy it across.
--   2. Drop the old @@unique([wineId, userId]) — its consumers in the
--      rate endpoint are gone in this PR.
--   3. Add the new partial unique on (user_id, wine_id, session_id)
--      WHERE session_id IS NOT NULL AND user_id IS NOT NULL. The
--      `user_id IS NOT NULL` clause is load-bearing — Postgres treats
--      NULLs as distinct, so without it anon two-tab races wouldn't
--      be constrained. (Anon ratings have user_id NULL; the partial
--      excludes them — anon two-anons-rate-same-wine collisions can't
--      happen anyway because anon ratings don't share an identity.)
--   4. ALTER TABLE ratings ALTER COLUMN score DROP NOT NULL — chips-only
--      and notes-only rating rows have no score (rewire.md §2 / §3).
--
-- Prisma wraps every migration in a transaction; the explicit BEGIN/COMMIT
-- below is belt-and-suspenders for the proposal's "must not split DROP and
-- CREATE across migrations" rule. Expect a Postgres NOTICE during apply
-- ("there is already a transaction in progress") — harmless, the inner
-- BEGIN is a no-op.
--
-- DEPLOY PROTOCOL (read before merging this PR):
--
-- The new rate endpoint emits raw `INSERT ... ON CONFLICT (user_id,
-- wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS
-- NOT NULL`, which Postgres can resolve ONLY once the partial unique
-- this migration creates exists. The OLD rate endpoint (the previous
-- release) uses Prisma's compound-key `ON CONFLICT (wine_id, user_id)`
-- with no WHERE predicate — which has NO arbiter once this migration
-- drops the old unique. Result: any old pod that serves a rate POST
-- after the migration applies but before it has been replaced by a
-- new pod returns 500 (Postgres 42P10: "no unique or exclusion
-- constraint matching the ON CONFLICT specification").
--
-- Deploio's default rollout is build → deploy job (this migration) →
-- rolling pod replacement. There is therefore a window where old pods
-- serve against the new schema. To eliminate the window:
--
--   1. In Cockpit, scale the project replicas to 0 BEFORE pushing this
--      PR's merge commit — no in-flight requests during the migration.
--   2. Merge to main. Deploio builds, runs this migration, brings up
--      new pods.
--   3. Verify the new release is healthy. Scale replicas back up.
--
-- Tim+Simon scale ⇒ a few minutes of downtime is fine. Skip this only
-- if a future Deploio config gives atomic migration + cutover.
--
-- ROLLBACK (if the migration applies but the new code mis-behaves):
--   CREATE UNIQUE INDEX "ratings_wine_id_user_id_key"
--       ON "ratings" ("wine_id", "user_id");
--   DROP INDEX "ratings_user_id_wine_id_session_id_key";
--   ALTER TABLE "ratings" ALTER COLUMN "score" SET NOT NULL;
-- The score-NOT-NULL restore FAILS if any chips-only (NULL-score) row
-- was inserted between the migration apply and the rollback. Take a
-- pg_dump before merging, so the answer to "is it still recoverable"
-- never depends on "did anyone rate during the window."

BEGIN;

------------------------------------------------------------------------
-- 1. Inter-deploy backfill
--    Catches in-session ratings written between the phase-1 deploy and
--    this migration applying: the old rate endpoint did not write
--    session_id (only the phase 1.5 refactor does), so any rating row
--    inserted during that window has session_id IS NULL even though the
--    wine has one. Copy from wines.session_id which is the source of
--    truth for in-session wines. Orphaned wines (session_id IS NULL)
--    leave the rating's session_id NULL too — correct (those are
--    standalone-ish leftovers from deleted sessions).
------------------------------------------------------------------------

UPDATE "ratings" r
   SET "session_id" = w."session_id"
  FROM "wines" w
 WHERE r."session_id" IS NULL
   AND r."wine_id" = w."id"
   AND w."session_id" IS NOT NULL;

------------------------------------------------------------------------
-- 2. Drop the old @@unique([wineId, userId])
--    Prod's Postgres materialises @@unique as a table CONSTRAINT (the
--    backing index shares the constraint's name). DROP INDEX on a
--    constraint-backed index errors ("cannot drop index ... because
--    constraint ... requires it") — must drop the constraint instead,
--    which removes the backing index automatically.
--
--    Some older databases materialise the same @@unique as a bare
--    unique index with no constraint row; ALTER TABLE DROP CONSTRAINT
--    IF EXISTS handles both shapes idempotently.
------------------------------------------------------------------------

ALTER TABLE "ratings" DROP CONSTRAINT IF EXISTS "ratings_wine_id_user_id_key";
DROP INDEX IF EXISTS "ratings_wine_id_user_id_key";

------------------------------------------------------------------------
-- 3. Create the new partial unique
--    Postgres treats every column in a partial index as part of the
--    arbiter — the rate endpoint's ON CONFLICT clause must name all
--    three columns + the same WHERE predicate verbatim, or Postgres
--    won't pick this index as the arbiter.
--
--    Name follows Prisma's would-be `@@unique([userId, wineId, sessionId])`
--    convention (`<table>_<col1>_<col2>_<col3>_key`). Prisma can't see
--    partial indexes via schema.prisma, so `migrate diff` doesn't
--    inspect this constraint either way — the convention match is for
--    future-proofing, not drift avoidance.
------------------------------------------------------------------------

CREATE UNIQUE INDEX "ratings_user_id_wine_id_session_id_key"
    ON "ratings" ("user_id", "wine_id", "session_id")
 WHERE "session_id" IS NOT NULL AND "user_id" IS NOT NULL;

------------------------------------------------------------------------
-- 4. ratings.score → nullable
--    A chips-only or notes-only rating row has no score, distinct from
--    score = 0 ("not rated"). See rewire.md §2 / §3 / §6 phase 1.5.
------------------------------------------------------------------------

ALTER TABLE "ratings" ALTER COLUMN "score" DROP NOT NULL;

COMMIT;
