-- Rewire phase 4 — drop the legacy checkins surface.
--
-- See docs/dev/proposals/rewire.md §6 phase 4. This is the irreversible step
-- of the rewire. Phase 2's migration backfilled `feed_items` / `ratings` /
-- `rating_images` from these tables; phase 3 routed all UI to the new model.
-- After a cooling period — minimum one production deploy cycle, ideally a
-- week — phase 4 drops the now-orphaned legacy tables.
--
-- Pre-flight (PR template):
--   1. `pg_dump` of prod taken, checksum recorded in the PR description.
--   2. `SELECT COUNT(*) FROM feed_items WHERE kind = 'standalone'` is the
--      authoritative reference for what the feed surface holds after the
--      drop — nothing here should affect it.
--   3. No production code path reads from `checkins*` after phase 2 (verified
--      via grep + the regression suite).
--
-- Use of explicit `IF EXISTS` on every drop: matches the prod-vs-local
-- materialisation pattern noted in `project-verre-deploy-constraint-vs-index`
-- (memory) — a constraint Prisma materialised differently between environments
-- shouldn't crash the migration. `DROP TABLE … CASCADE` would also drop the
-- FK constraints that reference these tables, but we list them explicitly
-- both for auditability and so a partial-failure replay is well-defined.

-- DropForeignKey
ALTER TABLE "checkin_likes" DROP CONSTRAINT IF EXISTS "checkin_likes_checkin_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_likes" DROP CONSTRAINT IF EXISTS "checkin_likes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_tags" DROP CONSTRAINT IF EXISTS "checkin_tags_checkin_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_tags" DROP CONSTRAINT IF EXISTS "checkin_tags_user_id_fkey";

-- DropForeignKey
ALTER TABLE "checkins" DROP CONSTRAINT IF EXISTS "checkins_user_id_fkey";

-- DropTable
DROP TABLE IF EXISTS "_migration_checkpoints";

-- DropTable
DROP TABLE IF EXISTS "checkin_likes";

-- DropTable
DROP TABLE IF EXISTS "checkin_tags";

-- DropTable
DROP TABLE IF EXISTS "checkins";
