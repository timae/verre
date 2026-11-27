-- 0.2.0 build 2: alcohol typed on a listed year that has none (ruled 2026-11-27 with
-- the catalogue-maintenance side: NEVER written into wine_vintages.abv). The value is a
-- review item, reason 'user-abv', with the vintage and who reported it; that side pulls
-- it, decides it, and delivers it back as a normal value. Until then every read shows it
-- on that year (lib/catalogEntries.ts), with no marker (ruled).
--
-- 🔒 At most ONE open report per vintage: the first value wins (told to that side). A
-- resolved report frees the year for a new one. `reported_by` → users SET NULL: the
-- value stays, the person goes (agreed with that side).
--
-- Ours, not a contract table (prisma/CLAUDE.md); that side locks it during a replace and
-- pulls it. The key into `users` takes a brief lock there too (the reason
-- 20261119160100 was its own migration); lock_timeout bounds the wait. ON FAILURE
-- (P3009) nothing applied: clear the cause, then
--   npx prisma migrate resolve --rolled-back 20261127120100_catalog_abv_reports
--   npx prisma migrate deploy
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "catalog_review_items"
  ADD COLUMN "abv" DECIMAL(4,2),
  ADD COLUMN "reported_by" INTEGER,
  DROP CONSTRAINT "catalog_review_items_reason_check",
  ADD CONSTRAINT "catalog_review_items_reason_check" CHECK ("reason" IN ('user-mint', 'user-abv')),
  ADD CONSTRAINT "catalog_review_items_abv_check" CHECK ((("reason" = 'user-abv') = ("abv" IS NOT NULL)) AND ("abv" IS NULL OR ("abv" >= 0 AND "abv" <= 25))),
  ADD CONSTRAINT "catalog_review_items_abv_vintage_check" CHECK ("reason" <> 'user-abv' OR "entity_type" = 'vintage');

ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_reported_by_fkey"
  FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "catalog_review_items_open_abv_key" ON "catalog_review_items"("entity_id")
  WHERE "reason" = 'user-abv' AND "resolved_at" IS NULL;

COMMIT;
