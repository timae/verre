-- Constrain `category` on `wines` and `wine_products` to a declared set.
--
-- ✅ DEPLOY PRECONDITION SATISFIED (2026-08-12). This migration was HELD on its
-- own branch until the catalog-maintenance side's export filter existed, because
-- they hold **21,671 rows whose category is outside this vocabulary** plus
-- **6,455 carrying styles we do not define** (2,409 dessert, 4,046 fortified).
-- Until the filter, those were pinned counts in their gate; the day this FK
-- lands they become rejections at the import boundary, and a batch is
-- all-or-nothing, so one row fails all of it.
--
-- Their filter is now in place and gated in CI, and it matches THIS FK's shape:
-- allowed `(category, style)` PAIRS rather than independent sets (a style valid
-- under one category is not exportable under another), a NULL style governed by
-- the category alone — mirroring the plain `category` FK below — and it fails
-- CLOSED, excluding an unrecognised category rather than passing it through.
-- Exclusion cascades to vintages and EANs, so no orphaned child rows arrive.
--
-- ⚠️ Their accuracy caveat, worth carrying: this is the boundary PREDICATE,
-- gated. No export run exists yet, so nothing reaches our import until their
-- exporter is built — and it is required to consume this predicate. The FK is
-- safe on the strength of the predicate and its gates, not because data has
-- already flowed.
--
-- 🔒 FUTURE STYLE RELEASES STAY OURS-THEN-THEIRS: `category_styles` rows land
-- here first, then their filter flips, then they re-pin. Their second gate fails
-- if their allowed pair set ever grows past our vocabulary. ⚠️ Note that is the
-- OPPOSITE order to the one that held this migration — there the precondition
-- was theirs. Check which side holds the precondition before assuming an order;
-- the two cases look symmetric and are not.
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

-- 🔒 TRANSACTIONAL. Prisma does NOT wrap migration SQL automatically — measured:
-- a file whose third statement fails leaves the first two COMMITTED. Same
-- contract as 20260725140000 / 160000 / 220000; its absence here was a review
-- finding (Codex, 2026-08-12) and it matters more than usual because this file
-- creates a table, seeds it, checks preconditions and then adds TWO FKs. A
-- failure between them would commit the table and one constraint while the
-- other is missing — a half-applied schema that every gate on this branch would
-- read as a legitimate state. On failure use `prisma migrate resolve
-- --rolled-back`, which is truthful ONLY because this file is transactional.
BEGIN;

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
--
-- ⚠️ COUNT > 0 IS NOT ENOUGH, and an earlier draft stopped there (Codex review,
-- 2026-08-12). The seed is derived from `category_styles`, so a future world in
-- which that table holds only some OTHER category passes a count check while
-- `wine` — the value the rest of this migration reasons about — does not exist.
-- Assert the literal, not the cardinality.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "categories";
  IF n = 0 THEN
    RAISE EXCEPTION 'categories seeded empty from category_styles — refusing to add FKs that would reject every write';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "categories" WHERE "category" = 'wine') THEN
    RAISE EXCEPTION 'categories has % row(s) but no ''wine'' — this migration reasons about that literal; refusing', n;
  END IF;
END $$;

-- ── 2. REFUSE on any row that would violate the new FK ──────────────────────
--
-- 🔒 THIS BLOCK DELIBERATELY DOES NOT REPAIR. An earlier draft ran
-- `UPDATE … SET category = 'wine'` over every null or out-of-vocabulary value,
-- and that was WRONG (Codex review, 2026-08-12): the constraint hole this
-- migration closes has been open for the life of the `wines` table, so exactly
-- the rows it would rewrite are the ones that got in THROUGH the hole. A real
-- `spirit` or `beer` row would become a permanently valid-looking `wine`, the
-- misclassification would be indistinguishable from correct data, and the
-- evidence needed to repair it properly would be destroyed by the same
-- statement that hid it. A backfill is only safe when the old value carries no
-- information; here it carries exactly the information that matters.
--
-- ⚠️ The seductive part was that it looked conservative — 'wine' is the default
-- `lib/session.ts` and `lib/catalogWrite.ts` already apply, so rewriting to it
-- reads as "make the data match what the app would have written". But the app
-- default applies to rows with NO category; these rows have one, and it
-- disagrees.
--
-- So: inventory and refuse. Deploy fails with the offending rows named, a human
-- decides per row, and the corrected data ships in its own migration before
-- this one is re-run. Prod holds ~130 `wines` rows and an empty
-- `wine_products`, so the expected outcome is zero rows and a silent pass.
DO $$
DECLARE bad_wines int; bad_products int; sample text;
BEGIN
  SELECT count(*) INTO bad_wines FROM "wines"
   WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories");
  SELECT count(*) INTO bad_products FROM "wine_products"
   WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories");
  IF bad_wines > 0 OR bad_products > 0 THEN
    SELECT string_agg(DISTINCT coalesce(c, '(null)'), ', ') INTO sample FROM (
      SELECT "category" c FROM "wines"
       WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories")
      UNION
      SELECT "category" FROM "wine_products"
       WHERE "category" IS NULL OR "category" NOT IN (SELECT "category" FROM "categories")
    ) t;
    RAISE EXCEPTION
      'refusing to add the category FK: % wines row(s) and % wine_products row(s) hold a category outside the vocabulary (values: %). These rows entered through the very hole this migration closes — rewriting them to ''wine'' would make a misclassification permanent and destroy the evidence. Decide each row, ship the correction as its own migration, then re-run this one.',
      bad_wines, bad_products, sample;
  END IF;
END $$;

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

COMMIT;
