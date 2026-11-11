-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bio" VARCHAR(200),
ADD COLUMN     "cover_photo_url" VARCHAR(512),
ADD COLUMN     "tile_cravings_url" VARCHAR(512),
ADD COLUMN     "tile_impressions_url" VARCHAR(512),
ADD COLUMN     "tile_moments_url" VARCHAR(512);
