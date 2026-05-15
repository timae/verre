-- Rewire phase 1 — additive schema only.
--
-- See docs/dev/proposals/rewire.md §6 phase 1 for what ships in this phase
-- and what is deliberately deferred to phase 1.5 (partial-unique swap on
-- ratings, ratings.score → nullable). Phase 1 is purely additive: every
-- read/write path in the app today keeps working unchanged after this
-- migration applies.
--
-- Order matters:
--   1. Create the new lookup/feed tables so FKs land cleanly.
--   2. Seed category_styles BEFORE adding the composite FK on wines.
--   3. Widen wines.id PK and dependent FK columns from VarChar(20) → VarChar(21).
--   4. Add new columns on sessions/ratings + the indexes the rewire needs.
--   5. Backfill ratings.origin / ratings.session_id from existing data.
--   6. Add the composite FK wines → category_styles (pre-flight confirmed
--      every row maps to a seeded pair; no backfill needed).
--   7. Partial + GIN indexes (hand-rolled — Prisma can't express them in
--      schema.prisma alone).

------------------------------------------------------------------------
-- 1. New tables
------------------------------------------------------------------------

CREATE TABLE "category_styles" (
    "category"   VARCHAR(32) NOT NULL,
    "style"      VARCHAR(64) NOT NULL,
    "label"      VARCHAR(64) NOT NULL,
    "sort_order" INTEGER     NOT NULL DEFAULT 0,
    "active"     BOOLEAN     NOT NULL DEFAULT true,

    CONSTRAINT "category_styles_pkey" PRIMARY KEY ("category","style")
);
CREATE INDEX "category_styles_category_sort_order_idx"
    ON "category_styles" ("category","sort_order");

