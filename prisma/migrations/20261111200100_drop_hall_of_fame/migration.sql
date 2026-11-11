-- Hall of Fame retired (2026-11-11). The previous release
-- (20261111190000_retire_hall_of_fame_fk) stopped every read and write, dropped
-- the user FK and emptied the table; it is live, so no serving instance can
-- meet the table missing. Destructive by design: the rows were test data, and
-- the owner confirmed the drop without a backup.
DROP TABLE IF EXISTS "hall_of_fame";
