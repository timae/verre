# app/api/ — API routes

Local rules for `app/api/*` Route Handlers. Root CLAUDE.md still applies; this is overlay context for backend endpoints.

## Origin guard (first thing on every state-changing route)

**`isSameOrigin(req)` MUST be the first guard on every POST/PATCH/DELETE/PUT route.** Reject 403 before `auth()`, `requireParticipant()`, or any other check. Helper in `lib/csrf.ts` — allows same-origin requests + origins in `SERVER_ACTIONS_ALLOWED_ORIGINS`. Defense-in-depth against SameSite=None / WebView quirks; missing it on a new write endpoint is the most common foot-gun. Documented separately from "Authorization patterns" because it runs before identity even resolves.

```ts
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return new Response('Forbidden', { status: 403 });
  // ... auth, rate limit, handler
}
```

## Authorization patterns

- 🔒 **Session routes open the moment through the entrance gate, FIRST**: `openSessionFor(code, req, session)` (or `openAsParticipant`, both `lib/sessionRoute.ts`; the join page `openSessionCharged`) right after `isSameOrigin`, `normalizeCode` and `resolveUser`, before any body parsing, route limiter, promotion or contract (leak-fixes F2). A wrong code is charged the never-reset wrong-code budget (`rate-limits.md`); once it is spent only the moment's members get past, everyone else the same 429 for every code. A check placed after a route's own decision re-creates the code oracle through that decision. A cold Postgres-backed moment is rebuilt; `'absent'` → 404 (the route's own body: `notFound` / `absent()`), `'restoring'` → **503 + `Retry-After: 1`, never 404** for a live row. ESLint refuses `openSession` / `ensureSessionLive` / `loadLiveWines` / `rehydrateSession` from `lib/sessionRehydrate` anywhere in `app/**` (pinned in `scripts/tests/lint-boundary-units.mjs`); the route sweep in `scripts/tests/leak-fixes-section.mts` (§ 20 b) holds every route under `[code]/**` to identical answers on a spent budget, so a new route is covered automatically. Only answers that are the same for every code may come before the gate (a signed-out `/visit` no-op, a sign-in 401, the preview's own every-lookup budget, the join POST's failed-attempts peek and body checks). The gate RESERVES a miss atomically before it opens the moment and refunds it for a right code (`reserveMiss` / `settleMiss`): a read-then-charge let a parallel burst read "not spent" on every request. Lineup reads after the gate go through `loadLiveWines` (absent-aware, inside `lib/`), never a `[]` stand-in. Exceptions (they never open a moment): `carousel-hidden`, bookmark DELETE (user-scoped), `/api/me/sessions` + feed enrichment (lists never rebuild).
- **Session reads** (`GET /api/session/:code`, `/wines`, `/ratings`, `/state`) require participant: `participantOrBanned()` — for a `u:` caller of a Postgres-backed session the RECORD admits (member, rating author, strict host; minus kicked/banned; a Redis ban denies first), a missing roster entry is healed; 401 + `X-Vr-Auth: invalid` when not admitted, `removed` when banned/kicked, 503 on `'unavailable'`.
- **Session read bodies are built ONLY by the `lib/sessionState.ts` builders** (`buildMetaView` / `buildWinesView` / `buildRatingsView`), shared by the three standalone GETs and the aggregate `GET /:code/state`. 🔒 A line-up WRITE's reply (reorder, reveal / hide, the wine PATCH, the brought-by reassign) goes through the same view (`buildWinesEcho` / `buildWineEcho`), so Blind for All masks the host's own echo too: a no-op edit must not unmask a bottle on demand (leak-fixes F6). The wine POST's echo stays a plain `wineToWire` (the adder just typed the bottle). Never re-derive the per-viewer transforms (block-pair arrays, avatar tier gate, blind/hideLineup redaction) in a route body — a drifted copy silently leaks (a blind wine identity, a block pair). `/state` degrades per-section: a failed builder returns `null` for that section, all-three-failed → 500.
- **Session existence is checked first** (by the entrance gate); nonexistent/deleted sessions return 404 (no auth header) so the client can distinguish "session is gone, go home" from "your token is bad, retry join." A NON-member on a spent wrong-code budget gets 429 "Too many codes tried" instead, for every code (no `X-Vr-Auth`: the web keeps local state, the app shows its rate-limited state).
- **Host actions** (wine CRUD, settings, reveal/hide, name) check `isHostByIdentity(meta, identity)` with an **`AuthorizedIdentity`** (`lib/sessionGrant.ts` — the helpers refuse a raw `resolveIdentity` result at compile time): from `identity.grant` (strict host or `co_host` in the RECORD) when present, else from meta (`hostIdentityId` / `hostUserId` / `coHostIds` — anonymous callers, Redis-only sessions). Pure id-based; no display-name fallback. Routes that a removed caller may reach (bans list/preview, removed-state, leave) use `resolveAuthorized` (same grant, no participant gate).
- **Strict-host actions** (cohost role assignment, session delete, removing a cohost) use `isStrictHost`. Session delete additionally lets a cohost delete a moment with no host identity at all (`isHostless`, § 4.5).
- 🔒 **Every write runs inside the session mutation contract** (`lib/CLAUDE.md`): the pre-lock checks above are only early rejects; the real decision is re-made under the locks from `ctx.caller` (fresh grant) and the target's fresh record state. Map failures with `contractFailure()`: busy → 503 + Retry-After (set-role, reassign, wine DELETE keep their 429; bans, unban, leave their 409).

## Header conventions

**Permission-denied vs auth-invalid**: the server returns 401 + `X-Vr-Auth: invalid` only when identity itself failed to resolve. Permission-denied 403s ("only the host can…", "pro required") return bare 403 without the header. The `lib/sessionFetch.ts` client-side wrapper only clears local state and bounces to `/join/<code>` on the auth-invalid header — permission denials are surfaced inline.

**`X-Vr-Auth: removed`** is the separate header for kicked/banned users — preserves local state, bounces to `/join/<C>?removed=1`. See `docs/dev/kick-ban.md` for the full bounce protocol.

## Public user ids (every route that takes or returns a user id)

🔒 The integer user id never leaves the server (root CLAUDE.md § Trust model; `docs/dev/proposals/public-user-ids.md`). Inbound: parse the public id FORMAT only (`lib/publicIds.ts`; an integer is malformed → 400), and resolve it where today's code meets a nonexistent target, after the limiter and the role gates, so an unknown id takes exactly that path (profile / people / badges / `feed?user=` → 404; follow / block / mute → the limiter charged and the same 200; set-role → 400 `targetId required`; bans POST / unban → 200, nothing written; ban preview → 404; brought-by → "not in this moment"; `hosts=` → a FALSE clause, never a dropped filter). Outbound: every user id through `publicIdsFor` / `wireIdentityMap` / `metaToWire` / the adder lookup (`buildAdderLookup`), a miss DROPPED. Session meta is echoed only through `metaToWire` (an allow-list), never `...meta`. **A new user-facing route joins § 18 of `scripts/tests/you-profile-integration.mts`**: its canary scans every response the suite sees, so a route outside it is the residual (there is no static gate).

## Usernames (every route that returns a person, or looks one up)

`docs/dev/proposals/usernames.md`; the trust rule is in root CLAUDE.md § Trust model.

- **Emission rule:** a person object OUTSIDE a moment carries `username: string | null` wherever it carries `name` (profile incl. the shell and blocked views, people rows, in-common faces, search rows and gated stubs, `/api/me/friends`, tasted-with, the Blocked / Muted lists, feed `author` and `checkin.tags[]`, `/api/me/account`, your own session). `null` = not chosen yet: never omit the key. 🔒 **Inside a moment, never**: nothing built by `lib/sessionState.ts`, `metaToWire`, the join / visit / bans routes, the Redis cache, or `/api/me/sessions` (its `people[]` are moment rosters). The suite's reverse canary (§ 21 h) scans moment responses and `s:<code>:*` for fixture usernames. **One exception, ruled 2026-11-14: the pre-join preview's `hostUsername`** (`app/api/session/[code]/preview/route.ts`): the host's name from the USERS row (never the cache), sent only beside `hostUserId` (a registered host, no block pair). It tells its reader nothing new: with that public id the profile shows the username to anyone. Pinned beside the canary (the host's and nobody else's; none across a block pair). Don't take it as a precedent for a route that answers from inside the moment.
- 🔒 **No parameter ever accepts "public id or username".** The formats overlap (`abcdefgh1234` is a valid username and a lowercase public id), so they live in separate routes: `GET /api/users/[id]` and `GET /api/users/by-username/[username]`, both thin wrappers over ONE handler (`serveProfile`, `lib/profileRoute.ts`: the same gate, shell, blocked view, 404 and `private, no-store`, the same `rl:profile` budget). A new by-username read does the same: parse its own format, hand a resolver to the shared code, never widen an id parameter.
- 🔒 **Order: parse → limiter → resolve → gate.** The route parses the FORMAT only (`usernameFromPath`, `@verre/core`; malformed → 400) and the shared handler resolves AFTER charging the limiter, so a spent budget runs no lookup. Unknown, held and renamed-away names all take the `'gone'` 404; there is no redirect from an old name (after the hold someone else may own it).
- 🔒 **Reads check the format, never the reserved list.** The reserved list is a rule for WRITES (`validateUsername` / `checkUsername`): an account the operator gave a reserved name (`@verre`) must open and share like any other. Lookups, the scanner and the share link use `usernameFromPath` / `normalizeUsername`.
- **Writes** go through `lib/username.ts` only (`changeUsername`; CI census `scripts/check-username-writes.mjs`): `PUT /api/me/username` (409 `{ code: 'taken' }` for a taken AND a held name, 409 `{ code: 'quota', nextChangeAt }`), never the profile PATCH.
- **Search** (`/api/users/search`, the People lists' `q`): one clause, `personSearch` (`lib/peopleSql.ts`): the name or the username; `@…` = the username only, and an `@` query no username could contain answers `[]`, never a fallback to names. `_` is escaped (a legal username character and a LIKE wildcard).

## Status code rules (leak prevention)

- **`{status: 'gone'}` from `resolveProfileViewer` → 404**, never 403 or 401. The caller can't distinguish "no such user" from "exists but tier denies you."
- **Negative result from the post gate (`viewerCanSeePosts`, `gate.sees.posts`) → 404**, never 403. Same leak prevention for per-resource visibility checks (e.g. liking a post whose author's Check-Ins Visible To excludes you). See `app/api/feed-items/[id]/like/route.ts` for the canonical pattern; its DELETE is the one open exception (your own like comes off a post now hidden from you; only when the author blocks you, `'gone'`, is it a 404: `docs/dev/profile-visibility.md`). One-author LIST reads answer an empty 200 instead (`/api/feed?user=`: 404 means gone to the app).
- **Owner-scoped id resources → 404 on wrong-owner/missing.** `DELETE /api/me/devices/[id]` scopes the revoke with `WHERE id = $id AND user_id = $me`; an id belonging to another user matches zero rows → 404, indistinguishable from "no such id". 403 is reserved for the wrong-password case. The owner-scope carries the security, NOT id unguessability: web rows are uuids (enumeration infeasible) but native rows are `ba:<int>` (trivially enumerable) — both are safe only because a wrong-owner probe and a missing id are the same 404. (Per-device session revocation lives under `/api/me/devices` — web gate is `user_sessions.revokedAt`, native rows revoke through `lib/identityStore.ts`; see `app/api/auth/CLAUDE.md` + `lib/CLAUDE.md`.)
- **403 reserved for permission-denied with identity AND visibility both resolved** ("only host can…", "pro required"). Never use 403 to indicate "you can't see this resource exists."
- **Unreleased surfaces → 404, never 403.** `/api/catalog/*` returns 404 whenever `canUseCatalog` (`lib/catalogGate.ts`) is false — while the release fence is closed the endpoints must be indistinguishable from ones that don't exist. A 403 would both advertise the unreleased feature and distinguish staff from everyone else. Same rule applies to any future gated-by-release endpoint.

## Cache-Control on viewer-dependent responses

Any response whose body varies by viewer — block-pair-scrubbed counts, gate status (`'shell' | 'blocked-by-me' | 'gone'`), `viewerMutes`, `isFollowing`, `viewerBlocksOut/In` — MUST set `Cache-Control: private, no-store` on every return path. Without it, a CDN cache or shared proxy could serve one viewer's tier-gated payload to another. Canonical example: `app/api/session/[code]/route.ts` GET response.

## Authorization tier resolution

The vocabulary glossary lives in root CLAUDE.md. Implementation:

- **strict host** — `isStrictHost(meta, identity)`: the grant's `strictHost` (`sessions.host_user_id`), else `meta.hostIdentityId`/`hostUserId`. Reserved for cohost role assignment (any transition touching `co_host`), session deletion, and banning a cohost.
- **host** — `isHostByIdentity(meta, identity)`: strict host OR cohost (the grant's role, else `meta.coHostIds`).
- **provider** — `isProvider(meta, identity)`: the grant's role `provider`, else `identity.id ∈ meta.providerIds`; own-wine ownership is read from the record for a `u:` caller.
- **participant** — `requireParticipant` / `participantOrBanned`: admitted by the record for a `u:` caller of a Postgres-backed session, else registered in the identities map. Implementation in `lib/identity.ts`.

For removed-bounce-aware endpoints, use `participantOrBanned(code, req, session)` which returns `'ok' | 'banned' | 'kicked' | 'invalid' | 'unavailable'` (→ `authUnavailable()`, 503) and let `authRemoved()` build the response.

## Anon per-session rename

`PATCH /api/session/:code/me/name` (body `{name}`). Anon-only — logged-in users hit 403 with a "use profile settings" hint, because their per-session name is read live from `users.name` and changing it once in profile settings propagates to every session. The endpoint validates via the same `validateDisplayName` pipeline as join, re-runs `disambiguateDisplayName` against the current participants map (so a collision with a current entry adds an emoji), and writes to `s:{CODE}:identities`. Rate-limited 10/min/identity to bound spam. Pre-rename `ratings.rater_name` snapshots stay frozen per the display-name policy in root — historic ratings keep the old name.

## Rate limits (usage)

Limit policy table lives in root CLAUDE.md. Helper API in `lib/CLAUDE.md`. Per-endpoint guidance:

- **Successful operations should not pollute the failure counter.** For login, use `peekRate` in the precheck and `checkRate` only on bcrypt failure. For visibility PATCH, use `peekRate` to detect no-op submits and only `checkRate` when the value actually changes.
- **Shared-counter pairs**: account PATCH+DELETE, mutes POST+DELETE, bans POST+DELETE — both endpoints call `checkRate` with the **same Redis key string** (e.g. `rl:account:user:${userId}:1h` shared by PATCH + DELETE in `app/api/me/account/route.ts`) so an attacker can't get `N+N` budget. No special parameter; just literally the same key. **The device sign-out endpoints' password re-auth extends this**: `lib/verifyPassword.ts` (used by `DELETE /api/me/devices/[id]` cross-device + `DELETE /api/me/devices` revoke-all) charges the *same* `rl:account` key, so a stolen cookie can't stack brute-force budget across account + device endpoints. Those endpoints ALSO keep a separate per-endpoint counter (`rl:devices`/`rl:devices-all`) bounding revoke-thrashing — distinct concern from the password-guess budget.
- **Recovery paths** (block DELETE): intentionally uncapped. A burst-block attack must always leave the unblock path open.
- **Multi-window batches** (login: 10/min/email + 20/h/email + 100/10min/IP): use `peekRates([...])` / `checkRates([...])` so all windows check together and 429 surfaces the longest wait.

## `/api/auth/login-precheck`

Exists because NextAuth v5 strips error messages from the client-side `signIn()` response. The login form calls precheck first and surfaces the "Try again in N seconds" message itself; on success it then hits the real `signIn()`. Precheck uses `peekRate` so it doesn't pollute the counter.

## Engagement trigger (rate POST + checkins POST → feed_items)

Both `POST /api/session/[code]/rate` and `POST /api/checkins` create `feed_items` rows alongside the underlying ratings. Two contracts shape this:

- **Session rate**: a feed_item materialises on first engagement (score > 0, OR chips, OR notes). Idempotent via the partial unique `(user_id, session_id)` + `ON CONFLICT DO NOTHING` — subsequent rates in the same session no-op, so `created_at` stays anchored on first engagement. Anon ratings skip entirely (schema-enforced via `feed_items.user_id NOT NULL`).
- **Standalone POST**: the act of POSTing IS the engagement signal; the feed_item is always created (the user explicitly chose to post). One feed_item per check-in (1:1 with the rating via `feed_items.ratingId`).

Full mechanics: see `docs/dev/social-feed.md` §Engagement trigger.

## Wine catalog (`/api/catalog/*`)

- **`GET /api/catalog/search`** — fuzzy producer/product suggestions. **`POST /api/catalog/entries`** — mints catalog rows for the five add branches (RFC § Add-a-wine flow). Both gate on `canUseCatalog` and 404 when it's false (above).
- **The link is separate from the catalog endpoints.** `productId`/`vintageId` are accepted by the session wine POST/PATCH and the check-in POST/PATCH, and every one of those routes must validate through `resolveCatalogLink` (`lib/CLAUDE.md`) — never store a raw body value. Those four paths are reachable *outside* the release fence by any wine-adder, including an anonymous host of their own session, which is why every catalog denial is generic (`denyCatalogRef`).
- **Rate limiting on the link paths.** The two **session-wine** routes share `rl:catalog-link` (120/h), charged only when a link is present; they had no limiter at all before. The two **check-in** routes are already bounded by the shared `rl:checkin` 100/h and carry no separate catalog charge. 🔒 Anonymous callers on the session routes are keyed by **IP, not identity** (`catalogLinkRateKey`): an `a:<uuid>` is re-minted on every join and a successful join charges nothing (only the per-address guest cap), so a per-identity key was rotatable by exactly the caller class it was meant to bound.
- **An identity-changing wine edit clears the link.** Changing a wine instance's name, producer, or vintage must not silently keep a now-incompatible catalog link; `applyIdentityEditRule` decides this, and it runs *before* the write so the wholesale Redis replacement carries the right value. Cosmetic edits keep the link.
- 🔒 **Catalog IDs are label identity** — `redactWine` nulls both on blind payloads. It spreads `...rest` from `WineMeta`, so a new identifying field leaks by default unless explicitly nulled there.

## API surface

The full endpoint list lives in README.md. When adding a new endpoint, also update the README API table if it's user-visible. Feature deep-dive docs live in `docs/dev/`.
