-- Align social-feed FK constraints with Prisma's canonical form.
-- The original add_social_feed migration created FKs without an explicit
-- ON UPDATE clause (which Postgres treats as NO ACTION). Prisma's schema
-- model derives ON UPDATE CASCADE from `onDelete: Cascade`, so the offline
-- schema-vs-migrations diff fires drop+re-add for every social-feed FK.
-- This migration applies that drop+re-add once so future diffs go quiet.
-- Functionally a no-op: users/checkins ids are SERIAL and never change.

-- DropForeignKey
ALTER TABLE "checkin_likes" DROP CONSTRAINT "checkin_likes_checkin_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_likes" DROP CONSTRAINT "checkin_likes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_tags" DROP CONSTRAINT "checkin_tags_checkin_id_fkey";

-- DropForeignKey
ALTER TABLE "checkin_tags" DROP CONSTRAINT "checkin_tags_user_id_fkey";

-- DropForeignKey
ALTER TABLE "checkins" DROP CONSTRAINT "checkins_user_id_fkey";

-- DropForeignKey
ALTER TABLE "follows" DROP CONSTRAINT "follows_follower_id_fkey";

-- DropForeignKey
ALTER TABLE "follows" DROP CONSTRAINT "follows_following_id_fkey";

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkin_tags" ADD CONSTRAINT "checkin_tags_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "checkins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkin_tags" ADD CONSTRAINT "checkin_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkin_likes" ADD CONSTRAINT "checkin_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkin_likes" ADD CONSTRAINT "checkin_likes_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "checkins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
