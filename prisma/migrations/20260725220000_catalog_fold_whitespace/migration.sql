-- Wine catalog: whitespace canonicalization in the fold, via versioned fold
-- functions.
--
-- 🔒 THE DEFECT. The folded columns are `lower(f_unaccent(x))`, which does
-- nothing about whitespace. Trimming happens only in the APP (`requiredName`
-- → `scrub` in lib/textSafe.ts), so the guarantee lives in TypeScript and
-- every non-app writer bypasses it: direct SQL, the planned import endpoint,
-- any external seed tool. Measured on the corpus the import will carry: 100
-- producer and 354 product names already hold edge whitespace.
--
--   lower(f_unaccent('Château Margaux ')) = lower(f_unaccent('Château Margaux'))
--     → FALSE  (trailing space)
--   lower(f_unaccent('Château  Margaux')) = lower(f_unaccent('Château Margaux'))
--     → FALSE  (doubled space)
--
-- ⚠️ SAME SHAPE AS THE FOLD-ORDER BUG, and invisible in the same way: pg_trgm
-- tokenises whitespace away, so trigram SEARCH keeps working and nothing looks
-- broken. What breaks is exact-equality — `findProducerByExactName`, dedupe,
-- and phase 5's exact-match-only legacy backfill. A results-based test on
-- search cannot see it.
--
-- ── Why functions, not inline expressions ───────────────────────────────────
--
-- The expression is now long enough that five inline copies in generated
-- columns plus two in query operands would drift. `catalog_fold_v1` is the ONE
-- scalar definition; `catalog_fold_arr_v1` is the ONE array definition.
--
-- 🔒 VERSIONED IN THE NAME, both of them, deliberately. Replacing an IMMUTABLE
-- function's body does NOT recompute existing STORED generated values —
-- Postgres trusts the immutability contract and never re-runs it. A future
-- semantic change MUST be `_v2` plus a column rewrite, never an edit to a v1
-- body. Editing in place would leave stored folds silently disagreeing with
-- freshly-written ones.
--
-- ⚠️ The ARRAY helper is versioned too, and this was a review finding: leaving
-- `f_unaccent_arr` unversioned and replaced-in-place would have left one of the
-- five stored columns behind a mutable name — exactly the trap the versioning
-- rule exists to prevent. `f_unaccent_arr` is dropped at the end of this file.
--
-- 🔒 `CREATE FUNCTION`, not `CREATE OR REPLACE`, for both v1 functions: they are
-- NEW. If a `catalog_fold_v1` already exists the deploy must FAIL loudly rather
-- than silently redefine a version other columns may already depend on.
--
-- ── Ordering, and why it is this order ──────────────────────────────────────
--
--   0. DELETE the invisibles `scrub` deletes  (ZWSP, BOM, bidi, LRM/RLM, …)
--   1. map Unicode whitespace → ASCII space   (NBSP et al. are NOT \s in PG)
--   2. collapse runs                          ('a  b' → 'a b')
--   3. trim                                   (edges, after 1 made them ASCII)
--   4. f_unaccent                             ('Château' → 'Chateau')
--   5. lower                                  (LAST — see 20260725140000)
--
-- ⚠️ Step 0 must precede step 1, or a deleted-then-collapsed sequence differs
-- from a collapsed-then-deleted one: 'a<ZWSP> b' → delete-first gives 'a b',
-- map-first would leave the ZWSP wedged between two spaces.
--
-- ⚠️ Step 1 before 2/3 is load-bearing: `btrim` strips ONLY ASCII spaces, and
-- PG's `\s`/`[[:space:]]` do not match U+00A0. Verified on PG 17:
--   btrim(E'x\t')      = 'x'  → FALSE   (tab survives)
--   btrim(E'x ')  = 'x'  → FALSE   (NBSP survives)
-- So "btrim then collapse" would leave both classes in the folded value.
--
-- ⚠️ Step 4 after 1–3 is safe, and this was VERIFIED rather than assumed:
-- scanning every BMP codepoint for an unaccent expansion that INTRODUCES
-- whitespace returned ZERO rows (the same scan finds 300 multi-character
-- expansions, e.g. '№'→'No', so it is not a vacuous test). No expansion can
-- re-introduce a space after step 2 has collapsed them.
--
-- 🔒 BOTH SIDES OF A FOLD CHANGE TOGETHER. The stored columns below and the
-- QUERY operands in lib/catalogSearch.ts (`trgmOrderSql`, and the exact-match
-- lookup in `findProducerByExactName`) must name the same function version. A
-- half-applied change is invisible: trigram search keeps working while exact
-- lookup silently stops matching (that is what 20260725140000 shipped).

-- 🔒 TRANSACTIONAL. Prisma does NOT wrap migration SQL automatically. Without
-- this, a failure partway through would leave the functions changed but the
-- generated columns dropped, or only some of the four indexes recreated —
-- unrecoverable without hand surgery. Same contract as 20260725140000 and
-- 20260725160000; on failure use `prisma migrate resolve --rolled-back`, which
-- is truthful ONLY because this file is transactional.
BEGIN;

