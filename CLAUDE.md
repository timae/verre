# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local development

```bash
docker run -d -p 6379:6379 redis:7-alpine   # Redis
npm install
npx prisma generate
npm run dev                                  # → http://localhost:3000
```

Type-check + lint:
```bash
npx tsc --noEmit
npm run lint
```

Apply schema changes to the database (Prisma is the single source of truth):
```bash
# Local dev: create a new versioned migration, applies it, regenerates client.
npx prisma migrate dev --name <description>

# Production: applied automatically by Deploio's deploy job (.deploio.yaml).
# Manually triggerable when needed: npx prisma migrate deploy
```

`prisma migrate dev` produces a versioned SQL file in `prisma/migrations/<timestamp>_<name>/migration.sql` that gets committed to git. On the next deploy, Deploio's deploy job runs `npx prisma migrate deploy`, which applies any pending migrations idempotently. The migration succeeds or the deploy is rolled back; the previous release keeps serving production until you fix the issue.

`prisma db push` is **no longer the canonical workflow** — it bypasses migration history. Only use it during early local exploration where you don't yet care about reproducibility, and never against production.

### Destructive schema changes — never automate

Routine, additive schema changes (new columns with defaults, new tables, new indexes, widening varchars, additive foreign keys) flow through the normal migration pipeline and apply automatically on deploy.

**Destructive changes** require explicit human confirmation:

- Dropping a column or table.
- Renaming a column (Prisma sees this as drop + add).
- Type changes that risk data loss (e.g. text → integer).
- Adding `NOT NULL` to a nullable column when NULLs exist.
- Anything Prisma would prompt about with "type 'y' to confirm" or any migration that would need `--accept-data-loss`.

For destructive changes:

1. Surface what data would be lost. Be specific.
2. Prefer a non-destructive sequence first: stop writing to the column → wait → drop in a follow-up. The "expand-then-contract" pattern.
3. If destructive is unavoidable and the user confirms: take a Postgres dump first (`pg_dump`), write the migration explicitly, push during a window the user can monitor.
4. Never use `--accept-data-loss` casually. If Prisma asks for it, that's a flag to stop and reconsider, not a flag to add.

This rule applies regardless of how much "easier" it would be to just drop and recreate. Lost user data doesn't come back from a `git revert`.

## Branching workflow

**Feature work goes on a branch, not `main`.** The threshold is intentionally low: anything beyond a single-file doc fix or typo gets its own branch.

- **OK to commit directly to `main`**: single-file doc edits (CLAUDE.md, README), typo fixes, dependency bumps that don't touch behavior.
- **Branch required**: anything that touches code, schema, config, or spans multiple files. Even small features.
- **Branch naming**: `feature/<short-name>` (e.g. `feature/phase2-auth`, `feature/admin-panel`). Lowercase, kebab-case after the slash.
- **Merge flow**: push the branch and merge yourself when ready. A PR isn't required — but opening one is encouraged, since it's nice for review, discussion, and capturing CI. The branch author can still merge their own PR; review is welcome, not a gate.
- **Cleanup**: delete the branch (locally and on origin) after merge. Don't accumulate stale branches.

## Architecture

### Two-tier persistence

| Layer | Technology | Responsibility |
|---|---|---|
| Active sessions | Redis (48h TTL) | Live wine list, ratings, participants |
| Accounts & history | Nine Eco PostgreSQL | Users, archived sessions, bookmarks, Hall of Fame |
| Images | Nine Object Storage (S3-compatible) | Bottle photos stored by URL |

**Redis key namespace:**
- `s:{CODE}:meta` — JSON session metadata (host, name, blind, lifespan, hostIdentityId, hostUserId, coHostIds, …)
- `s:{CODE}:wines` — JSON array of wines for this session
- `s:{CODE}:r:{IDENTITYID}:{WINEID}` — per-rating JSON (score, flavors, notes). Identity-id keyed (`u:<userId>` or `a:<uuid>`), never display name
- `s:{CODE}:identities` — hash of identity-id → display name (the participant list)
- `s:{CODE}:tokens` — hash of anon-token → identity-id (used by the resolver)

**Postgres archival is incremental:** data flows from Redis → Postgres only when a logged-in user commits a rating (`POST /api/session/:code/rate`) or joins a session (`POST /api/session/:code/visit`). Anonymous sessions stay Redis-only for 48h then expire.

