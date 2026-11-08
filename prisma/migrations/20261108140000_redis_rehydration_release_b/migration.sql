-- Redis rehydration — release B (cutover). docs/dev/proposals/redis-rehydration.md
-- § 4.3 (R6-2) and § 4.7 (r1-2 of the release-B plan review).
--
-- Deplo.io runs this BEFORE release B goes live while release A keeps serving.
-- Safe against A's writer: A's account deletion always sets tombstone_key with
-- user_id = NULL, and no other A writer nulls a session rating's user_id. The
-- catch-up below stamps any tombstone the PRE-A writer minted during A's own
-- rollout overlap, the validation proves none remain, and only then is the CHECK
-- added. schema.prisma is unchanged: Prisma does not model CHECK constraints —
-- prisma/session-record-checks.json + scripts/check-session-record-checks.mjs
-- are the gate for this predicate.
BEGIN;

-- 🔒 VERBATIM copy of release A's @recipe:legacy-tombstones block (the cutover
-- suite asserts the two are byte-identical). Idempotent: a second run stamps 0.
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

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.ratings
   WHERE session_id IS NOT NULL AND user_id IS NULL AND tombstone_key IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'release B: % session ratings still have no rater identity after the catch-up', n;
  END IF;
END $$;

-- § 4.3: a session rating always names its rater — a live user or the
-- (deleted user, session) tombstone key. Together with the ratings.user_id FK
-- (NO ACTION) the database refuses both bad end states of account deletion.
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_session_rater_known"
  CHECK (session_id IS NULL OR user_id IS NOT NULL OR tombstone_key IS NOT NULL);

-- Member rows exist only for codes with a live sessions row (plan § 2, r1-2).
-- Release A's set-role upserted session_members unconditionally (no FK to
-- sessions), so a Redis-only session's role row survives the session's expiry
-- and would grant that role in whichever session later recycles the code.
-- Safe under A's code during the overlap: A reads member rows only joined to a
-- live sessions row (/me/sessions) and in the join page's redirect, and
-- promotion re-creates rows for a still-live Redis-only session from its meta.
DO $$
DECLARE n int;
BEGIN
  DELETE FROM public.session_members m
   WHERE NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.code = m.session_code AND s.deleted_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'release B: % orphan session_members rows deleted (code with no live sessions row)', n;
END $$;

COMMIT;
