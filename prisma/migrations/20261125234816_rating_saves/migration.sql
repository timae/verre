-- Rating saves (tasting feedback 2026-11-25, docs/dev/rating-saves.md).
--
-- 1. Count ONCE per rating: three flags on `ratings` (five-star, one-star and
--    note counted) and the rating-action XP actually credited for the row
--    (`rating_action_xp`, refunded by the owner's own clear). Legacy rows keep
--    0: their historical XP stays on the user.
-- 2. The version of a person's session rating of a bottle (`rating_versions`),
--    bumped by every writer of a signed-in session rating, checked by the app's
--    merge saves (409 when outdated). Its own table so it survives a Clear;
--    `wine_id` without a foreign key (bottles are deleted and re-minted, the row
--    must outlive them); cascades with the user.
--
-- Additive: the previous release ignores the new columns and the table.
-- DDL ONLY: the flags' backfill is the next migration
-- (20261125234900_rating_flags_backfill), in its own transaction, so the ACCESS
-- EXCLUSIVE lock this one takes on `ratings` is held for the metadata changes
-- only (a column with a constant default needs no table rewrite), never for the
-- rewrite of rows. lock_timeout bounds the WAIT for the locks on `ratings` and
-- `users` (the foreign key).
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ratings" ADD COLUMN     "five_star_counted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note_counted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "one_star_counted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rating_action_xp" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "rating_versions" (
    "user_id" INTEGER NOT NULL,
    "wine_id" VARCHAR(21) NOT NULL,
    "version" INTEGER NOT NULL,
    "last_op_id" UUID,

    CONSTRAINT "rating_versions_pkey" PRIMARY KEY ("user_id","wine_id")
);

-- By bottle: a bottle delete bumps every version row of the bottle, and a
-- line-up re-key copies them (lib/ratingVersions.ts); the primary key leads
-- with the user.
CREATE INDEX "rating_versions_wine_id_idx" ON "rating_versions"("wine_id");

ALTER TABLE "rating_versions" ADD CONSTRAINT "rating_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
