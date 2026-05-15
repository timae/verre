-- Rewire phase 2 — sessions column nullability.
--
-- See docs/dev/proposals/rewire.md §6 phase 2 and §8 "data-survival contract".
-- Phase 2's DELETE /api/session/[code] flips from hard-delete to soft-delete:
-- it sets `deleted_at = now()` and scrubs every OTHER column on the sessions
-- row to NULL. The only data guaranteed to survive on the row is `id` and
-- `deleted_at`. That requires every other column to allow NULL.
--
-- Non-destructive: adding nullability never loses data. No prod-vs-local
-- materialisation issue here (the DROP-CONSTRAINT-vs-DROP-INDEX gotcha
-- applies to unique constraints, not to NOT NULL declarations).
--
-- Unique on `code` still works once it allows NULL — Postgres treats
-- multiple NULLs as distinct, so soft-deleted rows (all with code=NULL)
-- don't collide with each other or with live rows.
--
-- `blind` also loses its `default false`: every write path in app code
-- already sets `blind` explicitly (`app/api/session/route.ts:104,134,161`
-- and `app/api/session/[code]/settings/route.ts:72`), so the schema-level
-- default was redundant. After phase 2, `blind = NULL` on a soft-deleted
-- session is a meaningful tombstone signal — a default would have masked it.

ALTER TABLE "sessions"
  ALTER COLUMN "code" DROP NOT NULL,
  ALTER COLUMN "host_name" DROP NOT NULL,
  ALTER COLUMN "blind" DROP NOT NULL,
  ALTER COLUMN "blind" DROP DEFAULT,
  ALTER COLUMN "created_at" DROP NOT NULL,
  ALTER COLUMN "archived_at" DROP NOT NULL;

-- DB-level invariant: sessions are soft-deleted only.
--
-- Hard-deleting a session row is forbidden. All app code paths route through
-- the soft-delete UPDATE (set `deleted_at = NOW()`, scrub every other column).
-- This trigger turns that convention into an actual database invariant — a
-- forgotten code path, a buggy hotfix, or a manual `DELETE FROM sessions`
-- typo in psql can't lose session data.
--
-- Cleanup runbook (when periodic purge of long-tombstoned rows is needed):
--   ALTER TABLE sessions DISABLE TRIGGER prevent_session_hard_delete;
--   -- run vetted cleanup DELETE (e.g. WHERE deleted_at < NOW() - INTERVAL '1 year'
--   --                                AND id NOT IN (SELECT session_id FROM ratings ...))
--   ALTER TABLE sessions ENABLE TRIGGER prevent_session_hard_delete;
-- See docs/dev/session-deletion.md for the full procedure.

CREATE OR REPLACE FUNCTION reject_session_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sessions are soft-deleted only; use UPDATE sessions SET deleted_at = NOW() (id=%)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER prevent_session_hard_delete
  BEFORE DELETE ON "sessions"
  FOR EACH ROW
  EXECUTE FUNCTION reject_session_hard_delete();
