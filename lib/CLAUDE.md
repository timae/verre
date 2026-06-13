# lib/ — Server primitives and helpers

Local rules for `lib/*`. Root CLAUDE.md still applies; this is overlay context for shared server-side helpers.

## Redis key namespace

- `s:{CODE}:meta` — JSON session metadata (host, name, blind, blindForEveryone, lifespan, hostIdentityId, hostUserId, coHostIds, providerIds, …). `blindForEveryone` stacks on `blind`: when true, the host/cohost/provider/wine-adder bypasses in `redactWine` (`lib/wineRedaction.ts`) are disabled and only `revealed` un-redacts. Mirrored to Postgres `sessions.blindForEveryone` so the feed/profile read paths (`lib/sessionFeedWines.ts`) apply the same gate without Redis. Disabling `blind` in the settings PATCH cascades to clear `blindForEveryone`.
- `s:{CODE}:wines` — JSON array of wines for this session
- `s:{CODE}:r:{IDENTITYID}:{WINEID}` — per-rating JSON (score, flavors, notes). Identity-id keyed (`u:<userId>` or `a:<uuid>`), never display name
- `s:{CODE}:identities` — hash of identity-id → display name (the participant list)
- `s:{CODE}:tokens` — hash of anon-token → identity-id (used by the resolver)
- `s:{CODE}:lastseen` — hash of userId → ms timestamp of that user's last activity (visit + rate). Read by `/api/me/sessions` to pin a date-less session as "Just visited" for 1h since the user's last touch. Bumped via `bumpLastSeen` (`lib/redis.ts`), inherits the session TTL (dies with it; `touchWithMeta` re-stamps it). Ephemeral by design — never archived to Postgres.
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
