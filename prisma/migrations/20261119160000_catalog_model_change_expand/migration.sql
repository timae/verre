-- Catalogue model change, EXPAND step (docs/dev/proposals/wine-catalog-model-change.md
-- § 1, § 5, § 5a, § 7; build order § 12 step 2). Additive only: the previous
-- release runs unchanged on the migrated database during the rolling deploy (it
-- never reads the new columns, and every one is nullable or defaulted). Nothing
-- is dropped or renamed; the contract step (§ 12 step 9) makes `origin` NOT NULL
-- and drops what the code no longer reads.
--
--   1. wines (the occurrence; the table keeps its name, § 1):
--      origin    VARCHAR(16) NULL, CHECK session | standalone. `session_id IS NULL`
--                does not mean standalone (three paths orphan session bottles). The
--                previous release writes rows without it, so `wines_origin_default`
--                fills it on INSERT from session_id when the writer leaves it NULL
--                (right at insert time: orphaning is always a later UPDATE).
--      colour / sparkling / abv: the bottle's snapshot of the catalogue kind (the
--                CHECKs wine_products carries), so an unlinked or purged occurrence
--                keeps its Bubbles axis, colour mark and non-alcoholic mark. Derived
--                from `style` by the backfill (§ 6 below); the new code copies them
--                from the catalogue entry at link time and keeps `style` derived from
--                them in the same statement (§ 8a.0).
--   2. sessions.lineup_revision INTEGER NULL (NULL = not reconciled, § 8a; integer,
--      so no BigInt reaches JSON).
--   3. bookmarks: wine_id NULLABLE (the source bottle, "you craved it here"; its key
--      bookmarks_wine_id_fkey KEEPS ON DELETE CASCADE, § 5: the deploy runs this
--      before the previous release stops serving, so no key change can be timed
--      safely); product_id / vintage_id into the catalogue, NO ACTION (§ 5a), with
--      the composite key and the (vintage_id IS NULL OR product_id IS NOT NULL)
--      CHECK that wines carries; the snapshot name / producer / vintage (§ 5a: a
--      purged bookmark still renders); source_session_id (a craving keeps its
--      moment, § 5; sessions are never hard-deleted); the partial unique (user,
--      product, vintage) NULLS NOT DISTINCT WHERE product_id IS NOT NULL: one craving
--      per wine, a purged bookmark exempt. 🔒 bookmarks_user_id_wine_id_key is NOT
--      touched (a CONSTRAINT on prod, an INDEX in the chain: step 9 drops it with
--      DROP CONSTRAINT IF EXISTS and DROP INDEX IF EXISTS).
--   4. ratings: one rating per standalone occurrence (§ 8a, the check-in replay). The
--      predicate is `session_id IS NULL`, so it also holds legacy SESSION ratings
--      written before ratings carried a session (prod: 4, origin 'session', one per
--      bottle): strictly "one session-less rating per bottle".
--   5. Contract v3 (§ 1, ruled 2026-11-19): wine_products.country (where the wine
--      is from, never filled from the producer), description, vinification; the
--      FULL 249-code CHECK (COUNTRY_CODES, @verre/core) on that origin AND on
--      producers.country; the two texts not blank through the fold.
--   6. The backfill, the @recipe block below. scripts/backfill-model-change.mjs
--      re-runs it on release day once the old instances are gone (it reads the
--      block from this file, and refuses unless the file is the one prod applied).
--   catalog_review_items (§ 7) is its own migration (20261119160100), so this
--   transaction never locks `users`.
--
-- 🔒 The two partial uniques are NOT in the Prisma datamodel (an @@unique cannot
-- carry a WHERE, so the drift gate would ask for a different index), as the
-- ratings (user, wine, session) unique before them: catalog-schema-integration.mjs
-- § 22 pins them from pg_indexes.
--
-- 🔒 CONTRACT EVENT (contract version 2 → 3, prisma/catalog-contract-checks.json):
-- three columns on wine_products, four contract-scoped CHECKs (one a stricter
-- predicate on the EXISTING producers.country: a code outside the list on prod
-- fails this migration, so the catalogue's replacement is checked against the list
-- before it loads), two keys from bookmarks into the catalogue. Announced to the
-- catalog-maintenance side before the push (§ 9 condition 3a). catalog_review_items
-- (next migration) holds catalogue ids without a key, so their replace mode locks
-- it (told 2026-11-19).
--
-- Hand-written against prod's own schema (the pg_dump of 2026-11-17, § 6a): prod's
-- baseline-era drift on bookmarks, ratings, sessions and wines (types, defaults,
-- uniques that are CONSTRAINTS there and INDEXES in the chain) is named nowhere
-- below.
--
-- Lock order: the session record first (sessions, wines, ratings, bookmarks, the
-- order the contract's writers take them), then the catalogue. `users` is not
-- locked. The session tables are small on prod; the catalogue's CHECKs scan
-- wine_products (257k rows) and producers (49k) under the lock, and catalogue
-- search waits for that scan (the whole migration: 135 ms on the rehearsal).
-- ⚠️ A writer that takes ratings before wines without touching sessions (account
-- deletion of a user with no live moment, lib/accountDelete.ts) can make this
-- migration the deadlock victim (40P01) in a window of milliseconds: deploy in the
-- quiet window; the recovery below is the same.
--
-- ⚠️ ON FAILURE (the refusal in § 0, producers_country_check, a deadlock or the lock
-- timeout):
-- Prisma records the migration as failed and every later deploy aborts with P3009.
-- ⚠️ The deploy output shows only "current transaction is aborted" (Prisma reports
-- the LAST error): the refusal's message, with its count and examples, is in the
-- Postgres server log, or re-run the § 0 SELECT by hand. A producers_country_check
-- violation: `SELECT DISTINCT country FROM producers WHERE country IS NOT NULL`
-- against the 249 codes. A lock timeout: the pg_locks query in
-- docs/dev/deployment.md § PRE-DEPLOY CHECK finds the holder. The transaction
-- applied nothing, so clear the cause, then
--
--   npx prisma migrate resolve --rolled-back 20261119160000_catalog_model_change_expand
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE "sessions", "wines", "ratings", "bookmarks" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "producers", "wine_products" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "wine_vintages" IN SHARE ROW EXCLUSIVE MODE;

-- ── 0. REFUSE, never repair ─────────────────────────────────────────────────
--
-- The one-rating-per-standalone-occurrence unique (§ 4) needs every bottle to hold
-- at most one session-less rating (a check-in's, or a legacy session rating written
-- before ratings carried a session). Every check-in mints its own wine row
-- (app/api/checkins/route.ts), so none should hold two; the re-survey measured 0 on
-- prod (Q5g, 2026-11-18). Named here rather than as a bare unique violation.
-- 🔒 Driven by catalog-schema-integration.mjs § 22 (the block between the markers).
-- @recipe:model-change-refusal
DO $$
DECLARE n int; ex text;
BEGIN
  SELECT count(*), string_agg(wine_id, ', ' ORDER BY wine_id) FILTER (WHERE rn <= 10)
    INTO n, ex
    FROM (SELECT r.wine_id, row_number() OVER (ORDER BY r.wine_id) AS rn
            FROM public.ratings r WHERE r.session_id IS NULL
           GROUP BY r.wine_id HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION
      'refusing the catalogue model change: % wine(s) hold more than one rating with no session (standalone check-in ratings, or legacy session ratings written before ratings carried a session; first ids: %). Decide each by hand in its own change, then re-run.',
      n, ex;
  END IF;
END $$;
-- @endrecipe

-- ── 1. wines: origin and the snapshot ───────────────────────────────────────
--
-- A constant default is metadata-only, so NOT NULL DEFAULT false rewrites nothing.
ALTER TABLE "wines"
  ADD COLUMN "origin"    VARCHAR(16),
  ADD COLUMN "colour"    VARCHAR(16),
  ADD COLUMN "sparkling" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "abv"       DECIMAL(4,2);
ALTER TABLE "wines"
  ADD CONSTRAINT "wines_origin_check"
    CHECK ("origin" IS NULL OR "origin" IN ('session', 'standalone')),
  ADD CONSTRAINT "wines_colour_check"
    CHECK ("colour" IS NULL OR "colour" IN ('red', 'white', 'rose')),
  ADD CONSTRAINT "wines_abv_range_check"
    CHECK ("abv" IS NULL OR ("abv" >= 0 AND "abv" <= 25));

-- Fills NULL only: a writer that names origin keeps it (the new code will, and a
-- data-only restore carries it). Schema-qualified with a pinned search_path, like
-- every trigger function here, so a same-named temporary object cannot shadow it.
CREATE FUNCTION public.wines_origin_default() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.origin IS NULL THEN
    NEW.origin := CASE WHEN NEW.session_id IS NULL THEN 'standalone' ELSE 'session' END;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "wines_origin_default" BEFORE INSERT ON "wines"
  FOR EACH ROW EXECUTE FUNCTION public.wines_origin_default();

-- ── 2. sessions ─────────────────────────────────────────────────────────────
ALTER TABLE "sessions" ADD COLUMN "lineup_revision" INTEGER;

-- ── 3. bookmarks ────────────────────────────────────────────────────────────
ALTER TABLE "bookmarks"
  ALTER COLUMN "wine_id" DROP NOT NULL,
  ADD COLUMN "product_id"        VARCHAR(21),
  ADD COLUMN "vintage_id"        VARCHAR(21),
  ADD COLUMN "name"              VARCHAR(255),
  ADD COLUMN "producer"          VARCHAR(255),
  ADD COLUMN "vintage"           CHAR(4),
  ADD COLUMN "source_session_id" INTEGER;
-- The composite key is MATCH SIMPLE: it checks nothing while either column is
-- NULL, so the CHECK is what refuses a vintage without its product.
ALTER TABLE "bookmarks"
  ADD CONSTRAINT "bookmarks_catalog_link_check"
    CHECK ("vintage_id" IS NULL OR "product_id" IS NOT NULL),
  ADD CONSTRAINT "bookmarks_product_id_fkey" FOREIGN KEY ("product_id")
    REFERENCES "wine_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "bookmarks_vintage_id_product_id_fkey" FOREIGN KEY ("vintage_id", "product_id")
    REFERENCES "wine_vintages"("id", "product_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "bookmarks_source_session_id_fkey" FOREIGN KEY ("source_session_id")
    REFERENCES "sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "bookmarks_product_id_idx" ON "bookmarks"("product_id");
CREATE INDEX "bookmarks_vintage_id_idx" ON "bookmarks"("vintage_id");
CREATE INDEX "bookmarks_source_session_id_idx" ON "bookmarks"("source_session_id");
-- NOT in the datamodel (see the header). vintage_id NULL = "this wine, any year"
-- (a live save, deduplicated by NULLS NOT DISTINCT); product_id NULL = the
-- catalogue row is gone or was never linked (exempt).
CREATE UNIQUE INDEX "bookmarks_user_product_vintage_key" ON "bookmarks"("user_id", "product_id", "vintage_id")
  NULLS NOT DISTINCT WHERE "product_id" IS NOT NULL;

-- ── 4. ratings ──────────────────────────────────────────────────────────────
-- NOT in the datamodel (see the header).
CREATE UNIQUE INDEX "ratings_standalone_wine_id_key" ON "ratings"("wine_id") WHERE "session_id" IS NULL;

-- ── 5. Contract v3: the catalogue's new columns ─────────────────────────────
--
-- 🔒 The country CHECK is the FULL list, inline (not a format test): adding a code
-- is a migration and a contract event. catalog-schema-integration.mjs § 22 pins
-- both copies to COUNTRY_CODES, both ways. The texts are not blank through the
-- fold (the region pattern), so their meaning depends on catalog_fold_v1 and the
-- contract snapshot records it.
ALTER TABLE "wine_products"
  ADD COLUMN "country"      VARCHAR(2),
  ADD COLUMN "description"  VARCHAR(1000),
  ADD COLUMN "vinification" VARCHAR(1000);
ALTER TABLE "wine_products"
  ADD CONSTRAINT "wine_products_country_check"
    CHECK ("country" IS NULL OR "country" IN (
      'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW',
      'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN',
      'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG',
      'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
      'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
      'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
      'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR',
      'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
      'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
      'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
      'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU',
      'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
      'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR',
      'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD',
      'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
      'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
      'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE',
      'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW')),
  ADD CONSTRAINT "wine_products_description_not_blank_check"
    CHECK ("description" IS NULL OR catalog_fold_v1("description") <> ''),
  ADD CONSTRAINT "wine_products_vinification_not_blank_check"
    CHECK ("vinification" IS NULL OR catalog_fold_v1("vinification") <> '');
-- The company's HOME country (never the wine's origin), now held to the same list.
-- Validated against every existing row: measured on the loaded catalogue
-- (2026-11-19), 68 codes in use, all in the list, 13 producers NULL.
ALTER TABLE "producers"
  ADD CONSTRAINT "producers_country_check"
    CHECK ("country" IS NULL OR "country" IN (
      'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW',
      'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN',
      'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG',
      'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
      'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
      'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
      'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR',
      'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
      'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
      'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
      'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU',
      'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
      'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR',
      'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD',
      'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
      'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
      'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE',
      'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'));

-- ── 6. The backfill ─────────────────────────────────────────────────────────
--
-- 🔒 The block between the markers is READ AND RUN by scripts/backfill-model-change.mjs
-- (release day, once the previous release's instances are gone) and by
-- catalog-schema-integration.mjs § 22 (scripts/lib/modelChangeBackfill.mjs). Each
-- step is ONE statement, and FILL-ONLY: it writes a column only where it is still
-- unwritten, so a re-run changes exactly what an old writer left meanwhile, and a
-- second re-run changes nothing. One exception, ruled (spec § 8a.0, build plan step
-- 3): the `snapshot` step RE-DERIVES colour / sparkling from `style` wherever they no
-- longer derive to it, because the previous release's wine PATCH mirrors `style` and
-- never the snapshot. One direction only: the pair is compared by what it derives
-- to, so a sparkling rosé (rose + sparkling, token `spark`) is never touched; the new
-- code keeps `style` derived from the pair in the same statement, so its rows are
-- never touched either. abv is fill-only (a contradiction is reported, not changed).
-- @recipe:model-change-backfill
-- @step origin
-- A moment or a session rating → session; a standalone rating → standalone;
-- nothing left (an orphaned bottle nobody rated, a check-in whose rating was
-- deleted): a legacy 13-digit id (the old session add path minted Date.now(),
-- lib/session.ts as of 2026-05-10, and standalone wines exist only since the
-- 2026-05-14 rewire), an adder or a position → session, else standalone.
-- Prod 2026-11-18 (re-survey Q5a + the id clause): 124 session, 26 standalone.
UPDATE public.wines w
   SET origin = CASE
     WHEN w.session_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.ratings r WHERE r.wine_id = w.id AND r.origin = 'session') THEN 'session'
     WHEN EXISTS (SELECT 1 FROM public.ratings r WHERE r.wine_id = w.id AND r.origin = 'standalone') THEN 'standalone'
     WHEN w.id ~ '^[0-9]{13}$' OR w.added_by_identity_id IS NOT NULL OR w.position IS NOT NULL THEN 'session'
     ELSE 'standalone' END
 WHERE w.origin IS NULL;
-- @step snapshot
-- red / white / rose → that colour, not sparkling; `spark` → sparkling, colour
-- unknown; `nonalc`, NULL, '' and any other token → neither. Rewritten only where
-- the stored pair derives to something else (derive: sparkling → spark, else the
-- colour, else neither).
UPDATE public.wines
   SET colour = CASE WHEN style IN ('red', 'white', 'rose') THEN style END,
       sparkling = (style IS NOT DISTINCT FROM 'spark')
 WHERE category = 'wine'
   AND (CASE WHEN sparkling THEN 'spark' WHEN colour IN ('red', 'white', 'rose') THEN colour END)
       IS DISTINCT FROM (CASE WHEN style IN ('red', 'white', 'rose', 'spark') THEN style END);
-- @step abv
-- `nonalc` → abv 0, what the alcohol-free choice meant (§ 0.2); every other legacy
-- bottle keeps NULL.
UPDATE public.wines SET abv = 0
 WHERE abv IS NULL AND category = 'wine' AND style = 'nonalc';
-- @step bookmark-snapshot
-- Unlinked bookmarks only: every new craving points at the catalogue and carries
-- its own snapshot.
UPDATE public.bookmarks b
   SET name = w.name, producer = w.producer, vintage = w.vintage
  FROM public.wines w
 WHERE w.id = b.wine_id AND b.name IS NULL AND b.product_id IS NULL;
-- @step bookmark-moment
-- The bottle's moment, else (an orphaned bottle) the moment of its ratings: the
-- rule cravingSessionIdSql applies at read time (lib/outsideView.ts). A bottle
-- with neither leaves the bookmark without one (it shows, as it does today).
UPDATE public.bookmarks b
   SET source_session_id = m.sid
  FROM public.wines w
 CROSS JOIN LATERAL (SELECT COALESCE(w.session_id, (
          SELECT r.session_id FROM public.ratings r
           WHERE r.wine_id = w.id AND r.session_id IS NOT NULL ORDER BY r.id LIMIT 1)) AS sid) m
 WHERE w.id = b.wine_id AND b.source_session_id IS NULL AND m.sid IS NOT NULL AND b.product_id IS NULL;
-- @step bookmark-link
-- The bottle's catalogue link (0 linked bottles on prod at the re-survey). Two
-- bookmarks of one person whose bottles link to one wine would collide under the
-- unique: only the earliest takes the link, and none takes a link the person
-- already holds; the rest stay unlinked for the conversion, which merges them
-- (§ 5: keep the visible row, else the earlier saved_at).
UPDATE public.bookmarks b
   SET product_id = w.product_id, vintage_id = w.vintage_id
  FROM public.wines w
 WHERE w.id = b.wine_id AND b.product_id IS NULL AND w.product_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.bookmarks o
                    WHERE o.user_id = b.user_id AND o.product_id = w.product_id
                      AND o.vintage_id IS NOT DISTINCT FROM w.vintage_id)
   AND NOT EXISTS (SELECT 1 FROM public.bookmarks o JOIN public.wines ow ON ow.id = o.wine_id
                    WHERE o.user_id = b.user_id AND o.id <> b.id AND o.product_id IS NULL
                      AND ow.product_id = w.product_id AND ow.vintage_id IS NOT DISTINCT FROM w.vintage_id
                      AND (o.saved_at, o.id) < (b.saved_at, b.id));
-- @endrecipe

COMMIT;
