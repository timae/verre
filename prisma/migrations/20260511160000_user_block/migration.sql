-- Per-pair block. Stronger than mute: bidirectional invisibility outside
-- shared sessions, dormant inside sessions. Non-destructive (follows,
-- mutes, likes, tags between the pair stay intact). CHECK constraint
-- forbids self-block.

CREATE TABLE "user_blocks" (
  "blocker_id" INTEGER        NOT NULL,
  "blocked_id" INTEGER        NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id"),
  CONSTRAINT "user_blocks_not_self_chk" CHECK ("blocker_id" <> "blocked_id")
);

CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks"("blocked_id");

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocker_id_fkey"
  FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocked_id_fkey"
  FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
