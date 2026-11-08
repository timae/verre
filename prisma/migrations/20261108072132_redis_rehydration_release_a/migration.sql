-- Redis rehydration — release A (additive). docs/dev/proposals/redis-rehydration.md
-- § 4.2 (columns + two tables) and § 4.3 (legacy tombstone + provenance backfill).
--
-- 🔒 NO CHECK constraint here. Deplo.io runs this migration BEFORE the new
-- release goes live while the previous release keeps serving, and that release's
-- account-delete writer sets ratings.user_id = NULL without a tombstone_key. The
-- CHECK `ratings_session_rater_known` ships in release B, after B's migration
-- re-runs the catch-up below (the @recipe block) and validates zero rows remain.
--
-- Every new sessions column is nullable: the soft-delete scrub nulls every
-- column but id and deleted_at (rewire.md § 8).
BEGIN;

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN     "mirror_at" TIMESTAMPTZ(6),
ADD COLUMN     "tombstone_key" VARCHAR(40);

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "hide_lineup" BOOLEAN,
ADD COLUMN     "hide_lineup_minutes_before" INTEGER,
ADD COLUMN     "lifespan" VARCHAR(16),
ADD COLUMN     "show_provenance" BOOLEAN;

-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "position" INTEGER;

-- CreateTable
CREATE TABLE "session_bans" (
    "session_code" VARCHAR(16) NOT NULL,
    "identity_id" VARCHAR(64) NOT NULL,
    "banned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_bans_pkey" PRIMARY KEY ("session_code","identity_id")
);

-- CreateTable
CREATE TABLE "session_tombstones" (
    "code" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_tombstones_pkey" PRIMARY KEY ("code","created_at")
);

-- CreateIndex
CREATE INDEX "session_bans_identity_id_idx" ON "session_bans"("identity_id");

-- Legacy tombstones (§ 4.3, R2-6). Session ratings tombstoned before
-- tombstone_key existed carry user_id NULL and no key; the per-user split is
-- unrecoverable, so they get ONE key per session. Session wines whose
-- added_by_identity_id names a user that no longer exists get that same session
-- key and the '[deleted]' snapshot (otherwise wineToWire's snapshot fallback
-- renders the deleted person's real name). Session-less (orphaned) wines with a
-- gone adder keep no identity and get the '[deleted]' snapshot.
--
-- 🔒 The block between the markers is EXECUTED verbatim by
-- scripts/tests/redis-rehydration-additive.mts and is the catch-up release B's
-- migration repeats for tombstones minted by the old writer during the rollout
-- overlap. It must stay idempotent: a second run finds nothing to stamp.
-- @recipe:legacy-tombstones
DO $$
DECLARE
  n_sessions int;
  n_ratings  int;
  n_wines    int;
  n_orphans  int;
BEGIN
  DROP TABLE IF EXISTS pg_temp._legacy_tombstone_keys;
  CREATE TEMP TABLE _legacy_tombstone_keys ON COMMIT DROP AS
    SELECT s.sid, 'd:' || gen_random_uuid()::text AS k
      FROM (
        SELECT r.session_id AS sid
          FROM public.ratings r
         WHERE r.session_id IS NOT NULL AND r.user_id IS NULL AND r.tombstone_key IS NULL
        UNION
        SELECT w.session_id
          FROM public.wines w
         WHERE w.session_id IS NOT NULL
           AND w.added_by_identity_id ~ '^u:[0-9]{1,18}$'
           AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substring(w.added_by_identity_id FROM 3)::bigint)
      ) s;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  UPDATE public.ratings r
     SET tombstone_key = t.k
    FROM _legacy_tombstone_keys t
   WHERE r.session_id = t.sid AND r.user_id IS NULL AND r.tombstone_key IS NULL;
  GET DIAGNOSTICS n_ratings = ROW_COUNT;

  UPDATE public.wines w
     SET added_by_identity_id = t.k, added_by_display_name = '[deleted]'
    FROM _legacy_tombstone_keys t
   WHERE w.session_id = t.sid
     AND w.added_by_identity_id ~ '^u:[0-9]{1,18}$'
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substring(w.added_by_identity_id FROM 3)::bigint);
  GET DIAGNOSTICS n_wines = ROW_COUNT;

  UPDATE public.wines w
     SET added_by_identity_id = NULL, added_by_display_name = '[deleted]'
   WHERE w.session_id IS NULL
     AND w.added_by_identity_id ~ '^u:[0-9]{1,18}$'
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substring(w.added_by_identity_id FROM 3)::bigint);
  GET DIAGNOSTICS n_orphans = ROW_COUNT;

  DROP TABLE _legacy_tombstone_keys;
  RAISE NOTICE 'legacy tombstones: % session keys, % ratings stamped, % session wines and % orphaned wines re-attributed',
    n_sessions, n_ratings, n_wines, n_orphans;
END $$;
-- @endrecipe

COMMIT;
