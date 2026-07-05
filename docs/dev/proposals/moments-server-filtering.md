# Moments lists: Postgres-authoritative roles + server-side filtering

**Status:** proposal (Simon asked for the write-up 2026-07-04). Not scheduled.
**Trigger:** the mobile moments filters/search exist to FIND OLD MOMENTS, but
they run client-side over one `/api/me/sessions` payload capped at the 50
most-recent memberships (a 500 valve was tried 2026-07-04 and reverted over
the Redis enrichment fan-out — Simon's call: accept the clip until this
proposal ships). The device repro that surfaced it: the two oldest
friend-shared sessions fell off the cap and the friend vanished from the
friends-there picker. Two facets additionally lie on expired moments because
their truth lives only in Redis. Server-side filtering is the end-state; it
is blocked on roles becoming Postgres-authoritative first.

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

**As-built (2026-07-05, Part A shipped):**
- #1 — done. `/visit` now snapshots `provider` too (create-only; the role
  route stays the authoritative mirror for transitions). No DDL: `role` is
  `VarChar(16)`, never a Postgres enum — "enum grows provider" meant the
  app-layer union + written values, nothing to `ALTER`.
- #2 — **intentionally dropped** (Simon's call). The audit + an independent
  reviewer confirmed it's a no-op for correctness: the ONLY writer of
  `coHostIds`/`providerIds` is the role route, which already mirrors to PG,
  so registered-user rows are already correct (the 2026-06-29 prod dump has
  0 provider rows and both `co_host` rows already carry `role='co_host'`).
  The only residual is a *transient* swallowed PG-write failure in the role
  route on a still-live session — self-healing on the next transition, and
  repairable (if ever) only by a Redis-reading reconciliation SCRIPT, never
  a SQL migration (migrations can't read Redis; the source lives only in
  `s:{CODE}:meta`). Cosmetic if unrepaired: one old moment misfiled for one
  user after that session expires. Not worth the machinery.
- #3 — done. `/api/me/sessions` initializes `role` from `sm.role` and lets
  the live Redis-meta block OVERRIDE it (now authoritative-when-present incl.
  a reset to null, not upgrade-only). Validated on the prod dump: user `u:2`
  on a tombstoned-host session returned `null` before, now `cohost`.
- #4 — inherent, no code (anon never gets a `session_members` row).

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

**As-built (2026-07-05, Part B shipped):**
- **Contract:** `GET /api/me/sessions?tense&q&roles&hosts&people&category&from&to&cursor&limit`.
  No params → today's behavior verbatim (50 most-recently-active rows, JS
  activity re-sort for the carousel, bare-array body). Any param flips to
  PAGINATED mode. `nextCursor` rides an **`X-Next-Cursor` response header**, not
  the body — so the body stays a bare array in both modes (the home screen
  consumes the array shape directly; only `recents.tsx` reads the header).
- **`tense` added to the contract** (not in the original sketch): `upcoming`
  (future-start, soonest-first) vs `past` (everything else, newest-first). The
  client's two lists were each their own client-side sort; making tense a
  server facet keeps each list a coherent paginated stream instead of one
  date-mixed stream the client re-splits. **The split is a DATE predicate**
  (`upcoming` = `date_from > NOW()`), NOT the Redis-aware per-row `status` — a
  deliberate divergence (Simon 2026-07-05): a registered user's presence
  elevates a moment to unlimited lifespan, so "Redis expired" is not a demotion
  signal for the caller's own memberships (all rows here are). `status` is still
  computed + sent, and the home carousel/counts still route on it; only the
  paginated `recents.tsx` lists route on `tense`. `recents.tsx` renders nothing
  off `status`, so the narrow date-vs-status disagreement is invisible. Full
  rationale in `docs/dev/moments-home.md`.
- **Kicked moments dropped server-side.** A per-row `SISMEMBER s:<C>:kicked`
  in the enrichment drops any session the caller is currently kicked from — from
  the carousel, counts, AND both lists (Simon 2026-07-05). They rejoin by
  code/link (clears it). Detectable only while live in Redis (no PG mirror —
  durable-sessions territory); ban already drops via the deleted member row.
  See `docs/dev/kick-ban.md`.
