-- Canonical wine product catalog (docs/dev/proposals — wine product pages).
--
-- Introduces `wine_products`: one row per real-world bottle, the aggregation
-- anchor for the public product page (GET /api/wines/[productId]) and the
-- reuse target for future wine-entry lookup. Every `wines` row (a per-session
-- or per-checkin INSTANCE) gains a nullable `product_id` FK, populated by a
-- deterministic find-or-create on a normalized (producer, name, vintage)
-- match key at the Postgres-write boundary (lib/wineProductLink.ts).
--
-- Additive + data backfill in one file, following the rewire_phase2_data
-- precedent (prisma/CLAUDE.md): `prisma migrate diff` (the check-schema CI
-- gate) compares DDL only, so the backfill INSERT/UPDATE below are invisible
-- to it — the gate stays green as long as the DDL matches schema.prisma.
--
-- ── PARITY (highest-risk invariant) ────────────────────────────────────────
-- The match key MUST be byte-identical between this SQL and the runtime TS
-- (lib/wineProductKey.ts), or a wine created after this migration would mint a
-- second product instead of joining its backfilled one. Parity is achieved by
-- normalizing through the Unicode NFD STANDARD (Postgres normalize(x, NFD) ==
-- JS String.prototype.normalize('NFD')), NOT through Postgres `unaccent` —
-- whose dictionary (æ→ae, ø→o, ß→ss …) has no JS equivalent and would diverge.
-- The algorithm, in exact order, is: NFD-decompose → strip combining marks
-- [U+0300–U+036F] → lowercase → collapse every [^a-z0-9] run to one space →
-- trim. Both sides implement precisely this. scripts/ has a parity test.

-- IMMUTABLE so the functions are legal in an expression index later and the
-- planner can constant-fold. PARALLEL SAFE mirrors f_unaccent.
CREATE OR REPLACE FUNCTION f_wine_norm(text) RETURNS text AS $$
  SELECT btrim(regexp_replace(
    lower(regexp_replace(normalize(coalesce($1, ''), NFD), '[\u0300-\u036f]', '', 'g')),
    '[^a-z0-9]+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- chr(1) (U+0001) separator can never appear in normalized output (which is
-- only [a-z0-9 ]), so "ab"+"c" and "a"+"bc" can't collide.
CREATE OR REPLACE FUNCTION f_wine_match_key(producer text, name text, vintage text) RETURNS text AS $$
  SELECT f_wine_norm(producer) || chr(1) || f_wine_norm(name) || chr(1) || f_wine_norm(vintage)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- CreateTable
CREATE TABLE "wine_products" (
    "id" VARCHAR(21) NOT NULL,
    "match_key" VARCHAR(600) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "producer" VARCHAR(255),
    "vintage" CHAR(4),
    "grape" VARCHAR(255),
    "category" VARCHAR(32) NOT NULL DEFAULT 'wine',
    "style" VARCHAR(64),
    "region" VARCHAR(255),
    "country" VARCHAR(2),
    "vinification" VARCHAR(1000),
    "description" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wine_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wine_products_match_key_key" ON "wine_products"("match_key");

-- CreateIndex (pg_trgm GIN — future entry-time fuzzy autocomplete; mirrors wines)
CREATE INDEX "wine_products_name_idx" ON "wine_products" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "wine_products_producer_idx" ON "wine_products" USING GIN ("producer" gin_trgm_ops);

-- AlterTable
ALTER TABLE "wines" ADD COLUMN "product_id" VARCHAR(21);

-- CreateIndex
CREATE INDEX "wines_product_id_idx" ON "wines"("product_id");

-- AddForeignKey (product_id → wine_products; SetNull — product is derived
-- reference data, deleting one must never delete wine rows/ratings)
ALTER TABLE "wines" ADD CONSTRAINT "wines_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "wine_products"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey (composite (category, style) → category_styles; mirrors wines,
-- MATCH SIMPLE so it only enforces when both columns are non-null)
ALTER TABLE "wine_products" ADD CONSTRAINT "wine_products_category_style_fkey"
    FOREIGN KEY ("category", "style") REFERENCES "category_styles"("category", "style")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

------------------------------------------------------------------------
-- DATA BACKFILL (invisible to prisma migrate diff)
--
-- Group every existing wine row (with a non-empty normalized name) by its
-- match key into one product; then point the wines at their product.
-- Canonical metadata precedence: identity + a VALID (category, style) pair
-- come from one representative row (earliest created); the enrichable
-- nullable fields fill first-non-null across the group (fill-nulls accretion,
-- matching lib/wineProductLink.ts at runtime).
------------------------------------------------------------------------

WITH keyed AS (
    SELECT w.*, f_wine_match_key(w.producer, w.name, w.vintage) AS mk
    FROM "wines" w
    WHERE f_wine_norm(w.name) <> ''
),
rep AS (
    -- one representative per key: identity + a consistent (category, style) pair
    SELECT DISTINCT ON (mk) mk, name, producer, vintage, category, style
    FROM keyed
    ORDER BY mk, created_at ASC
),
enrich AS (
    SELECT mk,
        (array_agg(grape        ORDER BY created_at) FILTER (WHERE grape        IS NOT NULL))[1] AS grape,
        (array_agg(region       ORDER BY created_at) FILTER (WHERE region       IS NOT NULL))[1] AS region,
        (array_agg(country      ORDER BY created_at) FILTER (WHERE country      IS NOT NULL))[1] AS country,
        (array_agg(vinification ORDER BY created_at) FILTER (WHERE vinification IS NOT NULL))[1] AS vinification,
        (array_agg(description  ORDER BY created_at) FILTER (WHERE description  IS NOT NULL))[1] AS description
    FROM keyed
    GROUP BY mk
)
INSERT INTO "wine_products"
    (id, match_key, name, producer, vintage, grape, category, style, region, country, vinification, description, created_at, updated_at)
SELECT
    left(replace(gen_random_uuid()::text, '-', ''), 21),
    r.mk, r.name, r.producer, r.vintage,
    e.grape, r.category, r.style, e.region, e.country, e.vinification, e.description,
    now(), now()
FROM rep r JOIN enrich e USING (mk)
ON CONFLICT (match_key) DO NOTHING;

UPDATE "wines" w
SET product_id = p.id
FROM "wine_products" p
WHERE p.match_key = f_wine_match_key(w.producer, w.name, w.vintage)
  AND f_wine_norm(w.name) <> '';
