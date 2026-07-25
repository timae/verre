-- Wine catalog — phase 1, domain schema.
--
-- Spec of record: docs/dev/proposals/wine-catalog.md (the model) +
-- docs/dev/proposals/wine-catalog-implementation.md (the build plan, § Phase 1).
--
-- Ships: staff_roles + staff_role_audit, the four catalog tables
-- (producers, wine_products, product_producers, wine_vintages), product_eans,
-- the wines.product_id/vintage_id link columns, and catalog_audit.
-- Everything structural, nothing user-facing — no route reads these yet.
--
-- The file is in two halves. Above the RAW SQL banner is what Prisma generates
-- from schema.prisma. Below it is everything Prisma's datamodel CANNOT express,
-- and that half is not decoration: THE CONSTRAINTS ARE THE CONTRACT. It carries
--   • the generated folded columns (the single normalization path for matching)
--   • the pg_trgm GIN indexes those columns exist to serve
--   • UNIQUE NULLS NOT DISTINCT (product_id, year) — without it, unlimited
--     duplicate NV rows
--   • the partial unique that bounds leads at one
--   • the deferred constraint triggers that bound leads at >= one
--   • every value-domain and lifecycle CHECK
--
-- ⚠️ The two halves are NOT independent, and the check-schema CI gate is what
-- proves it. `prisma migrate diff` ignores what it cannot MODEL (functions,
-- CHECKs, triggers, the partial unique, NULLS NOT DISTINCT) — but it does NOT
-- ignore what it can SEE. Verified: the generated columns and the trgm indexes
-- below are visible to the diff and DID fail the gate until they were declared
-- in schema.prisma. So each of them has a counterpart there:
--   • name_folded / region_folded / grapes_folded — declared as plain fields
--     with @default(dbgenerated(...)) matching the expression below. Prisma has
--     no generated-column syntax, so the declaration is what keeps the gate
--     green; THIS FILE is what actually makes them generated.
--   • the trgm indexes — declared with an explicit `map:` so the generated name
--     matches the name used here.
--   • UNIQUE NULLS NOT DISTINCT (product_id, year) — declared as a plain
--     @@unique with a matching `map:`. That declaration is DELIBERATELY WEAKER
--     than what ships: Prisma cannot express NULLS NOT DISTINCT, so the
--     declaration attests the constraint EXISTS and this file supplies its
--     strength.
-- Consequence for anyone editing either file: changing a generation expression,
-- an index name, or that unique here without updating schema.prisma turns the
-- build red. That coupling is deliberate — it is the only thing keeping the two
-- representations honest with each other.

-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "product_id" VARCHAR(21),
ADD COLUMN     "vintage_id" VARCHAR(21);