**Lifetime counter snapshots on `users`:** the rate/visit/create endpoints atomically increment monotonic counters (lifetime_ratings, five_star, sessions_joined, etc.) on `users` rows. Counters never decrement — protects badge progression from rating deletions and gives O(1) reads on the badge hot path.

### Freemium split

- **Anonymous / free**: session-based, Redis only, 48h lifespan. No account required.
- **Logged-in (free account)**: same live session, but visit + ratings are archived to Postgres. History, bookmarks, Hall of Fame entries, and flavour profile persist indefinitely.
- **Pro** (`users.pro = true`): paid tier. Currently gates: blind tastings (host pre-rates while wine identities are hidden from tasters), extended lifespan (72h / 1w / unlimited beyond the 48h default).

### Session features

- **Session metadata**: name, description (1000 chars), address, datetime range (dateFrom/dateTo with timezone), external link. All editable via settings PATCH.
- **Lifespan**: 48h (default, all users) / 72h / 1w / unlimited (pro). Drives Redis TTL across all session keys.
- **Blind tasting**: host can hide wine identities from tasters until they reveal them. Host POSTs `/wines/<id>/reveal` per wine, or `/wines/reveal-all` / `/wines/hide-all` for batch. Server redacts wine details for non-host callers when `meta.blind && !wine.revealedAt`. Pro-gated.
- **Hide lineup before tasting**: when a host sets `meta.hideLineup = true` and provides `dateFrom`, the wine list is hidden from non-host participants until `dateFrom - hideLineupMinutesBefore`. Server returns `[]` for the wines GET in that window. The client shows a `LineupLocked` countdown screen, auto-refetches when the reveal time arrives.
- **Co-host roles**: host can promote any participant to co-host. Co-hosts can do everything a host can — add/edit/delete wines, edit settings, reveal/hide blind wines, reorder — except assign cohost roles or delete the session (those are strict-host-only). Tracked as `meta.coHostIds` (identity-id list, the trust anchor). When a host deletes their account on a session that has engagement, host fields are tombstoned and cohorts inherit delete rights via the softened strict-host check.
- **Display-name disambiguation on join**: when a participant tries to join with a name already taken in this session, they get a random food emoji suffix appended (e.g. `Sam` → `Sam 🍅`). Idempotent for logged-in users — re-joining doesn't accumulate suffixes. The check uses the identities map, not the legacy users set.
- **Bookmarks** (logged-in only): `POST /api/session/<code>/wines/<id>/bookmark`. Saved wines persist across sessions, survive session deletion (the wine row is orphaned with `session_id = NULL` rather than cascade-deleted).
- **Hall of Fame** (logged-in only): every 5★ rating creates a row in `hall_of_fame`. Public leaderboard at `/hof`, no auth required to read. Denormalized — entries survive without the underlying wine/session row.
- **Badges + XP**: ~60+ badges in `lib/badges.ts`, evaluated on every rate POST against the user's lifetime counter snapshots. Awarded badges are permanent (`user_badges` table); deleting ratings doesn't un-earn.

### Session deletion

Hosts (not co-hosts) can permanently delete a session. `DELETE /api/session/<code>`, host-strict authorization.

**Retention rule** (per `(user, wine)` pair):
- If the user **bookmarked** the wine, their rating row is **kept** so the bookmark detail page still renders score, notes, flavour wheel.
- If the user **didn't bookmark**, their rating is deleted. Hall of Fame entries follow the same rule (kept when bookmarked, dropped otherwise).

The wine rows themselves are kept (`session_id` set to NULL via the `ON DELETE SET NULL` foreign key) so bookmarked wines remain reachable from `/me/saved` with image and metadata intact.

**Lifetime snapshot counters never decrement.** `users.lifetime_ratings` etc. stay at the higher value even after the underlying ratings are gone — protects badge progression. The live aggregations in `/me/profile` (avg flavor, total_rated count) will reflect the smaller dataset.

The full Postgres cleanup runs in a `prisma.$transaction` so any failure rolls back; Redis wipe (`s:<code>:*`) runs after.

**Participants in the deleted session** get bounced when their next polled wines GET returns 404. SessionShell clears local cache for that code and redirects to `/join/<code>`, which renders the "session not found" page.

### Auth

