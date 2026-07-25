# lib/ — Server primitives and helpers

Local rules for `lib/*`. Root CLAUDE.md still applies; this is overlay context for shared server-side helpers.

## Redis key namespace

- `s:{CODE}:meta` — JSON session metadata (host, name, blind, blindForEveryone, lifespan, hostIdentityId, hostUserId, coHostIds, providerIds, …). `blindForEveryone` stacks on `blind`: when true, the host/cohost/provider/wine-adder bypasses in `redactWine` (`lib/wineRedaction.ts`) are disabled and only `revealed` un-redacts. Mirrored to Postgres `sessions.blindForEveryone` so the feed/profile read paths (`lib/sessionFeedWines.ts`) apply the same gate without Redis. Disabling `blind` in the settings PATCH cascades to clear `blindForEveryone`.
- `s:{CODE}:wines` — JSON array of wines for this session
- `s:{CODE}:r:{IDENTITYID}:{WINEID}` — per-rating JSON (score, flavors, notes). Identity-id keyed (`u:<userId>` or `a:<uuid>`), never display name
- `s:{CODE}:identities` — hash of identity-id → display name (the participant list)
- `s:{CODE}:tokens` — hash of anon-token → identity-id (used by the resolver)
- `s:{CODE}:lastseen` — hash of userId → ms timestamp of that user's last activity (visit + rate). Read by `/api/me/sessions` to pin a date-less session as "Just visited" for 1h since the user's last touch. Bumped via `bumpLastSeen` (`lib/redis.ts`), inherits the session TTL (dies with it; `touchWithMeta` re-stamps it). Ephemeral by design — never archived to Postgres.
- `u:{userId}:carouselhidden` — **USER-scoped, NOT `s:{CODE}:`** (the one session-related key that isn't session-prefixed): a Set of session codes the user dismissed from the Moments-home highlight carousel (they stay in "All moments"). Must outlive any single session, so it carries its OWN rolling 60-day TTL (refreshed on each `hideCarousel`) instead of riding a session TTL — `touchWithMeta`'s `s:{CODE}:*` SCAN does NOT cover it. `getHiddenCarousel`/`hideCarousel`/`unhideCarousel` in `lib/redis.ts`; auto-cleared on re-engagement (`/visit` + rate call `unhideCarousel`). The "never SCAN-delete outside `s:`/`rl:`" rule: this `u:`-prefixed key is self-TTL'd, never SCAN-swept. **Account-delete reclaim**: `lib/accountDelete.ts` `applyRedisCleanup` SCANs `s:{code}:*` only, so any `u:{userId}:*` key needs an EXPLICIT `redis.del` there (carousel-hidden already added) — a new user-scoped key that forgets this leaks past account deletion until its own TTL.
- `s:{CODE}:bans` — Set of banned identity-ids (see `docs/dev/kick-ban.md`)
- `s:{CODE}:kicked` — Set of kicked-but-not-banned identity-ids
- `s:{CODE}:lock:ban` — short-TTL advisory lock during a ban wipe
- **Better Auth keys (native auth, `lib/betterAuth.ts`)** — BA's `secondaryStorage` writes this same Redis DB, UNPREFIXED: `<sessionToken>` (bare opaque token → JSON session; the Redis-first read copy — see root CLAUDE.md "raw row deletes do NOT revoke"), `active-sessions-<userId>` (token list), `verification:<identifier>`, and rate-limit keys `<ip>|<path>`. Don't add new Verre keys shaped like a bare token or containing `|`, and never SCAN-delete outside the `s:`/`rl:` prefixes.

## TTL rule (`KEEPTTL`) — load-bearing

**All writes to `s:{CODE}:meta` and `s:{CODE}:wines` after session-create MUST use `{ KEEPTTL: true }`** so the session's lifespan (default 48h, pro 72h/1w/unlimited) isn't reset by routine edits. Hardcoded `{ EX: 48 * 3600 }` would silently downgrade a pro session on every role-toggle, name change, or wipe.

## Wine-list writes go through `mutateWines`

The whole wine list is one Redis string (`s:{CODE}:wines`, a JSON array), so a raw read→edit→`set` lets two concurrent host/cohost/provider edits clobber each other (lost update). **Never `redis.set(k.wines(...))` directly** — route every wine-list mutation through `mutateWines(code, transform)` in `lib/session.ts`. It wraps the read-modify-write in WATCH/MULTI optimistic concurrency on an isolated connection (`redis.executeIsolated` — WATCH is connection-scoped, so the shared singleton can't be used), retries on conflict, and preserves `KEEPTTL`.

- The `transform` **must be pure** — it re-runs on each retry. Keep side effects (S3 upload, Postgres, response building) in the caller, before/after the call, using the returned array. The `wines` POST and `[wineId]` PATCH do their `addWineToSession` S3 upload outside the transform and splice the result in by id.
- Return a `MutateReject` (`{ reject: string }`) from the transform for current-state validation that depends on the watched value (e.g. the target wine was concurrently deleted → caller maps the reject to 404/400 via `isMutateReject`).
- The ban-wipe wines write-back (`lib/sessionWipe.ts`) uses it too — that's why the `banLock` only serializes ban-vs-ban, not wine writes.

## Catalog writes go through `lib/catalogWrite.ts`; catalog matching goes through `lib/catalogSearch.ts`

Same chokepoint pattern as `mutateWines` above and `lib/identityStore.ts` — the invariants live in root CLAUDE.md § Wine catalog; this is where they're implemented.

- **Never call `prisma.producer.create` / `wineProduct.create` / `wineVintage.create` / `productProducer.*` from a route.** Route them through `createProducer` / `createProduct` / `createVintage`. Phase 4 must append a change-journal event **in the same transaction as every catalog mutation** ("a single mutation path that skips the journal reintroduces the silent-omission class the journal exists to eliminate"), and one helper is what makes that a single edit rather than an audit. Corollary: prefer passing a `tx` — a mint that runs outside a transaction cannot carry a journal append. `product_eans` has no application writer yet (import-owned); when phase 4 adds one, it goes here.
- 🔒 **A `WineProduct` can never be created in one statement.** A deferred trigger rejects a lead-less product at COMMIT, so the product row and its `product_producers` lead row must commit together — `createProduct` does this. A bare `prisma.wineProduct.create()` always raises `has no lead producer`. That's the invariant working, not a bug (`prisma/CLAUDE.md`).
- 🔒 **Nothing in either module may become a find-or-create.** An entry is created DISTINCT; the fuzzy match only ever produces suggestions for a human. Auto-selecting the top hit is the model that got PR #82's schema rejected.
- 🔒 **`resolveCatalogLink` is the only sanctioned way to accept `productId`/`vintageId` from a request body**, and it returns ONE generic message for every denial — distinguishing "unknown id" from "owned" / "rejected" / "wrong product" turns it into a catalog classifier, and these paths are reachable from the ordinary wine + check-in routes, i.e. outside the release fence.
- 🔒 **Merge tombstones RESOLVE to their survivor — they are not hidden.** `linked` rows are matched and then resolved (transitively, visited-set + depth cap) at BOTH grains, and product results report the **effective** producer's id and name. Excluding tombstones instead made a merged alias unfindable, and selecting the stored producer advertised a row already merged away. Note the catalog is empty today, so nothing surfaces this until phase 3 starts merging. ⚠️ Public release no longer waits for that phase — the fence opens with the model-change phase (`docs/dev/proposals/wine-catalog-model-change.md` § 7), so publicly-writable *provisional* entries exist before any curator UI does. Tombstones only appear once phase 3 ships the merge machinery, since nothing writes one before then.
- ⚠️ **Alias resolution must never become a catalog-wide scan.** Expressing it as a recursive CTE over the whole `producers` table — joined into every product search, including the unscoped path that doesn't use it — measured **3,252,182 blocks / 517 ms** at 60k producers × 60k products, versus ~1,600 blocks / 83 ms for the current shape (a selective search went 0.16 ms → 60 ms). Resolve only the chosen producer's alias GROUP (`producerAliasGroup`, index-served off `producers_links_to_idx`) and keep two distinct SQL shapes rather than one query with a nullable parameter — `($n IS NULL OR …)` leaves the join in the plan when unused. 🔒 The suite guards this **structurally** (§ 1b): the cost is superlinear, so a CI-sized fixture cannot catch it by measurement — a mutation reinstating the CTE cost only ~170 blocks at 30k rows and passed a block-ceiling assertion.
- 🔒 **Search orders by a GiST KNN distance** (`trgmOrderSql` — `col <->> lower(f_unaccent($1))`), with ONE definition shared by the runtime queries and the query-plan assertion in `scripts/tests/catalog-addflow-integration.mjs` § 1 — inlining it back into the queries silently disarms that test. ⚠️ **Operator and operand ORDER must match** — `column <->> query` and its commutator `query <<-> column` both plan an Index Scan (~4.9 ms); the mismatched pairings `column <<-> query` / `query <->> column` seq-scan the whole table (~116 ms over 60,001 rows) while returning correct rows. `<<->` is the declared commutator of `<->>` (pg_operator), so it is NOT a forbidden operator — it is usable only with the query on the left. Same operand-order trap as the GIN `<%`/`%>` pair. `<->>` is exactly `1 - word_similarity`, so ranking and typo tolerance are unchanged. **Why the swap:** `<%` at threshold 0.3 is not selective — candidates scale 1:1 with the catalog (a "selective" multi-word name still admitted 8.5% of a 300k catalog), the heap recheck dominated, and latency grew linearly (34 ms at 60k → 352 ms at 300k, with 15/50 concurrent searches failing on pool timeouts). The 0.3 threshold is now a **post-filter** on the ≤20 rows KNN returns, which also removed the `SET LOCAL` GUC and with it the interactive transaction that pinned a pool connection per search. **The GIN indexes are REPLACED by covering B-trees**, not kept: a trigram index is the wrong structure for `=`, and measured on the REAL query the planner chose GiST (0.544 ms / 130 buffers) over a bare B-tree — only `(name_folded, id) INCLUDE (status)` wins on its own, as an Index Only Scan with zero heap fetches (0.125 ms / 4 buffers). Nothing issues a `%`/containment query, so GIN had no live consumer.

## Session read views go through `lib/sessionState.ts`

The per-viewer session read bodies (meta / wines / ratings) are built only by `buildMetaView` / `buildWinesView` / `buildRatingsView` — shared by the three standalone session GETs and the aggregate `GET /api/session/:code/state`. The rule (never re-derive the per-viewer transforms in a route body) lives in `app/api/CLAUDE.md`.

## SCAN helpers

`lib/redis.ts` provides `scanKeys(pattern)` and `hasKey(key)` SCAN-based helpers — prefer these for new code instead of `redis.keys`, which blocks the Redis event loop.

## Identity resolver (`lib/identity.ts`)

`resolveIdentity(code, req, session)` returns `{id, displayName, kind}` from one of three sources, or `null` for unauthenticated callers:

- NextAuth session cookie (`__Secure-authjs.session-token`) → `kind: 'user'`, `id: 'u:<userId>'`
- `x-vr-anon-token` header against `s:{CODE}:tokens` hash → `kind: 'anon'`, `id: 'a:<uuid>'`
- Otherwise → `null`

**Identity is never read from the request body.** All authorization checks compare on `id`, never on display name.

`participantOrBanned(code, identity)` returns `'ok' | 'banned' | 'kicked' | 'invalid'` — used by removed-bounce-aware endpoints. `authRemoved()` builds the `X-Vr-Auth: removed` response.

## Per-device sessions (logged-in revocation gate)

Logged-in sessions are gated per-device via the `user_sessions` table (one row per credential login). The signed JWT carries an opaque `userSessionId`; the `auth.ts` `jwt()` callback looks up `user_sessions.revokedAt` on **every authenticated request** and strips identity on a revoked/missing row. This replaced the never-written `users.tokenVersion`. Full design + as-built deviations: `docs/dev/proposals/auth-sessions.md`.

- 🔒 **SECURITY — never cache `auth()`.** The revocation gate is only as fast as the next request that hits Postgres. **Never wrap `auth()` in `unstable_cache`, React `cache`, or a `revalidate`-tagged fetch** — any cache TTL becomes a window where a revoked cookie still resolves, which IS the security hole. The DB lookup must run every authenticated request, same cost as the old `tokenVersion` read. (The Edge `middleware.ts` deliberately only checks JWT signature/presence, not revocation — the real gate is the Node-runtime `auth()` in the `/me` layout and every `/api/me/*` handler. Don't move a Prisma call into the Edge config.)
- **`lastSeenAt` is self-only.** Queryable only via `WHERE userId = $self` (the `GET /api/me/devices` path). No analytics / other-user / aggregate surface. Stored bucketed to 5-min wall-clock edges (the value at rest is the bucket *start*, not the request time) so an exfiltrated DB can't reconstruct precise activity timelines. `createdAt` stays precise (one-shot, useful for disambiguating same-label devices).
- **`userSessionId` is JWT-only**, like all identity — never read it from a request body/header. The password re-auth on cross-device/revoke-all DELETEs goes through `lib/verifyPassword.ts`, which charges the shared `rl:account` counter (see `app/api/CLAUDE.md` shared-counter pattern).
- **Geo labels (`lib/geo.ts` `resolveGeoLabel`)** turn a login IP into a country name for the device row. **Fully in-process, best-effort, never throws**: the IP is resolved against binary lookup tables on local disk and is NEVER sent off-server (no API/WHOIS) and never persisted (only the country label is stored). The tables are delivered at boot (`instrumentation.ts` → `lib/geoData.ts` `ensureGeoData` downloads them from S3; on a cold start it background-seeds S3 then polls to self-heal this instance without a restart; a weekly `refresh-geo-data` scheduledJob in `.deploio.yaml` regenerates + uploads them). If the files are absent (cold start / download not finished) every lookup returns null → "Unknown location" — so a lookup before boot-download completes is harmless. Don't add a network call to this path. Full delivery story: `docs/dev/deployment.md` + `docs/dev/proposals/auth-sessions.md`.

## Defensive helpers (apply on every state-changing API route)

- **`lib/csrf.ts` `isSameOrigin(req)`** — origin/referer check. **First guard on every POST/PATCH/DELETE/PUT.** Allows same-origin + origins in `SERVER_ACTIONS_ALLOWED_ORIGINS` env. See `app/api/CLAUDE.md` "Origin guard" for the rule.
- **`lib/parsePathId.ts`** — strict path-segment-to-positive-int parser. **Use this, not `Number(params.id)`.** Rejects leading zeros, scientific notation, percent-encoded whitespace (`1%0a`, `1%20`), and other URL-canonicalisation tricks that could route to the wrong user or skew rate-limit keys.
- **`lib/textSafe.ts` `scrub(s)`** — strips C0 control chars + bidi overrides + zero-width chars. **Apply to every free-text field from a request body before DB write.** NULL bytes 500 with P22021; RTL overrides spoof display names in feeds; zero-width chars enable lookalike attacks.

## Rate-limit helpers (`lib/rateLimit.ts`)

- `peekRate(key, limit, window)` — check without incrementing. For paths that must not pollute the counter on success (login-precheck, no-op visibility PATCH).
- `checkRate(key, limit, window)` — atomic check + increment. The default for any limited endpoint.
- `peekRates([...])` / `checkRates([...])` — multi-window batch (e.g. login: 10/min + 20/h + 100/10min/IP all checked together).
- `formatWait(seconds)` — humanizes "in 3 minutes" / "in 45 seconds" for 429 response bodies.

Per-endpoint usage patterns (which helper for which route, shared-counter pairs): see `app/api/CLAUDE.md`.

## Display name disambiguation

- `disambiguateDisplayName(name, identities)` (in `lib/displayName.server.ts`) — appends a random food emoji on collision. Server-side only (imports `lib/redis`).
- `stripDisambiguationEmoji(name)` + `validateDisplayName(raw)` (in `@verre/core`) — client-safe, framework-neutral display-name rules (the rename-input strip + the register/rename validator). Shared with the native app.

The split prevents `lib/redis` from being bundled into client code; the pure half lives in `@verre/core` so it can also be shared with non-web clients.
