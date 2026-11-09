-- Wine catalog: split the product `style` token into colour / sparkling / style.
--
-- Spec of record: docs/dev/proposals/catalog-colour-sparkling.md.
--
-- One `style` token (`red | white | rose | spark | nonalc`) conflated three
-- independent facts: the colour, whether it is sparkling, and whether it is a
-- dessert or fortified wine. A sparkling rosé or a sweet sparkling wine could
-- not be expressed, and `nonalc` is an alcohol fact (`abv` already carries it).
-- After this migration a catalog wine product is:
--
--   colour     varchar(16) NULL           red | white | rose, NULL = unknown
--   sparkling  boolean NOT NULL DEFAULT false
--   style      unchanged column, narrowed  dessert | fortified | NULL
--
-- 🔒 CATALOG TABLES ONLY. `wines` keeps the old tokens until the catalog model
-- change replaces it with occurrences (wine-catalog-model-change.md). Every
-- user surface derives structure axes from `wines.style`, cached Redis lineups
-- write it back to Postgres, and shipped native builds send and read it, so
-- narrowing it here would build the new shape twice and put the risk where the
-- data is. Consequence: `category_styles` keeps the five old `wine/*` pairs
-- (`wines` references them), so the composite FK alone would still accept
-- `wine_products.style = 'red'`. The CHECK in § 4 is what binds catalog rows.
--
-- 🔒 CONTRACT EVENT. `wine_products` is a contract table and the style CHECK
-- rejects payloads that were valid before (rejection-surface test), so both new
-- CHECKs are `contract`-scoped in prisma/catalog-contract-checks.json and the
-- contract version moves 1 → 2. The vocabulary rows in § 3 follow the
-- ours-then-theirs order on the CategoryStyle comment: they land here first,
-- and the catalog-maintenance side flips its export filter only after this is
-- confirmed deployed.
--
-- 🔒 TRANSACTIONAL. Prisma does not wrap migration SQL (20260811215655). A
-- failure between the column adds and the CHECKs would otherwise commit an
-- unconstrained `colour` column.
--
-- ⚠️ ON FAILURE (the refusal in § 1, or the lock timeout): Prisma records the
-- migration as failed and every later deploy aborts with P3009 until it is
-- resolved. ⚠️ BOTH causes print the same generic "current transaction is
-- aborted" in the deploy output (measured: Prisma reports the LAST error, not
-- the RAISE). The refusal's own message, with the row count and the values,
-- is in the Postgres server log; or re-run the § 1 SELECT by hand. For a lock
-- timeout, find the holder with the pg_locks query in docs/dev/deployment.md
-- § PRE-DEPLOY CHECK. Recovery, as in 20260725140000 (header, step 3): clear
-- the cause, confirm nothing was applied (the transaction guarantees it: no
-- `colour` column, no `wine/dessert` row), then
--
--   npx prisma migrate resolve --rolled-back 20261109120000_catalog_colour_sparkling
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

-- `prisma migrate deploy` runs outside the app's statement_timeout, so without
-- this a long-running reader of `wine_products` would hang the deploy
-- indefinitely. Taken before the lock so the refusal below reads a table
-- nothing can write to until COMMIT (every ALTER below needs ACCESS EXCLUSIVE
-- anyway).
SET LOCAL lock_timeout = '5s';
LOCK TABLE "wine_products" IN ACCESS EXCLUSIVE MODE;

-- ── 1. REFUSE, never translate ──────────────────────────────────────────────
--
-- 🔒 No mapping UPDATE. Prod held 0 catalog rows when this was written, and the
-- only writer is a staff-only endpoint with no UI, so translation code would be
-- untested code guarding an empty table. Converting existing style values is
-- the user-wine migration's job at the model change. The predicate is the
-- negation of `wine_products_style_check` below, so this names exactly the
-- rows that CHECK would reject, with a count and the values (in the Postgres
-- log, see the header), instead of a bare constraint violation. Verified once
-- on a scratch database: refused, and left no column, vocabulary row or CHECK.
DO $$
DECLARE n int; vals text;
BEGIN
  SELECT count(*), string_agg(DISTINCT "style", ', ')
    INTO n, vals
    FROM "wine_products"
   WHERE "category" = 'wine' AND "style" IS NOT NULL AND "style" NOT IN ('dessert', 'fortified');
  IF n > 0 THEN
    RAISE EXCEPTION
      'refusing to narrow wine_products.style: % wine product row(s) hold a style outside dessert/fortified (values: %). This migration translates nothing. Move each row to colour/sparkling by hand in its own migration, then re-run this one.',
      n, vals;
  END IF;
END $$;

-- ── 2. The two new attributes ───────────────────────────────────────────────
--
-- A constant default is metadata-only on PG 11+, so NOT NULL DEFAULT false does
-- not rewrite the table. `sparkling` has no unknown state by ruling: a wrong
-- default is corrected by an edit, not by enrichment.
ALTER TABLE "wine_products"
  ADD COLUMN "colour"    VARCHAR(16),
  ADD COLUMN "sparkling" BOOLEAN NOT NULL DEFAULT false;

-- ── 3. The vocabulary grows (ours first) ────────────────────────────────────
--
-- This also makes the pairs FK-valid on `wines`. Nothing can write them there:
-- every user path validates against a hardcoded five-token list, and no
-- runtime code reads `category_styles`.
INSERT INTO "category_styles" ("category", "style", "label", "sort_order", "active") VALUES
  ('wine', 'dessert',   'Dessert Wine',   60, true),
  ('wine', 'fortified', 'Fortified Wine', 70, true);

-- ── 4. The constraints ──────────────────────────────────────────────────────
--
-- No orange: orange / skin-contact wine is `white` (ruled 2026-11-09).
--
-- 🔒 The style CHECK is SCOPED TO WINE. A new category stays "INSERT into
-- `categories`, then its styles into `category_styles`", never a migration
-- (prisma/CLAUDE.md § category); other categories are constrained by the
-- composite FK alone. An unscoped `style IN ('dessert','fortified')` would
-- make every future beer or spirit style a schema change.
--
-- The style CHECK becomes redundant once `wines` stops carrying `style` and the
-- five old pairs are deleted from `category_styles` (deferred to the model
-- change). Dropping it then only loosens.
ALTER TABLE "wine_products"
  ADD CONSTRAINT "wine_products_colour_check"
    CHECK ("colour" IS NULL OR "colour" IN ('red', 'white', 'rose')),
  ADD CONSTRAINT "wine_products_style_check"
    CHECK ("category" <> 'wine' OR "style" IS NULL OR "style" IN ('dessert', 'fortified'));

COMMIT;
