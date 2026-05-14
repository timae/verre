-- Rewire phase 2 — data migration.
--
-- Backfills the new model (`wines` + `ratings` + `feed_items` + `rating_images`,
-- plus `feed_item_likes` and `feed_item_tags`) from the legacy `checkins` /
-- `checkin_likes` / `checkin_tags` tables and from existing session `ratings`.
--
-- See docs/dev/proposals/rewire.md §5 for the spec. Key invariants:
--
--   1. **Self-guard**: aborts if `feed_items` is already populated. The
--      `copyFromCheckinId` URL/cache-compatibility story requires that
--      every standalone feed_item gets created with `id = source.checkin.id`.
--      If anything else inserted feed_items rows before this migration
--      (dry-run leftover, stray test write, hotfix), the id-equality
--      invariant is gone and we must investigate before re-running.
--
--   2. **Idempotent via `_migration_checkpoints`**: each migration step
--      writes a checkpoint row when it finishes. A re-run finds the
--      checkpoint and skips. Single-transaction at Tim+Simon scale; the
--      batching language in §5 is a future-proofing knob (1000-row
--      batches with intermediate commits) — at current scale, the whole
--      backfill fits comfortably inside Prisma's per-migration txn.
--
--   3. **Sequence bump after standalone backfill**: standalone feed_items
--      are inserted with EXPLICIT `id = checkin.id`. Future POSTs use
--      the autoincrement sequence, which Postgres won't auto-bump when
--      we INSERT with explicit ids. After the backfill, fix the sequence
--      with `setval` + scalar subquery (NOT `setval(seq, MAX(id)) FROM
--      feed_items` which fires once per row — well-known foot-gun).
--
--   4. **Wine ids**: 21-char hex from `replace(gen_random_uuid()::text, '-', '')`,
--      sliced. Runtime POSTs use nanoid (URL-safe alphabet); both shapes
--      fit VarChar(21) and both pass the wineId validation regex on the
--      rate route. Mixing alphabets across migrated/runtime ids is fine —
--      wine ids are internal, never user-facing or copied between systems.
--
--   5. **Session feed_items**: minted per `(user, session)` where the
--      user has at least one rating AND `userId IS NOT NULL`. Anon-only
--      sessions produce no feed_items per §3 of the rewire (anon → no
--      author → no post). createdAt = MIN(ratings.ratedAt) over the
--      (user, session) group — the earliest rating anchors the post.
--
--   6. **Rating provenance**: every backfilled rating gets
--      `origin = 'standalone'` (from a checkin) or `origin = 'session'`
--      (existing ratings — phase 1 already backfilled this column;
--      we re-affirm idempotently).
--
-- DEPLOY PROTOCOL: scale Deploio replicas to 0 BEFORE this migration
-- applies. The new POST /api/checkins (slice 3) stopped writing to
-- `checkins`, so any in-flight check-in during the migration would land
-- as a feed_item — but the self-guard at step 1 ABORTS if feed_items
-- contains pre-existing rows. Read paths (slice 4) also expect the
-- migration to have completed. Scale-to-0 enforces this contract.
--
-- ROLLBACK: take pg_dump before applying. If migration succeeds but the
-- new release misbehaves, restore the dump (loses any writes during the
-- cutover window, acceptable at Tim+Simon scale per the rewire's risk
-- mitigations).

BEGIN;

------------------------------------------------------------------------
-- Step 0: self-guard
------------------------------------------------------------------------

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM feed_items) > 0 THEN
    -- Allow re-runs: if every existing feed_item came from an earlier
    -- successful pass of THIS migration, the checkpoint table records it.
    -- Compare against checkpoint state — if migrate-data-standalone is
    -- already complete, this is a re-run and we proceed (each step's
    -- guard at the top of its block no-ops).
    IF EXISTS (
      SELECT 1 FROM _migration_checkpoints
      WHERE name = 'rewire_data_standalone'
    ) THEN
      RAISE NOTICE 'feed_items already populated by a prior run; re-running idempotently';
    ELSE
      RAISE EXCEPTION 'feed_items already populated but no checkpoint exists — aborting to preserve copyFromCheckinId id-equality invariant. Investigate stray writes before re-running.';
    END IF;
  END IF;
