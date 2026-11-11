# CLAUDE.md

Guidance for working in the Verre codebase. **Verre** is a wine-tasting web app with two surfaces:

- **Sessions** — people scan into a tasting via short code, rate wines on stars + flavour radar + notes, see each other's ratings in real time. Anonymous join supported.
- **Social feed** (logged-in) — post standalone check-ins of bottles you've had, follow other users, see what friends are drinking. Public profiles at `/u/<id>`.

Logged-in users also get persistent history, bookmarks, badges + XP, and a flavour profile.

This file is the always-loaded map: cross-cutting invariants, the destination-routing rule, and pointers to area-specific guides.

## How to work in this repo

### Branching workflow

**Feature work goes on a branch, not `main`.** The threshold is intentionally low: anything beyond a single-file doc fix or typo gets its own branch.

- **OK to commit directly to `main`**: single-file doc edits (CLAUDE.md, README), typo fixes, dependency bumps that don't touch behavior.
- **Branch required**: anything that touches code, schema, config, or spans multiple files. Even small features.
- **Branch naming**: `feature/<short-name>` (e.g. `feature/phase2-auth`, `feature/admin-panel`). Lowercase, kebab-case after the slash.
- **Merge flow**: push the branch and merge yourself when ready. A PR isn't required — but opening one is encouraged, since it's nice for review, discussion, and capturing CI. The branch author can still merge their own PR; review is welcome, not a gate.
- **Cleanup**: delete the branch (locally and on origin) after merge. Don't accumulate stale branches.

### Coding style

- **Guard clauses, not nested conditionals.** Validate, reject, return early at the top of a function. The happy path runs at the base indent level.
- **Compact code, no fluff.** No newlines between obviously-related statements. No comments for what well-named code already says. A 40-line function that reads top-to-bottom beats the same logic fragmented into five 8-line helpers.
- **When to extract a function:** the logic repeats in 3+ places across files; or the function no longer fits on screen; or extracting gives it a name that's clearer than the inline code. Cross-file helpers go in `lib/` under a module name that names what they do.
- 🔒 **No em dashes (U+2014) in user-facing copy**, anywhere: mobile, web, user-visible API messages, `@verre/core` strings, accessibility labels (they read as AI-written). Rewrite with a full stop, comma, colon or parentheses. Exempt: comments, logs, a lone `'—'` empty-value placeholder, en-dash ranges, and the attributions' licence text (the OGL-BC EN DASH is a licence obligation). CI-gated (`check-lint.yml`): ESLint in `app/`, `components/`, `packages/core/src` (`eslint.config.mjs`, pinned in `scripts/tests/lint-boundary-units.mjs`), and `scripts/check-no-em-dash-copy.mjs` for `apps/mobile/src`.

### Local development

Setup (Redis + a local S3-compatible store + bucket policy + `.env`) is documented in README.md. Day-to-day:

```bash
npm install
npx prisma generate
npm run dev                  # → http://localhost:3000
npx tsc --noEmit             # type-check
npm run lint                 # eslint . (flat config) — `next build` no longer lints since Next 16
```

**LAN testing gotcha**: `S3_ENDPOINT` is stored as a literal prefix in `users.image_url`, so rows uploaded under one address won't resolve from another. Switching networks → empty the bucket **through the S3 API** and clear `users.image_url`: `docker run --rm --network host -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin amazon/aws-cli:latest --endpoint-url http://localhost:9000 s3 rm s3://verre-local --recursive && psql "$DATABASE_URL" -c "UPDATE users SET image_url = NULL"`. ⚠️ Never `rm -rf` the bucket directory inside the RustFS container: it keeps bucket metadata under `/data/.rustfs.sys`, and a directory wipe leaves an "orphaned bucket generation" that refuses recreation (verified 2026-11-06). If that has happened, `docker rm -f verre-s3 && docker volume rm verre-s3-data` and recreate per README.

Schema migration workflow (`prisma migrate dev`, destructive-change rule, deploy semantics): see `prisma/CLAUDE.md`.

### Working with this codebase

**Where new content goes** — destination-routing rule. Re-read before adding any new section; this is what keeps root tight as the codebase grows.