-- ── 0. Preflight: lock, then prove the tables are empty ─────────────────────
--
-- 🔒 NOT REDUNDANT with "the catalog is empty today". Two distinct hazards:
--   • A staff write (the fence bypass) can land between the check that
--     motivated this migration and the moment it deploys. The count runs
--     INSIDE the lock, so nothing can slip in between.
--   • An old reader holding a conflicting lock would otherwise make the
--     ACCESS EXCLUSIVE acquisition wait indefinitely, hanging the deploy.
--     `lock_timeout` converts that into a fast, legible failure.
-- Identical to the preflight in 20260725140000 § 0.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "producers", "wine_products" IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE n_prod bigint; n_wp bigint;
BEGIN
  SELECT count(*) INTO n_prod FROM public."producers";
  SELECT count(*) INTO n_wp   FROM public."wine_products";
  IF n_prod > 0 OR n_wp > 0 THEN
    RAISE EXCEPTION
      'catalog is not empty (producers=%, wine_products=%) — dropping and re-adding the generated columns rewrites both tables under ACCESS EXCLUSIVE. Schedule this as a maintenance migration with a measured rewrite window, lock_timeout, verified backup, and a rollback plan.',
      n_prod, n_wp;
  END IF;
END $$;

-- ── 1. The versioned scalar fold ────────────────────────────────────────────
--
-- STRICT: NULL in → NULL out, matching the nullable `region` columns.
--
-- The whitespace class is ENUMERATED, not a class shorthand — PG's own classes
-- are exactly what gets this wrong. Written as a `U&'…'` escape string so every
-- codepoint is ASCII-VISIBLE: an earlier draft embedded the literal characters,
-- which is unreviewable (a reviewer cannot see one go missing). Verified on
-- PG 17: this class matches exactly 19 BMP codepoints, with no over-match.
--
--   0085 NEL · 00A0 NBSP · 1680 OGHAM SPACE MARK · 2000-200A EN QUAD..HAIR
--   SPACE · 2028 LINE SEP · 2029 PARA SEP · 202F NARROW NBSP · 205F MEDIUM
--   MATHEMATICAL SPACE · 3000 IDEOGRAPHIC SPACE
--
-- 🔒 STEP 0 — DELETE the invisibles first, matching `SCRUB_RE` in lib/textSafe.ts.
--
-- ⚠️ THIS WAS A REVIEW CORRECTION, and the first draft got it wrong. It mapped
-- U+2028/U+2029 to a space and PRESERVED U+200B, on the reasoning that folding a
-- zero-width character to a space would split a word. True — but DELETION is the
-- third option, and it is what the app already does: `SCRUB_RE` strips U+200B,
-- U+200E, U+200F, U+2028, U+2029 and U+FEFF for exactly the reason this fold
-- exists ("two visually-identical names can be byte-different").
--
-- Leaving them meant the SAME raw name got DIFFERENT keys depending on the
-- writer — app-written rows were scrubbed, imported rows were not. Measured on
-- PG 17 before the fix: `Châ<ZWSP>teau Margaux` folded to `cha<ZWSP>teau margaux`
-- from an import but `chateau margaux` through the app. Four characters diverged
-- (U+200B, U+200E, U+FEFF, and the 2028/2029 space-mapping mismatch), which is
-- precisely the cross-writer inconsistency this migration set out to remove.
--
-- 🔒 ZWNJ (U+200C) and ZWJ (U+200D) are deliberately PRESERVED, matching the app:
-- they are REQUIRED for correct ligature rendering in Persian, Arabic, Hindi and
-- other scripts. Deleting them would corrupt real names.
--
-- Pinned by a parity assertion: `catalog_fold_v1(raw) = catalog_fold_v1(scrub(raw))`
-- over the scrub character set. Folding protects MATCHING; a future importer must
-- still sanitize the DISPLAY value it stores.
CREATE FUNCTION catalog_fold_v1(text) RETURNS text AS $$
  SELECT lower(
           f_unaccent(
             btrim(
               regexp_replace(
                 regexp_replace(
                   regexp_replace($1,
                     U&'[\0001\0002\0003\0004\0005\0006\0007\0008\000B\000C\000E\000F\0010\0011\0012\0013\0014\0015\0016\0017\0018\0019\001A\001B\001C\001D\001E\001F\007F\200B\200E\200F\2028\2029\202A\202B\202C\202D\202E\2066\2067\2068\2069\FEFF]',
                     '', 'g'),
                   U&'[\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000]',
                   ' ', 'g'),
                 '\s+', ' ', 'g')
             )
           )
         )
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

COMMENT ON FUNCTION catalog_fold_v1(text) IS
  'Catalog matching key: unicode-space → ASCII, collapse, trim, unaccent, lower. '
  'VERSIONED — never edit this body; a semantic change needs _v2 + a column rewrite, '
  'because IMMUTABLE means Postgres will not recompute STORED generated columns.';

