-- Catalogue model change, step 7b: one search field for the bottle picker
-- (`.local` plan r8; spec § 7 + § 12). Three VERRE-OWNED tables feed the
-- every-word search in lib/catalogSearch.ts (`searchBottles`, `searchProducers`);
-- the catalogue tables are untouched.
--
--   catalog_search_docs            one row per wine_products row (every status and
--                                  scope: the read filters live), its words stored
--                                  (producer, the lead's effective survivor when the
--                                  lead is a merge tombstone, name, region) + two
--                                  tsvectors (tsv_name without region, tsv with it)
--   catalog_search_producer_docs   one row per producers row
--   catalog_search_words           every lexeme of both, with how many LIVE docs
--                                  hold it (`ndoc`, a rough rarity signal; 0 for a
--                                  word only rejected / archived / owned entries or
--                                  no doc at all hold, never offered as a typo). 🔒 The list never
--                                  decides whether a wine is found, only whether a
--                                  typo lookup runs: a typed word is always its own
--                                  alternative. So it is kept loosely (a mint adds
--                                  its new words after its COMMIT, best effort; the
--                                  rebuild refreshes ndoc and never deletes a word).
--
-- 🔒 NO FOREIGN KEYS, deliberately: a stale doc is never served (the read joins the
-- catalogue live for name, status, scope and lead), and an inbound key would join
-- the catalogue's FK contract (scripts/check-catalog-inbound-fks.mjs), force delete
-- ordering on every catalogue writer and tie these tables to the
-- catalogue-maintenance side's deliveries. Kept current by OUR writes
-- (lib/catalogWrite.ts: createProducer / createProduct / purgeProduct) + the
-- rebuild after each catalogue load (scripts/rebuild-catalog-search.mts, whose dry
-- run is the drift report) + a CI census (scripts/check-catalog-writes.mjs).
--
-- 🔒 The tokeniser is ONE definition for docs and queries, parser-free (no
-- text-search configuration, no locale): `catalog_search_words_v1(folded text)`.
-- Docs are `array_to_tsvector(words)`, queries a tsquery of quoted lexemes, so the
-- same text yields the same words in every environment. Never named
-- `catalog_fold_*` (that prefix is catalogue contract surface,
-- scripts/check-catalog-contract-checks.mjs). `pg_c_utf8` (PG 17's built-in
-- collation) makes `[[:alnum:]]` Unicode-aware whatever the database's ctype, so a
-- Greek or Cyrillic name keeps its words (608 products / 84 producers keep
-- non-Latin names after folding, dev DB 2026-11-21). Dots and apostrophes are
-- dropped first ("F.X." → "fx").
--
-- The build is the `@recipe:catalog-search-build` block below: the migration runs
-- it once (tables empty), `rebuildCatalogSearch` (lib/catalogSearch.ts) re-runs the
-- SAME text, read from this file, so there is one copy. It never truncates: docs
-- whose words differ are upserted, docs whose source is gone deleted, words
-- inserted (ndoc refreshed), never deleted. The indexes are built AFTER the
-- first fill (cheaper than maintaining them row by row), then ANALYZE.
-- Rolling deploy: the previous release mints without docs, so step 8's runbook
-- runs the rebuild once the old instances are gone (docs/dev/deployment.md).
BEGIN;