- **Cross-cutting invariant** (rule that can be hit without touching its canonical subtree — e.g. trust model, score coercion, cascade-vs-tombstone) → root (this file).
- **Area-scoped guidance** (rule tied to a directory) → nearest `<area>/CLAUDE.md`. Create one if missing. Loads lazily when Claude touches that subtree.
- **Self-contained feature deep-dive (shipped)** → `docs/dev/<feature>.md`. The bar is "deserves its own section" — e.g. the social feed earned its own doc because it added `/api/feed` + `/api/checkins/*` + `/api/users/*` + a follow graph. A single new route doesn't. Add a 1-line pointer to the index below.
- **Plans for new features / non-trivial changes (not yet shipped)** → `docs/dev/proposals/<name>.md`. Bar is the same as the deep-dive bar; use the proposal to align on the *why* and the migration shape before code. If the design conversation would be longer than the diff itself, write the proposal. See `docs/dev/proposals/README.md` for the post-ship lifecycle.
- **env var added/changed** → `docs/dev/deployment.md` (and README.md if the local dev story changes).
- **Native-app design decision / ruling** → `docs/design/` (mobile only): ADRs in `decisions/` (append-only, supersede never edit), reusable build recipes in `patterns/`. The component catalog + "reuse before you build" rule + the extraction backlog live in `apps/mobile/CLAUDE.md` (auto-loads on subtree touch). The mockup in `.local/design/` is historical, often stale — the shipped app + ADRs win. (Web design isn't tracked — it's slated for redesign.)
- **`AGENTS.md`** (root) is only a pointer for agents that read that filename (Codex) plus a block `next dev` manages between its markers. Never put guidance there; it goes in the CLAUDE.md files.
- **User-facing feature scope changes** → README.md (`What it does` list + API table).
- **API request/response shape changes for a route already documented in README** → update the README API table (example body shapes must stay accurate).

**Worked examples** (when the rule feels abstract):
- Added a new `MAX_UPLOAD_BYTES` env var → `docs/dev/deployment.md` + README env section. Not root.
- Discovered the Prisma `Decimal` → JSON-string trap → root (cross-cutting invariant). Already there.
- Added a `/api/me/preferences` endpoint with no schema impact → README API table only; no new doc.
- Shipped a notifications surface (new tables + endpoints + UI + delivery worker) → new `docs/dev/<feature>.md` + 1-line root pointer + any cross-cutting auth/rate rules to root.

**Tie-breaker when a rule fits two destinations**: put the invariant in root and the implementation in the area file; cross-link both ways. Don't restate the invariant in the area file.

**Soft cap — 250 lines for this file.** When root approaches that, audit which sections quietly moved up from area files — that's the re-bloat signal. The original file hit 563 lines because the "is this cross-cutting enough?" threshold was soft; the cap makes the next drift visible.

**Reviewer rule**: when the diff touches auth/schema, spans >3 files or >50 lines, or introduces a new shared primitive, it gets a review before pushing — **ask the user whether Codex should review it (the user runs Codex) or whether Claude should spawn a reviewer agent. Never spawn a reviewer without asking.** Either way, name the specific concerns + relevant area docs the review should cover (`app/api/CLAUDE.md`, `lib/CLAUDE.md`, `docs/dev/block.md`, `docs/dev/profile-visibility.md` for auth/security/schema; `apps/mobile/CLAUDE.md` + `docs/design/` for mobile/UI — a spawned reviewer only auto-loads root, so point it at these explicitly). After applying findings, offer a re-review. Single-file doc fixes can skip.

**Schema check**: `.github/workflows/check-schema.yml` runs `prisma migrate diff` and fails the build if `schema.prisma` and the migrations dir disagree. It also runs the catalog contract-shape gate plus three integration suites against a real Postgres for the invariants that diff is blind to (CHECK bodies, deferred triggers, partial uniqueness, `NULLS NOT DISTINCT`, audit immutability, concurrency, and the catalog query plans). Don't bypass.

## Architecture invariants

### Two-tier persistence

| Layer | Tech | Responsibility |
|---|---|---|
| Active sessions | Redis (48h TTL) | Live wines, ratings, participants |
| Accounts & history | Postgres | Users, archived sessions, bookmarks |
| Images | S3 (Nine Object Storage) | Bottle photos, avatars |

**Postgres archival is incremental**: a session is promoted to Postgres on a logged-in act (visit, rate, wine add, bookmark). Anonymous-only sessions stay Redis-only.

🔒 **A session with a live `sessions` row is Postgres-authoritative; Redis is its rebuildable cache** (redis-rehydration, shipped). A miss rebuilds (`ensureSessionLive` / `openSession`, `lib/sessionRehydrate.ts`) — `'restoring'` answers **503 + Retry-After, never 404** (mobile renders 404 as the terminal "This moment isn't available"). Mode is decided by the row's existence, never the caller's login. There is **no cross-store transaction**: every durable session writer goes through the session mutation contract (`lib/sessionMutation.ts` — fenced `lock:session:{CODE}`, one advisory lock per session, decisions under the locks, COMMIT, then the projection). Lifespan is only the cache TTL for such a session — it is reopenable whatever its age. Contract, participation table, ordering rule: `lib/CLAUDE.md`.

