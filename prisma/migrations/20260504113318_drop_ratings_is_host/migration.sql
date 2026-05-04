-- Drop the unused `is_host` column from `ratings`.
--
-- The column was a leftover from an early blind-tasting prototype that
-- distinguished host-pre-ratings from taster ratings at the row level.
-- That distinction is now handled differently (hosts mark wines as
-- revealed; ratings flow through the same code path regardless of who
-- the rater is). The column was never read or written by application
-- code and every row holds the schema default of `false`.
--
-- Verified zero application references to `is_host` (snake_case) before
-- this drop. Camel-case `isHost` matches in code refer to a React
-- session-context boolean prop, not the column.

ALTER TABLE "ratings" DROP COLUMN "is_host";
