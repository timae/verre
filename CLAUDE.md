# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local development

Setup (Redis + MinIO + bucket policy + `.env`) is documented in README.md. Day-to-day:

```bash
npm install
npx prisma generate
npm run dev                  # → http://localhost:3000
npx tsc --noEmit             # type-check
npm run lint
```

LAN testing gotcha: `S3_ENDPOINT` is stored as a literal prefix in `users.image_url`, so rows uploaded under one address won't resolve from another. Switching networks → wipe the bucket and clear `users.image_url`. Wipe command: `docker exec verre-minio rm -rf /data/verre-local && psql "$DATABASE_URL" -c "UPDATE users SET image_url = NULL"`, then recreate the bucket per README.

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

## Working with this codebase

Update this file (CLAUDE.md) whenever you:
- add an env var the app reads (Deployment section)
- introduce a shared primitive or coding rule (Shared visual primitives section)
- write a schema migration with non-obvious behaviour (Architecture / schema notes)
- change an authorization tier (Auth section)
- ship a feature with its own coherent surface — new endpoints, new tables, new architectural concept. The bar is "deserves its own section in this file" (e.g. the social feed got its own section because it added /api/feed, /api/checkins/*, /api/users/*, and a follow graph; a small route addition wouldn't).

Update README.md when:
- local dev setup or deploy story changes
- the user-facing feature scope changes meaningfully — a new flagship feature should appear in the "What it does" list and its endpoints in the API table
- the API request/response shape of an endpoint already documented there changes (the README API table includes example body shapes; keep them accurate)

Schema and migrations: enforced by `.github/workflows/check-schema.yml` — `prisma migrate diff` fails the build if `schema.prisma` and the migrations directory disagree. Don't try to bypass it; either generate the migration via `prisma migrate dev` or roll back the schema change.

Spawn a reviewer (Agent tool, `general-purpose` subagent) before pushing when the diff:
- touches authentication or authorization
- touches schema/migrations
- spans more than ~3 files or ~50 lines
- introduces a new shared primitive or refactors a cross-cutting concern

Brief the reviewer with specific concerns to look for (parameter validation, edge cases, race conditions, deploy-time risk). After the reviewer flags real issues, fix them and re-review. A reviewer pass that finds nothing is still cheap insurance — single-file doc fixes and trivial cleanups can skip it.

## Coding style

- **Guard clauses, not nested conditionals.** Validate, reject, return early at the top of a function. The happy path runs at the base indent level.

- **Compact code, no fluff.** No newlines between obviously-related statements. No comments for what well-named code already says. A 40-line function that reads top-to-bottom beats the same logic fragmented into five 8-line helpers.

- **When to extract a function:** the logic repeats in 3+ places across files; or the function no longer fits on screen; or extracting gives it a name that's clearer than the inline code. Cross-file helpers go in `lib/` under a module name that names what they do.

## Architecture

### Two-tier persistence

| Layer | Technology | Responsibility |
|---|---|---|
| Active sessions | Redis (48h TTL) | Live wine list, ratings, participants |
| Accounts & history | Nine Eco PostgreSQL | Users, archived sessions, bookmarks, Hall of Fame |
| Images | Nine Object Storage (S3-compatible) | Bottle photos stored by URL |

**Redis key namespace:**
- `s:{CODE}:meta` — JSON session metadata (host, name, blind, lifespan, hostIdentityId, hostUserId, coHostIds, providerIds, …)
- `s:{CODE}:wines` — JSON array of wines for this session
- `s:{CODE}:r:{IDENTITYID}:{WINEID}` — per-rating JSON (score, flavors, notes). Identity-id keyed (`u:<userId>` or `a:<uuid>`), never display name
- `s:{CODE}:identities` — hash of identity-id → display name (the participant list)
- `s:{CODE}:tokens` — hash of anon-token → identity-id (used by the resolver)

**TTL rule for meta and wines writes.** All writes to `s:{CODE}:meta` and `s:{CODE}:wines` after session-create MUST use `{ KEEPTTL: true }` so the session's lifespan (default 48h, pro 72h/1w/unlimited) isn't reset by routine edits. Hardcoded `{ EX: 48 * 3600 }` would silently downgrade a pro session on every role-toggle, name change, or wipe. `lib/redis.ts` also provides `scanKeys` and `hasKey` SCAN-based helpers — prefer these for new code instead of `redis.keys`, which blocks the Redis event loop.

**Postgres archival is incremental:** data flows from Redis → Postgres only when a logged-in user commits a rating (`POST /api/session/:code/rate`) or joins a session (`POST /api/session/:code/visit`). Anonymous sessions stay Redis-only for 48h then expire.

**Lifetime counter snapshots on `users`:** the rate/visit/create endpoints atomically increment monotonic counters (lifetime_ratings, five_star, sessions_joined, etc.) on `users` rows. Counters never decrement — protects badge progression from rating deletions and gives O(1) reads on the badge hot path.

### Score system

Scores are decimal `0..5` in `0.25` steps (quarter-stars). `0` means "not rated" — empty state. Anything stored is `> 0`.

**Storage.** Both `ratings.score` (in-session) and `checkins.score` (standalone) are `Decimal(3,2)` in Postgres. The same value lives transiently in Redis as a JSON number under `s:{CODE}:r:{IDENTITYID}:{WINEID}` while a session is live, then gets archived to the relational column on commit.

**Validation.** A value passes if `Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v * 4)` — the `× 4` integer check accepts dyadic fractions and rejects 0.1, 0.3, 1/3, etc. Apply this at every write boundary: `/api/session/<code>/rate`, `/api/checkins` POST, `/api/checkins/<id>` PATCH. Reject with `400` if it fails; never silently round.

**Wire format.** Prisma's runtime `Decimal` (decimal.js) serializes to a JSON **string** (`"4.25"`), not a number. Every API response that surfaces a score must coerce via `Number()` before sending — search for `score: c.score == null ? null : Number(c.score)` or equivalent at the route boundary. Forgetting this ships strings to the client where number arithmetic silently breaks (concatenation instead of addition, `>` comparisons that look right for single digits but fail at 10+).

**Display.** Always go through `<StarRating>` or `formatScore(v)` (see Shared visual primitives) — those encode the locked display rule (`★ 4.0` / `★ 4.5` / `★ 4.25`, no `/5`). Never compose `★ ${v}` inline.

**Input.** Always go through `<ScoreSlider>` for write surfaces. Don't reintroduce a 5-button row, a native `<input type="range">`, or any other control — the slider is the single source of touch + keyboard + ARIA correctness.

**Hall of Fame trigger.** A row is created when `score >= 5` on commit (the only way to hit it post-decimal is exactly `5`, since the snap caps there). The check is on the canonical numeric value, not on a string compare — relevant if you touch the rate POST handler.

### User avatars

Optional user-uploaded profile pictures, free for all users. The data column is `users.image_url` (nullable VARCHAR(512)). The S3 key shape is `avatars/u_<userId>_<timestamp>.<ext>`; the URL stored in DB is the full `${ENDPOINT}/${BUCKET}/<key>`.

**Edit endpoint.** `POST /api/me/avatar` (replace) and `DELETE /api/me/avatar` (remove). Both gated by `isSameOrigin` + cookie auth + 10/h per-user rate limit. POST takes `{imageData: dataURL}` JSON; the validation pipeline in `uploadImage` enforces MIME allow-list (`image/jpeg|png|webp|gif`), magic-byte signatures (SVG is explicitly excluded — XML can carry `<script>`), and a 2MB decoded-byte cap. On replace, the prior URL is reclaimed from S3 fire-and-forget after the new upload + DB update succeed. On account-delete, `lib/accountDelete.ts` reclaims the avatar alongside check-in and wine images.

**JPEG metadata strip.** `lib/s3.ts:stripJpegMetadata` drops APP/COM segments before S3 to remove EXIF GPS. JPEG-only — iOS HEIC→JPEG conversion covers the camera path; PNG/WebP/GIF aren't stripped.

**Editor UX.** `components/profile/AvatarEditor.tsx` is a `<Modal>` with file picker → `react-easy-crop` (round mask, square aspect, 1×–4× zoom slider, drag to reposition) → canvas crop to 512×512 JPEG @ 0.85 quality → POST. The canvas re-encode incidentally strips metadata (defense-in-depth alongside the server-side strip). Remove uses `<ConfirmDeleteButton>` with `btn-del` styling. Picker accepts `image/jpeg|png|webp` only — HEIC was dropped because non-Safari browsers can't decode it for the cropper.

### Session codes

Two valid lengths coexist: **4-char** (legacy bare form, e.g. `B369`) and **8-char canonical** (hyphenated for display: `XYZW-1234`). Both draw from the **Crockford base32 alphabet** — `0-9 A-Z` minus `I L O U` (32 chars, case-insensitive, profanity-resistant by removing the U). Existing 4-char rows happen to use the hex subset (legacy `genCode`), but the validators accept any Crockford char in either length — `genCode` only emits 8-char today, and any short codes that appear later would draw from the full 32-char alphabet.

**Three forms of the same code:**
- **Canonical** — what's stored in DB rows, Redis keys, localStorage keys, React Query keys: no hyphen. e.g. `XYZW1234` or `B369`.
- **Display** — what's rendered in JSX, share-dialog text, page headers: `formatCode()` returns 4-char codes bare, 8-char hyphenated.
- **URL** — `/session/<code>` and `/join/<code>` segments: hyphenated for 8-char (`/session/XYZW-1234`), bare for 4-char (`/session/B369`).

Server entry points run `normalizeCode()` which strips hyphens and uppercases, so non-hyphenated URLs (old shared links) still resolve. Same with form input: pasting `xyzw-1234`, `XYZW1234`, or `xyzw 1234` all normalize to the same canonical key.

**Helpers in `lib/sessionCode.ts`:**
- `genCode()` — produces 8-char Crockford. Caller-side collision retry handles the rare clash.
- `normalizeCode(input): string | null` — server entry-point normalization. Strict; `I/L/O/U` reject (no lenient decode, since a typo could otherwise silently land on the wrong session).
- `validateCodeInput(input)` — discriminated `{empty | invalid-length | invalid-char}` failure for user-facing forms so the UI can show specific errors instead of generic "not found."
- `formatCode(stored)` — display rendering, accepts null/undefined (returns '' so callers can render unconditionally).
- `formatCodeInput(raw)` — live transform for the type-a-code input field. Auto-hyphens past the 4th char.
- `sessionPath(code, sub?)` and `joinPath(code)` — URL builders. **Use these everywhere a session URL is built**; raw `/session/${code}` interpolation creates display drift.

**Storage:** `sessions.code`, `session_members.session_code`, `hall_of_fame.session_code` are `VarChar(16)` (widened from `Char(4)`). No data migration was needed since hex codes are valid Crockford.

**Collision check** on `POST /api/session` queries both Redis (`s:<code>:meta`) AND Postgres (`sessions.code` unique). Both must be empty before a code is used. Postgres rows can survive Redis TTL expiry, so checking only Redis would let archived codes get re-issued and clobber the unique constraint.

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
- **Provider role**: lighter-weight role for someone bringing wines to a tasting without full host powers. Providers can add wines to the lineup and edit/delete only the wines they themselves added (matched via `wines.addedByIdentityId === provider.id`). Providers cannot change settings, rename, delete the session, reorder wines, reveal/hide blind wines, or assign/remove roles. Cannot kick/ban — moderation stays with host + cohost. Tracked as `meta.providerIds` (identity-id list, the trust anchor). **Mutually exclusive with cohost** — a participant is at most one of {host, cohost, provider, taster}. In blind tasting mode, a provider sees their own wines un-redacted while other participants' wines stay redacted (provider-bypass at the wine GET level).

**Role transition rule (locked):** any role mutation that adds OR removes the `co_host` designation requires **strict-host**. Cohosts can only drive `taster ↔ provider` transitions. This collapses promote-to and demote-from cohost into one rule and is enforced both client-side (the SetRoleButton picker hides Co-host from non-strict-host viewers) and server-side (the `set-role` action gates on the strict-host check when the transition touches cohost). The picker also omits the target's current role from the option list — selecting a user who's already a provider shows just Co-host (strict-host only) and Taster.

**Role mutation endpoint:** `PATCH /api/session/<C>` with `action: 'set-role', targetId, role: 'taster'|'co_host'|'provider'`. Mutual exclusion: setting `co_host` strips from `providerIds`; setting `provider` strips from `coHostIds`; setting `taster` strips from both. The legacy `add-cohost`, `remove-cohost`, and `transfer-host` actions were removed in the provider-role commit — host handoff is handled by account-deletion's tombstone mechanism (see "Account deletion" below), not by a user-driven action.

**Enumeration oracle posture:** the PATCH handler runs a coarse moderator gate before target resolution (non-moderators → 403 regardless of target). For strict-host-only paths (`set-role co_host`), the strict-host check ALSO runs before target resolution, so cohost callers get a uniform 403 whether the target exists or not. The residual leak: a cohost calling `set-role taster|provider` on a cohost target gets 403 (touchesCohost), while the same call on a non-existent target gets 400 (targetId required). The asymmetry tells a cohost whether `targetId u:<n>` is a cohost in this session — but cohosts already see the full `coHostIds`/`providerIds` lists via `GET /api/session/<C>`, so this isn't a privilege escalation. Accepted as a bounded leak, not closed because closing it would require a redis read inside the lock that's redundant with already-public information.
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

### Kick / ban (host moderation)

Host moderation primitive scoped per-session. Distinct from the user-level [Block](#mute-`user_mutes`) primitive — block is bilateral and lives outside sessions; kick/ban is unilateral host action on session participants.

**Schema (Redis only).** No Postgres changes for the gate itself.
- `s:<C>:bans` — Set of banned identity-ids. SISMEMBER on every `requireParticipant` + `POST /api/session/join`. Expires with the session lifespan.
- `s:<C>:kicked` — Set of kicked-but-not-banned identity-ids. Marker only — not an authorization gate; lets `/join/<C>?removed=1` identify a kicked user whose identity-hash entry was stripped, so the bounce screen can offer the right Keep/Delete prompt. Cleared on rejoin OR on `/leave?cleanup=full`.
- `s:<C>:lock:ban` — short-TTL advisory lock taken during a wipe so the wines JSON write-back doesn't race a concurrent host action.

**Schema (Postgres).** `wines.added_by_identity_id VARCHAR(64)` (nullable) — records who added each wine. Populated on wine POST from the resolved identity; preserved on edit. Existing pre-feature rows stay NULL and never match a "delete their wines" filter. Indexed on `(session_id, added_by_identity_id)`.

`wines.added_by_display_name VARCHAR(64)` (nullable) — frozen snapshot of the adder's display name at create time. Same freeze rule as `added_by_identity_id`: populated on POST from the live `s:{CODE}:identities` map, preserved verbatim on edit. Pre-feature rows are NULL. Used as a fallback by the wire-time resolver when the adder has been kicked/banned and is no longer in the live identities map.

**Wire-time resolution of `addedByDisplayName`** (in `wineToWire`, the single sanctioned transform): priority is **live identities map → `users.name` lookup (only for `u:<id>` adders) → `addedByDisplayName` snapshot → null**. The live map wins so any future per-session rename surfaces immediately. The `users.name` fallback covers kicked logged-in adders (their identities entry is gone but the user row survives). The snapshot is the last-resort fallback for kicked anon adders (no users row exists). `redactWine` strips `addedByDisplayName` to `null` in blind mode — knowing "Alice brought this one" partially identifies a wine via her known preferences.

The raw `addedByIdentityId` is stripped from the wire by `wineToWire` (privacy: prevents anon-id correlation across wines from the same adder). Only the resolved display name surfaces. Display names are already public elsewhere (identities map, ratings list), so adding them to wines doesn't expand the leak surface.

**Two-flavor removal: kick vs ban.**

- **Kick** (`mode: 'kick'`) — strip the participant from identities + cohost list, drop their `session_members.role` to `taster`. Their ratings, hall_of_fame, bookmarks, session_members row all **stay**. Add to `s:<C>:kicked` so the bounce can identify them. They can rejoin (kicked is not an authorization gate). On the bounce screen they choose Keep (no-op) or Delete (`POST /leave?cleanup=full`, runs the `kick-delete` wipe path).
- **Ban** (`mode: 'ban'`) — same strip as kick PLUS delete their ratings, hall_of_fame, bookmarks (for wines in this session), session_members row in one Postgres transaction. Add to `s:<C>:bans`. They cannot rejoin. Anon tokens are kept on ban so a logged-in user reusing their cookie is recognised on the next request and bounced; anon users who clear localStorage and rejoin with a fresh `a:<uuid>` get through (documented weakness — no anti-fingerprint or auth-required setting yet).

**Wine-orphan toggle (`deleteAddedWines`).** Applies to both kick and ban — the host owns the call regardless of mode. Wines added by the target get `session_id = NULL` (orphaned, not hard-deleted), so third-party bookmarks survive in `/me/saved`. The wine record itself stays so other tasters who rated/bookmarked it keep their references; the live session's wines JSON gets the wine filtered out so the live tasting doesn't keep showing it.

**Authorization (`POST /bans`, `DELETE /bans/:identityId`).**
- Strict host: can kick/ban anyone except self.
- Cohost: can kick/ban regular tasters and providers. Banning a cohost requires **strict host** (matches the existing cohost-role-assignment rule — banning a cohost is an implicit demotion). Providers themselves have no moderation powers — they cannot kick/ban anyone.
- Self-target: rejected 400.
- Targeting the strict host: rejected 400.

**Rate limit:** 60 actions / 10 min / caller, shared between POST `/bans` (kick or ban) and DELETE `/bans/:identityId` (unban). DELETE intentionally shares the budget (unlike block DELETE which is uncapped) — moderation is bounded both ways.

**Bounce protocol (`X-Vr-Auth: removed`).** New header distinct from `invalid`. Existing `invalid` clears local state on the client (`vr_anon_*`, `vr_name_*`, `vr_id_*`) and bounces to `/join/<C>`. The new `removed` header **preserves local state** and bounces to `/join/<C>?removed=1` so the page can identify the user via the preserved token + cookie and render the right copy (`<RemovedView>`). Both polled GETs (`/api/session/<C>`, `/wines`, `/ratings`) AND state-changing endpoints (`/rate` POST/DELETE, `/wines` POST + `/wines/<id>` PATCH/DELETE, `/wines/reorder`, `/wines/<id>/reveal`, `/wines/{reveal,hide}-all`, `/settings`, `/name`) emit `removed` for banned/kicked callers — without this, a banned user could keep writing data until their next poll. `lib/identity.ts` `participantOrBanned()` is the resolver returning `'ok' | 'banned' | 'kicked' | 'invalid'`; `authRemoved()` builds the response. **`/visit` also consults bans + kicked** so a removed user opening the session URL can't re-admit themselves via the identities-hash write that visit otherwise performs.

**Removed-bounce client behaviour.** `<RemovedView>` strips the `?removed=1` query param on mount via `window.history.replaceState` (NOT `router.replace` — that triggers a Next.js navigation which re-runs the SSR page, sees no `removed=1`, and falls through to `<JoinClient>` instead of staying on the prompt). The URL bar updates without a re-render. The "back to home" button branches on `isLoggedIn` (passed in from the SSR page): logged-in → `/me`, anon → `/`. `<JoinClient>` (the regular invite form) also catches `403 {error: 'banned'}` from manual rejoin attempts and redirects to `?removed=1` so the user lands on the full RemovedView rather than seeing a small inline "banned" message.

**Order of operations (ban wipe).**
1. `SADD bans` — smallest Redis op, idempotent. Bans-Set membership alone is the authoritative gate, so even on partial failure the user can't rejoin.
2. `SADD kicked` (for both kick variants).
3. `prisma.$transaction`: delete user's ratings + hof + bookmarks (for wines in this session) + session_members. If `deleteAddedWines`: orphan their wines.
4. Redis cleanup (idempotent): delete per-rating keys, drop from identities, strip from `coHostIds` AND `providerIds` (one read-modify-write to meta), filter wines JSON.

The full wipe runs under `s:<C>:lock:ban` (`SET NX EX 10`) so two concurrent host actions on the same session don't clobber each other's wines JSON write-back.

**API surface.**
- `GET /api/session/<C>/bans` — host or cohost. Lists banned identities.
- `POST /api/session/<C>/bans` — host or cohost. Body `{identityId, mode: 'kick'|'ban', deleteAddedWines?: boolean}`. Strict-host required when targeting a cohost.
- `DELETE /api/session/<C>/bans/:identityId` — host or cohost. Lifts the ban-Set entry; data is already gone (deleted at ban time) and not restored.
- `GET /api/session/<C>/bans/preview/:identityId` — host or cohost. Returns `{identityId, displayName, ratingCount, addedWines}` for the host-side modal.
- `GET /api/session/<C>/removed-state` — caller's own state. Returns `{state: 'banned'|'kicked'|'none', identityId?, hasRatings?}`. Used by `<RemovedView>` on the `/join/<C>?removed=1` bounce screen.
- `POST /api/session/<C>/leave?cleanup={keep|full}` — kicked-user self-service. `keep` is a no-op (default). `full` runs the `kick-delete` wipe (ratings + hof + bookmarks + session_members). Authorization: caller must be in `bans` or NOT in identities (active participants can't use this path).

**Ghost-rater UX note.** Kick-keep strips the identity from `s:<C>:identities` but leaves ratings + hof + session_members. Compare screens (which iterate over Redis rating keys) still show those ratings; the rater's display name is rendered as-is. This is a deliberate side effect of "Keep means keep" — the kicked user wanted their data preserved. If they later choose Delete (via `/leave?cleanup=full`), everything goes.

**`docs/kick-ban.md`** holds the user-facing version.

### Social feed

A separate logged-in surface around individual users — sessions are still the primary tasting context, the feed is *what someone has been drinking* outside or alongside sessions.

**Schema** (Postgres, additive — sessions/ratings/HoF unaffected):
- `follows(followerId, followingId)` — explicit social graph, composite PK, cascade on user delete. No-self-follow is enforced at both the DB level (CHECK constraint in the migration SQL — not visible in `schema.prisma`) and the route level (`/api/users/<id>/follow` rejects with 400).
- `checkins(id, userId, wineName, producer, vintage, grape, type, score, flavors, notes, imageUrl, venueName, city, country, lat, lng, isPublic, createdAt)` — standalone wine logs (no session).
- `checkin_likes(userId, checkinId)` — composite PK, cascade.
- `checkin_tags(checkinId, userId)` — composite PK; `userId` is the *tagged* user, not the author.

**Network query.** `/api/feed` resolves the caller's "network" as the union of: the caller themselves, everyone they follow, and everyone they share a session with (`session_members` self-join). The feed merges check-ins (public only) and badge unlocks (last 30 days) ordered by createdAt, paginated by cursor.

**Tags require mutual follow.** `/api/checkins` POST and PATCH both run a SQL self-join against `follows` to filter the requested `taggedUserIds` down to mutual-follows-of-the-author. Non-mutuals are silently dropped server-side — clients can request anyone, only mutuals get persisted. Edit-time re-validation means an unfollow after creation drops the tag on the next save (acceptable: if you can't tag them today, the tag shouldn't survive an edit).

**Likes are persisted.** `/api/feed` includes a `liked: boolean` per check-in, computed by a single `checkin_likes` lookup keyed by the caller. The like button reflects the server state; toggling sends POST or DELETE to `/api/checkins/<id>/like`.

**S3 reclaim on edit/delete.** Check-in images live at `wines/ci_<userId>_<keyId>.<ext>` (POST keys by timestamp, PATCH keys by check-in id, so a PATCH that replaces an image always uses a different key). PATCH and DELETE both call a local `reclaimImage` helper that issues `DeleteObjectCommand` for the previous URL — fire-and-forget, logs failures, never blocks the user response.

**"Had a sip" copy flow.** A logged-in viewer who follows the source author can clone a public check-in (`+ had a sip` button on feed cards and `/u/<id>`). Wire field is `copyFromCheckinId` — image URL is never trusted from the client; server resolves the row, rejects unless source `isPublic` + source author ≠ caller + caller→source follow exists, then S3 `CopyObjectCommand`s into a fresh key the copier owns. No refcount: each check-in owns its image bytes outright, so existing `reclaimImage` paths stay correct. The feed payload includes `viewerFollowsAuthor` per check-in to gate the button without a per-row roundtrip.

**Places search** (`/api/places`) is a thin adapter: Google Places when `GOOGLE_PLACES_API_KEY` is set, OSM Overpass + Nominatim fallback otherwise. Both upstreams parameterised via `fetchJson` helper that throws labelled errors on non-OK / non-JSON responses (so transient outages surface in logs instead of a generic SyntaxError).

**Public surface.** Profiles at `/u/<id>` are public reads; viewer's `isFollowing` flag populated when authed. `/api/users/search` is anonymous prefix lookup for follow/tag discovery — never participates in authorization (see the Auth section's display-name rule).

### Auth

Two trust anchors:
- **Logged-in users** carry a NextAuth session cookie (`__Secure-authjs.session-token`, JWE-encrypted, 30 day lifetime). Resolved server-side via `auth()`.
- **Anonymous users** carry a per-session anon token (`crypto.randomUUID()`, stored in browser `localStorage` as `vr_anon_<CODE>`). Sent on every request as the `x-vr-anon-token` header. Maps to `s:{CODE}:tokens` → identity id.

The `lib/identity.ts` `resolveIdentity(code, req, session)` returns `{id, displayName, kind}` from one of those sources, or `null` for unauthenticated callers. Identity is never read from the request body.

**Identity ids:** `u:<userId>` for logged-in users, `a:<uuid>` for anonymous. These ids are the trust anchor everywhere — Redis rating keys, host checks, cohost lists, all id-keyed.

**Display names are presentation-only.** What a user types as their name (or what `users.name` holds for logged-in accounts) is user-chosen, mutable, non-unique within a session (collisions get an emoji suffix), and carries **zero** trust. It must never be used for identification, authentication, authorization, matching, or lookup. There is no concept of a "username" in this codebase — if a request, ticket, or PR talks about matching on username/name, translate it to identity id and push back on the framing. Fields like `meta.host`, `ratings.rater_name`, and the values (not keys) of `s:{CODE}:identities` are display strings: store them, render them, but never branch on them. All authorization checks resolve through `resolveIdentity` → `{id, kind}` and compare on `id`.

**URL query parameters are presentation-only too.** Bootstrap params like `?name=`, `?id=`, `?host=1` exist solely to seed the client UI on first render after a redirect from create/join. They must be captured synchronously into `useState` initializers (so the first render has the value) and stripped from the URL via `router.replace` in a mount effect — see `SessionShell.tsx`. Never branch authorization on a URL param; never leave one in the URL where copy-paste turns it into a confused-UI bug for the recipient. Server trust still flows only through the NextAuth cookie or the `x-vr-anon-token` header.

**Authorization patterns:**
- Session reads (`GET /api/session/:code`, `/wines`, `/ratings`) require participant: `requireParticipant()` rejects with 401 + `X-Vr-Auth: invalid` if the caller isn't a registered participant in this session's identities map.
- Session existence is checked first; nonexistent/deleted sessions return 404 (no auth header) so the client can distinguish "session is gone, go home" from "your token is bad, retry join."
- Host actions (wine CRUD, settings, reveal/hide, name) check `isHostByIdentity(meta, identity)`, which matches `meta.hostIdentityId` first, then `meta.hostUserId` (logged-in fallback), then any entry in `meta.coHostIds`. Pure id-based; no display-name fallback.
- Strict-host actions (cohost role assignment, session delete) bypass the cohost check — only the actual session host can perform them.

**Permission-denied vs auth-invalid:** the server returns 401 + `X-Vr-Auth: invalid` only when identity itself failed to resolve. Permission-denied 403s ("only the host can…", "pro required") return bare 403 without the header. The `lib/sessionFetch.ts` client-side wrapper only clears local state and bounces to `/join/<code>` on the auth-invalid header — permission denials are surfaced inline.

### Profile visibility

Per-user setting controlling who can read profile content (`/u/<id>` page, `/api/users/<id>` and sub-routes, feed entries authored by this user, check-in like POSTs). Stored on `users` as two columns:

- `profile_visibility VARCHAR(32)` — one of `public-internet` / `public-users` / `public-followers` / `public-mutual`. CHECK constraint hand-added in the migration; **the TypeScript union in `lib/profileVisibility.ts` is the authoritative source of truth**, the CHECK is belt-and-suspenders.
- `visibility_fof BOOLEAN` — when true, friend-of-follower (depth 1: viewer→intermediary→profile) is also admitted. Only meaningful for `public-followers` and `public-mutual`; `public-internet` and `public-users` already admit anyone qualifying via FoF.

**Tier semantics (locked):**
- `public-internet` — anyone, no auth required. Profile + check-ins indexable by search engines.
- `public-users` — any logged-in Verre user. **Default for new signups.**
- `public-followers` — only people who follow the profile owner (asymmetric: owner doesn't have to follow back).
- `public-mutual` — only mutual follows (both directions of `follows`).

**Default migration (existing users):** the privacy-tiers migration `UPDATE`s pre-existing rows to `public-internet` to preserve their de-facto state, and only NEW rows hit the column default `public-users`. Don't change this without surfacing the retroactive-tightening question to the user — silent default changes break shared profile URLs.

**Authorization chokepoints — never bypass:**
- `lib/profileVisibility.ts` `resolveProfileViewer(profileId, viewerId)` — single-profile gate. Returns `{status:'gone'}` when the profile shouldn't be observable; map to 404 (not 403, not 401) so the caller can't distinguish "no such user" from "exists but tier denies you" — that's the leak prevention.
- `viewerCanSeeAuthor(viewerId, authorId)` — per-pair gate for non-feed call sites (single check-in, like POST, etc.).
- `batchLoadVisibilities(ids)` + `resolveProfileViewerBulk(ids, viewerId)` + `viewerFofAuthorSet(viewerId, ids)` — batch path used by feed and search to avoid N+1 lookups.
- `setProfileVisibility(userId, tier, fof)` — the only sanctioned write path. Validates the union, enforces a 30/hour/user rate limit, writes user row + `profile_visibility_log` audit row in one transaction. Bypassing this and writing the column directly skips the audit trail.

**HoF stays public regardless of tier (deliberate decision):** `/hof` displays rater display names with no clickable user link; the leaderboard is treated as a deliberately public surface. This means a `public-mutual` user with a 5★ rating still has their name visible on `/hof`. If product later wants HoF to honour the tier, that's a localized change — see `app/hof/page.tsx`. The leak is documented and accepted, not an oversight.

**Session compare views are NOT gated by profile visibility.** Trust model: session participation > profile tier. If you joined a session together, you see each other's ratings and display names — `profile_visibility` only governs *outside-session* surfaces. Don't try to gate session ratings by profile_visibility; you'll break the compare screen.

**Tag display follows the check-in author's tier**, not the tagged user's. A user tagged in someone else's check-in appears according to that check-in's visibility — being tagged is a presentation surface the tagged user consented to via mutual-follow at creation time. Edit-time mutual-follow re-validation already drops a tag if the relationship has been broken since.

**Audit log (`profile_visibility_log`):** internal-only, no API surface, no UI. One row per change (tier or fof), plus an initial signup row with `from_tier=NULL` for forensic completeness. Cascade rule is `ON DELETE SET NULL` — the trail survives account deletion (tombstone pattern) so post-mortem queries can still reconstruct timelines for deleted users.

### Mute (`user_mutes`)

Per-pair soft-hide: A mutes B → A no longer sees B's content in A's feed. B is unaware. Independent of follow state, profile visibility, search, direct profile reads, likes, tags, and sessions — feed-only filter.

- `user_mutes(muter_id, muted_id, created_at)`, composite PK, CHECK forbidding self-mute, FK CASCADE both sides. No data on the row beyond the edge itself.
- `lib/userMute.ts` is the single sanctioned write path. `setMute` is rate-limited 60/h/user (shared POST + DELETE). FK violation on a non-existent target is swallowed to return uniform success — closes the user-id enumeration oracle.
- `/api/feed` Promise.all-batches `mutedUserIds(viewerId)` alongside the visibility check; the mute set is subtracted from `allowedNetworkIds` before the cursor query. Mute composes with the visibility tier filter — both must pass.
- `viewerMutes` flag is surfaced in `/api/users/[id]` full payload + the SSR `/u/[id]` render. Only meaningful on the non-shell / non-blocked view. The mute toggle in the UI lives behind the 3-dot menu on `ProfileHeader` (alongside Block).
- TanStack Query invalidation on toggle: `['user-profile', userId]` (refresh viewerMutes flag), `['feed']` (refresh feed filter). Wired in `UserProfileModal` / `ProfilePreviewInline` / the `ProfileActionsMenu` consumer chain.

### Profile blocking (`user_blocks`)

Per-pair invisibility: stronger than mute. Outside sessions, bidirectional invisibility — A blocks B → they vanish from each other's feed, search, profile reads, follower/following lists and counts, likes, tags, "had a sip" flow. Inside shared sessions, block goes render-only (locked design — block is a UI primitive, not a secrecy mechanism inside a shared tasting).

**Schema.** `user_blocks(blocker_id, blocked_id, created_at)`, composite PK, CHECK forbidding self-block, FK ON DELETE CASCADE both sides, index on `blocked_id` for reverse cascade. **Non-destructive**: blocking does NOT delete follows, mutes, likes, or tags between the pair. Unblock restores visibility everywhere.

**Authorization chokepoints (`lib/userBlock.ts`):**
- `anyBlockBetween(a, b)` — OR'd both directions. Fast-path primitive used by `viewerCanSeeAuthor` to short-circuit visibility resolution.
- `viewerBlocksAuthor` / `authorBlocksViewer` — directional checks for shaping the gate result (`blocked-by-me` for the blocker, `gone` for the blocked).
- `blockPairIds(userId)` — `{ blockedByMe, blockingMe }` Sets, capped at 1000 per direction. Hot-path filter set for feed, search, in-session participant matrix.
- `setBlock(blockerId, blockedId, mute)` — single sanctioned write path. POST rate-limited 30/h/user; DELETE intentionally uncapped (recovery from a stolen-cookie burst must always work). FK violation swallowed.

**Resolver tri/quad-state.** `resolveProfileViewer` now returns `'ok' | 'shell' | 'blocked-by-me' | 'gone'`. The block check runs **before** the visibility tier — block is the strictest primitive. `authorBlocksViewer` collapses to `'gone'` so the blocked viewer can't distinguish "I was blocked" from "user doesn't exist." Sub-routes (`/followers`, `/following`, `/badges`) gate on `status === 'ok'` so any non-ok state → 404.

**Mutual-block resolver behaviour.** When A and B have blocked each other, both directions of the check fire and `authorBlocksViewer` is evaluated first in the route, so **both sides resolve to `'gone'` (404)** — neither party gets the `'blocked-by-me'` stripped view on `/u/<id>`. Locked intent: mutual block treats the other as "anon-equivalent" everywhere, including profile reads, mirroring the in-session participants matrix where mutual rows render anon-style with no `[blocked]` marker on either side. The blocker reaches unblock via **Settings → Blocked users**, which is always available regardless of resolver state.

**Counts are globally subtracted, not per-viewer.** Locked design ("Instagram-style"):
- Like counts: a like by user X on a check-in by author Y is invisible to ALL viewers once a block exists between X and Y. Implemented via a batched `COUNT(DISTINCT cl.user_id)` SQL query that handles mutual A↔B blocks correctly.
- Follower / following counts: same — block-pair edges drop from the count shown to every viewer.
- Tag rendering: block-pair tags hidden from everyone (feed uses an `authorId:tagUserId` lookup set; profileLoad uses an owner-anchored set).

The single underlying rule: counts and renders depend on the **author** (or check-in owner), not the viewer. A SET-based deduplication in `lib/profileLoad.ts` prevents mutual-block from double-counting.

**Inside-session rules (render-only).** Locked matrix in the participants list (`SessionPanel`) — no row is ever hidden:
- Third party → both shown normally.
- Blocker viewing blocked (any tier: host, cohost, non-host) → `[blocked] {name}` + role badge, clickable to open `ProfilePreviewInline` with inline unblock.
- Blocked viewing blocker (any tier) → anon-style: plain name + role badge if any, no bold, no avatar, no link.
- Mutual block (A blocks B and B blocks A) → anon-style with **no `[blocked]` prefix** on either side. Both sides treat the other as an anon participant; unblock is reachable from the other user's `/u/<id>` page or settings → Blocked users. The prefix is suppressed because surfacing it on mutual would signal "this identifiable person blocked you back."
- Cohost role-toggle (`make co-host` / `remove role`) stays available to the host on block-pair rows. Block is a UI primitive, not a moderation one — kick/ban is the separate moderation primitive (see Kick/ban section).

Compare screen does **not** filter block-pair raters. Filtering by absence would itself be a leak — the blocked side would see the blocker's column missing and infer the block. Every rater appears under their plain display name; Compare has no profile-link or avatar surfaces, so there's nothing to strip beyond the participants-list treatment that already governs identity tells outside this view.

**Wine modal "Brought by" callout** (`WineInfoPane` inside `WineModal`) follows the participants-list matrix with two divergences:
- **No `[blocked]` prefix.** That marker stays exclusive to the participants list. Here, block state surfaces only through the lack of clickability + the plain (not bold/accent) name styling. Unblock is still reachable via the user's `/u/<id>` page or Settings → Blocked users.
- **Avatar always renders** (initial letter), including for anon-style modes (mutual block, being-blocked-by-adder). Since anon participants in this surface render WITH an avatar, dropping the avatar for a blocked user would itself leak the block — the absence is the tell. So the blocked side renders visually identical to a regular anon participant: avatar + plain name + no link. Same rule will eventually need to land in SessionPanel once anon participants there gain avatars; until then docs/block.md's "no avatar" line is participants-list-specific.

Click rules unchanged: clickable + blocked-by-me modes open `ProfilePreviewInline` inline below the callout. Anon-style + plain modes have no click. Anon viewers can't click any mode.

`/api/session/[code]` GET adds `viewerBlocksOut` + `viewerBlocksIn` arrays (identity-ids, scoped to in-session participants only — never the viewer's full block list). Anon viewers get empty arrays. Response has `Cache-Control: private, no-store` since it varies by viewer.

**Follow endpoint scenarios:** 12a (blocker→blocked) returns explicit 400; 12b (blocked→blocker) returns uniform 200 silent no-op so the blocked side can't infer the block via response code. Both checks run in `Promise.all`.

**SECURITY: don't log `viewerBlocksOut`/`viewerBlocksIn`.** These arrays carry the viewer's block-pair list scoped to a session. They must not be mirrored to analytics, stored in shared cache, or persisted outside the response.

**Out of scope (separate primitive):** kick / ban — see the "Kick / ban (host moderation)" section above. Different intent, different scope. The two never interact.

### Rate limiting

Redis-backed limiters via `lib/rateLimit.ts`. Use `peekRate` / `peekRates` to check without incrementing (login does this so successful logins don't count); `checkRate` / `checkRates` to check + increment atomically. `formatWait(seconds)` produces the humanized "in 3 minutes" / "in 45 seconds" string surfaced in 429 responses.

Limits in production:

| Endpoint | Limit | Why |
|---|---|---|
| Login (NextAuth `authorize()`) | 10 fails/min/email + 20 fails/hour/email + 100 fails/10min/IP | Brute-force on stolen email knowledge. Counters increment on bcrypt failure only. |
| `/api/auth/register` | 100/min/IP | Mass-signup spam. |
| `/api/me/account` PATCH + DELETE | 20/hour/user (shared counter) | Brute-force the password re-auth check from a stolen session cookie. PATCH and DELETE share the counter so an attacker doesn't get 20+20. |
| `/api/me/avatar` POST + DELETE | 10/hour/user | Storage abuse from a stolen session cookie — bounded by 10 uploads/hour, each replacing the prior. |
| `/api/me/visibility` GET + PATCH | 60/min/user (route-level, distinct counters for GET and PATCH) | Read-side noise + general burst protection. |
| `/api/me/visibility` PATCH (inner) | 30/hour/user, increments only on actual change | Stolen cookie thrashing the audit log + flipping visibility. Enforced inside `setProfileVisibility` via peek-then-checkRate-on-change so no-op submits don't burn slots. |
| `/api/me/mutes/:id` POST + DELETE | 60/hour/user (shared) | Stolen cookie thrashing the table or generating noise. |
| `/api/me/blocks/:id` POST | 30/hour/user | Stolen cookie burst-blocking. |
| `/api/me/blocks/:id` DELETE | uncapped | Recovery path must remain open against a burst-block attack. |
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

**Cascade vs. tombstone — the rule.** Two distinct deletion behaviors, picked per data type:

- **Tombstone** (UPDATE → `[deleted]`, FK set to NULL) — used when *other users' data references it*. Applied to `ratings`, `hall_of_fame`, hosted `sessions.host_user_id`, and the in-Redis identity map. Reason: deleting one user shouldn't break other tasters' compare views or HoF leaderboard.
- **Cascade hard-delete** (FK `onDelete: Cascade`) — used when the data is purely the user's own with no other-user references that need preserving. Applied to `checkins`, `checkin_likes`, `checkin_tags`, `follows`, `bookmarks`, `user_badges`, `session_members`. Postgres handles these atomically inside the same transaction.

When adding a new table tied to users, decide which side it falls on. The test: does another user's view (own history, compare screen, leaderboard, ongoing session they're in) reference this row in a way where deletion would leave their experience broken or nonsensical? Yes → tombstone. No → cascade.

**S3 image reclaim is independent of cascade.** Postgres cascade-deleting a row does NOT trigger S3 cleanup — the bytes stay in the bucket forever unless the deletion path explicitly fires `reclaimImage()`. Any new table that stores an `imageUrl` field needs explicit reclaim added to its deletion paths (account-delete, session-delete, edit-replace). See `lib/accountDelete.ts` and `app/api/session/[code]/route.ts` for examples.

### API surface

The full endpoint list lives in README.md. Authorization tier vocabulary used here and in route code:

- **strict host** — the original session host, not co-hosts. Reserved for cohost role assignment (any transition touching `co_host`), session deletion, and banning a cohost.
- **host** — passes `isHostByIdentity`: original host OR any cohost in `meta.coHostIds`. Cohosts share host powers for wines, settings, reveals, reorders, kick/ban of regular participants.
- **provider** — passes `isProviderById`: identity is in `meta.providerIds`. Can add wines; can edit/delete only wines they added (matched via `wines.addedByIdentityId`). No other host powers. Mutually exclusive with cohost.
- **participant** — passes `requireParticipant`: registered in this session's identities map.
- **identity required** — request must produce non-null `resolveIdentity` (cookie or valid anon-token). Stale/wrong token returns 401 + `X-Vr-Auth: invalid`; session-existence endpoints distinguish 404 (gone) from 401 (token bad).
- **cookie** — NextAuth session cookie. Logged-in users only.

### Frontend structure

Next.js 15 App Router. UI lives under `app/` (route segments) and `components/`.

Top-level routes:
- `/` — lobby (`app/(public)/page.tsx` → `LobbyClient`)
- `/login`, `/register` — NextAuth credentials flows
- `/me` and subpaths — logged-in dashboard, history, saved, profile, badges, account, feed
- `/session/<code>` — in-session shell (`SessionShell` provides context). Redirects to `/wines`.
- `/session/<code>/wines` — the sole wine-list surface. Tapping a row opens the wine modal on the Wine Info pane; the inline "Rate" button on unrated rows (or the score chip on rated rows) opens the modal on the Rate pane. Host-tier affordances render inline. Modal navigation between wines uses pull-to-swap / prev-next buttons / arrow keys.
- `/session/<code>/compare` — overlay/per-rater comparison view
- `/join/<code>` — invite landing page (anon name entry, or one-tap join for logged-in users; renders "session not found" for invalid codes)
- `/u/<id>` — public user profile + recent check-ins
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
- **`<FlavorChips>`** (`components/rate/FlavorChips.tsx`) — canonical input surface for setting flavour intensity (none → intense, 0–5). Used in WineModal's Rate pane and CheckinModal. Tap-or-drag pill chips with a separate × clear button per row; the `INTENSITY` label array is shared with `<IntensityHelp>` (`components/rate/IntensityHelp.tsx`), the (i)-popover that explains the scale, so chip captions and help text can't drift.
- **`<StarRating>`** (`components/ui/StarRating.tsx`) + **`formatScore`** (`lib/formatScore.ts`) — canonical *read-side* score rendering. The component renders `★ <num>` in two size tiers (`compact` / `detail`); `formatScore(v)` is the same logic exported for non-component call sites (compare-page chips, history sublist rows where the full primitive would dominate the surrounding row). Use one of these on every surface that displays a score — never re-implement `★ ${v}` inline. Display rule (locked): single star + number, no `/5` denominator; whole numbers show `.0` (`4.0`), half-steps trim trailing zero (`4.5`), quarters keep both decimals (`4.25`); empty state (null/undefined/0/NaN) renders nothing.
- **`<ScoreSlider>`** (`components/ui/ScoreSlider.tsx`) — canonical *write-side* score input. Touch-and-drag slider (0..5, snaps to 0.25), tabular-nums + `.toFixed(2)` for stable digits during drag, full keyboard support via `role="slider"` + arrow/Page/Home/End handlers. Used in WineModal's Rate pane and CheckinModal. Replaces the old 5-button score row; if a third score-entry surface appears, route it through this primitive too.
- **`<Avatar>`** (`components/profile/Avatar.tsx`) — canonical user-avatar circle. Renders `<img>` when `imageUrl` is set, falls back to the user's initial letter on an accent-tinted background. Single `size` prop (pixels). Use this everywhere a user circle appears (ProfileHeader, ProfilePreviewInline, CheckinCard author byline, ProfilePanelPeople rows, AvatarEditor empty state). Two thin client wrappers add behavior: `<EditableAvatar>` (own avatar — tap opens AvatarEditor with optimistic UI + TanStack invalidation on save), `<ZoomableAvatar>` (other users — tap opens the full-screen lightbox).

Pending extractions that are on the follow-up list (extract them when you next touch the relevant area):

- `<WineIdentityFields>` — sibling for create/edit forms (CheckinModal, AddWineModal). Same canonical field order as `<WineIdentity>`.

**Modals use the shared `<Modal>` primitive.** `components/ui/Modal.tsx` handles `createPortal(children, document.body)` (so the overlay is never trapped in a parent stacking context — important because `.panel` uses `backdrop-filter` which creates a containing block for fixed descendants), backdrop click-to-close, Escape-key-to-close, and the standard sheet styling. New modal/overlay components should use it rather than re-rolling `position: fixed; inset: 0; …` boilerplate. `ImageLightbox` is the deliberate exception — it has unique styling needs (z-index 9999 to float over everything, full-black backdrop, center-aligned close button) and stays standalone.

The shared `<Modal>` also handles **iOS body scroll lock** while open (overflow:hidden + position:fixed + overscroll-behavior:contain on body). Nested modals don't double-lock; only the first one in the stack mutates body styles, and the last one out restores. Modal stack depth is exposed via `getModalStackDepth()` for callers that need to gate window-level handlers on "am I the topmost modal."

### iOS touch gestures inside modals

Pull-to-swap on the wine modal (drag past top/bottom scroll boundary → load previous/next wine) is built on a narrow set of iOS Safari requirements. Each is load-bearing and was learned the hard way during the wine-rate-split iteration.

- **Hook**: `lib/usePullToSwap.ts`. Touch-only. Dev-mode runtime check asserts the container has `touch-action: pan-y`, `overscroll-behavior: contain`, and `overflow-y: auto/scroll`.
- **Container CSS** (in the caller, e.g. `WineModal.tsx`'s scrollRef): all three properties above are required. `touch-action: pan-y` permanent (native iOS scroll handles momentum); pull engages via `preventDefault()` inside touchmove with `passive:false` on the first qualifying move ≥2px past the boundary, while `e.cancelable` is still `true`. Letting that engagement window slip (waiting for 4px+, or starting the gesture mid-content and crossing the boundary later) breaks the gesture because iOS commits to native scroll and `cancelable` flips to `false`.
- **Modal sheet sizing**: `svh` units, not `vh` — iOS Safari's URL-bar collapse changes `vh` mid-gesture, which jumps scrollTop and kills momentum. The Modal sheet uses `display:flex column` when both `minHeight` and `maxHeight` are set, so the inner column with `flex:1` claims a definite height.
- **scrollTop reset**: required on `activeWineId` change in the consuming modal (`WineModal.tsx`). Otherwise the new wine renders with the previous wine's scrollTop, often past the new content height.
- **Horizontal-drag controls inside the scroll container** (score slider, flavor bars): use horizontal-intent detection (defer `setPointerCapture` until the first move resolves direction via `|dx|>|dy|`). Do NOT use `touch-action: none` — it would block vertical scroll. Pattern from `components/rate/FlavorChips.tsx` on main; reused in `components/wine/RatingPane.tsx`.
- **Textarea inside scroll container**: do NOT bail in `onTouchStart` on `<textarea>` targets. The first-move preventDefault wins the race against iOS's text-selection classification, so pull-from-textarea works. Focused textareas (user typing) keep native text behavior because they're not typically at a scroll boundary.

**See `components/wine/CLAUDE.md` for the quick edit-time rules and `docs/dev/ios-touch-gestures.md` for the full history (architectures tried + discarded, why each failed).**

### Flavour chart system

Two chart types coexist:
- **Polar chart** (`drawPolarChart(id, flavors, sz, fl)`) — arc segments per dimension. Used for single-wine detail, compare cards, and user profile. Takes an optional `fl` array; if omitted, `detectFL(flavors)` infers the right one from stored key names.
- **Radar** (`drawRadar(...)`) — polygon overlay. Used only for multi-wine compare overlays where shapes need to be compared visually.

Flavour dimensions are **type-specific**:
- `FL_RED`: dark_fruit, red_fruit, earth, spice, oak, tannin, body, acid, herbal, floral
- `FL_WHITE`: citrus, tropical, stone, floral, herbal, mineral, oak, body, acid, sweet
- `FL_SPARK`: floral_herb, citrus, tree_fruit, red_fruit, dried_fruit, earth, creamy, oak, nutty, acid
- `FL_ROSE`: red_fruit, citrus, floral, stone, herbal, mineral, body, acid, sweet, tropical
- Legacy `FL` (generic 10 keys): used for old ratings and profile aggregation

`detectFL(flavors)` identifies which array applies by checking key names. Existing ratings always keep their stored keys — switching wine type never migrates old flavor data.

### Deployment (Deploio / Nine)

- Hosted on Deploio, deployed from `main` on push (Dockerfile build).
- Postgres + Redis + S3-compatible Object Storage all on Nine. Specific app names, project IDs, hostnames, and live URLs are intentionally not in this file — see the Deploio dashboard.
- Env vars set on Deploio (values not stored in repo):
  - `REDIS_URL`, `DATABASE_URL` — service connections.
  - `AUTH_SECRET` — NextAuth + register-token HMAC. (`NEXTAUTH_SECRET` / `JWT_SECRET` accepted as fallback names by `auth.ts` and `lib/registerToken.ts`.)
  - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` — Object Storage.
  - `SERVER_ACTIONS_ALLOWED_ORIGINS` — comma-separated extra origins for Server Actions CSRF (deployed hostname; `localhost:8080` always allowed; no scheme).
  - `PUBLIC_HOSTNAME` — used as contact info in the Nominatim User-Agent header when `GOOGLE_PLACES_API_KEY` is unset; falls back to `'self-hosted'`.
  - `GOOGLE_PLACES_API_KEY` (optional) — when set, `/api/places` uses Google Places; when unset, falls back to OSM Overpass + Nominatim.
  - `NEXT_TELEMETRY_DISABLED=1` — opts out of Next.js anonymous build/usage telemetry.

### Schema notes for future features

These columns exist in the schema but are not yet wired to UI:
- `wines.purchase_url` — vendor/pro feature: link to purchase
- `users.role = 'vendor'` — paid tier hook (the `pro` boolean is wired)
- `wines.category` — extensible drink type beyond wine (beer, spirit, kombucha)
