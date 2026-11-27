-- Moment Visibility step 3, R12 (ruled 2026-11-25): Hide from Feed for your
-- post of a moment, stored per (moment, person) beside Only Inside (Incognito,
-- R11), so the choice holds before the post exists (a post appears on the first
-- rating). Additive: the previous release never reads `moment_privacy`'s new
-- column, and the table is empty on production. `only_inside` gets a default
-- so a row written for Hide from Feed alone needs no Only Inside value.
-- lock_timeout bounds the WAIT for the lock (the P3009 recovery as in
-- 20261124120000_moment_privacy_step3).
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "moment_privacy"
  ADD COLUMN "hidden_from_feed" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "only_inside" SET DEFAULT false;

COMMIT;
