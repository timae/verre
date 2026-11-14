-- Usernames (docs/dev/proposals/usernames.md § 3). Additive only: the previous
-- release runs unchanged on the migrated database. It never reads or writes
-- the new column, so the claim triggers never fire for it (its register
-- inserts a NULL username, which passes untouched); the delete trigger does
-- fire on its account deletions and, with a NULL username, only prunes.
--
--   1. users.username (NULL = has not chosen yet, for good), its unique index,
--      its trigram index (people search), its format CHECK: byte-for-byte the
--      FORMAT half of the core validator (`isUsernameFormat`, @verre/core):
--      lowercase a-z 0-9 . _, 3 to 30, no `..`, no dot at either end, at least
--      one letter or digit.
--      🔒 The reserved list is NOT here: it is policy, it changes without a
--      migration, and the operator script may assign a reserved name.
--   2. username_holds (a name nobody else may take yet) and username_changes
--      (the rename quota's rows).
--   3. username_hash / username_is_held: the ONE spelling of the hash and of
--      "a live hold by someone else".
--   4. The hold triggers. 🔒 Holds are enforced HERE, not in app code: four
--      writers touch users.username (Better Auth's own insert, the web
--      register, the change route, the operator script) plus every delete
--      path, and a trigger covers them and any future one.
--
-- 🔒 The claim triggers are AFTER, on purpose. B claims a name while A is
-- releasing it (a rename or a deletion, not yet committed): B's row write
-- waits on the unique index until A commits, an AFTER trigger runs after that
-- wait, and under READ COMMITTED its queries see A's committed hold. A BEFORE
-- trigger would have looked before the wait and missed it. Under REPEATABLE
-- READ the trigger would read a stale snapshot, so it refuses outright.
--
-- The hash is a plain SHA-256 of a 3 to 30 character name: it keeps a deleted
-- person's handle out of plain sight; whoever holds the database can still
-- test a guess against it (ruled, D1).
--
-- Lock: the transaction holds ACCESS EXCLUSIVE on `users` from the ALTER to
-- COMMIT, through both index builds and the CHECK's validation scan
-- (lock_timeout bounds only the WAIT for it). Milliseconds at today's size;
-- past roughly 100k users the index builds move into their own migrations as
-- CREATE INDEX CONCURRENTLY. Record the row count and this file's duration on
-- a copy before the deploy (docs/dev/deployment.md § Usernames).
--
-- If the deploy fails on the lock timeout (a long transaction holding
-- `users`; find it with the pg_locks query in docs/dev/deployment.md
-- § PRE-DEPLOY CHECK): the transaction applied nothing, so clear the cause,
-- then
--
--   npx prisma migrate resolve --rolled-back 20261114090000_usernames
--   npx prisma migrate deploy
--
-- Never `--applied`: that marks the work done without doing it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. users.username
ALTER TABLE "users" ADD COLUMN "username" VARCHAR(30);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

CREATE INDEX "users_username_idx" ON "users" USING GIN ("username" gin_trgm_ops);

ALTER TABLE "users"
  ADD CONSTRAINT "users_username_format_chk"
  CHECK ("username" IS NULL
      OR ("username" ~ '^[a-z0-9._]{3,30}$'
          AND "username" !~ '\.\.'
          AND "username" !~ '^\.'
          AND "username" !~ '\.$'
          AND "username" ~ '[a-z0-9]'));

-- 2. holds and changes
CREATE TABLE "username_holds" (
    "name_hash" BYTEA NOT NULL,
    "user_id" INTEGER,
    "username" VARCHAR(30),
    "held_until" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "username_holds_pkey" PRIMARY KEY ("name_hash")
);

CREATE TABLE "username_changes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "username_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "username_holds_user_id_idx" ON "username_holds"("user_id");

CREATE INDEX "username_holds_held_until_idx" ON "username_holds"("held_until");

CREATE INDEX "username_changes_user_id_changed_at_idx" ON "username_changes"("user_id", "changed_at");

ALTER TABLE "username_holds" ADD CONSTRAINT "username_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "username_changes" ADD CONSTRAINT "username_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. The hash and the hold predicate
CREATE FUNCTION public.username_hash(name text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$ SELECT sha256(convert_to(name, 'UTF8')) $$;

-- A live hold by someone else. Both NULLs matter: a sign-up has no user yet
-- (for_user NULL) and a deleted account's hold has none either (user_id NULL);
-- a NULL-safe comparison would read those two as "the same owner" and call
-- the name free. The date is tested here, never left to a prune.
CREATE FUNCTION public.username_is_held(name text, for_user integer) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.username_holds h
    WHERE h.name_hash = public.username_hash(name)
      AND h.held_until > now()
      AND (for_user IS NULL OR h.user_id IS NULL OR h.user_id <> for_user)
  )
$$;

-- 4. Triggers. One function, three triggers, so the hold period has one home.
CREATE FUNCTION public.users_username_hold() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  hold_period CONSTANT interval := interval '14 days';
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The user's own rename holds become anonymous (their date kept), the
    -- current name is held with no user and no clear text. The upsert means
    -- an account deletion can never fail here.
    UPDATE public.username_holds SET user_id = NULL, username = NULL WHERE user_id = OLD.id;
    IF OLD.username IS NOT NULL THEN
      INSERT INTO public.username_holds (name_hash, user_id, username, held_until)
      VALUES (public.username_hash(OLD.username), NULL, NULL, now() + hold_period)
      ON CONFLICT (name_hash) DO UPDATE
        SET user_id = NULL, username = NULL, held_until = EXCLUDED.held_until;
    END IF;
    DELETE FROM public.username_holds WHERE name_hash IN (
      SELECT name_hash FROM public.username_holds WHERE held_until <= now() FOR UPDATE SKIP LOCKED);
    RETURN OLD;
  END IF;

  IF NEW.username IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.username IS NOT DISTINCT FROM OLD.username THEN RETURN NULL; END IF;

  -- (Postgres runs READ UNCOMMITTED as READ COMMITTED.)
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'users.username can only be written under READ COMMITTED'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Claim: the caller's own hold on this name goes (switching back); a live
  -- hold by anyone else fails exactly like a taken name.
  DELETE FROM public.username_holds
   WHERE name_hash = public.username_hash(NEW.username) AND user_id = NEW.id;
  IF public.username_is_held(NEW.username, NEW.id) THEN
    RAISE EXCEPTION 'username is held'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'users_username_held';
  END IF;

  -- Release: the old name is held 14 days for its owner (who may switch back
  -- to it). An EARLIER old name stays held until its own date, but for
  -- nobody: it loses its owner and its clear text, so a second rename never
  -- frees a name early (a long-used handle and its links don't change hands
  -- the same minute), and only the most recent old name can be switched back to.
  IF TG_OP = 'UPDATE' AND OLD.username IS NOT NULL THEN
    UPDATE public.username_holds SET user_id = NULL, username = NULL WHERE user_id = NEW.id;
    INSERT INTO public.username_holds (name_hash, user_id, username, held_until)
    VALUES (public.username_hash(OLD.username), NEW.id, OLD.username, now() + hold_period)
    ON CONFLICT (name_hash) DO UPDATE
      SET user_id = EXCLUDED.user_id, username = EXCLUDED.username, held_until = EXCLUDED.held_until;
  END IF;

  -- Prune, skipping rows another transaction has locked (two concurrent
  -- writes can't deadlock on it).
  DELETE FROM public.username_holds WHERE name_hash IN (
    SELECT name_hash FROM public.username_holds WHERE held_until <= now() FOR UPDATE SKIP LOCKED);
  RETURN NULL;
END $$;

CREATE TRIGGER "users_username_claim_insert"
  AFTER INSERT ON "users"
  FOR EACH ROW WHEN (NEW.username IS NOT NULL)
  EXECUTE FUNCTION public.users_username_hold();

-- Scoped to the column: the lifetime-counter bumps, profile edits and session
-- writes never name it, so they never fire this.
CREATE TRIGGER "users_username_claim_update"
  AFTER UPDATE OF "username" ON "users"
  FOR EACH ROW WHEN (NEW.username IS DISTINCT FROM OLD.username)
  EXECUTE FUNCTION public.users_username_hold();

CREATE TRIGGER "users_username_hold_delete"
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION public.users_username_hold();

-- Set once, never cleared.
CREATE FUNCTION public.users_username_keep() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'users.username cannot be cleared' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER "users_username_keep"
  BEFORE UPDATE OF "username" ON "users"
  FOR EACH ROW WHEN (OLD.username IS NOT NULL AND NEW.username IS NULL)
  EXECUTE FUNCTION public.users_username_keep();

COMMIT;
