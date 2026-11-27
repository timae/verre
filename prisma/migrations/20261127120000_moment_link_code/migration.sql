-- 0.2.0 build 2: the look-in link's code is stored on the moment (lib/momentLink.ts),
-- replacing the HMAC over MOMENT_LINK_SECRET. 32 hex, NULL while the link is off;
-- a new code at Share-when-off and at Reset. Stored as is (ruled 2026-11-27: Share
-- on an active link shows the link again). Additive: the previous release never
-- reads it, and no link exists on production (the link POST answered 404 while
-- Moment Visibility was dark). Both delete scrubs clear it (docs/dev/session-deletion.md).
-- lock_timeout bounds the WAIT for the lock; ON FAILURE (P3009) nothing applied:
--   npx prisma migrate resolve --rolled-back 20261127120000_moment_link_code
--   npx prisma migrate deploy
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "sessions"
  ADD COLUMN "link_code" VARCHAR(32),
  ADD CONSTRAINT "sessions_link_code_format_chk" CHECK ("link_code" IS NULL OR "link_code" ~ '^[0-9a-f]{32}$');

COMMIT;