-- ── 2. The versioned array fold ─────────────────────────────────────────────
--
-- Per-element, so grapes fold identically to scalars. STRICT + COALESCE
-- preserved verbatim from `f_unaccent_arr` (20260725140000): NULL in → NULL
-- out, and {} folds to {} rather than NULL (array_agg over zero rows returns
-- NULL), keeping "no grapes recorded" distinguishable from unknown.
CREATE FUNCTION catalog_fold_arr_v1(text[]) RETURNS text[] AS $$
  SELECT COALESCE(array_agg(catalog_fold_v1(elem) ORDER BY ord), '{}'::text[])
  FROM unnest($1) WITH ORDINALITY AS t(elem, ord)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

COMMENT ON FUNCTION catalog_fold_arr_v1(text[]) IS
  'Element-wise catalog_fold_v1 over a text[]. VERSIONED for the same reason as '
  'the scalar: a STORED generated column depends on it.';

-- ── 3. Blank-name CHECKs stop using bare btrim ──────────────────────────────
--
-- 🔒 SEPARATE DEFECT, found while verifying the fold. These CHECKs claim to
-- reject blank names but use `btrim(name) <> ''`, and btrim strips only ASCII
-- spaces. Verified on PG 17 — all three of these currently PASS:
--   btrim(E'\t')       <> ''  → TRUE   (tab-only name accepted)
--   btrim(E'\n')       <> ''  → TRUE   (newline-only name accepted)
--   btrim(E' ')   <> ''  → TRUE   (NBSP-only name accepted)
-- Routing through the fold closes all three: each folds to '' and is rejected.
ALTER TABLE "producers"
  DROP CONSTRAINT "producers_name_not_blank_check",
  DROP CONSTRAINT "producers_region_not_blank_check";
ALTER TABLE "producers"
  ADD CONSTRAINT "producers_name_not_blank_check"
    CHECK (catalog_fold_v1("name") <> ''),
  ADD CONSTRAINT "producers_region_not_blank_check"
    CHECK ("region" IS NULL OR catalog_fold_v1("region") <> '');

ALTER TABLE "wine_products"
  DROP CONSTRAINT "wine_products_name_not_blank_check",
  DROP CONSTRAINT "wine_products_region_not_blank_check";
ALTER TABLE "wine_products"
  ADD CONSTRAINT "wine_products_name_not_blank_check"
    CHECK (catalog_fold_v1("name") <> ''),
  ADD CONSTRAINT "wine_products_region_not_blank_check"
    CHECK ("region" IS NULL OR catalog_fold_v1("region") <> '');

-- ── 4. Re-generate the folded columns on the versioned functions ────────────
--
-- ⚠️ A column DROP takes its indexes with it — § 5 recreates all four.
ALTER TABLE "producers"
  DROP COLUMN "name_folded",
  DROP COLUMN "region_folded";

ALTER TABLE "producers"
  ADD COLUMN "name_folded"   text GENERATED ALWAYS AS (catalog_fold_v1("name"))   STORED,
  ADD COLUMN "region_folded" text GENERATED ALWAYS AS (catalog_fold_v1("region")) STORED;

ALTER TABLE "wine_products"
  DROP COLUMN "name_folded",
  DROP COLUMN "region_folded",
  DROP COLUMN "grapes_folded";

ALTER TABLE "wine_products"
  ADD COLUMN "name_folded"   text   GENERATED ALWAYS AS (catalog_fold_v1("name"))     STORED,
  ADD COLUMN "region_folded" text   GENERATED ALWAYS AS (catalog_fold_v1("region"))   STORED,
  ADD COLUMN "grapes_folded" text[] GENERATED ALWAYS AS (catalog_fold_arr_v1("grapes")) STORED;

-- ── 5. Recreate the four indexes the column drops removed ───────────────────
--
-- 🔒 NOT OPTIONAL, and their absence would not fail visibly: without the GiST
-- indexes catalog search still returns CORRECT ROWS and merely seq-scans; the
-- covering B-trees are what make the exact-equality path an Index Only Scan.
-- Definitions identical to 20260725160000 (GiST KNN) — verified against
-- pg_indexes on a migrated database rather than transcribed from memory.
CREATE INDEX "producers_name_folded_gist_idx"
  ON "producers" USING gist ("name_folded" gist_trgm_ops);
CREATE INDEX "producers_name_folded_idx"
  ON "producers" USING btree ("name_folded", "id") INCLUDE ("status");

CREATE INDEX "wine_products_name_folded_gist_idx"
  ON "wine_products" USING gist ("name_folded" gist_trgm_ops);
CREATE INDEX "wine_products_name_folded_idx"
  ON "wine_products" USING btree ("name_folded", "id") INCLUDE ("status");

-- ── 6. Retire the unversioned array helper ──────────────────────────────────
--
-- Safe only now that `grapes_folded` has been re-generated on
-- `catalog_fold_arr_v1` in § 4 — the DROP would otherwise fail on the
-- dependency, which is the backstop making this ordering self-enforcing.
DROP FUNCTION f_unaccent_arr(text[]);

COMMIT;