-- CreateTable
CREATE TABLE "staff_roles" (
    "user_id" INTEGER NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "granted_by" INTEGER,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "staff_role_audit" (
    "id" SERIAL NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "actor_id" INTEGER,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_role_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producers" (
    "id" VARCHAR(21) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "country" VARCHAR(2),
    "region" VARCHAR(255),
    "website" VARCHAR(512),
    "status" VARCHAR(16) NOT NULL DEFAULT 'provisional',
    "links_to" VARCHAR(21),
    "curator_locked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "added_by" INTEGER,
    "curated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wine_products" (
    "id" VARCHAR(21) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "category" VARCHAR(32) NOT NULL DEFAULT 'wine',
    "style" VARCHAR(64),
    "abv" DECIMAL(4,2),
    "grapes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "region" VARCHAR(255),
    "scope" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'provisional',
    "links_to" VARCHAR(21),
    "curator_locked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "added_by" INTEGER,
    "curated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wine_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_producers" (
    "product_id" VARCHAR(21) NOT NULL,
    "producer_id" VARCHAR(21) NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_producers_pkey" PRIMARY KEY ("product_id","producer_id")
);

-- CreateTable
CREATE TABLE "wine_vintages" (
    "id" VARCHAR(21) NOT NULL,
    "product_id" VARCHAR(21) NOT NULL,
    "year" INTEGER,
    "abv" DECIMAL(4,2),
    "status" VARCHAR(16) NOT NULL DEFAULT 'provisional',
    "links_to" VARCHAR(21),
    "curator_locked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "added_by" INTEGER,
    "curated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wine_vintages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_eans" (
    "ean" VARCHAR(14) NOT NULL,
    "product_id" VARCHAR(21) NOT NULL,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_eans_pkey" PRIMARY KEY ("ean")
);

-- CreateTable
CREATE TABLE "catalog_audit" (
    "id" SERIAL NOT NULL,
    "entity_type" VARCHAR(16) NOT NULL,
    "entity_id" VARCHAR(21) NOT NULL,
    "target_id" VARCHAR(21),
    "action" VARCHAR(24) NOT NULL,
    "prior_status" VARCHAR(16),
    "actor_id" INTEGER,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_roles_role_idx" ON "staff_roles"("role");

-- CreateIndex
CREATE INDEX "staff_role_audit_subject_id_id_idx" ON "staff_role_audit"("subject_id", "id");

-- CreateIndex
CREATE INDEX "producers_status_idx" ON "producers"("status");

-- CreateIndex
CREATE INDEX "producers_links_to_idx" ON "producers"("links_to");

-- CreateIndex
CREATE INDEX "wine_products_status_idx" ON "wine_products"("status");

-- CreateIndex
CREATE INDEX "wine_products_links_to_idx" ON "wine_products"("links_to");

-- CreateIndex
CREATE INDEX "product_producers_producer_id_idx" ON "product_producers"("producer_id");

-- CreateIndex
CREATE INDEX "wine_vintages_status_idx" ON "wine_vintages"("status");

-- CreateIndex
CREATE INDEX "wine_vintages_links_to_idx" ON "wine_vintages"("links_to");

-- CreateIndex
CREATE UNIQUE INDEX "wine_vintages_id_product_id_key" ON "wine_vintages"("id", "product_id");

-- CreateIndex
CREATE INDEX "product_eans_product_id_idx" ON "product_eans"("product_id");

-- CreateIndex
CREATE INDEX "catalog_audit_entity_type_entity_id_id_idx" ON "catalog_audit"("entity_type", "entity_id", "id");

-- CreateIndex
CREATE INDEX "catalog_audit_created_at_idx" ON "catalog_audit"("created_at" DESC);

-- CreateIndex
CREATE INDEX "wines_product_id_idx" ON "wines"("product_id");

-- CreateIndex
CREATE INDEX "wines_vintage_id_idx" ON "wines"("vintage_id");

-- AddForeignKey
ALTER TABLE "wines" ADD CONSTRAINT "wines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "wine_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wines" ADD CONSTRAINT "wines_vintage_id_product_id_fkey" FOREIGN KEY ("vintage_id", "product_id") REFERENCES "wine_vintages"("id", "product_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "producers" ADD CONSTRAINT "producers_links_to_fkey" FOREIGN KEY ("links_to") REFERENCES "producers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "producers" ADD CONSTRAINT "producers_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "producers" ADD CONSTRAINT "producers_curated_by_fkey" FOREIGN KEY ("curated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_products" ADD CONSTRAINT "wine_products_links_to_fkey" FOREIGN KEY ("links_to") REFERENCES "wine_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_products" ADD CONSTRAINT "wine_products_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_products" ADD CONSTRAINT "wine_products_curated_by_fkey" FOREIGN KEY ("curated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_products" ADD CONSTRAINT "wine_products_category_style_fkey" FOREIGN KEY ("category", "style") REFERENCES "category_styles"("category", "style") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_producers" ADD CONSTRAINT "product_producers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "wine_products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_producers" ADD CONSTRAINT "product_producers_producer_id_fkey" FOREIGN KEY ("producer_id") REFERENCES "producers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_vintages" ADD CONSTRAINT "wine_vintages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "wine_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_vintages" ADD CONSTRAINT "wine_vintages_links_to_fkey" FOREIGN KEY ("links_to") REFERENCES "wine_vintages"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_vintages" ADD CONSTRAINT "wine_vintages_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wine_vintages" ADD CONSTRAINT "wine_vintages_curated_by_fkey" FOREIGN KEY ("curated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_eans" ADD CONSTRAINT "product_eans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "wine_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ═══════════════════════════════════════════════════════════════════════════
-- RAW SQL — everything schema.prisma cannot express.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The fold helpers ────────────────────────────────────────────────────
--
-- `name` preserves the accented display form; `name_folded` is the MATCHING
-- KEY. One value cannot serve both jobs. The fold is produced by ONE mandatory
-- database-side path — a STORED generated column — so no write path can make
-- display and fold drift.
--
-- f_unaccent(text) already exists as IMMUTABLE PARALLEL SAFE STRICT from
-- 20260705120000_moments_search_unaccent (the moments-search migration), so
-- generated columns and functional trgm indexes over it are legal here with no
-- new plumbing. A generated column requires IMMUTABLE, which is exactly why
-- that wrapper pins the dictionary argument.
--
-- The array variant needs its own wrapper because a generated column cannot
-- contain a subquery — it must be a single function call.
--
-- ⚠️ STRICT is load-bearing twice over:
--   • NULL in → NULL out, so a NULL array folds to NULL rather than {}.
--   • Combined with the COALESCE, {} folds to {} rather than NULL. Without the
--     COALESCE, array_agg over ZERO ROWS returns NULL, not {} — so an empty
--     array would silently become NULL in the folded column and empty would
--     stop being distinguishable from unknown at the matching layer.
-- Both directions matter: for `grapes`, {} means "no grapes recorded" and is
-- enrichable, and the fold must not quietly convert that into something else.
CREATE OR REPLACE FUNCTION f_unaccent_arr(text[]) RETURNS text[] AS $$
  SELECT COALESCE(array_agg(f_unaccent(lower(elem)) ORDER BY ord), '{}'::text[])
  FROM unnest($1) WITH ORDINALITY AS t(elem, ord)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- ── 2. Generated folded columns ────────────────────────────────────────────
--
-- STORED (not VIRTUAL — Postgres 16 supports only STORED) so they are
-- indexable. Prisma models generated columns as read-only at best and cannot
-- emit them, hence raw SQL; migrate diff ignores the generation expression, so
-- this does not register as drift.
ALTER TABLE "producers"
  ADD COLUMN "name_folded"   text GENERATED ALWAYS AS (f_unaccent(lower("name")))   STORED,
  ADD COLUMN "region_folded" text GENERATED ALWAYS AS (f_unaccent(lower("region"))) STORED;

ALTER TABLE "wine_products"
  ADD COLUMN "name_folded"   text   GENERATED ALWAYS AS (f_unaccent(lower("name")))   STORED,
  ADD COLUMN "region_folded" text   GENERATED ALWAYS AS (f_unaccent(lower("region"))) STORED,
  ADD COLUMN "grapes_folded" text[] GENERATED ALWAYS AS (f_unaccent_arr("grapes"))    STORED;

-- ── 3. pg_trgm GIN indexes on the folded columns ───────────────────────────
--
-- These serve the ONE matcher (RFC § Add-a-wine flow): add-time search,
-- review-queue suggestions, and post-import rescans all run the same query over
-- *_folded. There is no second matcher to drift — the old TS/SQL fuzzy-parity
-- CI-gate debt from PR #82 is struck.
--
-- Unlike the moments-search case (always scoped to one caller's handful of
-- rows), catalog matching scans TABLE-WIDE across a large catalog, so the
-- indexes are needed from the start rather than deferred.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔒 HOW TO WRITE THE QUERY, OR THIS INDEX DOES NOTHING. Read this before
-- writing any catalog search — it is not obvious and it is easy to get wrong in
-- a way that still returns correct rows, just slowly.
--
-- Measured on PG16 with 60k producers:
--
--   'query' <% name_folded     → Bitmap Index Scan     1.2 ms   ✅
--   name_folded %> 'query'     → Bitmap Index Scan     1.2 ms   ✅
--   'query' %> name_folded     → Seq Scan            140.0 ms   ❌
--   name_folded <% 'query'     → Seq Scan            140.0 ms   ❌
--   word_similarity('query', name_folded) >= 0.3
--                              → Seq Scan  (NEVER indexable)    ❌
--
-- Three separate traps in that table:
--
--  1. ⚠️ `word_similarity(...) >= 0.3` — the form the moments-search migration
--     (20260705120000) documents — CANNOT use a trgm index AT ALL, in any
--     operand order. A function call is not an indexable operator. It is fine
--     THERE (that query is always narrowed to one caller's few sessions first)
--     but it is the pattern most likely to be copied into a table-wide catalog
--     scan, where it degrades to a full seq scan of the whole catalog.
--
--  2. ⚠️ The operator and the operand order must MATCH. `<%` takes the QUERY on
--     the left; `%>` takes the COLUMN on the left. They are not commutative and
--     the mismatched pairings silently seq-scan. "Put the column first" is NOT
--     the rule — it is only right for `%>`.
--
--  3. ⚠️ These operators read the threshold from a GUC that DEFAULTS TO 0.6,
--     not the 0.3 tuned against real data. Without setting it the search is
--     silently stricter than intended and misses real typos. Set it with
--     SET LOCAL inside a transaction:
--
--       BEGIN;
--       SET LOCAL pg_trgm.word_similarity_threshold = 0.3;
--       SELECT id, name FROM producers WHERE $1 <% name_folded
--       ORDER BY word_similarity($1, name_folded) DESC LIMIT 20;
--       COMMIT;
--
--     🔒 SET LOCAL, NEVER a bare SET. Verified: SET LOCAL reverts at COMMIT,
--     while a bare SET persists on the connection — and on a POOLED connection
--     that leaks the threshold into every later query that reuses it. Avoiding
--     that leak is exactly why the moments-search migration inlined
--     word_similarity() instead of using the operator; SET LOCAL is what lets us
--     have the index without reintroducing the hazard.
--
-- Note `word_similarity()` in ORDER BY is fine and useful — the operator does
-- the indexed FILTERING, the function does the SCORING on the surviving rows.
-- Also mirrored in prisma/CLAUDE.md and the implementation proposal § Phase 2.
-- ══════════════════════════════════════════════════════════════════════════
CREATE INDEX "producers_name_folded_trgm_idx"
  ON "producers" USING gin ("name_folded" gin_trgm_ops);
CREATE INDEX "wine_products_name_folded_trgm_idx"
  ON "wine_products" USING gin ("name_folded" gin_trgm_ops);

-- ── 4. Vintage uniqueness — one row per year, one NV row per product ───────
--
-- 🔒 NULLS NOT DISTINCT is the entire point and is why this cannot be an
-- @@unique in schema.prisma. Postgres treats NULLs as distinct by DEFAULT, so
-- a plain compound unique would permit UNLIMITED null-year rows — i.e. an
-- unbounded pile of duplicate NV rows on one product, exactly the duplication
-- this constraint exists to prevent.
--
-- Recall year = null means THE NON-VINTAGE INSTANCE EXCLUSIVELY, never "year
-- unknown" (an unknown-year rating links at product grain with vintage_id
-- null). So "at most one NV row per product" is a real business rule, not an
-- artifact.
ALTER TABLE "wine_vintages"
  ADD CONSTRAINT "wine_vintages_product_year_key"
  UNIQUE NULLS NOT DISTINCT ("product_id", "year");

-- ── 5. Exactly one lead — piece 1 of 3: AT MOST ONE ────────────────────────
--
-- 🔒 The composite PK (product_id, producer_id) does NOT substitute for this,
-- and assuming it does is the trap. Verified against PG16: the PK blocks
-- duplicate PAIRS while happily allowing two DIFFERENT producers on the same
-- product both marked 'lead' (a test insert produced 2 leads on one product).
CREATE UNIQUE INDEX "product_producers_one_lead_idx"
  ON "product_producers" ("product_id") WHERE "role" = 'lead';

-- ── 6. Exactly one lead — pieces 2 and 3: AT LEAST ONE ─────────────────────
--
-- 🔒 "At least one child row exists" is NOT declaratively expressible in
-- Postgres — no CHECK can see other rows, and the partial unique above only
-- bounds the UPPER side. So the lower bound lives in triggers.
--
-- Chosen over a write-path helper at the phase-1 review gate (2026-07-24).
-- The deciding question was whether the invariant must be claimable as
-- DATABASE-enforced, and only this route gets there: a helper plus a CI gate is
-- enforcement by discipline, bypassable by raw SQL, a psql session, or a future
-- code path nobody remembered. It also covers the phase-4 import path — which
-- writes producer links from outside the add-flow — for free.
--
-- SCOPE OF THE CLAIM, stated precisely rather than as "unbypassable" — three
-- acknowledged exclusions, all verified against PG16:
--   • `TRUNCATE product_producers` bypasses it. Row-level triggers do not fire
--     on TRUNCATE; catching it needs a BEFORE TRUNCATE … FOR EACH STATEMENT
--     trigger, which CANNOT be a constraint trigger and therefore cannot be
--     deferred. Not added: TRUNCATE is not a code path, and the seed's
--     truncate fence (RFC § Seed + the truncate fence) governs its one
--     legitimate use.
--   • `SET LOCAL session_replication_role = replica` bypasses it (it disables
--     FK triggers too — a known operator-level escape hatch).
--   • `ALTER TABLE … DISABLE TRIGGER` bypasses it, though only from a clean
--     transaction: with trigger events already pending, Postgres refuses the
--     ALTER.
-- All three require table-owner or superuser, i.e. the same trust level that
-- could drop the constraint outright. The claim is therefore: unbypassable by
-- any ordinary application write path, including ones not yet written.
--
-- 🔒 INITIALLY DEFERRED is MANDATORY, not a preference. An IMMEDIATE trigger
-- fires on the delete/demote and blocks the LEGITIMATE swap before the
-- replacement lands. Deferring to COMMIT is what makes the transient
-- zero-lead state (invisible outside the transaction) legal while the
-- committed state never is.
--
-- ⚠️ Two ordering traps the trigger permits but callers still must respect,
-- because the IMMEDIATE partial unique in §5 is not deferred:
--   • Remove or demote the old lead FIRST, then insert or promote. Promoting
--     the new lead first fails the partial unique — the old lead still exists.
--   • REPLACEMENT IS NOT ALWAYS AN INSERT. If the incoming lead is already a
--     collaborator on that product (the common promotion case), inserting a
--     second (product_id, producer_id) row fails the composite PK. It must be
--     UPDATE … SET role = 'lead'. A replace path that only ever inserts is
--     broken for exactly the case most likely to occur.
--
-- 🔒 THE PURGE CARVE-OUT. The staff hard-purge deletes a product and its join
-- rows in one transaction. Without the parent-existence check below, this
-- invariant would block its own cleanup path: at COMMIT the join rows are gone,
-- so a naive "does this product still have a lead?" check would raise on a
-- product that no longer exists. The guard is to look up the parent first and
-- return quietly when it is gone. product_producers.product_id is ON DELETE
-- CASCADE precisely so the purge does not have to sequence this by hand.
CREATE OR REPLACE FUNCTION catalog_product_requires_lead(p_product_id varchar(21))
RETURNS void AS $$
BEGIN
  -- Purge carve-out: the parent product is gone in this same transaction, so
  -- there is no invariant left to satisfy.
  IF NOT EXISTS (SELECT 1 FROM public."wine_products" WHERE "id" = p_product_id) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."product_producers"
    WHERE "product_id" = p_product_id AND "role" = 'lead'
  ) THEN
    RAISE EXCEPTION
      'wine_products % has no lead producer (exactly-one-lead invariant)',
      p_product_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

-- Piece 3 — AT LEAST ONE OVER TIME. Fires on DELETE and on ANY UPDATE.
--
-- 🔒 The UPDATE arm is the one that gets skipped, and it is the reason this
-- covers demotion at all: demoting the sole lead to 'collaborator' DELETES
-- NOTHING, so a delete-focused guard never fires and the product silently ends
-- up lead-less. Both arms are required.
--
-- ⚠️ AND IT MUST BE A BARE `UPDATE`, NOT `UPDATE OF "role"`. This is a fixed
-- defect, recorded because the narrow form looks obviously sufficient and is
-- not: `UPDATE OF <col>` fires only when that column appears in the statement's
-- SET list, so `UPDATE … SET product_id = …` — RE-POINTING a lead link to a
-- different product — never fired it, and the ORIGIN product committed with
-- ZERO leads. Verified against PG16 before the fix:
--
--   BEGIN;
--     INSERT INTO wine_products(id,…) VALUES ('fb',…);
--     UPDATE product_producers SET product_id='fb' WHERE product_id='fa';
--   COMMIT;                      -- succeeded
--   -- fa: 0 leads (committed!), fb: 1 lead
--
-- Worse than a bare zero-lead state: that ONE statement also satisfied the
-- creation trigger for the new product by STEALING the old product's lead row,
-- defeating both halves of the invariant at once. The `OF` clause bought
-- nothing — this guard is cheap and idempotent — while also narrowing away any
-- demotion issued via a form Postgres compiles without `role` in the target
-- list.
--
-- 🔒 Both SIDES must be checked on an UPDATE, for the same reason: OLD alone
-- misses nothing on a demotion (same product both sides) but a re-point changes
-- product_id, so the origin is OLD and the destination is NEW. Checking only
-- NEW would invert the original bug.
CREATE OR REPLACE FUNCTION catalog_pp_lead_guard() RETURNS trigger AS $$
BEGIN
  PERFORM catalog_product_requires_lead(OLD."product_id");
  IF TG_OP = 'UPDATE' AND NEW."product_id" IS DISTINCT FROM OLD."product_id" THEN
    PERFORM catalog_product_requires_lead(NEW."product_id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER "product_producers_lead_required"
  AFTER DELETE OR UPDATE ON "product_producers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog_pp_lead_guard();

-- Piece 2 — AT LEAST ONE AT CREATION. Without this arm the invariant is only
-- half-covered: a plain INSERT INTO wine_products with no join row would
-- commit a lead-less product and nothing would object. Including it is what
-- lets the invariant be described as database-enforced rather than
-- "enforced except at creation".
CREATE OR REPLACE FUNCTION catalog_product_lead_guard() RETURNS trigger AS $$
BEGIN
  PERFORM catalog_product_requires_lead(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER "wine_products_lead_required"
  AFTER INSERT ON "wine_products"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog_product_lead_guard();

-- ── 7. Lifecycle CHECKs ────────────────────────────────────────────────────
--
-- Structurally enforced on every catalog entity table: a tombstone ALWAYS has
-- a pointer, a pointer ALWAYS means 'linked', and no row links to itself.
-- Merge/unmerge update status, pointer, and the catalog_audit row atomically in
-- ONE transaction, so a partial write can never produce an unreadable tombstone.
--
-- Chains are KEPT, not flattened (with A→B then B→C, flattening A to A→C would
-- break single-update unmerge). Reads resolve transitively with a visited set
-- and a depth cap, so corrupt data fails safely instead of looping.
ALTER TABLE "producers"
  ADD CONSTRAINT "producers_status_check"
    CHECK ("status" IN ('provisional','confirmed','linked','archived','rejected')),
  ADD CONSTRAINT "producers_linked_pointer_check"
    CHECK (("status" = 'linked') = ("links_to" IS NOT NULL)),
  ADD CONSTRAINT "producers_no_self_link_check"
    CHECK ("links_to" IS DISTINCT FROM "id"),
  -- Blank required names are rejected at the DATABASE, not only in the route,
  -- so no write path can bypass it. This is not hypothetical: f_unaccent(
  -- lower('')) is '', not NULL, so every blank-name entry would fold to the
  -- SAME key and fuzzy-match as an exact collision — minting one shared
  -- catalog identity where there should be none. The live precedent is in
  -- lib/session.ts, where clean() is `scrub(v) ?? ''` (null → '' into Redis)
  -- while the Postgres mirror uses `|| null` ('' → null): same value, two
  -- representations, decided by different operators in different files.
  ADD CONSTRAINT "producers_name_not_blank_check"
    CHECK (btrim("name") <> ''),
  -- Optional facts that participate in matching normalize blank → NULL at the
  -- boundary; region is a fact rather than an identity field, but it feeds
  -- region_folded and joins the fold, so a blank there still collides.
  ADD CONSTRAINT "producers_region_not_blank_check"
    CHECK ("region" IS NULL OR btrim("region") <> '');

ALTER TABLE "wine_products"
  ADD CONSTRAINT "wine_products_status_check"
    CHECK ("status" IN ('provisional','confirmed','linked','archived','rejected')),
  ADD CONSTRAINT "wine_products_linked_pointer_check"
    CHECK (("status" = 'linked') = ("links_to" IS NOT NULL)),
  ADD CONSTRAINT "wine_products_no_self_link_check"
    CHECK ("links_to" IS DISTINCT FROM "id"),
  ADD CONSTRAINT "wine_products_name_not_blank_check"
    CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "wine_products_region_not_blank_check"
    CHECK ("region" IS NULL OR btrim("region") <> ''),
  -- The deferred ownership axis. 'owned' is not reachable in v1 — every write
  -- boundary sets scope EXPLICITLY (creation rejects a missing scope rather
  -- than relying on the column default) so a future owned entry can never leak
  -- to public because a caller omitted the field.
  ADD CONSTRAINT "wine_products_scope_check"
    CHECK ("scope" IN ('shared','owned')),
  -- ABV is a percentage, and this is a GARBAGE FENCE, not a style-specific
  -- validation. ⚠️ Note DECIMAL(4,2) already caps the magnitude at 99.99, so a
  -- <= 100 bound would be UNREACHABLE and the constraint would be decoration
  -- (verified: inserting 135 raises "numeric field overflow" from the type,
  -- never reaching the CHECK). 25 is the bound that actually bites — fortified
  -- wine tops out near 22.
  ADD CONSTRAINT "wine_products_abv_range_check"
    CHECK ("abv" IS NULL OR ("abv" >= 0 AND "abv" <= 25));

ALTER TABLE "wine_vintages"
  ADD CONSTRAINT "wine_vintages_status_check"
    CHECK ("status" IN ('provisional','confirmed','linked','archived','rejected')),
  ADD CONSTRAINT "wine_vintages_linked_pointer_check"
    CHECK (("status" = 'linked') = ("links_to" IS NOT NULL)),
  ADD CONSTRAINT "wine_vintages_no_self_link_check"
    CHECK ("links_to" IS DISTINCT FROM "id"),
  ADD CONSTRAINT "wine_vintages_abv_range_check"
    CHECK ("abv" IS NULL OR ("abv" >= 0 AND "abv" <= 25)),
  -- Plausible-year fence for the lightweight vintage-add path (RFC § Vintage
  -- curation is lightweight). Deliberately a wide floor rather than a tight
  -- one: the upper bound is what actually matters (a typo'd 20255), and the
  -- route applies the tighter current-year + 1 rule. NULL is the NV row.
  ADD CONSTRAINT "wine_vintages_year_range_check"
    CHECK ("year" IS NULL OR ("year" >= 1800 AND "year" <= 2200));

-- ── 8. Remaining value-domain CHECKs ───────────────────────────────────────
ALTER TABLE "product_producers"
  ADD CONSTRAINT "product_producers_role_check"
    CHECK ("role" IN ('lead','collaborator'));

-- admin IMPLIES curator — the resolver (lib/staffRole.ts) answers a
-- curator-level check affirmatively for an admin grant, so each person holds
-- exactly ONE row and there is no "grant both" state to keep consistent.
ALTER TABLE "staff_roles"
  ADD CONSTRAINT "staff_roles_role_check"
    CHECK ("role" IN ('admin','curator'));

ALTER TABLE "staff_role_audit"
  ADD CONSTRAINT "staff_role_audit_role_check"
    CHECK ("role" IN ('admin','curator')),
  ADD CONSTRAINT "staff_role_audit_action_check"
    CHECK ("action" IN ('grant','revoke'));

ALTER TABLE "catalog_audit"
  ADD CONSTRAINT "catalog_audit_entity_type_check"
    CHECK ("entity_type" IN ('producer','product','vintage')),
  ADD CONSTRAINT "catalog_audit_action_check"
    CHECK ("action" IN ('merge','unmerge','confirm','reject','archive',
                        'lock_field','unlock_field','purge','edit')),
  ADD CONSTRAINT "catalog_audit_prior_status_check"
    CHECK ("prior_status" IS NULL OR "prior_status" IN
           ('provisional','confirmed','linked','archived','rejected')),
  -- 🔒 BIDIRECTIONAL, not one-directional. The earlier form only stopped a
  -- target_id on a NON-merge action, which let the opposite defect through: a
  -- 'merge' row with target_id NULL was accepted (verified). That row is
  -- worthless for the table's whole purpose — without the target there is no
  -- survivor to identify, so the merge is not reconstructible.
  ADD CONSTRAINT "catalog_audit_target_check"
    CHECK (("action" IN ('merge','unmerge')) = ("target_id" IS NOT NULL)),
  -- 🔒 A merge additionally REQUIRES prior_status. Unmerge must restore the
  -- loser's pre-merge lifecycle state exactly (a pre-merge `provisional` must
  -- not come back `confirmed`), and that state is captured here at merge time.
  -- A merge row without it silently makes the unmerge unrestorable. Unmerge
  -- itself does not carry one — it is the operation that CONSUMES the value.
  ADD CONSTRAINT "catalog_audit_merge_prior_status_check"
    CHECK ("action" <> 'merge' OR "prior_status" IS NOT NULL);

-- EANs are canonicalized to digits before storage. 🔒 Stored as a STRING, never
-- numeric — a numeric type drops the leading zero and corrupts every 0-prefixed
-- EAN-13. Check-digit validation is applied at the write boundary; this
-- constraint is the shape fence.
ALTER TABLE "product_eans"
  -- 🔒 EXACT lengths, not a range. `{8,14}` also accepted 9-, 10- and 11-digit
  -- values (verified: a 9-digit insert succeeded), which are not valid GTINs at
  -- all. The real world has exactly four: EAN-8, UPC-A (12), EAN-13, GTIN-14.
  -- A range here would let malformed barcodes become permanent identity keys.
  ADD CONSTRAINT "product_eans_format_check"
    CHECK ("ean" ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'),
  -- last_seen is monotonic (advanced with GREATEST, never rewound) and is
  -- explicitly exempt from the fill-null rule — under fill-null-only a
  -- non-null last_seen would never advance, freezing at first sight.
  -- first_seen is write-once. Neither is enforceable declaratively; this
  -- constraint pins only their ordering.
  ADD CONSTRAINT "product_eans_seen_order_check"
    CHECK ("last_seen" >= "first_seen");

-- ── 9. Array columns are NOT NULL ──────────────────────────────────────────
--
-- 🔒 Prisma emits scalar lists WITHOUT `NOT NULL`, so this must be added by
-- hand. Verified: without these statements `grapes` and all three
-- `curator_locked` columns ship as nullable, and both a NULL INSERT and
-- `UPDATE … SET grapes = NULL` succeed.
--
-- ⚠️ THIS IS NOT COSMETIC — it breaks the phase-4 import fill, specifically.
-- The whole array-missingness design rests on `{}` being the SOLE
-- representation of "unrecorded" (there is no known-empty state in v1; a
-- deliberate empty becomes authoritative only via curatorLocked). The fill rule
-- is `CASE WHEN cardinality(existing) = 0 THEN incoming ELSE existing END` —
-- and `cardinality(NULL)` is NULL, not 0, which is falsy in a CASE. So a
-- NULL-grapes row would be PERMANENTLY UNENRICHABLE: exactly the failure mode
-- the non-null design exists to prevent, arriving through the representation
-- the design assumed impossible.
--
-- ⚠️ And it is invisible from the application side, which is what makes it
-- dangerous rather than merely wrong: the Prisma client coerces NULL → [] on
-- read, so a NULL row and a `{}` row are INDISTINGUISHABLE through the client
-- while the raw-SQL fill treats them oppositely. Silent drift between the two
-- access paths.
--
-- The DEFAULTs Prisma emits (ARRAY[]::TEXT[]) mean these are safe to enforce:
-- an omitted column still lands `{}`, never NULL.
ALTER TABLE "wine_products"  ALTER COLUMN "grapes"         SET NOT NULL;
ALTER TABLE "producers"      ALTER COLUMN "curator_locked" SET NOT NULL;
ALTER TABLE "wine_products"  ALTER COLUMN "curator_locked" SET NOT NULL;
ALTER TABLE "wine_vintages"  ALTER COLUMN "curator_locked" SET NOT NULL;

-- ── 10. updated_at must actually advance ───────────────────────────────────
--
-- 🔒 `@default(now())` sets the value ONCE, on insert, and nothing moves it
-- afterwards. Verified against the pre-fix schema: updating a producer's name
-- left updated_at unchanged. That is not cosmetic — the phase-4 pull leg's
-- `(updatedAt, id)` keyset walk uses this column to find edits, so a frozen
-- timestamp means the export SILENTLY OMITS every update. The consumer reads in
-- order, sees nothing new, and advances its cursor.
--
-- 🔒 A TRIGGER, NOT PRISMA'S `@updatedAt`. `@updatedAt` is applied by the Prisma
-- CLIENT, so it covers only writes that go through the client — and the writers
-- that matter most here do not: the phase-4 import applies rows in raw SQL, and
-- curation/merge paths use $executeRaw for the constraint-sensitive updates. A
-- column whose freshness depends on which access path wrote it is exactly the
-- kind of invariant this migration puts in the database instead.
--
-- Deliberately NOT applied to product_eans: `last_seen` is that table's
-- freshness signal and is advanced explicitly with GREATEST (monotonic, never
-- rewound), while `first_seen` is write-once.
CREATE OR REPLACE FUNCTION catalog_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "producers_touch_updated_at"
  BEFORE UPDATE ON "producers"
  FOR EACH ROW EXECUTE FUNCTION catalog_touch_updated_at();

CREATE TRIGGER "wine_products_touch_updated_at"
  BEFORE UPDATE ON "wine_products"
  FOR EACH ROW EXECUTE FUNCTION catalog_touch_updated_at();

CREATE TRIGGER "wine_vintages_touch_updated_at"
  BEFORE UPDATE ON "wine_vintages"
  FOR EACH ROW EXECUTE FUNCTION catalog_touch_updated_at();

-- ── 11. Audit tables are append-only, and the DB owns the clock ────────────
--
-- 🔒 The 🔒-prose in schema.prisma claimed these rows are "NEVER updated or
-- deleted" while nothing enforced it. Verified against the pre-fix schema: a
-- reviewer rewrote a row's actor_id, DELETED a row, and inserted one dated
-- 1999. For a PRIVILEGE audit log — the record that answers "who granted this
-- person admin" — a comment is not a control.
--
-- The precedent is `prevent_session_hard_delete` in this same database
-- (20260514183437), which makes the session soft-delete rule a DB invariant
-- rather than an app convention. Same shape here.
--
-- ⚠️ THREE holes, and blocking UPDATE/DELETE closes only two. The third is
-- BACKDATED FAKE INSERTS: an append-only table whose timestamps the writer
-- chooses cannot establish when anything happened. So a BEFORE INSERT trigger
-- OVERWRITES any supplied created_at with the server clock. A caller may still
-- append a false *statement*, but never a false *time*, and never alter or
-- remove what is already recorded.
--
-- Residual, named honestly: this stops the application role from rewriting
-- history, not a superuser (who can drop the triggers). Restricting the runtime
-- DB role to SELECT/INSERT on these tables is the stronger control and is an
-- operator-level change, not a migration — see prisma/CLAUDE.md.
CREATE OR REPLACE FUNCTION audit_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'relation % is append-only: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION audit_force_created_at() RETURNS trigger AS $$
BEGIN
  NEW."created_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE TRIGGER "staff_role_audit_immutable"
  BEFORE UPDATE OR DELETE ON "staff_role_audit"
  FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();

CREATE TRIGGER "staff_role_audit_force_created_at"
  BEFORE INSERT ON "staff_role_audit"
  FOR EACH ROW EXECUTE FUNCTION audit_force_created_at();

CREATE TRIGGER "catalog_audit_immutable"
  BEFORE UPDATE OR DELETE ON "catalog_audit"
  FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();

CREATE TRIGGER "catalog_audit_force_created_at"
  BEFORE INSERT ON "catalog_audit"
  FOR EACH ROW EXECUTE FUNCTION audit_force_created_at();

-- ── 12. The last admin cannot be removed — by ANY path ────────────────────
--
-- 🔒 The app-layer guard in lib/staffRole.ts defended only against ITSELF.
-- `staff_roles.user_id` is ON DELETE CASCADE, so `DELETE FROM users` removed a
-- grant without ever consulting it. Verified against the pre-fix schema:
--   • The sole admin deleting their own account → 0 admins, silent, unaudited.
--     `DELETE /api/me/account` is a live self-service endpoint needing no
--     privilege at all.
--   • Racing a revoke against an account deletion → 8/10 trials reached ZERO
--     admins. `SELECT … FOR UPDATE` locks the rows it RETURNS; it cannot make a
--     count taken before another transaction's commit re-evaluate afterwards.
--
-- 🔒 SERIALIZATION IS THE POINT, NOT COUNTING. A trigger that merely counts
-- admins reproduces the same race: two concurrent removals each see two admins
-- and both proceed. So every removal path first takes ONE advisory lock on a
-- fixed key, which forces delete-vs-delete and delete-vs-revoke into a real
-- order before either counts. Same lock in the app-layer revoke path
-- (lib/staffRole.ts), so the two paths serialize against EACH OTHER and not
-- merely within themselves.
--
-- pg_advisory_xact_lock (not FOR UPDATE) because the resource being protected is
-- "the set of admin grants" — an emptiness property of the whole set, not any
-- particular row. Row locks cannot guard a property of rows that may not exist
-- yet. It releases at transaction end, so no unlock bookkeeping.
--
-- Consequence, deliberately accepted (Simon, 2026-07-25): A SOLE ADMIN CANNOT
-- DELETE THEIR OWN ACCOUNT until they grant admin to someone else. Their
-- deletion request fails with this exception. That is preferred over silently
-- ending with zero admins and a lockout recoverable only via production DB
-- credentials.
-- ⚠️ DELETE IS NOT THE ONLY WAY TO REACH ZERO ADMINS, and a DELETE-only trigger
-- is a fixed defect. `UPDATE staff_roles SET role='curator'` on the sole admin
-- deletes nothing, so a delete-only guard never fires — verified: it left the
-- database with ZERO admins. This is the same class of miss as the
-- `UPDATE OF "role"` lead-trigger defect in § 6: the removal that isn't a
-- deletion. Since user_id is the PK, a demotion is an UPDATE of `role`, so the
-- guard must cover UPDATE too, with the SAME lock and count.
CREATE OR REPLACE FUNCTION staff_roles_protect_last_admin() RETURNS trigger AS $$
DECLARE
  remaining int;
BEGIN
  -- ⚠️ EVERY early return must yield NEW on an UPDATE. A `BEFORE UPDATE` trigger
  -- that returns OLD SILENTLY DISCARDS THE ROW'S NEW VALUES — the statement
  -- still reports success, so the caller sees `UPDATE 1` and no error while
  -- nothing changed. That is exactly what broke the curator → admin promotion:
  -- OLD.role was 'curator', this guard early-returned OLD, and the promotion
  -- vanished while the caller reported a successful promotion.
  --
  -- Only removals of an ADMIN grant matter here. On UPDATE, a row that stays
  -- 'admin' is not a removal (e.g. re-stamping granted_by), so it passes through.
  IF OLD."role" <> 'admin' OR (TG_OP = 'UPDATE' AND NEW."role" = 'admin') THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Serialize every admin-removal path against every other one. Must be taken
  -- BEFORE the count, or the count is a snapshot that a concurrent committer
  -- invalidates.
  PERFORM pg_advisory_xact_lock(hashtext('verre:staff_roles:admin'));
  SELECT count(*) INTO remaining
    FROM public."staff_roles" WHERE "role" = 'admin' AND "user_id" <> OLD."user_id";
  IF remaining = 0 THEN
    RAISE EXCEPTION
      'cannot remove the last admin grant (user %)', OLD."user_id"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'grant admin to another user first: INSERT INTO staff_roles (user_id, role) VALUES (<id>, ''admin'')';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE TRIGGER "staff_roles_last_admin_guard"
  BEFORE DELETE OR UPDATE OF "role" ON "staff_roles"
  FOR EACH ROW EXECUTE FUNCTION staff_roles_protect_last_admin();

-- 🔒 The account-delete cascade must also leave HISTORY. Blocking the lockout
-- without auditing would fix the availability problem and keep the forensic one:
-- a grant that vanished with an account would have no revoke record at all.
--
-- ⚠️ THIS MUST HANG OFF `users`, NOT `staff_roles` — a fixed defect. An
-- AFTER DELETE ON staff_roles trigger fires for EVERY role-row deletion, so it
-- unconditionally stamped `actor=NULL, reason='account deletion'` onto
-- deliberate revokes too. Verified: a plain revoke produced TWO audit rows (the
-- real one plus a false 'account deletion'), and deleting a role row while its
-- user still existed was labelled an account deletion. That turns the audit log
-- into a liar about the one thing it exists to record — WHO removed privilege.
--
-- Hanging it off `users` makes the condition structural rather than guessed: the
-- trigger can only run when a user row is actually being deleted. It is BEFORE
-- DELETE so it runs ahead of the cascade — which also means it rolls back
-- cleanly if the last-admin guard then rejects that cascade, leaving no orphan
-- audit row for a deletion that never happened.
--
-- actorId = NULL + reason = 'account deletion' is the DOCUMENTED CONTRACT for
-- this row (see the StaffRoleAudit model comment): inside a cascade there is no
-- trustworthy way to obtain the authenticated actor, and inventing one would be
-- worse than recording none. That pairing means "privilege ended because the
-- account went away", never "an admin did this".
CREATE OR REPLACE FUNCTION users_audit_staff_role_on_delete() RETURNS trigger AS $$
BEGIN
  -- 🔒 TAKE THE ADVISORY LOCK HERE, BEFORE THE CASCADE — this is a DEADLOCK FIX,
  -- not bookkeeping. Lock-order analysis of the two removal paths:
  --
  --   app revoke       : advisory lock  →  staff_roles row lock
  --   account deletion : users row lock →  (cascade)  →  staff_roles row lock
  --                      →  last-admin trigger requests advisory lock
  --
  -- Those orders are OPPOSITE, so the two paths could each hold what the other
  -- wanted: Postgres 40P01. Reproduced against the previous version — 1 in 15
  -- races on an idle local database, and contention only makes that worse.
  -- Ordering the app path "advisory first" fixed app-vs-app but could not fix
  -- this, because the cascade's row lock is taken by Postgres before any trigger
  -- of ours runs.
  --
  -- This trigger is BEFORE DELETE ON users, so it fires before the row is
  -- deleted and before the cascade reaches staff_roles. Acquiring the advisory
  -- lock here makes the deletion path ALSO "advisory first", so both paths take
  -- the two locks in the same order and a cycle is impossible.
  --
  -- Taken unconditionally, not only when the user holds a grant: a conditional
  -- lock would reintroduce the inversion for exactly the rows that matter, and
  -- the lock is cheap (uncontended it is a single hashtable insert).
  PERFORM pg_advisory_xact_lock(hashtext('verre:staff_roles:admin'));
  INSERT INTO public."staff_role_audit" ("subject_id", "role", "action", "actor_id", "reason")
  SELECT OLD."id", sr."role", 'revoke', NULL, 'account deletion'
  FROM public."staff_roles" sr WHERE sr."user_id" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE TRIGGER "users_audit_staff_role_on_delete"
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_audit_staff_role_on_delete();

-- ── 13. wines link-state CHECK ────────────────────────────────────────────
--
-- 🔒 The composite FK (vintage_id, product_id) → wine_vintages (id, product_id)
-- alone does NOT catch this, and that is the whole reason the CHECK exists:
-- the FK is MATCH SIMPLE, so it SKIPS THE CHECK ENTIRELY whenever any of its
-- columns is null — including the (null product, set vintage) case.
--
-- Valid: (set, set) known vintage or the NV row · (set, null) known product,
-- unknown year · (null, null) legacy or unmatched. (null, set) is invalid.
ALTER TABLE "wines"
  ADD CONSTRAINT "wines_catalog_link_check"
    CHECK ("vintage_id" IS NULL OR "product_id" IS NOT NULL);
