# lib/ — Server primitives and helpers

Local rules for `lib/*`. Root CLAUDE.md still applies; this is overlay context for shared server-side helpers.

## Redis key namespace

- `s:{CODE}:meta` — JSON session metadata (host, name, blind, lifespan, hostIdentityId, hostUserId, coHostIds, providerIds, …)
- `s:{CODE}:wines` — JSON array of wines for this session
- `s:{CODE}:r:{IDENTITYID}:{WINEID}` — per-rating JSON (score, flavors, notes). Identity-id keyed (`u:<userId>` or `a:<uuid>`), never display name
- `s:{CODE}:identities` — hash of identity-id → display name (the participant list)
- `s:{CODE}:tokens` — hash of anon-token → identity-id (used by the resolver)
- `s:{CODE}:bans` — Set of banned identity-ids (see `docs/dev/kick-ban.md`)
- `s:{CODE}:kicked` — Set of kicked-but-not-banned identity-ids
- `s:{CODE}:lock:ban` — short-TTL advisory lock during a ban wipe

## TTL rule (`KEEPTTL`) — load-bearing

**All writes to `s:{CODE}:meta` and `s:{CODE}:wines` after session-create MUST use `{ KEEPTTL: true }`** so the session's lifespan (default 48h, pro 72h/1w/unlimited) isn't reset by routine edits. Hardcoded `{ EX: 48 * 3600 }` would silently downgrade a pro session on every role-toggle, name change, or wipe.

## SCAN helpers

`lib/redis.ts` provides `scanKeys(pattern)` and `hasKey(key)` SCAN-based helpers — prefer these for new code instead of `redis.keys`, which blocks the Redis event loop.

## Identity resolver (`lib/identity.ts`)

`resolveIdentity(code, req, session)` returns `{id, displayName, kind}` from one of three sources, or `null` for unauthenticated callers:

- NextAuth session cookie (`__Secure-authjs.session-token`) → `kind: 'user'`, `id: 'u:<userId>'`
- `x-vr-anon-token` header against `s:{CODE}:tokens` hash → `kind: 'anon'`, `id: 'a:<uuid>'`
- Otherwise → `null`

**Identity is never read from the request body.** All authorization checks compare on `id`, never on display name.

`participantOrBanned(code, identity)` returns `'ok' | 'banned' | 'kicked' | 'invalid'` — used by removed-bounce-aware endpoints. `authRemoved()` builds the `X-Vr-Auth: removed` response.

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
- `stripDisambiguationEmoji(name)` (in `lib/displayName.ts`) — client-safe helper to strip a trailing emoji from a displayed name (used to populate the rename input).

The split prevents `lib/redis` from being bundled into client code.
