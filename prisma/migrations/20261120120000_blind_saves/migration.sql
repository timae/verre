-- Catalogue model change, build step 5 (docs/dev/proposals/wine-catalog-model-change.md
-- § 5; ruled 2026-11-20, Simon, R2): a save of a bottle that is hidden from you.
--
-- On a blind bottle you can't see yet ("Wine N") the save button saves THAT
-- bottle: it reads saved after a reload, can be unsaved there, and never touches
-- a craving of the same wine made elsewhere. 🔒 While the bottle is hidden for
-- its saver this row is ALL that is stored: no craving, no bookmarks id taken
-- (review r1: a craving created only when the wine was not already craved made
-- the bookmarks sequence an oracle, and a craving shared by two blind saves
-- named one at the other's reveal). The save counts as a craving once its bottle
-- is no longer hidden for the saver (lib/cravings.ts reads it so).
--
-- `id`: its own sequence (every blind save takes one, whatever the wine): the
-- remove key and the list's tiebreak. `session_id`: the bottle's moment, kept on
-- the save like a craving's (an orphaned, unrated bottle must stay hidden until
-- its moment reveals). `item_id`: the post it was saved from (NULL in the
-- moment): decides who may see its photo on the saver's lists (ruled
-- 2026-11-20). Cascade with the user (their own data) and with the bottle (the
-- old release's wine DELETE keeps working); the post SET NULL; the moment NO
-- ACTION (sessions are never hard-deleted).
--
-- `from_post`: saved from a post (true) or in the moment (false: its saver was a
-- participant). Kept when the post is deleted (item_id goes NULL): the photo rule
-- must still know the saver was not there. A constant default: a metadata-only
-- ADD COLUMN, no table rewrite.
--
-- bookmarks.source_item_id / from_post: the same for a craving.
--
-- Additive: the previous release never reads either. ON FAILURE (a lock timeout
-- on users / wines / bookmarks / feed_items): P3009; nothing applied, so clear
-- the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261120120000_blind_saves
--   npx prisma migrate deploy
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE "blind_saves" (
  "id"       SERIAL NOT NULL,
  "user_id"  INTEGER NOT NULL,
  "wine_id"  VARCHAR(21) NOT NULL,
  "session_id" INTEGER,
  "item_id"  INTEGER,
  "from_post" BOOLEAN NOT NULL DEFAULT false,
  "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blind_saves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "blind_saves_user_id_wine_id_key" ON "blind_saves"("user_id", "wine_id");
CREATE INDEX "blind_saves_wine_id_idx" ON "blind_saves"("wine_id");
CREATE INDEX "blind_saves_item_id_idx" ON "blind_saves"("item_id");
ALTER TABLE "blind_saves" ADD CONSTRAINT "blind_saves_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "blind_saves" ADD CONSTRAINT "blind_saves_wine_id_fkey"
  FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "blind_saves" ADD CONSTRAINT "blind_saves_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "blind_saves" ADD CONSTRAINT "blind_saves_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "feed_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "bookmarks" ADD COLUMN "source_item_id" INTEGER;
ALTER TABLE "bookmarks" ADD COLUMN "from_post" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "bookmarks_source_item_id_idx" ON "bookmarks"("source_item_id");
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_source_item_id_fkey"
  FOREIGN KEY ("source_item_id") REFERENCES "feed_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

COMMIT;
