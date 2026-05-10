-- Quarter-stars: widen score columns from SmallInt to Decimal(3,2).
-- Postgres cast is lossless: existing integer scores (0..5) become
-- 0.00..5.00. Validation enforces 0.25 steps at the route layer.
ALTER TABLE "ratings"        ALTER COLUMN "score" TYPE NUMERIC(3,2) USING score::numeric(3,2);
ALTER TABLE "hall_of_fame"   ALTER COLUMN "score" TYPE NUMERIC(3,2) USING score::numeric(3,2);
ALTER TABLE "checkins"       ALTER COLUMN "score" TYPE NUMERIC(3,2) USING score::numeric(3,2);
