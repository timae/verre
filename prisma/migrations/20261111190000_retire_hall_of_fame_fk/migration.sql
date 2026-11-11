-- Hall of Fame retired (2026-11-11): nothing in this release reads or writes
-- hall_of_fame. Drop its user FK (account deletion no longer tombstones the
-- table) and empty it (test data only, owner-approved without a backup; an
-- old instance still serving during the deploy then shows an empty board and
-- leaks no moment code). The table itself is dropped by a later migration: an
-- instance still serving the previous release must never meet it missing.
--
-- If the deploy fails on the lock timeout (a long transaction holding `users`,
-- e.g. an account deletion; find it with the pg_locks query in
-- docs/dev/deployment.md § PRE-DEPLOY CHECK): the transaction applied nothing
-- (the FK is still there), so clear the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261111190000_retire_hall_of_fame_fk
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

-- Dropping a FK takes ACCESS EXCLUSIVE on the referenced `users` table too:
-- never queue behind a long transaction holding it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "hall_of_fame" DROP CONSTRAINT IF EXISTS "hall_of_fame_user_id_fkey";
DELETE FROM "hall_of_fame";

COMMIT;
