-- Moment Defaults (docs/dev/proposals/moment-defaults.md): a person's own
-- defaults, COPIED into a moment when they create or join it and into a
-- check-in when they post it; never read live by anything that shows a moment
-- or a post. NULL = the system default (the column defaults of `sessions` and
-- `moment_privacy`, and `feed_items.hidden_from_feed`'s false). Purely the
-- user's own data: cascades with the account. Additive: the previous release
-- never reads it. lock_timeout bounds the WAIT for the lock on `users` (the
-- foreign key), as in 20261124120000_moment_privacy_step3.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE "moment_defaults" (
    "user_id" INTEGER NOT NULL,
    "visibility" VARCHAR(16),
    "include_guest_circles" BOOLEAN,
    "show_place" BOOLEAN,
    "show_details" BOOLEAN,
    "only_inside" BOOLEAN,
    "moment_hidden_from_feed" BOOLEAN,
    "checkin_hidden_from_feed" BOOLEAN,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "moment_defaults_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "moment_defaults_visibility_chk" CHECK ("visibility" IS NULL OR "visibility" IN ('members', 'friends', 'followers', 'verre'))
);

ALTER TABLE "moment_defaults" ADD CONSTRAINT "moment_defaults_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
