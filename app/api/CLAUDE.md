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

- **Session reads** (`GET /api/session/:code`, `/wines`, `/ratings`) require participant: `requireParticipant()` rejects with 401 + `X-Vr-Auth: invalid` if the caller isn't a registered participant in this session's identities map.
- **Session existence is checked first**; nonexistent/deleted sessions return 404 (no auth header) so the client can distinguish "session is gone, go home" from "your token is bad, retry join."
- **Host actions** (wine CRUD, settings, reveal/hide, name) check `isHostByIdentity(meta, identity)`, which matches `meta.hostIdentityId` first, then `meta.hostUserId` (logged-in fallback), then any entry in `meta.coHostIds`. Pure id-based; no display-name fallback.
- **Strict-host actions** (cohost role assignment, session delete) bypass the cohost check — only the actual session host can perform them.

## Header conventions

**Permission-denied vs auth-invalid**: the server returns 401 + `X-Vr-Auth: invalid` only when identity itself failed to resolve. Permission-denied 403s ("only the host can…", "pro required") return bare 403 without the header. The `lib/sessionFetch.ts` client-side wrapper only clears local state and bounces to `/join/<code>` on the auth-invalid header — permission denials are surfaced inline.

**`X-Vr-Auth: removed`** is the separate header for kicked/banned users — preserves local state, bounces to `/join/<C>?removed=1`. See `docs/dev/kick-ban.md` for the full bounce protocol.

## Status code rules (leak prevention)

- **`{status: 'gone'}` from `resolveProfileViewer` → 404**, never 403 or 401. The caller can't distinguish "no such user" from "exists but tier denies you."
- **Negative result from `viewerCanSeeAuthor` → 404**, never 403. Same leak prevention for per-resource visibility checks (e.g. liking a check-in by a `public-mutual` profile that doesn't follow you back). See `app/api/feed-items/[id]/like/route.ts` for the canonical pattern.
- **403 reserved for permission-denied with identity AND visibility both resolved** ("only host can…", "pro required"). Never use 403 to indicate "you can't see this resource exists."

## Cache-Control on viewer-dependent responses

Any response whose body varies by viewer — block-pair-scrubbed counts, gate status (`'shell' | 'blocked-by-me' | 'gone'`), `viewerMutes`, `isFollowing`, `viewerBlocksOut/In` — MUST set `Cache-Control: private, no-store` on every return path. Without it, a CDN cache or shared proxy could serve one viewer's tier-gated payload to another. Canonical example: `app/api/session/[code]/route.ts` GET response.

## Authorization tier resolution

The vocabulary glossary lives in root CLAUDE.md. Implementation:

- **strict host** — match `meta.hostIdentityId === identity.id`. Reserved for cohost role assignment (any transition touching `co_host`), session deletion, and banning a cohost.
- **host** — `isHostByIdentity(meta, identity)`: strict host OR `identity.id ∈ meta.coHostIds`.
- **provider** — `isProviderById(meta, identity)`: `identity.id ∈ meta.providerIds`.
- **participant** — `requireParticipant`: registered in the session's identities map. Implementation in `lib/identity.ts`.

For removed-bounce-aware endpoints, use `participantOrBanned(code, identity)` which returns `'ok' | 'banned' | 'kicked' | 'invalid'` and let `authRemoved()` build the response.

## Anon per-session rename

`PATCH /api/session/:code/me/name` (body `{name}`). Anon-only — logged-in users hit 403 with a "use profile settings" hint, because their per-session name is read live from `users.name` and changing it once in profile settings propagates to every session. The endpoint validates via the same `validateDisplayName` pipeline as join, re-runs `disambiguateDisplayName` against the current participants map (so a collision with a current entry adds an emoji), and writes to `s:{CODE}:identities`. Rate-limited 10/min/identity to bound spam. Pre-rename `ratings.rater_name` snapshots stay frozen per the display-name policy in root — historic ratings keep the old name.

## Rate limits (usage)

Limit policy table lives in root CLAUDE.md. Helper API in `lib/CLAUDE.md`. Per-endpoint guidance:

- **Successful operations should not pollute the failure counter.** For login, use `peekRate` in the precheck and `checkRate` only on bcrypt failure. For visibility PATCH, use `peekRate` to detect no-op submits and only `checkRate` when the value actually changes.
- **Shared-counter pairs**: account PATCH+DELETE, mutes POST+DELETE, bans POST+DELETE — both endpoints call `checkRate` with the **same Redis key string** (e.g. `rl:account:user:${userId}:1h` shared by PATCH + DELETE in `app/api/me/account/route.ts`) so an attacker can't get `N+N` budget. No special parameter; just literally the same key.
- **Recovery paths** (block DELETE): intentionally uncapped. A burst-block attack must always leave the unblock path open.
- **Multi-window batches** (login: 10/min/email + 20/h/email + 100/10min/IP): use `peekRates([...])` / `checkRates([...])` so all windows check together and 429 surfaces the longest wait.

## `/api/auth/login-precheck`

Exists because NextAuth v5 strips error messages from the client-side `signIn()` response. The login form calls precheck first and surfaces the "Try again in N seconds" message itself; on success it then hits the real `signIn()`. Precheck uses `peekRate` so it doesn't pollute the counter.

## Engagement trigger (rate POST + checkins POST → feed_items)

Both `POST /api/session/[code]/rate` and `POST /api/checkins` create `feed_items` rows alongside the underlying ratings. Two contracts shape this:

- **Session rate**: a feed_item materialises on first engagement (score > 0, OR chips, OR notes). Idempotent via the partial unique `(user_id, session_id)` + `ON CONFLICT DO NOTHING` — subsequent rates in the same session no-op, so `created_at` stays anchored on first engagement. Anon ratings skip entirely (schema-enforced via `feed_items.user_id NOT NULL`).
- **Standalone POST**: the act of POSTing IS the engagement signal; the feed_item is always created (the user explicitly chose to post). One feed_item per check-in (1:1 with the rating via `feed_items.ratingId`).

Full mechanics: see `docs/dev/social-feed.md` §Engagement trigger.

## API surface

The full endpoint list lives in README.md. When adding a new endpoint, also update the README API table if it's user-visible. Feature deep-dive docs live in `docs/dev/`.