END
$$;

------------------------------------------------------------------------
-- Step 1: backfill ratings.origin for any rows the phase 1 backfill missed
--
-- Phase 1 ran `UPDATE ratings SET origin='session'` for every row that
-- existed at phase-1-deploy time. Rows inserted between phase 1 and now
-- have origin='session' set by the rate endpoint. Defensive sweep here
-- catches any oddities.
------------------------------------------------------------------------

UPDATE ratings SET origin = 'session'
 WHERE origin IS NULL OR origin = '';

------------------------------------------------------------------------
-- Step 2: backfill ratings.session_id for any rows the phase 1.5 inter-
--         deploy backfill missed
--
-- Phase 1.5 ran the same update inside its own migration. New rows
-- since phase 1.5 had session_id set by the rate endpoint directly.
-- Defensive sweep.
------------------------------------------------------------------------

UPDATE ratings r
   SET session_id = w.session_id
  FROM wines w
 WHERE r.session_id IS NULL
   AND r.wine_id = w.id
   AND w.session_id IS NOT NULL;

------------------------------------------------------------------------
-- Step 3: backfill standalone wines + ratings + feed_items +
--         rating_images from `checkins`
--
-- The single biggest piece. For each legacy `checkins` row:
--   - mint a `wines` row (sessionId=NULL, category='wine',
--     style=checkin.type)
--   - mint a `ratings` row pointing at it (origin='standalone',
--     sessionId=NULL)
--   - mint a `feed_items` row with EXPLICIT `id = checkin.id` (the
--     copyFromCheckinId compatibility story), kind='standalone',
--     ratingId pointing at the rating, location fields carried over
--   - mint a `rating_images` row if checkin.imageUrl is non-null
--
-- All four are wrapped in a single CTE so we can chain id captures
-- without separate round-trips. Reads from `checkins` ORDER BY id
-- so the inserted ratings appear in the same order — gives the
-- ratings table a deterministic ratedAt ordering matching the source.
--
-- ON CONFLICT DO NOTHING handles the re-run case (checkpoint says
-- "already done" → guard at top skips us, but belt-and-suspenders).
------------------------------------------------------------------------

