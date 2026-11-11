-- You profile, step 4: the post audience (Check-Ins Visible To) and the three
-- profile switches (Show Cravings / Show Moments / Show My Locations), plus
-- full before/after snapshots of them in the visibility audit log. Additive
-- only: the previous release runs unchanged on the migrated database (it never
-- reads the new columns; every default keeps today's behaviour).
--
-- checkin_visibility NULL = Same as Profile. The CHECK is hand-added (Prisma
-- can't express it), like profile_visibility_chk; the union in
-- lib/profileVisibilityShared.ts (CheckinVisibility) is the source of truth.
-- 'public-internet' is never stored: it would equal NULL.
--
-- If the deploy fails on the lock timeout (a long transaction holding `users`,
-- e.g. an account deletion; find it with the pg_locks query in
-- docs/dev/deployment.md § PRE-DEPLOY CHECK): the transaction applied nothing,
-- so clear the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261111200000_you_profile_step4
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

-- Adding a CHECK takes ACCESS EXCLUSIVE on `users`: never queue behind a long
-- transaction holding it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "users" ADD COLUMN "checkin_visibility" VARCHAR(32),
ADD COLUMN "show_cravings" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "show_moments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "show_locations" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "users"
  ADD CONSTRAINT "checkin_visibility_chk"
  CHECK ("checkin_visibility" IS NULL OR "checkin_visibility" IN ('public-users','public-followers','public-mutual','only-me'));

-- Same as Profile is logged as the sentinel 'profile'; NULL in these columns
-- means a row from before this migration (or a signup row's from_*).
ALTER TABLE "profile_visibility_log" ADD COLUMN "from_checkin_tier" VARCHAR(32),
ADD COLUMN "to_checkin_tier" VARCHAR(32),
ADD COLUMN "from_show_cravings" BOOLEAN,
ADD COLUMN "to_show_cravings" BOOLEAN,
ADD COLUMN "from_show_moments" BOOLEAN,
ADD COLUMN "to_show_moments" BOOLEAN,
ADD COLUMN "from_show_locations" BOOLEAN,
ADD COLUMN "to_show_locations" BOOLEAN;

COMMIT;