**Lifetime counter snapshots on `users`**: rate/visit/create endpoints atomically increment monotonic counters (lifetime_ratings, five_star, sessions_joined, etc.). Never decrement — protects badge progression and gives O(1) reads on the badge hot path.

**NX to create, XX + `KEEPTTL` to update** on `s:{CODE}:meta` and `s:{CODE}:wines` (lint-gated, `eslint.config.mjs`): a wiped or evicted key can never be recreated by a stale writer, and a hardcoded `{ EX: … }` would downgrade an unlimited lifespan. Wine-list writes go through `mutateWines(fence, …)` (`lib/session.ts`) inside the contract — it rejects on an absent lineup.

Redis key namespace, SCAN helpers (`scanKeys`, `hasKey`, preferred over `redis.keys` which blocks the event loop): see `lib/CLAUDE.md`.

### Score system

Scores are decimal `0..5` in `0.25` steps. `0` means "not rated".

- **Validation** (at every write boundary): `Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v * 4)`. The `* 4` integer check accepts dyadic fractions and rejects 0.1, 0.3, 1/3. Reject 400 if it fails.
- **Wire-format trap**: Prisma's `Decimal` serializes to a JSON **string** (`"4.25"`), not a number. Every API response that surfaces a score must coerce via `Number()` before sending. Forgetting this ships strings where number arithmetic silently breaks.
- **Read**: `<StarRating>` or `formatScore(v)`. **Write**: `<ScoreSlider>`. Never inline `★ ${v}` or roll your own input.

Full pipeline (flavour integration): see `docs/dev/score-system.md`.

### Trust model

- **Identity ids are the only trust anchor**: `u:<userId>` for logged-in, `a:<uuid>` for anonymous. Resolved via `lib/identity.ts` `resolveIdentity(code, req, session)`. Never read identity from a request body.
- 🔒 **For a `u:` identity in a Postgres-backed session, authorization derives from COMMITTED Postgres state — the cache can deny, never grant.** One grant read per request inside `participantOrBanned` (`lib/sessionGrant.ts`), carried as `AuthorizedIdentity.grant`; the privilege helpers (`isHostByIdentity`, `isStrictHost`, `isProvider`) take only that type. Cached role lists / roster / kicks are presentation; a Redis ban still bounces first. Anonymous identities and Redis-only sessions keep Redis as their authority.
- **Display names are presentation-only**: user-chosen, mutable, non-unique within a session (collisions get an emoji suffix). Carry **zero** trust. Never used for identification, authentication, authorization, matching, or lookup. There is no concept of "username" in this codebase — if a ticket or PR talks about matching on username/name, push back and translate to identity id. Fields like `meta.host`, `ratings.rater_name`, and the values (not keys) of `s:{CODE}:identities` are display strings: store them, render them, never branch on them.
- **URL query parameters are presentation-only too**: `?name=`, `?id=`, `?host=1` exist solely to seed client UI on first render after a redirect. Capture them synchronously into state and strip via `router.replace` on mount. Never branch authorization on a URL param.
- 🔒 **SECURITY: don't log `viewerBlocksOut` / `viewerBlocksIn`.** These arrays from `GET /api/session/[code]` carry the viewer's block-pair list scoped to a session. They must not be mirrored to analytics, stored in shared cache, or persisted outside the response.

Authorization patterns, header conventions (`X-Vr-Auth: invalid` vs `removed`), tier-resolution implementation: see `app/api/CLAUDE.md`.

### Credential & revocation chokepoint

🔒 **`lib/identityStore.ts` is the ONLY code allowed to write `users.password_hash` or `user_sessions.revokedAt`.** Every credential write and every session revoke routes through its helpers (`syncCredential`, `backfillNativeCredential`, `revokeAllSessions`, `revokeAllWebSessions`, `revokeAllForNativeCaller`, `revokeOneSession`, `revokeOneNativeSession`, `deleteAllNativeSessions`, `revokeNativeSessionsExcept`, `pruneExpiredNativeSessions` — the module header is canonical; account deletion calls `deleteAllNativeSessions` before its cascade). A CI gate (`.github/workflows/check-identity-writes.yml` → `scripts/check-identity-writes.mjs`) **fails the build** on any such write elsewhere — safe-by-construction, not safe-by-discipline. The reason: native auth (Better Auth) adds a *second* credential + session store (`auth_accounts` / `auth_sessions`), and "log out everywhere" / a password change must hit **both** stores or they drift. Funnelling every write through one module means the dual-store fan-out has exactly one home. The fan-out across stores must be independent (one store throwing must not skip the other). **Status: live end-to-end** — `syncCredential` mirrors into `auth_accounts` (update-only), `revokeAllSessions` / `revokeOneNativeSession` fan out across both stores; partial-failure pins in `.local/test-env/scripts/_ba-e2e-step5.ts`. See `docs/dev/proposals/mobile-app/01-identity-and-auth.md` §3.

