-- Social feed: follows + checkins

CREATE TABLE "follows" (
  "follower_id"  INTEGER NOT NULL,
  "following_id" INTEGER NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "following_id"),
  CONSTRAINT "follows_follower_id_fkey"  FOREIGN KEY ("follower_id")  REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "follows_following_id_idx" ON "follows"("following_id");

CREATE TABLE "checkins" (
  "id"         SERIAL PRIMARY KEY,
  "user_id"    INTEGER NOT NULL,
  "wine_name"  VARCHAR(255) NOT NULL,
  "producer"   VARCHAR(255),
  "vintage"    CHAR(4),
  "grape"      VARCHAR(255),
  "type"       VARCHAR(16),
  "score"      SMALLINT,
  "flavors"    JSONB NOT NULL DEFAULT '{}',
  "notes"      TEXT,
  "image_url"  TEXT,
  "is_public"  BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "checkins_user_id_created_at_idx" ON "checkins"("user_id", "created_at" DESC);
