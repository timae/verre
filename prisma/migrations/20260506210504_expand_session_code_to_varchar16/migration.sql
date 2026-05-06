-- Widen session-code columns from Char(4) to VarChar(16) so 8-char Crockford
-- codes (and future 12+ if needed) fit alongside the legacy 4-char hex codes.
-- No data migration: existing 4-char hex values are valid Crockford-32
-- (hex 0-9 A-F is a strict subset of Crockford 0-9 A-Z minus I L O U) and
-- the application's normalizeCode accepts both lengths permanently.
--
-- All three ALTER COLUMN statements run in a single transaction; Postgres
-- DDL is transactional so this commits or rolls back as one. Each ALTER
-- takes ACCESS EXCLUSIVE on its table — Char→VarChar is a storage-format
-- change (fixed-width to length-prefixed) so Postgres rewrites the table.
-- At Verre's scale this is sub-second per table.
--
-- session_members.session_code is part of the composite PRIMARY KEY
-- (user_id, session_code). Postgres ALTER COLUMN TYPE on a PK column
-- rebuilds the underlying index in place — no DROP CONSTRAINT needed for
-- a length-only widening within compatible character types.

ALTER TABLE "sessions"        ALTER COLUMN "code"         TYPE VARCHAR(16);
ALTER TABLE "session_members" ALTER COLUMN "session_code" TYPE VARCHAR(16);
ALTER TABLE "hall_of_fame"    ALTER COLUMN "session_code" TYPE VARCHAR(16);