Two trust anchors:
- **Logged-in users** carry a NextAuth session cookie (`__Secure-authjs.session-token`, JWE-encrypted, 30 day lifetime). Resolved server-side via `auth()`.
- **Anonymous users** carry a per-session anon token (`crypto.randomUUID()`, stored in browser `localStorage` as `vr_anon_<CODE>`). Sent on every request as the `x-vr-anon-token` header. Maps to `s:{CODE}:tokens` → identity id.

The `lib/identity.ts` `resolveIdentity(code, req, session)` returns `{id, displayName, kind}` from one of those sources, or `null` for unauthenticated callers. Identity is never read from the request body.

**Identity ids:** `u:<userId>` for logged-in users, `a:<uuid>` for anonymous. These ids are the trust anchor everywhere — Redis rating keys, host checks, cohost lists, all id-keyed.

**Display names are presentation-only.** What a user types as their name (or what `users.name` holds for logged-in accounts) is user-chosen, mutable, non-unique within a session (collisions get an emoji suffix), and carries **zero** trust. It must never be used for identification, authentication, authorization, matching, or lookup. There is no concept of a "username" in this codebase — if a request, ticket, or PR talks about matching on username/name, translate it to identity id and push back on the framing. Fields like `meta.host`, `ratings.rater_name`, and the values (not keys) of `s:{CODE}:identities` are display strings: store them, render them, but never branch on them. All authorization checks resolve through `resolveIdentity` → `{id, kind}` and compare on `id`.

**Authorization patterns:**
- Session reads (`GET /api/session/:code`, `/wines`, `/ratings`) require participant: `requireParticipant()` rejects with 401 + `X-Vr-Auth: invalid` if the caller isn't a registered participant in this session's identities map.
- Session existence is checked first; nonexistent/deleted sessions return 404 (no auth header) so the client can distinguish "session is gone, go home" from "your token is bad, retry join."
- Host actions (wine CRUD, settings, reveal/hide, name) check `isHostByIdentity(meta, identity)`, which matches `meta.hostIdentityId` first, then `meta.hostUserId` (logged-in fallback), then any entry in `meta.coHostIds`. Pure id-based; no display-name fallback.
- Strict-host actions (cohost role assignment, session delete) bypass the cohost check — only the actual session host can perform them.

**Permission-denied vs auth-invalid:** the server returns 401 + `X-Vr-Auth: invalid` only when identity itself failed to resolve. Permission-denied 403s ("only the host can…", "pro required") return bare 403 without the header. The `lib/sessionFetch.ts` client-side wrapper only clears local state and bounces to `/join/<code>` on the auth-invalid header — permission denials are surfaced inline.

### Rate limiting