- **Pagination = keyset**, not offset: cursor is opaque base64url of
  `(eff_key, id)` where `eff_key` is the effective date rendered to
  MICROSECOND-precision text (`to_char(..'US'..)`) — Postgres timestamptz stores
  µs but JS `Date`/Prisma only ms, so a `getTime()` cursor would drop/dupe rows
  sharing a millisecond across a page boundary (a review catch; verified fixed
  with µs-twin rows). The query compares the tuple `(COALESCE(date_from,
  created_at), id)` (bound back as `::timestamptz`) strictly beyond the last
  kept row in the sort direction, with `id` as the stable tiebreak.
  Fetch-one-extra detects the next page (no COUNT). Verified against the prod
  dump: 24 rows paged in pages of 5 with no
  dupes/gaps, terminates.
- **Search = `unaccent` + `pg_trgm`** (Simon's build-time pick, overriding the
  proposal's Q1 "start with plain ILIKE" default): the predicate is
  `f_unaccent(col) ILIKE '%'||f_unaccent(q)||'%' OR word_similarity(f_unaccent(q),
  f_unaccent(col)) >= 0.3` over `name` + `host_name`. The explicit `0.3`
  threshold is inlined (NOT the `%>` operator, which reads a pooled-connection-
  leaking session GUC); 0.3 was tuned on the prod dump (real typos score
  0.54–0.67, the stock 0.6 missed them, no false positives at 0.3). ⚠️ ACCEPTED
  DIVERGENCE from the client's OSA matcher (`apps/mobile/src/lib/search.ts`):
  pg_trgm forgives differently — documented, NOT replicated. No functional GIN
  index (the query is always scoped to one caller's ≤N sessions — a trivial
  seq scan; the index is the documented scale lever in the migration if per-user
  counts ever explode). Extension availability verified on PG17 before shipping;
  `f_unaccent` is IMMUTABLE (pinned dict) so the future index stays legal. The
  substring branch ESCAPES the LIKE metacharacters (`\ % _`) in `q` with
  `ESCAPE '\'` so a `%`/`_` is matched literally (a review catch — verified on
  the dump: unescaped `_` matched all 37 rows, escaped matched only the 7 with a
  literal `_`); the trigram branch is unaffected.
- **Q2 (wine-name search): v1 = name + host_name only** (the decided scope). No
  `EXISTS (wines …)` — that lives in the profile later.
- **Q3 (friend picker counts): DROPPED** (Simon's call). The picker shows all
  friends, no `?facets` endpoint, no per-friend counts — the server decides
  matches. Host picker offers "You" + friends; a non-friend host you shared a
  moment with is the deferred host-facet (the picker only supplies candidate
  ids; the option lists derive from the friend list, not the paginated page).
- **Security:** the `people`/`hosts` facets can't become an attendance oracle —
  requested `people` ids are intersected with the caller's actual mutual-follow
  set AND block-scrubbed before any `EXISTS`; every row stays scoped to `WHERE
  sm.user_id = me` (the caller's own memberships), no facet can drop that guard.
  Block-pair scrub on the returned `people` list stays. `Cache-Control: private,
  no-store` on every path. The FILTERED path is rate-limited (30/min/user,
  `rl:moments-search`, mirrors `/api/users/search`) — the unfiltered carousel
  hot path is uncapped so it isn't starved. `q` is `scrub()`'d + 128-char capped
  (a NUL byte would 500 the `$queryRaw` on reads too), `people` + `hosts` capped
  at 20, anon-host names at 64 chars.
- **Review round 2 (2026-07-05) folded in** — a second 10-finding review:
  - **Rate limit narrowed to `q`/`people` only** (not "any filter param"). The
    client always sends `tense`, so charging on `filtered` throttled ordinary
    Recent/Upcoming browsing; only the trigram search + per-friend EXISTS are the
    expensive channel worth capping.
  - **True full-history bucket counts** for the home nav rows: the unfiltered
    response returns `X-Upcoming-Total`/`X-Recent-Total` headers from a cheap
    `members⋈sessions` COUNT grouped by tense (no wine/rating joins). The home
    Upcoming/Recent rows gate on these, not the capped 50-row page — else a user
    whose only upcoming moment is older than their recent-50 couldn't reach the
    paginated list. (May over-count by a live-kicked session; harmless — the row
    still opens the correct kicked-dropped list.)
  - **Date filter = device-local day, sent as UTC instants.** `from`/`to` are now
    full ISO instants (the picked local day's start/end), not bare `YYYY-MM-DD`
    re-anchored at UTC midnight — so "July 5" means the user's local July 5, the
    same day the cards render (device-local). No off-by-a-day for non-UTC users.
  - **Under-fill auto-advance** (client): kicked-drop can thin a page below the
    requested size; a too-short list can't scroll, so `onEndReached` never fires.
    A `useEffect` pulls the next page until the list is scrollable or history is
    exhausted — closes the "empty page + valid cursor strands pagination" gap.
  - **LIKE-escape** (`\ % _`), **µs-precision cursor**, **kicked-drop**,
    **focus-refetch by prefix invalidation** (not a stale observer),
    **keepPreviousData not shown under new chips on error** — all from the review.
  - Deferred with rationale: per-page aggregate-before-limit (caller-scoped tiny
    set — scale-note comment, same posture as the trigram index); integration
    tests (repo has no test framework — `.local/test-env/` bash+curl harnesses).
- **Review round 3 (2026-07-05) folded in** — a 4-finding pass:
  - **Kicked-count correction**: the `X-Upcoming/Recent-Total` headers now
    subtract kicked sessions found in the enriched page (bucketed by the same
    date tense the count query uses), so the counts obey "kicked drops from
    counts" like the lists — not just the SQL membership total. (Round 2 left
    this as an accepted over-count; the reviewer was right it violated the rule.)
    Verified against real Redis+PG: SQL says upcoming=2, a kicked upcoming
    session drops it to 1.
  - **Under-fill auto-advance now guards `!isError` + `!isFetching`** (not just
    `!isFetchingNextPage`) with primitive deps — a FAILED next-page left
    `hasNextPage` true + the list short, so the effect re-fired in a tight retry
    loop against a failing endpoint. Closed.
  - **429 renders the wait message**: a rate-limit error (only `q`/`people` can
    trigger it) shows the server's human wait copy via `ErrorState`, not the
    generic "can't reach server".
- **Review round 4 (2026-07-05) — durable kick-state, exact counts.** The
  round-3 kicked-count correction was BEST-EFFORT (page-scoped, could over-count
  the home badge by one on a kicked session older than the 50-row page). Simon's
  call: fix it EXACTLY by persisting kick-state in Postgres rather than a
  hot-path Redis fan-out or a documented residual. New nullable column
  `session_members.removed_state` (migration `20260705130000`; a slice of the
  durable-sessions workstream — Postgres-authoritative moderation state):
  kick-keep (`lib/sessionWipe.ts`) writes `'kicked'` beside the role reset,
  rejoin (`join` route) clears it (NOT `/visit` — its upsert is create-only), and
  kick-delete/ban delete the row. `/api/me/sessions` excludes
  `sm.removed_state = 'kicked'` in ALL its SQL (count + both row queries), so
  counts + lists are exact AND durable past Redis expiry. The per-row Redis
  `SISMEMBER` stays as a live belt for the partial-failure window (the kicked
  SADD precedes the PG txn in `sessionWipe`). Verified end-to-end on the dev
  stack driving the real `sessionWipe`: kick-keep → excluded from count+list;
  rejoin → restored. Full contract in `docs/dev/kick-ban.md`.

## Sequencing & size

A before B (B's role facet needs A). A is small: enum value + write-path
audit + backfill + one read-side fallback — a normal feature branch. B is
medium: route params + pagination + client rework + extension check. With
the cap back at 50, B is what makes old moments findable AT ALL — the
revisit trigger is now simply "someone needs to find a moment older than
their last 50" (Simon hit it 2026-07-04), or the durable-sessions work
(future-ideas) — B should ride with that if it lands first.

## PR #65 review findings folded in (2026-07-04)

The review independently hit three of this proposal's motivations: expired
cohost/provider misclassification (Part A #3 — Simon's call: fix here, not
piecemeal), the Redis enrichment fan-out (which led to reverting the 500
valve back to LIMIT 50 — Part B's per-page enrichment is the real answer),
and the beyond-cap clip (now back at 50, making Part B's pagination the only
path to finding old moments).

## Open questions (decide at build time)

1. pg_trgm similarity threshold vs plain unaccented ILIKE — start with ILIKE
   (substring, accent-insensitive), add trigram fuzziness only if misses
   annoy in practice?
2. Does `q` reach wine names in v1 or v2?
3. Keep per-friend match counts in the picker (needs the facets aggregate)
   or drop counts once matching is server-truth?