DO $$
BEGIN
  -- Skip if already complete (idempotent re-run).
  IF EXISTS (
    SELECT 1 FROM _migration_checkpoints
    WHERE name = 'rewire_data_standalone'
  ) THEN
    RAISE NOTICE 'rewire_data_standalone already complete; skipping';
    RETURN;
  END IF;

  -- Stage the wine rows first (need stable wine ids before we mint
  -- ratings that point at them). One wine per checkin; ids are
  -- 21-char hex from a UUID.
  CREATE TEMP TABLE _rewire_wine_map AS
    SELECT c.id AS checkin_id,
           substr(replace(gen_random_uuid()::text, '-', ''), 1, 21) AS wine_id
      FROM checkins c
     ORDER BY c.id;

  INSERT INTO wines (
    id, session_id, name, producer, vintage, grape, style, category,
    image_url, description, region, country, vinification, purchase_url,
    added_by_identity_id, added_by_display_name, revealed_at
  )
  SELECT m.wine_id,
         NULL,
         c.wine_name,
         c.producer,
         c.vintage,
         c.grape,
         c.type,
         'wine',
         -- Tasting photos live on rating_images, NOT on wines.imageUrl
         -- (which is the canonical catalog bottle shot, per §2). The
         -- legacy `checkins.imageUrl` is a tasting photo; route it to
         -- rating_images below.
         NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM checkins c
    JOIN _rewire_wine_map m ON m.checkin_id = c.id;

  -- Stage the rating ids. INSERT...RETURNING captures the autoincrement
  -- ids in the same order as the source checkins (because we ORDER BY
  -- checkin_id below and Postgres preserves INSERT order within a
  -- single statement).
  CREATE TEMP TABLE _rewire_rating_map (
    checkin_id INTEGER,
    rating_id  INTEGER
  );

  WITH inserted AS (
    INSERT INTO ratings (
      wine_id, user_id, session_id, origin, rater_name, score,
      flavors, notes, rated_at
    )
    SELECT m.wine_id,
           c.user_id,
           NULL,
           'standalone',
           COALESCE(u.name, '[deleted]'),
           c.score,
           c.flavors,
           c.notes,
           c.created_at
      FROM checkins c
      JOIN _rewire_wine_map m ON m.checkin_id = c.id
      LEFT JOIN users u ON u.id = c.user_id
     ORDER BY c.id
    RETURNING id, wine_id
  )
  INSERT INTO _rewire_rating_map (checkin_id, rating_id)
  SELECT m.checkin_id, i.id
    FROM inserted i
    JOIN _rewire_wine_map m ON m.wine_id = i.wine_id;

  -- Now the feed_items, with EXPLICIT id = checkin.id. Postgres won't
  -- auto-bump the sequence on an explicit insert — fixed by setval below.
  INSERT INTO feed_items (
    id, user_id, kind, session_id, rating_id,
    venue_name, city, country, lat, lng, location_public, created_at
  )
  SELECT c.id,
         c.user_id,
         'standalone',
         NULL,
         r.rating_id,
         c.venue_name,
         c.city,
         c.country,
         c.lat,
         c.lng,
         -- locationPublic: true iff any location field is non-null
         -- (matches POST /api/checkins behaviour per §5).
         CASE WHEN c.venue_name IS NOT NULL
                OR c.city IS NOT NULL
                OR c.country IS NOT NULL
                OR c.lat IS NOT NULL
                OR c.lng IS NOT NULL
              THEN true ELSE false
         END,
         c.created_at
    FROM checkins c
    JOIN _rewire_rating_map r ON r.checkin_id = c.id;

  -- Rating images for any checkin that had an imageUrl.
  INSERT INTO rating_images (rating_id, image_url, sort_order, created_at)
  SELECT r.rating_id,
         c.image_url,
         0,
         c.created_at
    FROM checkins c
    JOIN _rewire_rating_map r ON r.checkin_id = c.id
   WHERE c.image_url IS NOT NULL;

  DROP TABLE _rewire_wine_map;
  DROP TABLE _rewire_rating_map;

  INSERT INTO _migration_checkpoints (name, last_row_id)
    VALUES ('rewire_data_standalone', (SELECT COALESCE(MAX(id), 0) FROM checkins));
END
$$;

------------------------------------------------------------------------
-- Step 4: sequence bump for feed_items
--
-- Standalone feed_items got EXPLICIT ids matching checkin.id. The
-- sequence hasn't moved. Future POSTs would collide. Bump it past
-- the max with a SCALAR subquery — the `setval(seq, MAX(id)) FROM
-- feed_items` form is the foot-gun (fires once per row, last value
-- depends on physical row order).
------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _migration_checkpoints
    WHERE name = 'rewire_data_sequence_bump'
  ) THEN
    RAISE NOTICE 'rewire_data_sequence_bump already complete; skipping';
    RETURN;
  END IF;

  -- Scalar subquery ensures setval fires once with the correct max.
  -- COALESCE handles the edge case of zero checkins (empty database
  -- on a fresh test environment) — setval requires a positive value.
  PERFORM setval(
    'feed_items_id_seq',
    GREATEST((SELECT COALESCE(MAX(id), 0) FROM feed_items), 1)
  );

  INSERT INTO _migration_checkpoints (name, last_row_id)
    VALUES ('rewire_data_sequence_bump', 0);
