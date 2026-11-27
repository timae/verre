-- Rating saves, part 2 (tasting feedback 2026-11-25, docs/dev/rating-saves.md):
-- the count-once flags backfilled from the stored values. Its own migration
-- (after 20261125234816_rating_saves, which adds the columns) so that the
-- row rewrite holds only ROW EXCLUSIVE on `ratings` (app reads and writes go
-- on; a write to a row being rewritten waits for this COMMIT), never the
-- ACCESS EXCLUSIVE lock of the DDL.
--
-- Both run in `migrate deploy` BEFORE the new release serves, so an old
-- instance can still touch a rating for a few minutes after the backfill
-- (named residual, ruled 2026-11-25: such a rating can count once more).
-- lock_timeout 15 s: above the app's 10 s transaction limit, so a row held by
-- a normal app transaction never fails the deploy, while a stuck lock does.
BEGIN;

SET LOCAL lock_timeout = '15s';

-- The flags from the stored values: a rating that is 5 (or 1) now has counted
-- its five (or one) star; a note of more than 5 characters has counted its
-- note. `char_length` is the rate route's own rule (code points, not UTF-16
-- units). Only the rows that set a flag are rewritten (every other row keeps
-- the defaults, which are what the SET would write). Run verbatim against
-- rows written the old way by scripts/tests/rating-saves-integration.mts § 8
-- (state 2 once shipped: never edit this file, markers included).
-- @backfill:rating-flags
UPDATE "ratings" SET
  "five_star_counted" = COALESCE("score" = 5, false),
  "one_star_counted" = COALESCE("score" = 1, false),
  "note_counted" = COALESCE(char_length("notes") > 5, false)
WHERE "score" IN (5, 1) OR char_length("notes") > 5;
-- @endbackfill

COMMIT;