Redis-backed limiters via `lib/rateLimit.ts`. Use `peekRate` / `peekRates` to check without incrementing (login does this so successful logins don't count); `checkRate` / `checkRates` to check + increment atomically. `formatWait(seconds)` produces the humanized "in 3 minutes" / "in 45 seconds" string surfaced in 429 responses.

Limits in production:

| Endpoint | Limit | Why |
|---|---|---|
| Login (NextAuth `authorize()`) | 10 fails/min/email + 20 fails/hour/email + 100 fails/10min/IP | Brute-force on stolen email knowledge. Counters increment on bcrypt failure only. |
| `/api/auth/register` | 100/min/IP | Mass-signup spam. |
| `/api/me/account` PATCH + DELETE | 20/hour/user (shared counter) | Brute-force the password re-auth check from a stolen session cookie. PATCH and DELETE share the counter so an attacker doesn't get 20+20. |
| `/api/session` POST | 10/10min/user (logged-in) or /IP (anon) | Code-space exhaustion. |
| `/api/session/join` POST | 30 invalid attempts/min/IP, counter cleared on valid code | Code-guessing. |

`/api/auth/login-precheck` exists because NextAuth v5 strips error messages from the client-side `signIn()` response. The login form calls it first and surfaces the "Try again in N seconds" message itself; on success it then hits the real `signIn()`. Precheck uses `peekRate` so it doesn't pollute the counter — only the actual auth call does.

### Bot defenses on `/api/auth/register`

- **Honeypot field**: an offscreen `<input name="website">` rendered by the register form. Real users never see it; bots scraping the DOM tend to fill plausibly-named text inputs. Non-empty submissions reject with a generic 400.
- **Signed-timestamp form token**: `lib/registerToken.ts` mints a `<timestamp>.<hmac>` token at page render (server component, `force-dynamic`). The form posts it back with the body. Server verifies the HMAC, accepts only `>= 800ms` and `<= 30min` old. Rejects forged signatures, too-fast submits, and stale tokens with the same generic 400.
- Both checks run **before** the bcrypt hash + DB write, so a tripped honeypot or bad token costs the server effectively nothing.

### Account deletion

`DELETE /api/me/account` takes `{password}`, bcrypt-verifies against the user row, then:

1. **Postgres transaction**: tombstones references on tables with `ON DELETE NoAction` (`UPDATE ratings SET user_id=NULL, rater_name='[deleted]'` etc. for `ratings`, `hall_of_fame`, `sessions.host_user_id`), then `DELETE FROM users WHERE id=$id`. Cascades fire on `bookmarks`, `user_badges`, `session_members`.
2. **Redis cleanup** (`lib/accountDelete.ts`): SCAN every `s:*:meta` and decide per session:
   - If user is host AND no non-host has rated yet → drop the entire session (Redis + Postgres `sessions` row + wines orphan + session_members delete) so the session vanishes from participants' `/me/history`.
   - If user is host AND there's engagement → keep the session alive, set `meta.host = '[deleted]'`, null `meta.hostUserId` and `meta.hostIdentityId`. The softened strict-host check in `app/api/session/[code]/route.ts` lets cohorts delete the session from there.
   - If user is cohost or plain participant → relabel their identity-map entry to `'[deleted]'` and drop them from `meta.coHostIds`. Their rating data stays so other tasters' compare views are unchanged.

The plan + apply runs as a single SCAN+decide+act loop per session — no TOCTOU window between observation and action.

UI lives in `components/me/AccountSettings.tsx` as a Danger Zone modal: shows the email read-only, asks for password, on success wipes all `vr_anon_*` / `vr_name_*` / `vr_id_*` localStorage keys (so other tabs in the same browser don't render with stale identity) and `signOut()`s.

### NextAuth logger override

`auth.ts` overrides NextAuth's default error logger to collapse two expected-noise classes:
- `CredentialsSignin` (any failed login) → one warn-level line `[auth] failed login (wrong credentials)`. No PII.
- `CallbackRouteError` whose cause matches `RATE_LIMITED:N` (our throw from `authorize()` when login is rate-limited) → one warn-level line `[auth] login rate-limited (retry in Ns)`.

Anything else falls through to `console.error(error)` with a full stack so genuine bugs stay visible.

### API surface

| Endpoint | Method | Auth required | Authorization |
|---|---|---|---|
| `/api/auth/[...nextauth]` | GET/POST | none (auth flow) | NextAuth handles |
| `/api/auth/register` | POST | none | honeypot + signed-timestamp + rate-limit; email uniqueness |
| `/api/me/profile` | GET | cookie | implicit (queries by `session.user.id`) |
| `/api/me/sessions` | GET | cookie | implicit |
| `/api/me/badges` | GET/POST/PATCH | cookie | implicit |
| `/api/me/bookmarks` | GET | cookie | implicit |
| `/api/me/ratings` | GET | cookie | implicit |
| `/api/me/account` | PATCH | cookie | edits own row only |
| `/api/me/account` | DELETE | cookie + password re-auth | tombstones references, drops user row, scrubs Redis |
| `/api/hof` | GET | none | public leaderboard |
| `/api/session` | POST | none (anyone can host) | blind requires pro; lifespan>48h requires pro |
| `/api/session/join` | POST | none (anyone with the code) | by design |
| `/api/session/<code>` | GET | participant | `requireParticipant` |
| `/api/session/<code>` | PATCH | strict host | cohost role assignment |
| `/api/session/<code>` | DELETE | strict host | session deletion |
| `/api/session/<code>/visit` | POST | cookie (anon early-returns) | implicit; no-op for anons |
| `/api/session/<code>/wines` | GET | participant | `requireParticipant` (blind redaction for non-hosts) |
| `/api/session/<code>/wines` | POST | host | `isHostByIdentity` (cohosts pass) |
| `/api/session/<code>/wines/<id>` | PATCH/DELETE | host | `isHostByIdentity` |
| `/api/session/<code>/wines/<id>/reveal` | POST/DELETE | host | `isHostByIdentity` (blind reveal) |
| `/api/session/<code>/wines/reveal-all` | POST | host | `isHostByIdentity` |
| `/api/session/<code>/wines/hide-all` | POST | host | `isHostByIdentity` |
| `/api/session/<code>/wines/reorder` | POST | host | `isHostByIdentity` |
| `/api/session/<code>/wines/<id>/bookmark` | POST/DELETE | cookie | logged-in only; no anon bookmarks |
| `/api/session/<code>/ratings` | GET | participant | `requireParticipant` |
| `/api/session/<code>/rate` | POST | identity (cookie or anon-token) | rates own slot only (id-keyed Redis key) |
| `/api/session/<code>/rate/<wineId>` | DELETE | identity | deletes own rating only |
| `/api/session/<code>/settings` | PATCH | host | `isHostByIdentity`; pro-gated for blind/lifespan |
| `/api/session/<code>/name` | PATCH | host | `isHostByIdentity` |

**"Strict host"** = the original session host, not co-hosts. Reserved for role assignment (`PATCH /api/session/<code>` with cohost actions) and session deletion.

**"Identity required"** = the request must produce a non-null result from `resolveIdentity` (cookie or valid anon-token). Different from "participant" — a stale or wrong token returns 401 + `X-Vr-Auth: invalid` for both, but session-existence-checked endpoints distinguish 404 (session is gone) from 401 (your token is bad).

### Frontend structure

Next.js 15 App Router. UI lives under `app/` (route segments) and `components/`.

Top-level routes:
- `/` — lobby (`app/(public)/page.tsx` → `LobbyClient`)
- `/login`, `/register` — NextAuth credentials flows
- `/me` and subpaths — logged-in dashboard, history, saved, profile, badges, account
- `/session/<code>` — in-session shell (`SessionShell` provides context to wine list, rate, compare screens)
- `/session/<code>/rate/<wineId>` — per-wine rating screen
- `/session/<code>/compare` — overlay/per-rater comparison view
- `/join/<code>` — invite landing page (anon name entry, or one-tap join for logged-in users; renders "session not found" for invalid codes)
- `/hof` — public Hall of Fame leaderboard

State management:
- **Server state**: TanStack Query (`useQuery` + `refetchInterval`) for wines/ratings/meta polling.
- **Client identity**: `localStorage` keys `vr_anon_<CODE>` (token), `vr_name_<CODE>` (display name), `vr_id_<CODE>` (identity id).
- **Session-scoped context**: `components/session/SessionShell.tsx` exposes `useSession()` returning `{code, displayName, myId, isHost, sessionMeta, wines, allRatings, myRatings, refresh, …}` to descendant screens.

State-changing fetches against session endpoints go through `lib/sessionFetch.ts` (auto-attaches the anon token header, handles auth-invalid responses). Logged-in `/me/*` reads use `lib/authedFetch.ts`.

### Shared visual primitives

Visual consistency across screens is enforced by reusable primitives, not by convention. The standing rule: **if a visual pattern appears in 3+ places, extract it into a shared component or constant.** Inline magic numbers and copy-pasted layout tend to drift across commits — especially when multiple authors (or AI tools) are working on the project.

Primitives in place today:

- **Color tokens** (`app/globals.css` CSS variables exposed via Tailwind). Use `var(--bg2)`, `var(--accent)`, `text-fg-dim`, etc. — never raw hex codes.
- **Element classes** (`.btn-p`, `.btn-g`, `.btn-s`, `.btn-del`, `.fi`, `.field`, `.fl`, `.panel`, `.chip`). Use these for buttons and form fields rather than re-styling inline.
- **`<ConfirmDeleteButton>`** (`components/ui/ConfirmDeleteButton.tsx`) — two-press destructive button with armed/pending/failed states. Use for any destructive action that previously would have called `window.confirm()`.
- **Lightbox** (`components/ui/ImageLightbox.tsx`). Use `openLightbox(url, alt)` to display any image full-screen.
- **`<WineIdentity>`** (`components/wine/WineIdentity.tsx`) — canonical wine identity rendering: Name + Vintage on line 1, Producer on line 2, Grape on line 3. Three sizes (`compact` / `card` / `hero`) cover list rows, modal cards, and hero banners. Use this on every surface that displays a wine — never re-implement the field order inline. Surrounding chrome (image, accent bar, score, like button, "revealed" badge, etc.) stays in the call site.
- **`CHART_SIZE`** (`components/charts/sizes.ts`) — named PolarChart / RadarChart sizes (`THUMB` / `EMBED` / `DETAIL` / `COMPARE` / `HERO`) instead of inline pixel values. Pick the tier that matches the chart's *role* in the layout (glance, embedded with form, modal detail, side-by-side compare, hero interactive surface).

Pending extractions that are on the follow-up list (extract them when you next touch the relevant area):

- `<WineIdentityFields>` — sibling for create/edit forms (CheckinModal, AddWineModal). Same canonical field order as `<WineIdentity>`.

**Modals must use a portal.** Several layout styles in this app create a containing block that traps `position: fixed` descendants — most notably `.panel` with `backdrop-filter`. New modal/overlay components must wrap their JSX in `createPortal(children, document.body)` so the overlay is attached at the document root and reliably covers the viewport regardless of where it's rendered from. `CheckinModal` does this correctly; older overlays (`AddWineModal`, `SavedWineModal`, `ImageLightbox`, `UserPanel`, `SessionPanel`) still need the migration.

### Flavour chart system

Two chart types coexist:
- **Polar chart** (`drawPolarChart(id, flavors, sz, fl)`) — arc segments per dimension. Used for single-wine detail, compare cards, and user profile. Takes an optional `fl` array; if omitted, `detectFL(flavors)` infers the right one from stored key names.
- **Radar** (`drawRadar(...)`) — polygon overlay. Used only for multi-wine compare overlays where shapes need to be compared visually.

Flavour dimensions are **type-specific**:
- `FL_RED`: dark_fruit, red_fruit, earth, spice, oak, tannin, body, acid, herbal, floral
- `FL_WHITE`: citrus, stone, tropical, floral, herbal, mineral, oak, body, acid, sweet
- `FL_SPARK`: floral_herb, citrus, tree_fruit, red_fruit, dried_fruit, earth, creamy, oak, nutty, acid
- `FL_ROSE`: red_fruit, citrus, floral, stone, herbal, mineral, body, acid, sweet, tropical
- Legacy `FL` (generic 10 keys): used for old ratings and profile aggregation

`detectFL(flavors)` identifies which array applies by checking key names. Existing ratings always keep their stored keys — switching wine type never migrates old flavor data.

### Deployment (Deploio / Nine)

- App: `moonlit-pond`, project: `timgrethler`, branch: `main`
- Live URL: `tasting.tgweb.li`
- Env vars set on Deploio:
  - `REDIS_URL`, `DATABASE_URL` — service connections.
  - `AUTH_SECRET` (or `NEXTAUTH_SECRET` / `JWT_SECRET` — same secret; NextAuth and `lib/registerToken.ts` look for any of those names in that order).
  - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION=us-east-1` — Nine Object Storage.
  - `SERVER_ACTIONS_ALLOWED_ORIGINS` — the deployed hostname (e.g. `tasting.tgweb.li`). `localhost:8080` is always allowed; this var adds extra origins for CSRF on Server Actions. Comma-separated, no scheme.
  - `PUBLIC_HOSTNAME` — the deployed hostname. Used as contact info in the Nominatim User-Agent header when `GOOGLE_PLACES_API_KEY` is unset; falls back to `'self-hosted'`.
  - `GOOGLE_PLACES_API_KEY` (optional) — when set, `/api/places` uses Google Places API for venue search; when unset, falls back to OSM Overpass + Nominatim.
  - `NEXT_TELEMETRY_DISABLED=1` — opts out of Next.js anonymous build/usage telemetry.
- S3 endpoint: `https://es34.objects.nineapis.ch` (Nine Object Storage, region always `us-east-1`)
- Postgres: `verre.d600599.db.postgres.nineapis.ch`, TLS with `rejectUnauthorized: false`
- Deploio builds from the Dockerfile on every push to the tracked branch

### Schema notes for future features

These columns exist in the schema but are not yet wired to UI:
- `wines.purchase_url` — vendor/pro feature: link to purchase
- `users.role = 'vendor'` — paid tier hook (the `pro` boolean is wired)
- `wines.category` — extensible drink type beyond wine (beer, spirit, kombucha)
