-- A year that gets its alcohol settles its open alcohol report (asked by the
-- catalogue-maintenance side 2026-11-28, ruled: in the database, so every writer is
-- covered: their update path through our import, a hand fix). When wine_vintages.abv
-- goes from NULL to a value, that vintage's open 'user-abv' review item
-- (20261127120100_catalog_abv_reports) gets resolved_at = now() in the SAME
-- transaction. resolved_by stays NULL: it names a user, and the trigger is none
-- (catalog_review_items_resolved_check forbids only a resolver without a time). A
-- NULL resolver does not prove a delivery settled it: a report resolved by hand
-- looks the same once its resolver's account is deleted (SET NULL). The report keeps
-- its value and its reporter. A resolved report frees the year for a new one, which the report writer
-- (lib/catalogWrite.ts reportVintageAbv) only accepts while the year's abv is NULL.
--
-- UPDATE only: a report needs an existing year, so a new year has none to settle.
-- It fires for any UPDATE that names abv, an upsert's DO UPDATE SET abv = … included.
-- A value changed to another value fires nothing, nor does an update that leaves abv
-- NULL, nor a delete and reload of the same id (entity_id has no key, so that report
-- stays open). Per row: a bulk UPDATE settles each year it fills; each lookup is the
-- partial unique catalog_review_items_open_abv_key.
--
-- Residuals (named, accepted 2026-11-28):
-- * Under READ COMMITTED a report stays open when its INSERT saw the year's abv
--   NULL and the trigger's UPDATE did not see the report (it committed after that
--   statement's snapshot, before or after the delivery's commit). The report writer
--   takes no row lock on the year (it would make a report wait behind any delivery
--   touching it). After the delivery commits, every catalogue read shows the
--   delivered value; a bottle's stored snapshot keeps the value it saved. Such a
--   report is cleared like a wrong one (prisma/CLAUDE.md).
-- * NEW WAIT: once the delivery's trigger has touched a year's open report, a second
--   report on that year (a screen loaded before the first report showed) waits on
--   that row for the delivery's transaction to FINISH, inside the bottle write's
--   transaction. The delivery commits: the stale insert creates a new open report
--   (the first residual's: open on a year with a value). It rolls back: the original
--   report stays open and the second is ignored. It outlasts the transaction limit
--   (10 s in a moment, Prisma's 5 s default on a check-in): the add fails, and a
--   retry can wait again while the delivery is still in flight. Rare by construction (an open
--   report, a stale screen, a delivery mid-flight on that year). Keeping an update
--   transaction short is the writer's job: the planned import endpoint caps a batch
--   at 1,000 rows per transaction (docs/dev/proposals/wine-catalog-implementation.md,
--   not built yet); a hand fix or a one-off script has no cap.
--
-- ⚠️ A trigger: off wherever triggers are off (session_replication_role = replica,
-- pg_restore --disable-triggers). The function runs as the caller, so the role that
-- updates wine_vintages needs UPDATE (resolved_at) and SELECT (entity_id, reason,
-- resolved_at) on catalog_review_items, even when no report matches. A purge
-- (lib/catalogWrite.ts purgeReferences) deletes each vintage before its review items,
-- the trigger's lock order for that year: that removes the deadlock of taking those
-- two locks in opposite orders (a multi-year purge and a bulk delivery taking years
-- in different orders can still deadlock, as any two multi-row writers can). A trigger is NOT in the
-- catalogue CHECK snapshot (prisma/catalog-contract-checks.json); it does change the
-- catalogue schema fingerprint the catalogue-maintenance side's deliveries assert.
--
-- No data change on apply (production 2026-11-28: 0 delivered years with an abv,
-- 0 user-abv reports). Schema-qualified with a pinned search_path, like every trigger
-- function here. lock_timeout bounds the WAIT for the lock on wine_vintages;
-- ON FAILURE (P3009) nothing applied: clear the cause, then
--   npx prisma migrate resolve --rolled-back 20261128120000_catalog_abv_report_settle
--   npx prisma migrate deploy
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.catalog_abv_report_settle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.catalog_review_items
     SET resolved_at = now()
   WHERE entity_id = NEW.id AND reason = 'user-abv' AND resolved_at IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER "wine_vintages_abv_settles_report"
  AFTER UPDATE OF "abv" ON "wine_vintages"
  FOR EACH ROW
  WHEN (OLD."abv" IS NULL AND NEW."abv" IS NOT NULL)
  EXECUTE FUNCTION public.catalog_abv_report_settle();

COMMIT;
