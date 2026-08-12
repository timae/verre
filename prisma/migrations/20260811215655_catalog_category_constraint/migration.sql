-- Constrain `category` on `wines` and `wine_products` to a declared set.
--
-- 🔒 DEPLOY ORDER: THIS MIGRATION IS NOT SAFE TO SHIP ALONE. Raised by the
-- catalog-maintenance side 2026-08-12 and it governs when this may deploy.
--
-- They hold **21,671 rows whose category is outside prod's vocabulary**, plus
-- **6,455 carrying styles we do not define** (2,409 dessert, 4,046 fortified).
-- Today those are *pinned counts* in their gate — a tripwire. The day this
-- migration deploys they become **rejections at the import boundary**, and an
-- import batch is all-or-nothing, so one row fails the whole batch.
--
-- ⚠️ REQUIRED BEFORE THIS DEPLOYS: their export filter must exclude those rows.
-- That is their step 9/10 and does not exist yet.
--
-- ✅ The OTHER migration on this branch (`20260811213521`, the fold search_path
-- pin) IS safe to ship alone and should not be held behind this one — the two
-- have different deployment risk despite sharing a branch. If this branch merges
-- as one unit, that is a decision to deploy both, and this one is the gate.
--
-- (The reverse ordering — their filter first, then this — is the safe one and
-- is the same shape as the dessert/fortified sequencing in the RFC, which runs
-- ours-then-theirs because there the precondition is on our side. Here it is on
-- theirs. Check which side holds the precondition before assuming an order.)
--
-- 🔒 THE DEFECT. `category` was constrained ONLY by the composite FK
-- `(category, style)` → `category_styles`. That FK is MATCH SIMPLE, so it skips
-- the check ENTIRELY whenever either column is NULL — and `style` is nullable by
-- design ("a wine whose style we don't know yet"). Measured on PG 16, on BOTH
-- tables:
--
--   category='spirit', style='grappa'  → REJECTED   (FK fires, both non-null)
--   category='spirit', style=NULL      → ACCEPTED   ← the hole
--
-- ⚠️ THIS IS THE SAME TRAP THIS CODEBASE ALREADY GUARDS AGAINST TWICE. The
-- `wines.vintage_id`/`product_id` pair carries an explicit
-- `CHECK (vintage_id IS NULL OR product_id IS NOT NULL)` precisely because its
-- composite FK is MATCH SIMPLE, and `20260725090000` warns about it in prose.
-- It was simply never applied to `category`. Knowing a trap and having applied
-- it everywhere are different things.
--
-- 🔒 WHY NOW: `lib/catalogWrite.ts` takes a caller-supplied `category` string
-- (`input.category?.trim() || 'wine'`) with no validation, and `style` is
-- optional on the same path. That is the write path `CATALOG_PUBLIC_ENABLED`
-- opens. Until this lands, the only thing keeping non-wine out of the wine
-- catalog is the catalog-maintenance side's pinned export count — which they
-- correctly describe as a promise plus a tripwire, not a constraint. They found
-- 30 rows in their own corpus carrying a `wine` category while being pomace
-- brandies at 35–50% ABV; our schema would not have rejected them either.
--
-- ── Shape: a `categories` table, not a CHECK ────────────────────────────────
--
-- ⚠️ A `CHECK (category IN (SELECT …))` is NOT legal in Postgres — a CHECK
-- cannot contain a subquery. The first sketch of this fix was written that way
-- and would not have deployed. The two shapes that DO work are a trigger or a
-- referenced table; a table is chosen because:
--
--   • It keeps "add beer/spirits later" an INSERT rather than a migration,
--     which is the property that made this a blocker in the first place
--     (`wines.category` is documented as intended to extend beyond wine).
--   • A real FK is declarative and cannot be bypassed, whereas a trigger is
--     app-adjacent logic that a future `DISABLE TRIGGER` silently defeats.
--   • It gives categories a home for future attributes (display label, sort
--     order) without another restructure.
--
-- `category_styles` cannot serve as the FK target: its PK is the PAIR
-- `(category, style)`, so there is no row to reference for a category alone.
--
-- 🔒 NOT NULL on `style` was the alternative and is deliberately NOT taken: it
-- would forbid "known product, unknown style", which is a legitimate state the
-- add-flow relies on. This fix leaves `style` optional and constrains only the
-- column that was genuinely unguarded.

-- ── 1. The category vocabulary ──────────────────────────────────────────────
--
-- Seeded from what actually exists rather than from a guess: `category_styles`
-- holds exactly one category today (`wine`, across five styles). A new category
-- is one INSERT here plus its styles in `category_styles`.
CREATE TABLE "categories" (
  "category"   VARCHAR(32) PRIMARY KEY,
  "label"      VARCHAR(64) NOT NULL,
  "sort_order" INTEGER     NOT NULL DEFAULT 0,
  "active"     BOOLEAN     NOT NULL DEFAULT true
);

COMMENT ON TABLE "categories" IS
  'Declared drink-category vocabulary. FK target for wines.category and '
  'wine_products.category, which the (category, style) composite FK cannot '
  'constrain alone because it is MATCH SIMPLE and style is nullable. '
  'Extending: INSERT here, then the styles into category_styles.';

INSERT INTO "categories" ("category", "label", "sort_order")
SELECT DISTINCT cs."category", initcap(cs."category"), 0
FROM "category_styles" cs;

-- 🔒 Fail loudly rather than ship an empty vocabulary. If `category_styles`
-- were ever empty, the FKs below would reject EVERY write — an outage, not a
-- constraint. The non-vacuity check belongs here, at the moment the set is
-- derived, not in a later test.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "categories";
  IF n = 0 THEN
    RAISE EXCEPTION 'categories seeded empty from category_styles — refusing to add FKs that would reject every write';
  END IF;
END $$;

-- ── 2. Repair any row that would violate the new FK ─────────────────────────
--
-- ⚠️ NOT a no-op assumption. `wines` is a live table (prod holds ~130 rows) and
-- the hole above has been open for its whole life, so an out-of-vocabulary
-- value may exist. Anything unrecognised becomes 'wine' — the same default
-- `lib/session.ts` and `lib/catalogWrite.ts` already apply — rather than
-- failing the deploy on data the constraint is being added to govern.
-- `wine_products` is empty today; the same statement is harmless there and
-- correct if that stops being true.
UPDATE "wines" SET "category" = 'wine'
 WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories");

UPDATE "wine_products" SET "category" = 'wine'
 WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories");

-- ── 3. The constraints ──────────────────────────────────────────────────────
--
-- Plain single-column FKs, so MATCH SIMPLE is irrelevant: `category` is NOT NULL
-- on both tables, so the FK always has a value to check. The composite
-- `(category, style)` FK stays — it still governs the PAIR when a style is
-- given. The two are complementary: the composite one rejects a wrong style for
-- a category, this one rejects a category outright.
--
-- 🔒 `NO ACTION` on delete, matching the eight other forward FKs into catalog
-- reference data: removing a category that products still reference must FAIL,
-- never cascade into product rows or silently null a column that is NOT NULL.
ALTER TABLE "wines"
  ADD CONSTRAINT "wines_category_fkey"
  FOREIGN KEY ("category") REFERENCES "categories"("category")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "wine_products"
  ADD CONSTRAINT "wine_products_category_fkey"
  FOREIGN KEY ("category") REFERENCES "categories"("category")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