🔒 **Better Auth sessions are Redis-first — a raw row delete does NOT revoke.** With `secondaryStorage` configured, BA writes sessions to both `auth_sessions` and Redis and reads Redis first: a raw `prisma.authSession.delete` leaves the Redis copy live until TTL. Every BA-session revocation must go through Better Auth (`$context.internalAdapter.deleteSession` per token, as `lib/identityStore.ts` does — it deletes both stores), never raw row writes. The converse invariant is enforced at the `secondaryStorage` boundary in `lib/betterAuth.ts`: **a Redis session copy whose `auth_sessions` row is gone is unauthenticated and deleted on sight** — BA's refresh writes Redis before Postgres with no ordering against a concurrent delete, so without this a heartbeat racing a revoke resurrects the session. `/update-user` stays a `disabledPaths` 404 (it would bypass the avatar pipeline + name scrub); `/change-password` is live — the `account.update.after` mirror routes the new hash + the web AND native session revokes through the chokepoint (BA's own list-driven `revokeOtherSessions` is forced OFF; `/revoke-sessions` + `/revoke-other-sessions` are likewise answered by the before-hook from a Postgres snapshot, because BA's list-driven versions can't reach a Redis copy whose `active-sessions-<uid>` list was evicted). 🔒 Never prune `auth_sessions` with raw SQL either — `pruneExpiredNativeSessions` retires expired rows through BA so a Redis copy ahead of its row can't be stranded. Full rationale: comments in `lib/betterAuth.ts`.

### Authorization tier vocabulary

Glossary used in code and PRs throughout. Implementation lives in `app/api/CLAUDE.md`.

- **strict host** — original session host (not cohosts). Reserved for cohost role assignment, session deletion, banning a cohost.
- **host** — passes `isHostByIdentity`: original host OR any cohost. Shares host powers for wines, settings, reveals, reorders, kick/ban of regular participants.
- **provider** — passes `isProviderById`. Can add wines + edit/delete only wines they added. No other host powers. Mutually exclusive with cohost.
- **participant** — passes `requireParticipant`: registered in the session's identities map.
- **identity required** — non-null `resolveIdentity` (cookie or anon-token).
- **cookie** — NextAuth session cookie. Logged-in only.

### Cascade vs tombstone (new user-linked tables)

When adding a table that references `users.id`, pick one:

- **Cascade hard-delete** (FK `onDelete: Cascade`) — data is purely the user's own with no other-user references. Examples: `feed_items`, `feed_item_likes`, `feed_item_tags`, `follows`, `bookmarks`, `user_badges`, `session_members`. **Downstream**: `rating_images` cascades via `ratings.id` (not directly via user); a standalone rating's deletion takes its rating_images with it.
- **Tombstone** (FK `SetNull` + `UPDATE … SET rater_name='[deleted]'` in the delete path) — another user's view references the row. Examples: `ratings` where `session_id IS NOT NULL`, `sessions.host_user_id`.
- **Split rule on `ratings`** — standalone ratings (`session_id IS NULL`) hard-cascade in the account-delete path (their feed_items go with them via downstream cascade); session ratings tombstone (other tasters' compare views need them). See `lib/accountDelete.ts` for the implementation.

The test: does another user's view (own history, compare screen, leaderboard, ongoing session they're in) reference this row in a way where deletion would leave their experience broken? Yes → tombstone. No → cascade. (Or **both ways within one table, keyed on a column** — see `ratings`, which splits on `session_id IS NULL`.) **S3 image reclaim is independent of cascade**: cascade does NOT trigger S3 cleanup; any table with an `imageUrl` field needs explicit `reclaimImage()` calls in every deletion path.

