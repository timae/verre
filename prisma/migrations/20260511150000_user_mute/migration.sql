-- Per-pair soft-hide ("silence"). A mutes B → A doesn't see B's content
-- in A's feed; B is unaware. CHECK constraint forbids self-mute.

CREATE TABLE "user_mutes" (
  "muter_id"   INTEGER        NOT NULL,
  "muted_id"   INTEGER        NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("muter_id", "muted_id"),
  CONSTRAINT "user_mutes_not_self_chk" CHECK ("muter_id" <> "muted_id")
);

CREATE INDEX "user_mutes_muted_id_idx" ON "user_mutes"("muted_id");

ALTER TABLE "user_mutes"
  ADD CONSTRAINT "user_mutes_muter_id_fkey"
  FOREIGN KEY ("muter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_mutes"
  ADD CONSTRAINT "user_mutes_muted_id_fkey"
  FOREIGN KEY ("muted_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
