-- Moment Visibility, step 3 (.local plan § 4.8): Only Inside This Moment's
-- writes and Hide from Feed. Additive only: the previous release runs unchanged
-- on the migrated database (it never reads the new column or the index).
--
--   1. moment_privacy (user_id): the account-deletion cascade and the owner's
--      own reads go by user; the table had only its (session_id, user_id) key.
--   2. feed_items.hidden_from_feed: a check-in its author took out of every
--      feed and every profile post list for everyone but themselves (it stays
--      on their Impressions). A constant default: no table rewrite.
--   3. 🔒 Only a check-in can carry it (the CHECK): a moment post has Only
--      Inside This Moment instead (ruled: two similar switches would confuse).
--      Validated in the same statement (a NEW column is false on every row).
--
-- lock_timeout bounds the WAIT for the locks, not the work. If the deploy fails
-- on it (a long transaction holding `feed_items` or `moment_privacy`), the
-- transaction applied nothing and the old release keeps serving; clear the
-- cause, then
--
--   npx prisma migrate resolve --rolled-back 20261124120000_moment_privacy_step3
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1.
CREATE INDEX "moment_privacy_user_id_idx" ON "moment_privacy"("user_id");

-- 2 + 3.
ALTER TABLE "feed_items"
  ADD COLUMN "hidden_from_feed" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "feed_items_hidden_from_feed_standalone" CHECK (NOT "hidden_from_feed" OR "kind" = 'standalone');

COMMIT;
