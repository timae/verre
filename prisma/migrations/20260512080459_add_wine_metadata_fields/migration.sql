-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "country" VARCHAR(2),
ADD COLUMN     "description" VARCHAR(1000),
ADD COLUMN     "region" VARCHAR(255),
ADD COLUMN     "vinification" VARCHAR(1000);
