-- Wine catalog: per-vintage grape override.
--
-- WHY. Grapes lived only on `wine_products`, so every vintage of a wine was
-- forced to share one composition. That is wrong often enough to matter: blend
-- proportions shift year to year, and a producer may drop a variety outright in
-- a difficult vintage (observed in the field — Simon, 2026-07-26). Under the
-- product-only model there was nowhere to record it.
--
-- ── Why a FLAG and not a nullable array ─────────────────────────────────────
--
-- ⚠️ THE FIRST DRAFT USED A NULLABLE `text[]` (NULL = inherit, `{}` = genuinely
-- none) and it was WRONG — not in Postgres, but through the ORM every read path
-- actually uses. Measured against the generated client:
--
--     RAW SQL : [{id:'v_empty', grapes:'{}'}, {id:'v_null', grapes:null}]
--     PRISMA  : [{id:'v_empty', grapes:[]},   {id:'v_null', grapes:[]}]
--
-- Prisma collapses NULL and `{}` to `[]` on a scalar list, so "inherit" and
-- "genuinely none" were INDISTINGUISHABLE to the application. The tri-state
-- existed only in a raw-SQL view of the table — which is exactly the toolchain
-- limitation already recorded in the plan (§ Arrays are non-null: Prisma cannot
-- model an optional scalar list).
--
-- 🔒 SO THE OVERRIDE IS AN EXPLICIT BOOLEAN, and every state is visible to both
-- SQL and Prisma:
--
--   grapes_override = false, grapes = '{}'        → INHERIT the product's
--   grapes_override = true,  grapes = '{}'        → this vintage genuinely has none
--   grapes_override = true,  grapes = ARRAY[...]  → this vintage's own composition
--
-- The effective value is:
--     CASE WHEN v.grapes_override THEN v.grapes ELSE p.grapes END
--
-- ⚠️ NOT `COALESCE` — that was the nullable design's read path and it silently
-- turns "genuinely none" back into inheritance, because `{}` is not NULL.
--
-- A CHECK forbids the fourth, incoherent combination (flag false but grapes
-- non-empty), so a hidden override cannot sit unread behind a false flag and
-- surface later if the flag is ever flipped by a different code path.
--
-- 🔒 NOTE the vintage rule is NOT the product rule. At PRODUCT grain `{}` means
-- "no grapes recorded" and IS enrichable by import (plan § Arrays are non-null).
-- At VINTAGE grain `{}` under a TRUE flag is an assertion, and import must not
-- fill it. The two grains have deliberately different missingness semantics;
-- see the plan's import section.
--
-- 🔒 NO `grapes_folded` COUNTERPART HERE, deliberately. A folded column exists
-- to be MATCHED, and 🔒 discovery/search only ever touches producer and product
-- (Simon, 2026-07-26) — a vintage is SELECTED after the fact, from the product
-- view, never searched. Verified: `lib/catalogSearch.ts` queries `producers` and
-- `wine_products` only, and no code reads `grapes_folded` at all today (the
-- product's exists for a future grape filter, which is product-scoped by the
-- same rule). Adding one here would be a generated column, on every row, that
-- nothing can ever query.

-- 🔒 TRANSACTIONAL. Prisma does not wrap migration SQL automatically; the
-- contract for every catalog migration in this directory.
BEGIN;

-- ⚠️ NO emptiness preflight here, unlike 20260725140000 / 160000 / 220000 — but
-- this migration is NOT free against a populated table, and the distinction is
-- worth stating precisely:
--
--   • THE TWO COLUMNS are metadata-only in PG 11+ (both defaults are constant),
--     so adding them does not rewrite the table. Every existing row reads as
--     `grapes_override = false`, i.e. inherit, which is the status quo.
--   • THE CHECK IS NOT. Postgres validates a new CHECK against every existing
--     row IMMEDIATELY, so § 3 below is a FULL SCAN of `wine_vintages` while
--     holding ACCESS EXCLUSIVE.
--
-- 🔒 That scan is cheap ONLY because this migration precedes the first import.
-- `wine_vintages` is projected at ~2.15M rows once the fill runs — by far the
-- largest catalog table. Adding an equivalent constraint AFTER the import must
-- use `NOT VALID` plus a separate `VALIDATE CONSTRAINT`, which takes a weaker
-- lock and does not block writes for the duration of the scan.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "wine_vintages"
  ADD COLUMN "grapes"          text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN "grapes_override" boolean NOT NULL DEFAULT false;

-- 🔒 The fourth combination is incoherent and must be unrepresentable: grapes
-- present while the flag says "inherit" would be a value no read path returns,
-- waiting to appear the moment the flag flips.
ALTER TABLE "wine_vintages"
  ADD CONSTRAINT "wine_vintages_grapes_override_check"
    CHECK ("grapes_override" OR cardinality("grapes") = 0);

COMMENT ON COLUMN "wine_vintages"."grapes" IS
  'Per-vintage grape override. Meaningful ONLY when grapes_override is true; '
  'a CHECK forbids non-empty grapes while the flag is false.';
COMMENT ON COLUMN "wine_vintages"."grapes_override" IS
  'false = inherit wine_products.grapes. true = this vintage''s grapes are '
  'authoritative, INCLUDING the empty array ("genuinely none listed"). Effective '
  'value: CASE WHEN grapes_override THEN vintage.grapes ELSE product.grapes END '
  '— never COALESCE, which would turn "genuinely none" back into inheritance.';

COMMIT;
