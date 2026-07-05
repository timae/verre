-- Accent-insensitive, typo-tolerant moments search for GET /api/me/sessions?q
-- (moments-server-filtering.md Part B). Two building blocks:
--
--   1. `unaccent` — folds diacritics so "venenum" matches "Vénénum". Verified
--      available on Nine's managed Postgres: it ships in the same
--      postgresql-contrib package as pg_trgm, which is already enabled here.
--   2. `f_unaccent(text)` — an IMMUTABLE wrapper around unaccent(). The stock
--      unaccent() is only STABLE (it reads the dictionary), which bars it from
--      an expression index and makes the planner treat it conservatively.
--      Pinning the dictionary argument ('public.unaccent') makes the call
--      deterministic, so we can mark the wrapper IMMUTABLE — required if a
--      functional trgm index is ever added (see the note at the bottom), and
--      cleaner in the WHERE clause either way.
--
-- The search predicate itself (in app/api/me/sessions/route.ts) is:
--     f_unaccent(col) ILIKE '%'||f_unaccent($q)||'%'                -- substring
--  OR word_similarity(f_unaccent($q), f_unaccent(col)) >= 0.3       -- fuzzy
-- over sessions.name + sessions.host_name. The explicit word_similarity()
-- threshold (0.3) is inlined per query — it does NOT use the %> operator, which
-- reads a session-local GUC (pg_trgm.word_similarity_threshold) that would leak
-- across a pooled connection. 0.3 was tuned against the prod dump: it catches
-- real typos (funfn→FunFin, venenom→Vénénum, simn→Simon all score 0.54–0.67)
-- with no false positives across the row set; the stock 0.6 default missed them.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- STRICT: NULL in → NULL out (host_name can be NULL on a tombstoned row).
-- PARALLEL SAFE: usable in parallel plans. IMMUTABLE: the pinned-dictionary
-- call is deterministic, so this is safe to index and constant-fold.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text AS $$
  SELECT public.unaccent('public.unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- No functional GIN index is created here on purpose. The moments-search query
-- is ALWAYS scoped to one caller (WHERE sm.user_id = $me), so it scans at most
-- that user's handful of sessions after the session_members(user_id) narrowing
-- — a seq scan over tens of rows, not the whole table (unlike users/wines
-- search, which do carry trgm GIN indexes because they scan table-wide). If
-- per-user session counts ever grow large enough to matter, the index is:
--   CREATE INDEX sessions_name_unaccent_trgm_idx
--     ON sessions USING gin (f_unaccent(name) gin_trgm_ops);
--   CREATE INDEX sessions_host_name_unaccent_trgm_idx
--     ON sessions USING gin (f_unaccent(host_name) gin_trgm_ops);
-- f_unaccent is IMMUTABLE precisely so those remain legal. (A functional
-- expression index can't be declared in schema.prisma — it would live only
-- here; prisma migrate diff ignores objects it can't model, so it wouldn't
-- register as drift.)