CREATE TABLE "rating_images" (
    "id"         SERIAL NOT NULL,
    "rating_id"  INTEGER NOT NULL,
    "image_url"  TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rating_images_rating_id_sort_order_idx"
    ON "rating_images" ("rating_id","sort_order");

CREATE TABLE "feed_items" (
    "id"              SERIAL NOT NULL,
    "user_id"         INTEGER NOT NULL,
    "kind"            VARCHAR(32) NOT NULL,
    "session_id"      INTEGER,
    "rating_id"       INTEGER,
    "venue_name"      VARCHAR(255),
    "city"            VARCHAR(100),
    "country"         CHAR(2),
    "lat"             DECIMAL(9,6),
    "lng"             DECIMAL(9,6),
    "location_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feed_items_rating_id_key"
    ON "feed_items" ("rating_id");
-- Per §2: one feed_item per (user, session). NULLs are distinct in Postgres
-- unique constraints, so standalone rows (sessionId IS NULL) are
-- intentionally unconstrained here — there can be many standalone posts
-- per user.
CREATE UNIQUE INDEX "feed_items_user_id_session_id_key"
    ON "feed_items" ("user_id","session_id");
CREATE INDEX "feed_items_user_id_created_at_idx"
    ON "feed_items" ("user_id","created_at" DESC);
CREATE INDEX "feed_items_created_at_idx"
    ON "feed_items" ("created_at" DESC);

CREATE TABLE "feed_item_likes" (
    "user_id"      INTEGER NOT NULL,
    "feed_item_id" INTEGER NOT NULL,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_item_likes_pkey" PRIMARY KEY ("user_id","feed_item_id")
);
CREATE INDEX "feed_item_likes_feed_item_id_idx"
    ON "feed_item_likes" ("feed_item_id");

CREATE TABLE "feed_item_tags" (
    "feed_item_id" INTEGER NOT NULL,
    "user_id"      INTEGER NOT NULL,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_item_tags_pkey" PRIMARY KEY ("feed_item_id","user_id")
);
CREATE INDEX "feed_item_tags_user_id_idx"
    ON "feed_item_tags" ("user_id");

CREATE TABLE "_migration_checkpoints" (
    "name"        VARCHAR(64) NOT NULL,
    "last_row_id" INTEGER NOT NULL,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_migration_checkpoints_pkey" PRIMARY KEY ("name")
);

------------------------------------------------------------------------
-- 2. Seed category_styles with the 5 wine styles
------------------------------------------------------------------------

INSERT INTO "category_styles" ("category","style","label","sort_order","active") VALUES
    ('wine','red',    'Red Wine',       10, true),
    ('wine','white',  'White Wine',     20, true),
    ('wine','rose',   'Rosé Wine',      30, true),
    ('wine','spark',  'Sparkling Wine', 40, true),
    ('wine','nonalc', 'Non-alcoholic',  50, true);

------------------------------------------------------------------------
-- 3. Widen wines.id PK and dependent FK columns from VARCHAR(20) → VARCHAR(21)
--    Order: drop FKs that reference wines.id, alter PK + FK columns, re-add FKs.
--    Prisma's existing FKs use the default RESTRICT/NO ACTION on update; the
--    re-added FKs keep parity with the schema declarations.
------------------------------------------------------------------------

ALTER TABLE "ratings"   DROP CONSTRAINT "ratings_wine_id_fkey";
ALTER TABLE "bookmarks" DROP CONSTRAINT "bookmarks_wine_id_fkey";

ALTER TABLE "wines"     ALTER COLUMN "id"      TYPE VARCHAR(21);
ALTER TABLE "ratings"   ALTER COLUMN "wine_id" TYPE VARCHAR(21);
ALTER TABLE "bookmarks" ALTER COLUMN "wine_id" TYPE VARCHAR(21);

ALTER TABLE "ratings"   ADD CONSTRAINT "ratings_wine_id_fkey"
    FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_wine_id_fkey"
    FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

------------------------------------------------------------------------
-- 4. New columns on sessions / ratings
--    ratings.origin is NOT NULL with no default; add nullable, backfill, then
--    set NOT NULL (single-migration safe — sees the same transaction).
------------------------------------------------------------------------

ALTER TABLE "sessions" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "ratings" ADD COLUMN "session_id" INTEGER;
ALTER TABLE "ratings" ADD COLUMN "origin"     VARCHAR(32);

------------------------------------------------------------------------
-- 5. Backfill ratings.origin and ratings.session_id from existing data
--    Today every rating row came from a session (no other ingestion path
--    exists yet), so origin = 'session' for all rows. session_id comes from
--    the rating's wine: wines.session_id is non-null for in-session wines,
--    NULL for orphaned (deleted-session) wines.
------------------------------------------------------------------------

UPDATE "ratings" SET "origin" = 'session';

UPDATE "ratings" r
   SET "session_id" = w."session_id"
  FROM "wines" w
 WHERE r."wine_id" = w."id";

ALTER TABLE "ratings" ALTER COLUMN "origin" SET NOT NULL;

------------------------------------------------------------------------
-- 6. Foreign keys on the new columns and tables
------------------------------------------------------------------------

-- ratings.session_id → sessions.id. Restrict matches the schema: hard-deletes
-- of a referenced session must fail loudly; soft-delete is the contract.
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- rating_images.rating_id → ratings.id, cascade with the rating.
ALTER TABLE "rating_images" ADD CONSTRAINT "rating_images_rating_id_fkey"
    FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- feed_items relations.
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_rating_id_fkey"
    FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "feed_item_likes" ADD CONSTRAINT "feed_item_likes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "feed_item_likes" ADD CONSTRAINT "feed_item_likes_feed_item_id_fkey"
    FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "feed_item_tags" ADD CONSTRAINT "feed_item_tags_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "feed_item_tags" ADD CONSTRAINT "feed_item_tags_feed_item_id_fkey"
    FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Composite FK wines → category_styles. Pre-flight (rewire.md §8) confirmed
-- every existing wine row already references a seeded pair; the FK lands
-- with no backfill needed. NULL styles are permitted (MATCH SIMPLE default).
ALTER TABLE "wines" ADD CONSTRAINT "wines_category_style_fkey"
    FOREIGN KEY ("category","style") REFERENCES "category_styles"("category","style")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

------------------------------------------------------------------------
-- 7. Indexes — partial (sessions live filter) + GIN trigram (wine name/producer)
--    + the new B-tree indexes from the schema.
------------------------------------------------------------------------

-- Partial index for the dominant filter "is this session live?". A regular
-- B-tree on a mostly-NULL column wouldn't be selective. See rewire.md §2.
CREATE INDEX "sessions_live_idx" ON "sessions" ("id") WHERE "deleted_at" IS NULL;

-- pg_trgm is already enabled in the datasource. Trigram GIN indexes unblock
-- future Tastes-tab search/filter on wine name + producer (captured in §9
-- future-work). Index names match Prisma's default convention
-- (`<table>_<col>_idx`) so `prisma migrate diff` against schema.prisma
-- doesn't report drift.
CREATE INDEX "wines_name_idx"
    ON "wines" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "wines_producer_idx"
    ON "wines" USING GIN ("producer" gin_trgm_ops);

-- New B-tree indexes on ratings — match the @@index declarations in
-- schema.prisma. (`ratings_user_id_idx` already exists; not recreated.)
CREATE INDEX "ratings_session_id_idx"          ON "ratings" ("session_id");
CREATE INDEX "ratings_user_id_wine_id_idx"     ON "ratings" ("user_id","wine_id");
CREATE INDEX "ratings_user_id_session_id_idx"  ON "ratings" ("user_id","session_id");
