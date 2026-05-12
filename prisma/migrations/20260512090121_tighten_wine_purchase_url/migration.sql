/*
  Warnings:

  - You are about to alter the column `purchase_url` on the `wines` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(1000)`.

*/
-- AlterTable
ALTER TABLE "wines" ALTER COLUMN "purchase_url" SET DATA TYPE VARCHAR(1000);
