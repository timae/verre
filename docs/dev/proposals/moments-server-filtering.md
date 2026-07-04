# Moments lists: Postgres-authoritative roles + server-side filtering

**Status:** proposal (Simon asked for the write-up 2026-07-04). Not scheduled.
**Trigger:** the mobile moments filters/search exist to FIND OLD MOMENTS, but
they run client-side over one `/api/me/sessions` payload. Today that payload
is capped (500-row safety valve after the LIMIT-50 clip ate the two oldest
friend-shared sessions), and two facets quietly lie on expired moments
because their truth lives only in Redis. Server-side filtering is the
end-state; it is blocked on roles becoming Postgres-authoritative first.

## Part A — roles move into Postgres (independently valuable, do first)

**Today:** the trust anchor for cohost/provider is Redis meta
(`coHostIds`/`providerIds`). `session_members.role` already EXISTS as a
partial mirror: `/visit` snapshots `host|co_host|taster` at visit time (no
`provider`), the role route mirrors changes for `u:` targets, and the wipe
path resets to `taster`. But `/api/me/sessions` never READS it — on an
expired session the caller's role degrades to host-or-nothing, and the
role filter lies about old moments. The same gap is why the cohost
feed-redaction fix is parked ("PG cohost mirror") and why anon-host names
snapshot-drift.

**Change:**
1. `session_members.role` becomes the DURABLE record. Enum grows `provider`.
   Audit every role-mutation path to write it: role grant/revoke (all
   transitions, both directions), visit (add `provider` to its snapshot),
   kick/ban (resets), wipe (already does). Redis meta stays the LIVE trust
   anchor for in-session authorization — nothing about request auth changes;
   Postgres is the archive copy, written through the same chokepoints.
2. Backfill migration: for live sessions, sweep Redis meta and update rows
   (expand-style, idempotent). Expired history keeps its visit-time snapshot
   (provider rows are unrecoverable there — accepted, they were 'taster').
3. `/api/me/sessions` reads `sm.role` as the fallback when Redis meta is
   gone (live sessions keep the Redis-first resolution — reflects grants
   after the last visit). Codex flagged the same gap independently
   (2026-07-04 P2: expired cohost/provider rows misclassify under the role
   filter) and the audit for it confirmed the mirror is ALREADY trustworthy
   for registered users (the role route mirrors every transition incl.
   provider; `/visit` never overwrites) — Simon's call: ship it with this
   proposal, not piecemeal.
4. Anon roles stay Redis-only (an anon can't log in to see a moments list;
   `session_members.user_id` is NOT NULL by design).

**Also unblocks:** the cohost feed-redaction fix (sessionFeedWines can check
the PG mirror), honest role display on expired moments everywhere.

## Part B — server-side filtering/search on /api/me/sessions

**Contract:** `GET /api/me/sessions?q&roles&hosts&people&from&to&category&cursor&limit`
— same response shape per row, plus `nextCursor`. No params = today's
behavior (the home carousel keeps its unfiltered recent page).

- **SQL facets** (all Postgres after Part A): date window on
  `COALESCE(date_from, created_at)`; `category`; `people` via
  `EXISTS (session_members sm2 WHERE sm2.user_id = ANY(friendIds))` — AND
  semantics = one EXISTS per selected friend; `roles` via the caller's
  `sm.role`; `hosts` via `host_user_id` (registered) — anon-hosted moments
  match on the `host_name` snapshot, accepting rename drift.
- **Search:** `unaccent` + `pg_trgm` (`ILIKE`/similarity) over
  `sessions.name` + `host_name`. ⚠️ ACCEPTED DIVERGENCE from the client-side
  forgiving matcher (`apps/mobile/src/lib/search.ts` — OSA typos, scaled
  tolerance): pg_trgm forgives differently. Document it; do NOT try to
  replicate the OSA matcher in SQL. Extension availability on Deplo.io
  managed Postgres must be verified before this ships (deployment.md note).
  Option (v2): extend `q` to reach wine names via `EXISTS (wines w …)` —
  "find the moment where we had the Oslavje".
- **Enrichment** (Redis TTL/meta/people) runs on the returned page only —
  the cap becomes a real page size again instead of a safety valve.
- **Client:** `recents.tsx` moves query+filters into the request (debounced
  `q`, params from the filter sheet), infinite-scroll on `nextCursor`.
  Friends-there picker counts come from a cheap
  `GET /api/me/sessions/facets?friends=1` aggregate or are dropped in favor
  of showing all friends (server decides matches anyway). The home screen
  (carousel + Upcoming/Recent rows) is untouched.

## Sequencing & size

A before B (B's role facet needs A). A is small: enum value + write-path
audit + backfill + one read-side fallback — a normal feature branch. B is
medium: route params + pagination + client rework + extension check. Neither
is urgent while the whole history fits one payload; the 500-row valve buys
the time. Revisit trigger: real payload pain, or the durable-sessions work
(future-ideas) — B should ride with that if it lands first.

## Open questions (decide at build time)

1. pg_trgm similarity threshold vs plain unaccented ILIKE — start with ILIKE
   (substring, accent-insensitive), add trigram fuzziness only if misses
   annoy in practice?
2. Does `q` reach wine names in v1 or v2?
3. Keep per-friend match counts in the picker (needs the facets aggregate)
   or drop counts once matching is server-truth?
