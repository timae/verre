-- Public user ids (docs/dev/proposals/public-user-ids.md § 3). Additive only:
-- the integer stays the primary key and every foreign key; the public id is
-- the only user id the wire carries. The previous release runs unchanged on
-- the migrated database (it never reads the new columns).
--
--   1. follows (following_id, created_at) / (follower_id, created_at): the
--      people lists' newest-follow-first keyset (D3).
--   2. CHECKs on the two stored identity strings (session_bans.identity_id,
--      wines.added_by_identity_id), byte-for-byte the internal validator
--      (lib/identity.ts isValidIdentityId: `u:` digits, case-insensitive `a:` /
--      `d:` uuids), so a missed inbound translation (a `u:<publicId>` reaching
--      storage) fails loudly instead of storing a ban that never matches.
--   3. users: gen_public_user_id(), public_id (every existing row gets its own
--      value in the same statement), its unique index, its format CHECK, the
--      mint trigger (🔒 ALWAYS overrides a supplied value: no creation path
--      can choose an id) and the immutability trigger; the three
--      tile_*_own_url columns (tile ownership moves off the image key, D2),
--      backfilled with today's exact isOwnTileUpload test (lib/profileTiles.ts).
--
-- Lock order: follows, wines, session_bans first, `users` LAST so its ACCESS
-- EXCLUSIVE (a volatile DEFAULT on ADD COLUMN rewrites the table, and every
-- authenticated request reads `users`) isn't held through the others.
--
-- 🔒 The mint trigger also fires on COPY: a DATA-ONLY restore needs
-- --disable-triggers or every user gets a new id (docs/dev/deployment.md).
--
-- If the deploy fails on the lock timeout (a long transaction holding one of
-- the four tables; find it with the pg_locks query in docs/dev/deployment.md
-- § PRE-DEPLOY CHECK): the transaction applied nothing, so clear the cause,
-- then
--
--   npx prisma migrate resolve --rolled-back 20261112230000_public_user_ids
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. follows
CREATE INDEX "follows_following_id_created_at_idx" ON "follows"("following_id", "created_at");
CREATE INDEX "follows_follower_id_created_at_idx" ON "follows"("follower_id", "created_at");

-- 2. Stored identity strings. A nonconforming row fails this migration: count
-- them first (docs/dev/deployment.md § Public user ids).
ALTER TABLE "wines"
  ADD CONSTRAINT "wines_added_by_identity_id_chk"
  CHECK ("added_by_identity_id" IS NULL
      OR "added_by_identity_id" ~ '^u:[0-9]+$'
      OR "added_by_identity_id" ~* '^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR "added_by_identity_id" ~* '^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE "session_bans"
  ADD CONSTRAINT "session_bans_identity_id_chk"
  CHECK ("identity_id" ~ '^u:[0-9]+$'
      OR "identity_id" ~* '^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR "identity_id" ~* '^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- 3. users
--
-- 12 characters: a LETTER (the 22 letters of the Crockford alphabet) then 11
-- of its 32 characters, about 59 bits, from gen_random_uuid() bytes (version
-- and variant bytes 6 and 8 skipped, 14 usable). Tail: byte % 32 (uniform,
-- 256 = 8 · 32). First letter: rejection sampling, a byte below 242 then % 22
-- (242 = 11 · 22) from the 3 bytes left; all three miss about once in 6,000
-- mints, and then it loops to a fresh uuid. The synthetic sign-up id
-- (lib/betterAuth.ts) uses exactly this mapping.
CREATE FUNCTION public.gen_public_user_id() RETURNS VARCHAR(12)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  alphabet CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  letters CONSTANT text := 'ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea;
  tail text;
  p int;
  v int;
BEGIN
  LOOP
    b := uuid_send(gen_random_uuid());
    tail := '';
    FOREACH p IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12] LOOP
      tail := tail || substr(alphabet, (get_byte(b, p) % 32) + 1, 1);
    END LOOP;
    FOREACH p IN ARRAY ARRAY[13, 14, 15] LOOP
      v := get_byte(b, p);
      IF v < 242 THEN
        RETURN substr(letters, (v % 22) + 1, 1) || tail;
      END IF;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE "users"
  ADD COLUMN "public_id" VARCHAR(12) NOT NULL DEFAULT gen_public_user_id(),
  ADD COLUMN "tile_impressions_own_url" VARCHAR(512),
  ADD COLUMN "tile_moments_own_url" VARCHAR(512),
  ADD COLUMN "tile_cravings_own_url" VARCHAR(512);

CREATE UNIQUE INDEX "users_public_id_key" ON "users"("public_id");

ALTER TABLE "users"
  ADD CONSTRAINT "users_public_id_format_chk"
  CHECK ("public_id" ~ '^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$');

CREATE FUNCTION public.users_public_id_mint() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.public_id := public.gen_public_user_id();
  RETURN NEW;
END $$;

CREATE TRIGGER "users_public_id_mint"
  BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION public.users_public_id_mint();

CREATE FUNCTION public.users_public_id_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'users.public_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Scoped to the column, so the lifetime-counter bump on every rating never
-- fires it.
CREATE TRIGGER "users_public_id_immutable"
  BEFORE UPDATE OF "public_id" ON "users"
  FOR EACH ROW EXECUTE FUNCTION public.users_public_id_immutable();

-- own ⇔ tile_*_url = tile_*_own_url. Backfilled with today's exact own test
-- (key part `/avatars/tile_<tile>_u_<id>_` with no `/` after it), not a LIKE
-- (`_` is a wildcard: `_u_42_` would match `_u_421_`).
UPDATE "users" SET
  "tile_impressions_own_url" = CASE
    WHEN strpos("tile_impressions_url", '/avatars/tile_impressions_u_' || "id" || '_') > 0
     AND strpos(substr("tile_impressions_url", strpos("tile_impressions_url", '/avatars/tile_impressions_u_' || "id" || '_') + length('/avatars/tile_impressions_u_' || "id" || '_')), '/') = 0
    THEN "tile_impressions_url" END,
  "tile_moments_own_url" = CASE
    WHEN strpos("tile_moments_url", '/avatars/tile_moments_u_' || "id" || '_') > 0
     AND strpos(substr("tile_moments_url", strpos("tile_moments_url", '/avatars/tile_moments_u_' || "id" || '_') + length('/avatars/tile_moments_u_' || "id" || '_')), '/') = 0
    THEN "tile_moments_url" END,
  "tile_cravings_own_url" = CASE
    WHEN strpos("tile_cravings_url", '/avatars/tile_cravings_u_' || "id" || '_') > 0
     AND strpos(substr("tile_cravings_url", strpos("tile_cravings_url", '/avatars/tile_cravings_u_' || "id" || '_') + length('/avatars/tile_cravings_u_' || "id" || '_')), '/') = 0
    THEN "tile_cravings_url" END
WHERE "tile_impressions_url" IS NOT NULL OR "tile_moments_url" IS NOT NULL OR "tile_cravings_url" IS NOT NULL;

COMMIT;