**Capture / commit / reclaim-after ordering is mandatory** when an S3 delete is paired with a DB delete: capture the `imageUrl` set into memory BEFORE the txn, run the DB cascade, commit, then fire `reclaimImage()` on each captured URL AFTER commit. A txn rollback after S3 deletes already fired would leave a "DB still has the row, bytes are gone" inconsistency. This pattern is implemented across `lib/accountDelete.ts`, `lib/sessionWipe.ts`, `app/api/session/[code]/route.ts`, and the `/api/checkins/[id]` PATCH/DELETE handlers. "Had a sip" is the deliberate exception — it COPIES bytes server-side (CopyObjectCommand), never reclaims.

Account-deletion implementation (Postgres transaction + Redis SCAN+decide+act loop): see `docs/dev/account-deletion.md`.

### Profile visibility (cross-cutting authorization)

Any route serving user-scoped content (`/api/users/<id>/*`, `/u/<id>` reads, feed entries, check-in likes/tags) MUST gate through the profile-visibility resolver — not just `resolveIdentity`. Two chokepoints in `lib/profileVisibility.ts`:

- `resolveProfileViewer(profileId, viewerId)` — single-profile gate. Returns `{status: 'ok' | 'shell' | 'blocked-by-me' | 'gone', …}` (plus `name` for `shell`/`blocked-by-me`, `viewer` for `ok`). Map `status === 'gone'` to **404** (never 403 or 401) so the caller can't distinguish "no such user" from "exists but tier denies you."
- `viewerCanSeeAuthor(viewerId, authorId)` — per-pair gate for non-feed call sites.

Bulk variants for feed / search: `batchLoadVisibilities` + `resolveProfileViewerBulk` + `viewerFofAuthorSet`. Block-pair check (`anyBlockBetween` in `lib/userBlock.ts`) runs BEFORE the tier check.

Tier semantics, audit log, compare exception: see `docs/dev/profile-visibility.md` and `docs/dev/block.md`.

### Freemium split

