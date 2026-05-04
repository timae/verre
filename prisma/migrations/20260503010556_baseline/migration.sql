-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'taster',
    "pro" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "lifetime_ratings" INTEGER NOT NULL DEFAULT 0,
    "lifetime_five_star" INTEGER NOT NULL DEFAULT 0,
    "lifetime_one_star" INTEGER NOT NULL DEFAULT 0,
    "lifetime_notes_written" INTEGER NOT NULL DEFAULT 0,
    "lifetime_max_note_len" INTEGER NOT NULL DEFAULT 0,
    "lifetime_sessions_joined" INTEGER NOT NULL DEFAULT 0,
    "lifetime_sessions_hosted" INTEGER NOT NULL DEFAULT 0,
    "lifetime_photos_added" INTEGER NOT NULL DEFAULT 0,
    "lifetime_consecutive_months" INTEGER NOT NULL DEFAULT 0,
    "first_rated_at" TIMESTAMP(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" SERIAL NOT NULL,
    "code" CHAR(4) NOT NULL,
    "host_user_id" INTEGER,
    "host_name" VARCHAR(64) NOT NULL,
    "blind" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" VARCHAR(255),
    "address" VARCHAR(255),
    "date_from" TIMESTAMPTZ(6),
    "date_to" TIMESTAMPTZ(6),
    "timezone" VARCHAR(64),
    "description" TEXT,
    "link" VARCHAR(512),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wines" (
    "id" VARCHAR(20) NOT NULL,
    "session_id" INTEGER,
    "name" VARCHAR(255) NOT NULL,
    "producer" VARCHAR(255),
    "vintage" CHAR(4),
    "grape" VARCHAR(255),
    "category" VARCHAR(32) NOT NULL DEFAULT 'wine',
    "style" VARCHAR(64),
    "image_url" TEXT,
    "purchase_url" TEXT,
    "revealed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" SERIAL NOT NULL,
    "wine_id" VARCHAR(20) NOT NULL,
    "user_id" INTEGER,
    "rater_name" VARCHAR(64) NOT NULL,
    "is_host" BOOLEAN NOT NULL DEFAULT false,
    "score" SMALLINT NOT NULL,
    "flavors" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "rated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_members" (
    "user_id" INTEGER NOT NULL,
    "session_code" CHAR(4) NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" VARCHAR(16) NOT NULL DEFAULT 'taster',

    CONSTRAINT "session_members_pkey" PRIMARY KEY ("user_id","session_code")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "wine_id" VARCHAR(20) NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hall_of_fame" (
    "id" SERIAL NOT NULL,
    "wine_name" VARCHAR(255) NOT NULL,
    "producer" VARCHAR(255),
    "vintage" CHAR(4),
    "category" VARCHAR(32) NOT NULL DEFAULT 'wine',
    "style" VARCHAR(64),
    "score" SMALLINT NOT NULL,
    "rater_name" VARCHAR(64) NOT NULL,
    "user_id" INTEGER,
    "session_code" CHAR(4),
    "rated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hall_of_fame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" VARCHAR(60) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "icon" VARCHAR(10) NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "rarity" VARCHAR(20) NOT NULL DEFAULT 'common',
    "xp_reward" INTEGER NOT NULL DEFAULT 50,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "badge_id" VARCHAR(60) NOT NULL,
    "earned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_code_key" ON "sessions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_wine_id_user_id_key" ON "ratings"("wine_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_user_id_wine_id_key" ON "bookmarks"("user_id", "wine_id");

-- CreateIndex
CREATE UNIQUE INDEX "hall_of_fame_wine_name_user_id_key" ON "hall_of_fame"("wine_name", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_badges_user_id_badge_id_key" ON "user_badges"("user_id", "badge_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wines" ADD CONSTRAINT "wines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_wine_id_fkey" FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_members" ADD CONSTRAINT "session_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_wine_id_fkey" FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "hall_of_fame" ADD CONSTRAINT "hall_of_fame_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

