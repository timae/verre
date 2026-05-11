-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "added_by_identity_id" VARCHAR(64);

-- CreateIndex
CREATE INDEX "wines_session_id_added_by_identity_id_idx" ON "wines"("session_id", "added_by_identity_id");