CREATE FUNCTION public.catalog_search_words_v1(t text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT array_remove(regexp_split_to_array(regexp_replace(coalesce(t, '') COLLATE pg_c_utf8, '[.''’]', '', 'g'), '[^[:alnum:]]+'), '')
$$;

COMMENT ON FUNCTION public.catalog_search_words_v1(text) IS
  'Verre catalogue search tokeniser (step 7b): folded text -> its words. ONE definition for search docs and queries; never edit in place (a new version is a new function + a rebuild).';

CREATE TABLE "catalog_search_docs" (
    "product_id" VARCHAR(21) NOT NULL,
    "producer_words" TEXT[] NOT NULL,
    "survivor_words" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "name_words" TEXT[] NOT NULL,
    "region_words" TEXT[] NOT NULL,
    "tsv_name" tsvector NOT NULL,
    "tsv" tsvector NOT NULL,
    CONSTRAINT "catalog_search_docs_pkey" PRIMARY KEY ("product_id")
);

CREATE TABLE "catalog_search_producer_docs" (
    "producer_id" VARCHAR(21) NOT NULL,
    "tsv" tsvector NOT NULL,
    CONSTRAINT "catalog_search_producer_docs_pkey" PRIMARY KEY ("producer_id")
);

-- 🔒 COLLATE "C": the prefix check (`word >= w AND word < w || U+10FFFF`) is a range
-- on the primary key, which needs byte order.
CREATE TABLE "catalog_search_words" (
    "word" TEXT COLLATE "C" NOT NULL,
    "ndoc" INTEGER NOT NULL,
    CONSTRAINT "catalog_search_words_pkey" PRIMARY KEY ("word")
);

-- @recipe:catalog-search-build
-- Each step is ONE statement headed `-- @step <name>`. Runs in ONE transaction
-- (the rebuild takes the exclusive catalog-search advisory lock first, see
-- lib/catalogSearch.ts), so readers never see docs without their words.
-- @step stage-products
-- The docs as the catalogue says now. The lead's EFFECTIVE survivor (a tombstone
-- lead's chain followed like resolveEffectiveIds: at most 10 hops, stop on a
-- revisit) is stored apart, so "untyped producer words" counts against whichever
-- of the two names matches better. Only tombstones are walked (0 today).
CREATE TEMP TABLE catalog_search_stage ON COMMIT DROP AS
WITH RECURSIVE walk(start, id, links_to, depth, path) AS (
  SELECT p.id, p.id, p.links_to, 0, ARRAY[p.id::text] FROM producers p WHERE p.links_to IS NOT NULL
  UNION ALL
  SELECT w.start, p.id, p.links_to, w.depth + 1, w.path || p.id::text
    FROM walk w JOIN producers p ON p.id = w.links_to
   WHERE w.depth < 10 AND p.id::text <> ALL(w.path)
),
eff AS (SELECT DISTINCT ON (start) start, id FROM walk ORDER BY start, depth DESC)
SELECT wp.id AS product_id,
       (wp.status IN ('provisional', 'confirmed', 'linked') AND wp.scope = 'shared' AND pr.status <> 'rejected') AS live,
       public.catalog_search_words_v1(pr.name_folded) AS producer_words,
       CASE WHEN eff.id IS NULL OR eff.id = pr.id THEN ARRAY[]::text[]
            ELSE public.catalog_search_words_v1(sv.name_folded) END AS survivor_words,
       public.catalog_search_words_v1(wp.name_folded) AS name_words,
       public.catalog_search_words_v1(wp.region_folded) AS region_words
  FROM wine_products wp
  JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
  JOIN producers pr ON pr.id = pp.producer_id
  LEFT JOIN eff ON eff.start = pr.id
  LEFT JOIN producers sv ON sv.id = eff.id;
-- @step stage-producers
CREATE TEMP TABLE catalog_search_stage_producers ON COMMIT DROP AS
SELECT p.id AS producer_id, p.status IN ('provisional', 'confirmed', 'linked') AS live,
       public.catalog_search_words_v1(p.name_folded) AS words FROM producers p;