END
$$;

------------------------------------------------------------------------
-- Step 5: session feed_items from existing ratings
--
-- Per §5: for each (session, user) pair where the user has at least
-- one rating AND user_id IS NOT NULL (anon-only sessions produce no
-- feed_item — §3). createdAt = earliest rating's ratedAt.
--
-- Uses ON CONFLICT DO NOTHING against feed_items_user_id_session_id_key
-- (the @@unique on FeedItem). Idempotent: a re-run finds the row and
-- no-ops.
------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _migration_checkpoints
    WHERE name = 'rewire_data_session_feed_items'
  ) THEN
    RAISE NOTICE 'rewire_data_session_feed_items already complete; skipping';
    RETURN;
  END IF;

  -- Engagement guard per rewire.md §3: a session feed_item only materialises
  -- when the user actually engaged with at least one wine (score > 0, OR
  -- flavour chips set, OR a non-empty note). Pre-rewire ratings that were
  -- all-empty (legacy oddity) shouldn't show up as ghost session posts.
  -- Mirrors the runtime `hasEngagement` guard in the rate POST handler.
  INSERT INTO feed_items (
    user_id, kind, session_id, created_at, location_public
  )
  SELECT r.user_id,
         'session',
         r.session_id,
         MIN(r.rated_at),
         false
    FROM ratings r
   WHERE r.user_id IS NOT NULL
     AND r.session_id IS NOT NULL
   GROUP BY r.user_id, r.session_id
  HAVING bool_or(
           (r.score IS NOT NULL AND r.score > 0)
        OR (r.flavors IS NOT NULL AND r.flavors <> '{}'::jsonb)
        OR (r.notes IS NOT NULL AND length(r.notes) > 0)
       )
  ON CONFLICT (user_id, session_id) DO NOTHING;

  INSERT INTO _migration_checkpoints (name, last_row_id)
    VALUES ('rewire_data_session_feed_items', 0);
END
$$;

------------------------------------------------------------------------
-- Step 6: feed_item_likes from checkin_likes
--
-- feed_items.id = checkin.id for standalone rows (step 3), so a flat
-- copy works. user_id maps 1:1. Session feed_items don't have likes
-- in the legacy model.
--
-- ON CONFLICT against feed_item_likes' compound PK (user_id, feed_item_id).
------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _migration_checkpoints
    WHERE name = 'rewire_data_likes'
  ) THEN
    RAISE NOTICE 'rewire_data_likes already complete; skipping';
    RETURN;
  END IF;

  INSERT INTO feed_item_likes (user_id, feed_item_id, created_at)
  SELECT cl.user_id, cl.checkin_id, cl.created_at
    FROM checkin_likes cl
  ON CONFLICT (user_id, feed_item_id) DO NOTHING;

  INSERT INTO _migration_checkpoints (name, last_row_id)
    VALUES ('rewire_data_likes', 0);
END
$$;

------------------------------------------------------------------------
-- Step 7: feed_item_tags from checkin_tags
--
-- Same id-equality story. The legacy checkin_tags has no createdAt
-- column; use NOW() as a best-effort. Documented lossy mapping (the
-- exact moment of tagging is gone for migrated tags).
------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _migration_checkpoints
    WHERE name = 'rewire_data_tags'
  ) THEN
    RAISE NOTICE 'rewire_data_tags already complete; skipping';
    RETURN;
  END IF;

  INSERT INTO feed_item_tags (feed_item_id, user_id, created_at)
  SELECT ct.checkin_id, ct.user_id, NOW()
    FROM checkin_tags ct
  ON CONFLICT (feed_item_id, user_id) DO NOTHING;

  INSERT INTO _migration_checkpoints (name, last_row_id)
    VALUES ('rewire_data_tags', 0);
END
$$;

COMMIT;
