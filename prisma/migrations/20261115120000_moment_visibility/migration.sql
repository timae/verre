-- Moment Visibility, step 1a (docs/dev/proposals/moment-visibility.md § 5).
-- Additive only: the previous release runs unchanged on the migrated database
-- (it never reads or writes the new columns), and everything here stays dark
-- behind MOMENT_LOOKIN_ENABLED.
--
--   1. sessions.public_id: the in-app address of a moment, never its code. The
--      volatile DEFAULT rewrites the table, so every row, tombstones included,
--      gets its own id in the same statement (the users.public_id pattern,
--      20261112230000_public_user_ids). Same shape and generator as a user's
--      public id (gen_public_user_id()); the two never share a route. Unique
--      index, format CHECK, the mint trigger (🔒 ALWAYS overrides a supplied
--      value) and the immutability trigger (BEFORE UPDATE OF public_id, so the
--      delete scrub, which never names the column, never fires it).
--   2. The seven settings columns, all nullable so both delete scrubs can wipe
--      them. 🔒 Every read treats NULL as closed or off. Constant defaults:
--      visibility 'friends', guests' circles on, place and details off, no
--      active link.
--   3. Tombstones: the seven columns back to NULL (ADD COLUMN ... DEFAULT just
--      filled them), keeping the scrub contract.
--   4. Guest-hosted live moments are closed ('members'). A moment whose host
--      deleted their account is stamped '[deleted]' (lib/accountDelete.ts) and
--      keeps the default (ruled). 🔒 This one-off statement is the ONLY place
--      that display string is read; at runtime nothing branches on it. The
--      NOTICE counts those rows for the go-live runbook.
--   5. sessions_guest_hosted_closed: a row inserted with no host lands as
--      'members', whatever the insert supplied. THE one mechanism for
--      promotion: an old instance promoting during the rolling deploy cannot
--      open a guest-hosted moment, and no insert path can forget.
--   6. moment_privacy: one row per person per moment ("Only Inside This
--      Moment"), keyed by the session's id (member rows are keyed by a code
--      that is recycled, and die with the moment). Read-only until step 3.
--      RESTRICT on the session: the third RESTRICT child of `sessions`
--      (docs/dev/session-deletion.md, the hard-delete runbook).
--
-- 🔒 The mint trigger also fires on COPY, and so does the guest-hosted one: a
-- DATA-ONLY restore needs --disable-triggers, or every moment gets a new
-- public id and host-deleted moments are closed (docs/dev/deployment.md).
--
-- Cost: one rewrite of `sessions` under ACCESS EXCLUSIVE (one row per moment).
-- lock_timeout bounds the WAIT for the lock, not the work. If the deploy fails
-- on it (a long transaction holding `sessions` or `users`), the transaction
-- applied nothing and the old release keeps serving; clear the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261115120000_moment_visibility
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1 + 2. One ALTER, one rewrite.
ALTER TABLE "sessions"
  ADD COLUMN "public_id" VARCHAR(12) NOT NULL DEFAULT gen_public_user_id(),
  ADD COLUMN "visibility" VARCHAR(16) DEFAULT 'friends',
  ADD COLUMN "include_guest_circles" BOOLEAN DEFAULT true,
  ADD COLUMN "show_place" BOOLEAN DEFAULT false,
  ADD COLUMN "show_details" BOOLEAN DEFAULT false,
  ADD COLUMN "link_version" INTEGER DEFAULT 0,
  ADD COLUMN "link_active" BOOLEAN DEFAULT false,
  ADD COLUMN "link_since" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "sessions_public_id_key" ON "sessions"("public_id");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_public_id_format_chk"
  CHECK ("public_id" ~ '^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$'),
  ADD CONSTRAINT "sessions_visibility_chk"
  CHECK ("visibility" IS NULL OR "visibility" IN ('members', 'friends', 'followers', 'verre'));

CREATE FUNCTION public.sessions_public_id_mint() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.public_id := public.gen_public_user_id();
  RETURN NEW;
END $$;

CREATE TRIGGER "sessions_public_id_mint"
  BEFORE INSERT ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION public.sessions_public_id_mint();

CREATE FUNCTION public.sessions_public_id_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'sessions.public_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Scoped to the column: the settings writes, the mirrors and both delete
-- scrubs never name it, so they never fire it.
CREATE TRIGGER "sessions_public_id_immutable"
  BEFORE UPDATE OF "public_id" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION public.sessions_public_id_immutable();

-- 3. Tombstones keep `id`, `deleted_at` and `public_id`, nothing else.
-- (The two marked blocks are run against fixture rows by
-- scripts/tests/moment-visibility-section.mts: keep the markers.)
-- @backfill:tombstones
UPDATE "sessions"
   SET "visibility" = NULL, "include_guest_circles" = NULL, "show_place" = NULL, "show_details" = NULL,
       "link_version" = NULL, "link_active" = NULL, "link_since" = NULL
 WHERE "deleted_at" IS NOT NULL;
-- @endbackfill

-- 4. Guest-hosted live moments are closed; host-deleted ones keep the default.
-- @backfill:guest-hosted
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.sessions
   WHERE host_user_id IS NULL AND deleted_at IS NULL AND host_name = '[deleted]';
  RAISE NOTICE 'moment_visibility: % live hostless moment(s) named [deleted] keep the default visibility', n;
END $$;

UPDATE "sessions"
   SET "visibility" = 'members'
 WHERE "host_user_id" IS NULL AND "deleted_at" IS NULL AND "host_name" IS DISTINCT FROM '[deleted]';
-- @endbackfill

-- 5. A moment inserted without a signed-in host is closed.
CREATE FUNCTION public.sessions_guest_hosted_closed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.visibility := 'members';
  RETURN NEW;
END $$;

CREATE TRIGGER "sessions_guest_hosted_closed"
  BEFORE INSERT ON "sessions"
  FOR EACH ROW WHEN (NEW.host_user_id IS NULL)
  EXECUTE FUNCTION public.sessions_guest_hosted_closed();

-- 6. moment_privacy
CREATE TABLE "moment_privacy" (
  "session_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "only_inside" BOOLEAN NOT NULL,
  CONSTRAINT "moment_privacy_pkey" PRIMARY KEY ("session_id", "user_id")
);

ALTER TABLE "moment_privacy"
  ADD CONSTRAINT "moment_privacy_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "moment_privacy"
  ADD CONSTRAINT "moment_privacy_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