-- @step stage-words
-- Every word of every doc, with ndoc = the LIVE docs holding it (add-time
-- statuses or a merge tombstone, shared scope, the lead producer not rejected;
-- producers: add-time or tombstone): a word only rejected, archived or owned
-- entries hold counts 0, and the typo lookup never offers it (a junk
-- word stops steering corrections once its entry is rejected; and the empty
-- fallback treats it as rare, so a misspelling squatted by a rejected entry
-- is corrected again).
CREATE TEMP TABLE catalog_search_stage_words ON COMMIT DROP AS
SELECT word, (count(*) FILTER (WHERE live))::int AS ndoc FROM (
  SELECT DISTINCT s.product_id AS doc, s.live, x.word
    FROM catalog_search_stage s, unnest(s.producer_words || s.survivor_words || s.name_words || s.region_words) x(word)
  UNION ALL
  SELECT DISTINCT 'p:' || s.producer_id, s.live, x.word FROM catalog_search_stage_producers s, unnest(s.words) x(word)
) d GROUP BY word;
-- @step words
-- BEFORE the docs. A mint's word publication (lib/catalogWrite.ts addWords)
-- takes the SHARED catalog-search lock, so it never runs during this
-- transaction (which holds the exclusive one).
INSERT INTO catalog_search_words AS w (word, ndoc)
SELECT word, ndoc FROM catalog_search_stage_words ORDER BY word COLLATE "C"
ON CONFLICT (word) DO UPDATE SET ndoc = EXCLUDED.ndoc WHERE w.ndoc <> EXCLUDED.ndoc;
-- @step orphan-words
-- A word no doc holds any more (its entry purged or renamed) keeps its row
-- (a word is never deleted online) but counts 0, so it no longer steers a
-- typo lookup. Locked in byte order first.
WITH o AS (
  SELECT w.word FROM catalog_search_words w
   WHERE w.ndoc <> 0 AND NOT EXISTS (SELECT 1 FROM catalog_search_stage_words s WHERE s.word = w.word)
   ORDER BY w.word FOR UPDATE
) UPDATE catalog_search_words w SET ndoc = 0 FROM o WHERE w.word = o.word;
-- @step docs
INSERT INTO catalog_search_docs AS d (product_id, producer_words, survivor_words, name_words, region_words, tsv_name, tsv)
SELECT s.product_id, s.producer_words, s.survivor_words, s.name_words, s.region_words,
       array_to_tsvector(s.producer_words || s.survivor_words || s.name_words),
       array_to_tsvector(s.producer_words || s.survivor_words || s.name_words || s.region_words)
  FROM catalog_search_stage s ORDER BY s.product_id
ON CONFLICT (product_id) DO UPDATE SET
  producer_words = EXCLUDED.producer_words, survivor_words = EXCLUDED.survivor_words, name_words = EXCLUDED.name_words,
  region_words = EXCLUDED.region_words, tsv_name = EXCLUDED.tsv_name, tsv = EXCLUDED.tsv
 WHERE (d.producer_words, d.survivor_words, d.name_words, d.region_words)
       IS DISTINCT FROM (EXCLUDED.producer_words, EXCLUDED.survivor_words, EXCLUDED.name_words, EXCLUDED.region_words);
-- @step producer-docs
INSERT INTO catalog_search_producer_docs AS d (producer_id, tsv)
SELECT s.producer_id, array_to_tsvector(s.words) FROM catalog_search_stage_producers s ORDER BY s.producer_id
ON CONFLICT (producer_id) DO UPDATE SET tsv = EXCLUDED.tsv WHERE d.tsv IS DISTINCT FROM EXCLUDED.tsv;
-- @step gone-docs
-- AFTER the upserts, in a fresh statement: a doc an upsert re-wrote for a product
-- purged meanwhile is removed here (a purge that commits later deletes its own).
DELETE FROM catalog_search_docs d WHERE NOT EXISTS (SELECT 1 FROM wine_products wp WHERE wp.id = d.product_id);
-- @step gone-producer-docs
DELETE FROM catalog_search_producer_docs d WHERE NOT EXISTS (SELECT 1 FROM producers p WHERE p.id = d.producer_id);
-- @endrecipe

CREATE INDEX "catalog_search_docs_tsv_name_idx" ON "catalog_search_docs" USING GIN ("tsv_name");
CREATE INDEX "catalog_search_docs_tsv_idx" ON "catalog_search_docs" USING GIN ("tsv");
CREATE INDEX "catalog_search_producer_docs_tsv_idx" ON "catalog_search_producer_docs" USING GIN ("tsv");
-- siglen 256 (the default 12 bytes is too coarse for ~81k words: a typo lookup
-- read the whole 5 MB index), with the lookup filtered on the first letter
-- (`word LIKE first || '%'`, a typo keeps it): 8.7 → 1.0 ms a word (dev DB,
-- 2026-11-22).
CREATE INDEX "catalog_search_words_word_gist_idx" ON "catalog_search_words" USING GIST ("word" gist_trgm_ops(siglen=256));

ANALYZE catalog_search_docs;
ANALYZE catalog_search_producer_docs;
ANALYZE catalog_search_words;

COMMIT;
