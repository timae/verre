-- Catalogue model change, expand step (docs/dev/proposals/wine-catalog-model-change.md
-- § 7; build order § 12 step 2): catalog_review_items.
--
-- One row per user-minted catalogue entry, written by lib/catalogWrite.ts in the
-- mint's own transaction (from build step 4); resolved_at / resolved_by stay empty
-- until the review queue (phase 3). `status = 'provisional'` alone is not that
-- record: a delivery may move a user entry to confirmed, and then nothing would say
-- no curator ever looked at it.
--
-- 🔒 entity_id has NO key into the catalogue: the entity is polymorphic, and a purge
-- deletes the entity and its item in one transaction. A table holding catalogue ids
-- without a key is one the catalog-maintenance side's replace mode must LOCK for its
-- whole load (told 2026-11-19); a new such table is told to them too.
--
-- Its own migration (not part of 20261119160000) because its key into `users` takes
-- a lock on `users`: here it is the only lock, held for milliseconds, instead of
-- being taken last while the expand migration holds seven tables.
--
-- ON FAILURE (a lock timeout or a deadlock on `users`): P3009; the transaction
-- applied nothing, so clear the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261119160100_catalog_review_items
--   npx prisma migrate deploy
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE "catalog_review_items" (
  "id"          SERIAL NOT NULL,
  "entity_type" VARCHAR(16) NOT NULL,
  "entity_id"   VARCHAR(21) NOT NULL,
  "reason"      VARCHAR(32) NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  "resolved_by" INTEGER,
  CONSTRAINT "catalog_review_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "catalog_review_items_entity_type_check" CHECK ("entity_type" IN ('producer', 'product', 'vintage')),
  CONSTRAINT "catalog_review_items_reason_check" CHECK ("reason" IN ('user-mint')),
  CONSTRAINT "catalog_review_items_resolved_check" CHECK ("resolved_by" IS NULL OR "resolved_at" IS NOT NULL)
);
CREATE INDEX "catalog_review_items_entity_type_entity_id_idx" ON "catalog_review_items"("entity_type", "entity_id");
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

COMMIT;