- **Anonymous / free**: session-based, Redis only, 48h lifespan (the only real one: no record, so expiry ends it). No account. The create refuses any other lifespan (403); the lobby says "Guest moments last 48 hours. Sign in to keep yours."
- **Logged-in (free account)**: same live session + visits/ratings archived to Postgres. History, bookmarks, flavour profile persist indefinitely. 🔒 **Every logged-in moment is `unlimited`**, web and native alike: a logged-in create ignores any `lifespan` in the body, and PROMOTION (a guest moment's first logged-in act) sets the row to `unlimited` and re-stamps every key's TTL. A Postgres-backed moment is reopenable whatever its age, so its lifespan only sizes the cache TTL; `unlimited` keeps a far-future moment's cache warm, so it stays in Upcoming (`/api/me/sessions` live/pin is Redis presence, ruled to stay). No client offers a lifespan picker; the settings PATCH `lifespan` path is vestigial. Moments created before 2026-11-09 keep their stored lifespan (no backfill).
- **Pro** (`users.pro = true`): paid tier. Gates **blind tastings** (host pre-rates while wine identities are hidden from tasters until reveal) for every caller class. Lifespan is not a pro feature any more. The blind-tasting "host bypass" — the host/cohost/provider/wine-adder see un-redacted wines while tasters see "Wine N" — can be disabled per session via the **Blind-for-everyone** toggle (`meta.blindForEveryone`, mirrored to `sessions.blindForEveryone`). When on, every viewer of every surface (live wine GET, feed, profile session-card) gates uniformly; only per-wine reveal un-redacts. NOT pro-gated on its own — only flipping a session TO blind needs pro; cohosts on a pro-blind session can flip the toggle without being pro themselves. Disabling `meta.blind` cascades to clear `blindForEveryone` so a stale flag can't resurrect on re-enable. **Also pro-gated: hiding who-brought-each-impression** (`meta.showProvenance`, default ON — a host can turn attribution OFF, which server-side nulls `addedByDisplayName`/`addedByUserId` in `wineToWire` so no VIEWER-FACING surface renders "Brought by"; moderation tools like the ban preview are a named carve-out — a host must still see whose impressions a ban deletes). Symmetric pro-gate (a change either way needs pro); a non-pro caller (host OR free cohost) sees the toggle locked at whatever the host set — which can be OFF, so the locked copy is state-aware, not a fixed "upgrade to hide". Details: `docs/dev/session-features.md`.

### Moment required fields (name + start date)

🔒 **A moment ALWAYS has a name and a start date (`dateFrom`) — enforced server-side for EVERY caller (web, native, anon), on create AND edit (Simon, 2026-07-06; reverses the earlier "dates optional" ruling).** `dateTo` stays optional. Two enforcement layers, and a new name/date-write path MUST honor them (the rename endpoint was initially missed — don't repeat):
- **`lib/sessionFields.ts`** (shared by create + settings PATCH) rejects a field that is PRESENT in the body and resolves to empty/null — a clear attempt. Gated on `body.<field> !== undefined`, so a partial PATCH that omits the field passes (unrelated edits still work).
- **`app/api/session/route.ts`** (create) adds a presence check after `applySessionFields` for the "field omitted entirely" case, before the S3 cover upload.
- **`app/api/session/[code]/name/route.ts`** (the standalone host-rename path — a 4th name-write surface) rejects an empty name directly.

Existing dateless moments (created before the rule) are grandfathered ONLY until their next settings save — which then requires a start date (the "absolute invariant" ruling). Clients guard for friendly copy but the server is the authority. **Deferred (documented):** this made `POST /api/session` a breaking contract for a future stale native binary — a release-fence item (version bump + min-version gate before first TestFlight), see `docs/dev/proposals/mobile-app/04-api-versioning.md` §6.

### Session deletion is a soft-delete (rewire phase 2)

When a host deletes a session: `sessions.deletedAt = NOW()` is set and every other column on the row is scrubbed to NULL (`code`, `host_name`, `name`, `blind`, `blind_for_everyone`, `created_at`, `archived_at`, `address`, `dateFrom`/`dateTo`, `timezone`, `description`, `link`, `host_user_id`, `cover_photo_url`, `category`). The cover photo's S3 bytes are reclaimed via the capture/commit/reclaim-after pattern in both delete paths (session DELETE + account delete). Ratings + feed_items survive untouched — their `session_id` still points at the tombstoned row, providing the grouping signal for the user's own Tastes / Posts views. Wines orphan (`session_id = NULL`) so bookmarked wines remain reachable from `/me/saved`; the wishlist tombstone label resolves via the wine's ratings, not the wine's session FK. 🔒 **Wine-photo retention (D8, ruled 2026-11-10):** a deleted moment's wine photo is reclaimed only when NO rating and no bookmark references the wine; the surviving ratings, feed posts and profile tiles still show it, and it will feed the catalog's pictures (only a moderator removes such a photo, and that must null / replace the stored URL, not only the bytes). Account deletion applies the same predicate to a moment wiped with the account, and keeps every wine photo of a moment that SURVIVES it (anonymised); the user's own uploads (solo check-in photos, profile photo, cover) leave with them. Any new path that reclaims a wine photo applies this predicate. Lifetime counters never decrement.

A Postgres trigger (`prevent_session_hard_delete`) blocks any `DELETE FROM sessions` — soft-delete is an actual DB invariant, not just an app-layer convention. Cleanup of long-tombstoned rows is a manual operator step (`DISABLE TRIGGER` for the duration of a vetted DELETE, then re-enable).

Full impl, Redis-first ordering vs Postgres scrub, trigger contract, cleanup runbook: see `docs/dev/session-deletion.md`.

## Rate limits

Production limits. Kept in root (via `@`-import) because design conversations about new endpoints often happen before any `app/api/` file is opened, and the limit policy informs the design.

@app/api/rate-limits.md

**Patterns** (referenced when adding a new limited endpoint):
- **Recovery paths** (block DELETE) are intentionally uncapped — a burst-block attack must still leave the unblock path open.
- **Shared-counter pairs** prevent attackers from getting `N+N`. Implementation: both endpoints call `checkRate` with the **same Redis key string** — no special parameter, just literally the same key. Example: PATCH + DELETE in `app/api/me/account/route.ts` both write to `rl:account:user:${userId}:1h`. Currently used for account PATCH+DELETE, mutes POST+DELETE, bans POST+DELETE.
- **`peek-then-check-on-change`** (visibility PATCH inner): `peekRate` first; only `checkRate` if the value actually changes. Prevents no-op submits from burning slots.

Limiter helpers (`peekRate`, `checkRate`, `checkRates`, `formatWait`), bot defenses on `/api/auth/register`, `/api/auth/login-precheck`: see `app/api/CLAUDE.md` and `app/api/auth/CLAUDE.md`.

## Where to find detail

**Naming convention**: user-facing copy of moderation/privacy features lives at `docs/<name>.md` (kick-ban, block, mute, profile-visibility, roles). Developer implementation docs live at `docs/dev/<name>.md`. **Native-app design** (ADRs + UI build patterns, mobile only) lives at `docs/design/` — distinct from `docs/dev/` (backend/cross-platform impl); a mobile-UI lessons doc goes in `docs/design/patterns/`, not `docs/dev/`. Grep for the wrong one will mislead — pointer indices below always reference the dev version.

### Area CLAUDE.md (lazy-loaded when Claude touches that subtree)

- `app/CLAUDE.md` — Next.js App Router routes, state management, fetch helpers, bootstrap URL params
- `app/api/CLAUDE.md` — authorization patterns, tier resolution, header conventions, rate-limit usage, anon rename
- `app/api/auth/CLAUDE.md` — register honeypot + signed-token bot defenses, login-precheck, NextAuth + anon-token mechanisms
- `components/CLAUDE.md` — shared visual primitives catalog (color tokens, StarRating, ScoreSlider, ConfirmDeleteButton, Modal, FlavorChips, Avatar, …) — use `var(--bg2)` etc., never raw hex
- `components/wine/CLAUDE.md` — wine modal: load-bearing pull-to-swap CSS (`touch-action: pan-y`, `overscroll-behavior: contain`, `overflow-y: auto`), `svh` sheet sizing, horizontal-drag pattern, slide-animation gotchas
- `lib/CLAUDE.md` — Redis key namespace, `KEEPTTL` semantics, SCAN helpers, `resolveIdentity` + `participantOrBanned` resolvers, rate-limit helper API
- `prisma/CLAUDE.md` — migration workflow, destructive-change procedure, schema check, schema notes for future features
- `packages/core` (`@verre/core`) — framework-neutral domain logic shared web↔native (score validation/coercion, `formatScore`, pure session-code helpers, client-safe display-name rules, the `scrub` character set + `normalizeBio`). Platform-pure: no `node:*`/`next`/`@prisma/client`/React/DOM. Server-only carve-outs (`genCode`, `sessionPath`/`joinPath`, `validateFlavors`, `displayName.server`) stay in `lib/`. See `docs/dev/proposals/mobile-app/00-shared-logic-extraction.md`.

### Feature deep dives (`docs/dev/`)

- [Kick & ban](docs/dev/kick-ban.md) — host moderation primitive, `X-Vr-Auth: removed` bounce protocol, lock + wipe ordering
- [Block](docs/dev/block.md) — bilateral invisibility, in-session render matrix, globally-subtracted counts, mutual-block resolver
- [Mute](docs/dev/mute.md) — feed-only filter, composes with the profile-visibility tier filter
- [Profile visibility](docs/dev/profile-visibility.md) — four tiers + FoF, chokepoint API, audit log
- [Session features](docs/dev/session-features.md) — blind tasting, blind-for-everyone toggle, hide-lineup, roles, lifespan, disambiguation, enumeration-oracle posture
- [Session codes](docs/dev/session-codes.md) — Crockford alphabet, 4/8-char canonical forms, three-forms rule, collision check
- [Session deletion](docs/dev/session-deletion.md) — retention rule implementation, the soft-delete protocol inside the mutation contract (fenced wipe, `session_tombstones` registry, crash table), participant bounce
- [Redis rehydration](docs/dev/proposals/redis-rehydration.md) — **SHIPPED** (releases A + B + C): Postgres as the record, Redis as the cache — rebuild + reconciliation, the session mutation contract, the grant read, the publication generation (`s:{C}:gen`), eviction belts, the `ratings_session_rater_known` CHECK (`prisma/session-record-checks.json` gate); the operator script `scripts/rehydrate-sessions.mts` (warm-up / verification, dry run by default — `docs/dev/deployment.md`).
- [Moments-home routing](docs/dev/moments-home.md) — the mobile Moments tab's `status` (lists) / `pinned` (carousel) / `carouselLabel` (chip) model, the cross-product, server-authoritative label rationale
- [Account deletion](docs/dev/account-deletion.md) — Postgres transaction + Redis SCAN+decide+act loop, host tombstoning
- [Per-device sessions](docs/dev/proposals/auth-sessions.md) — `user_sessions` revocation gate (never-cache-`auth()`), Connected-devices panel, password-change + signOut revoke, revocation-reason login notices. Cross-cutting invariants in `lib/CLAUDE.md`. (Doc is the shipped proposal w/ as-built deviations noted.)
- [Native auth (Better Auth)](docs/dev/proposals/mobile-app/01-identity-and-auth.md) — **SHIPPED** (PR #39): native iOS/Android credential + session layer in-process beside NextAuth, over one `users` table. The `identityStore` dual-store chokepoint, `resolveUser` seam, `disabledPaths` clamp, two CI gates (`check-identity-writes`, `check-better-auth-config`). Dormant in prod (no native client yet). Cross-cutting invariants above + in `app/api/auth/CLAUDE.md`. (Doc is the as-built rationale-of-record.)
- [Score system](docs/dev/score-system.md) — full validation pipeline, Decimal wire-format trap
- [Social feed](docs/dev/social-feed.md) — unified `feed_items` model, follow graph, engagement trigger + auto-deletion cascade, mutual-follow tag gating, "had a sip" S3 copy flow, `<SessionFeedCard>` aggregate render with server-side blind redaction
- [Avatars](docs/dev/avatars.md) — upload pipeline, MIME allow-list + magic-byte signatures, JPEG EXIF strip, account-delete reclaim
- [Flavour charts](docs/dev/flavour-charts.md) — polar vs radar, structure intensity axes (resolveAxes/perRatingAxes; legacy FL_* descriptor sets removed in the Contract PR)
- [iOS touch gestures](docs/dev/ios-touch-gestures.md) — pull-to-swap design history (architectures tried + discarded)
- [Deployment](docs/dev/deployment.md) — Deploio env vars, deploy story
- [Wine metadata](docs/dev/wine-metadata.md) — description/region/country/vinification/purchase_url specs, `cleanUrl` http(s)-only rule
- **Legal attributions** (`lib/attributions.ts` + `/legal/attributions` + `GET /api/legal/attributions` + the native You → About screens) — 🔒 a **LICENCE OBLIGATION**, not credits: CC BY / OGL-BC / MIT each require naming the source, so shipping catalog data without this surface is a breach. It is a **hard release gate on the first catalog fill**. Attribution is **CORPUS-level, never per-record** — never attach a source id/URL to a catalog row. 🔒 `licence.text` is a **`scrub()` carve-out** (verbatim, never trimmed — `scrub`'s `.trim()` drops the MIT block's trailing newline) and the OGL-BC statement's **U+2013 EN DASH** must survive every boundary (BC's own page title uses a hyphen, so a normalise corrupts a required string). Entries are deploy config (`ATTRIBUTIONS_PATH`), validated as a **complete replacement** keyed on an immutable `id`; the native copy is a release-time fallback, so **never claim changes reach clients "immediately"** — see `docs/dev/deployment.md` § ATTRIBUTIONS_PATH for the three caches. Five CI suites guard it (`check-attributions-parity` workflow).
- [Wine catalog](docs/dev/proposals/wine-catalog.md) — producer/product/vintage identity spine. **Phase 1 (domain schema) SHIPPED** (`4bc14c5`); **phase 2 (add-flow + fuzzy search) BUILT but gated OFF** — `CATALOG_PUBLIC_ENABLED` (`lib/catalogGate.ts`) keeps catalog creation staff-only. ⚠️ The fence now opens BEFORE phase 3's review queue (ruled 2026-07-25, reversing the earlier boundary — negligible volume at current scale); entries minted meanwhile stay `provisional` and must be RECORDED as awaiting review from day one. **Next up is the [model change](docs/dev/proposals/wine-catalog-model-change.md)** — planned + review-approved, not started: per-event fields move off `wines` onto a new **occurrence** row (one encounter with one bottle, session or standalone), ratings reference the occurrence and derive catalog identity through it, bookmarks point at product + optional vintage. 🔒 It also makes a promoted session's occurrences **Postgres-authoritative** (Redis becomes a revision-stamped cache) and takes a **hard cutover** on the native bookmark endpoints. Phases 3–5 pending, see the [implementation plan](docs/dev/proposals/wine-catalog-implementation.md). 🔒 Catalog IDs are label identity — `wineToWire`/`redactWine` strip `productId`/`vintageId` from blind payloads, and `redactWine` spreads `...rest` so a new identifying field on `WineMeta` leaks BY DEFAULT unless explicitly nulled there. 🔒 An entry is created DISTINCT — combining is a deliberate, reversible merge, never an automatic find-or-create. Catalog table shapes are a VERSIONED INTERFACE (§ Catalog write ownership) — 🔒 **"shape" includes CHECK predicates**, by the rejection-surface test (a constraint is contract surface iff a payload valid under the old predicate can be rejected under the new one); a committed snapshot + CI diff (`scripts/check-catalog-contract-checks.mjs`, wired into `check-schema.yml`) fails the build on any drift, and a stricter predicate is an AVAILABILITY change (rows become non-insertable, and an import batch is all-or-nothing). Account-level staff powers live in `staff_roles`, never `users.role` (see `prisma/CLAUDE.md`); resolver + permission map in `lib/staffRole.ts`. Schema invariants Prisma can't express, the trigram query rule, and the bootstrap runbook: `prisma/CLAUDE.md`.

Planning docs for unshipped work live in [`docs/dev/proposals/`](docs/dev/proposals/) — not indexed here until they ship.
