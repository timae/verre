-- Social feed: follows, checkins (with location), checkin_likes

CREATE TABLE "follows" (
  "follower_id"  INTEGER NOT NULL,
  "following_id" INTEGER NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "following_id"),
  CONSTRAINT "follows_no_self" CHECK ("follower_id" <> "following_id"),
  CONSTRAINT "follows_follower_id_fkey"  FOREIGN KEY ("follower_id")  REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "follows_following_id_idx" ON "follows"("following_id");

CREATE TABLE "checkins" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER NOT NULL,
  "wine_name"   VARCHAR(255) NOT NULL,
  "producer"    VARCHAR(255),
  "vintage"     CHAR(4),
  "grape"       VARCHAR(255),
  "type"        VARCHAR(16),
  "score"       SMALLINT CHECK ("score" BETWEEN 0 AND 5),
  "flavors"     JSONB NOT NULL DEFAULT '{}',
  "notes"       TEXT,
  "image_url"   TEXT,
  "venue_name"  VARCHAR(255),
  "city"        VARCHAR(100),
  "country"     CHAR(2),
  "lat"         NUMERIC(9,6),
  "lng"         NUMERIC(9,6),
  "is_public"   BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "checkins_user_id_created_at_idx" ON "checkins"("user_id", "created_at" DESC);
CREATE INDEX "checkins_city_idx" ON "checkins"("city") WHERE "city" IS NOT NULL;

CREATE TABLE "checkin_likes" (
  "user_id"    INTEGER NOT NULL,
  "checkin_id" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "checkin_likes_pkey" PRIMARY KEY ("user_id", "checkin_id"),
  CONSTRAINT "checkin_likes_user_id_fkey"    FOREIGN KEY ("user_id")    REFERENCES "users"("id")    ON DELETE CASCADE,
  CONSTRAINT "checkin_likes_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "checkins"("id") ON DELETE CASCADE
);
