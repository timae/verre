/*
  Warnings:

  - The primary key for the `auth_accounts` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `auth_accounts` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `auth_sessions` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `auth_sessions` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `auth_verifications` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `auth_verifications` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "auth_accounts" DROP CONSTRAINT "auth_accounts_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "auth_verifications" DROP CONSTRAINT "auth_verifications_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "auth_verifications_pkey" PRIMARY KEY ("id");
