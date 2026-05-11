-- checkin_tags: tag mutual follows in a check-in

CREATE TABLE IF NOT EXISTS "checkin_tags" (
  "checkin_id" INTEGER NOT NULL,
  "user_id"    INTEGER NOT NULL,
  CONSTRAINT "checkin_tags_pkey" PRIMARY KEY ("checkin_id", "user_id"),
  CONSTRAINT "checkin_tags_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "checkins"("id") ON DELETE CASCADE,
  CONSTRAINT "checkin_tags_user_id_fkey"    FOREIGN KEY ("user_id")    REFERENCES "users"("id")    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "checkin_tags_user_id_idx" ON "checkin_tags"("user_id");
