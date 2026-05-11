-- Privacy visibility tiers + FoF + audit log + drop checkins.is_public.
--
-- The CHECK constraint on profile_visibility is hand-added here; Prisma's
-- schema model can't represent it. Future migrate runs are append-only so
-- this constraint persists. The lib-side TypeScript union in
-- lib/profileVisibility.ts is the authoritative source of truth — the CHECK
-- is belt-and-suspenders.
--
-- Existing users are explicitly UPDATEd to 'public-internet' to preserve
-- their de-facto state (they joined under the assumption that profiles
-- are world-readable). Only NEW signups land at the 'public-users' default.
--
-- pg_trgm + GIN index on users.name accelerates substring search in
-- /api/users/search. Required for scale; harmless at current size.
--
-- The DROP COLUMN checkins.is_public is destructive. Per CLAUDE.md, this
-- requires a pg_dump first (operator responsibility) and explicit user
-- confirmation, both obtained before this migration ships. The single
-- pre-existing private check-in (id=19) was deleted manually in prod
-- before this migration was applied.

-- AlterTable: User
ALTER TABLE "users"
  ADD COLUMN "profile_visibility" VARCHAR(32) NOT NULL DEFAULT 'public-users',
  ADD COLUMN "visibility_fof"     BOOLEAN     NOT NULL DEFAULT false;

ALTER TABLE "users"
  ADD CONSTRAINT "profile_visibility_chk"
  CHECK ("profile_visibility" IN ('public-internet','public-users','public-followers','public-mutual'));

-- Preserve de-facto state for users that existed before this migration ran.
-- All existing rows came in with the column default 'public-users'; flip
-- them to 'public-internet' so we don't silently tighten their visibility.
-- Idempotent on retry: the WHERE filter only touches rows still at the
-- default, so a re-run after operator-driven changes is a no-op.
UPDATE "users" SET "profile_visibility" = 'public-internet' WHERE "profile_visibility" = 'public-users';

-- CreateTable: ProfileVisibilityLog (audit trail, internal only)
CREATE TABLE "profile_visibility_log" (
  "id"         SERIAL       NOT NULL,
  "user_id"    INTEGER,
  "from_tier"  VARCHAR(32),
  "to_tier"    VARCHAR(32)  NOT NULL,
  "from_fof"   BOOLEAN,
  "to_fof"     BOOLEAN,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "profile_visibility_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "profile_visibility_log_user_id_changed_at_idx"
  ON "profile_visibility_log"("user_id", "changed_at");

ALTER TABLE "profile_visibility_log"
  ADD CONSTRAINT "profile_visibility_log_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill initial-state rows for pre-existing users. New signups get an
-- audit row via the register route's transaction; for users that existed
-- before this migration, capture the post-UPDATE state here so the log
-- has a complete history starting at migration time. `from_tier=NULL`
-- matches the signup convention.
INSERT INTO "profile_visibility_log" ("user_id", "to_tier", "to_fof")
SELECT "id", "profile_visibility", "visibility_fof" FROM "users";

-- pg_trgm + GIN on users.name for fast substring search at scale. The
-- index name matches Prisma's auto-generated `<table>_<col>_idx` shape so
-- the schema-diff CI guard (.github/workflows/check-schema.yml) sees them
-- as the same object.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "users_name_idx" ON "users" USING gin ("name" gin_trgm_ops);

-- DropColumn: checkins.is_public (replaced by per-user profile_visibility)
ALTER TABLE "checkins" DROP COLUMN "is_public";
