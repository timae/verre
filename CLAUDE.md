# CLAUDE.md

Guidance for working in the Verre codebase. **Verre** is a wine-tasting web app with two surfaces:

- **Sessions** — people scan into a tasting via short code, rate wines on stars + flavour radar + notes, see each other's ratings in real time. Anonymous join supported.
- **Social feed** (logged-in) — post standalone check-ins of bottles you've had, follow other users, see what friends are drinking. Public profiles at `/u/<id>`.

Logged-in users also get persistent history, bookmarks, Hall of Fame entries, badges + XP, and a flavour profile.

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

### Local development

Setup (Redis + MinIO + bucket policy + `.env`) is documented in README.md. Day-to-day:

```bash
npm install
npx prisma generate
npm run dev                  # → http://localhost:3000
npx tsc --noEmit             # type-check
npm run lint
```

**LAN testing gotcha**: `S3_ENDPOINT` is stored as a literal prefix in `users.image_url`, so rows uploaded under one address won't resolve from another. Switching networks → wipe the bucket and clear `users.image_url`: `docker exec verre-minio rm -rf /data/verre-local && psql "$DATABASE_URL" -c "UPDATE users SET image_url = NULL"`, then recreate the bucket per README.

Schema migration workflow (`prisma migrate dev`, destructive-change rule, deploy semantics): see `prisma/CLAUDE.md`.

### Working with this codebase

**Where new content goes** — destination-routing rule. Re-read before adding any new section; this is what keeps root tight as the codebase grows.

- **Cross-cutting invariant** (rule that can be hit without touching its canonical subtree — e.g. trust model, score coercion, cascade-vs-tombstone) → root (this file).
- **Area-scoped guidance** (rule tied to a directory) → nearest `<area>/CLAUDE.md`. Create one if missing. Loads lazily when Claude touches that subtree.
- **Self-contained feature deep-dive** → `docs/dev/<feature>.md`. The bar is "deserves its own section" — e.g. the social feed earned its own doc because it added `/api/feed` + `/api/checkins/*` + `/api/users/*` + a follow graph. A single new route doesn't. Add a 1-line pointer to the index below.
- **env var added/changed** → `docs/dev/deployment.md` (and README.md if the local dev story changes).
- **User-facing feature scope changes** → README.md (`What it does` list + API table).
- **API request/response shape changes for a route already documented in README** → update the README API table (example body shapes must stay accurate).

**Worked examples** (when the rule feels abstract):
- Added a new `MAX_UPLOAD_BYTES` env var → `docs/dev/deployment.md` + README env section. Not root.
- Discovered the Prisma `Decimal` → JSON-string trap → root (cross-cutting invariant). Already there.
- Added a `/api/me/preferences` endpoint with no schema impact → README API table only; no new doc.
- Shipped a notifications surface (new tables + endpoints + UI + delivery worker) → new `docs/dev/<feature>.md` + 1-line root pointer + any cross-cutting auth/rate rules to root.

**Tie-breaker when a rule fits two destinations**: put the invariant in root and the implementation in the area file; cross-link both ways. Don't restate the invariant in the area file.

**Soft cap — 250 lines for this file.** When root approaches that, audit which sections quietly moved up from area files — that's the re-bloat signal. The original file hit 563 lines because the "is this cross-cutting enough?" threshold was soft; the cap makes the next drift visible.

**Reviewer rule**: spawn an Agent (`general-purpose`) before pushing when the diff touches auth/schema, spans >3 files or >50 lines, or introduces a new shared primitive. Brief with specific concerns. **Subagents only auto-load root** — when briefing on auth/security/schema, explicitly tell the reviewer to read the relevant area docs (`app/api/CLAUDE.md`, `lib/CLAUDE.md`, `docs/dev/block.md`, `docs/dev/profile-visibility.md`). After fixes, re-review — a reviewer pass that finds nothing is still cheap insurance. Single-file doc fixes can skip.

**Schema check**: `.github/workflows/check-schema.yml` runs `prisma migrate diff` and fails the build if `schema.prisma` and the migrations dir disagree. Don't bypass.

## Architecture invariants

### Two-tier persistence

| Layer | Tech | Responsibility |
|---|---|---|
| Active sessions | Redis (48h TTL) | Live wines, ratings, participants |
| Accounts & history | Postgres | Users, archived sessions, bookmarks, Hall of Fame (public leaderboard of 5★ ratings) |
| Images | S3 (Nine Object Storage) | Bottle photos, avatars |

**Postgres archival is incremental**: Redis → Postgres only when a logged-in user commits a rating or joins a session. Anonymous sessions stay Redis-only.

**Lifetime counter snapshots on `users`**: rate/visit/create endpoints atomically increment monotonic counters (lifetime_ratings, five_star, sessions_joined, etc.). Never decrement — protects badge progression and gives O(1) reads on the badge hot path.

**`KEEPTTL` is mandatory** on all writes to `s:{CODE}:meta` and `s:{CODE}:wines` after session-create. Hardcoded `{ EX: 48 * 3600 }` would silently downgrade a pro session's lifespan (72h / 1w / unlimited) on every role-toggle, rename, or wipe. Easy to violate from `app/api/session/[code]/route.ts`.

Redis key namespace, SCAN helpers (`scanKeys`, `hasKey`, preferred over `redis.keys` which blocks the event loop): see `lib/CLAUDE.md`.

### Score system

Scores are decimal `0..5` in `0.25` steps. `0` means "not rated".

- **Validation** (at every write boundary): `Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v * 4)`. The `* 4` integer check accepts dyadic fractions and rejects 0.1, 0.3, 1/3. Reject 400 if it fails.
- **Wire-format trap**: Prisma's `Decimal` serializes to a JSON **string** (`"4.25"`), not a number. Every API response that surfaces a score must coerce via `Number()` before sending. Forgetting this ships strings where number arithmetic silently breaks.
- **Read**: `<StarRating>` or `formatScore(v)`. **Write**: `<ScoreSlider>`. Never inline `★ ${v}` or roll your own input.

Full pipeline (HoF trigger, flavour integration): see `docs/dev/score-system.md`.

### Trust model

- **Identity ids are the only trust anchor**: `u:<userId>` for logged-in, `a:<uuid>` for anonymous. Resolved via `lib/identity.ts` `resolveIdentity(code, req, session)`. Never read identity from a request body.
- **Display names are presentation-only**: user-chosen, mutable, non-unique within a session (collisions get an emoji suffix). Carry **zero** trust. Never used for identification, authentication, authorization, matching, or lookup. There is no concept of "username" in this codebase — if a ticket or PR talks about matching on username/name, push back and translate to identity id. Fields like `meta.host`, `ratings.rater_name`, and the values (not keys) of `s:{CODE}:identities` are display strings: store them, render them, never branch on them.
- **URL query parameters are presentation-only too**: `?name=`, `?id=`, `?host=1` exist solely to seed client UI on first render after a redirect. Capture them synchronously into state and strip via `router.replace` on mount. Never branch authorization on a URL param.
- 🔒 **SECURITY: don't log `viewerBlocksOut` / `viewerBlocksIn`.** These arrays from `GET /api/session/[code]` carry the viewer's block-pair list scoped to a session. They must not be mirrored to analytics, stored in shared cache, or persisted outside the response.

Authorization patterns, header conventions (`X-Vr-Auth: invalid` vs `removed`), tier-resolution implementation: see `app/api/CLAUDE.md`.

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

- **Cascade hard-delete** (FK `onDelete: Cascade`) — data is purely the user's own with no other-user references. Examples: `checkins`, `checkin_likes`, `checkin_tags`, `follows`, `bookmarks`, `user_badges`, `session_members`.
- **Tombstone** (FK `SetNull` + `UPDATE … SET rater_name='[deleted]'` in the delete path) — another user's view references the row. Examples: `ratings`, `hall_of_fame`, `sessions.host_user_id`.

The test: does another user's view (own history, compare screen, leaderboard, ongoing session they're in) reference this row in a way where deletion would leave their experience broken? Yes → tombstone. No → cascade. **S3 image reclaim is independent of cascade**: cascade does NOT trigger S3 cleanup; any table with an `imageUrl` field needs explicit `reclaimImage()` calls in every deletion path.

Account-deletion implementation (Postgres transaction + Redis SCAN+decide+act loop): see `docs/dev/account-deletion.md`.

### Profile visibility (cross-cutting authorization)

Any route serving user-scoped content (`/api/users/<id>/*`, `/u/<id>` reads, feed entries, check-in likes/tags) MUST gate through the profile-visibility resolver — not just `resolveIdentity`. Two chokepoints in `lib/profileVisibility.ts`:

- `resolveProfileViewer(profileId, viewerId)` — single-profile gate. Returns `{status: 'ok' | 'shell' | 'blocked-by-me' | 'gone', …}` (plus `name` for `shell`/`blocked-by-me`, `viewer` for `ok`). Map `status === 'gone'` to **404** (never 403 or 401) so the caller can't distinguish "no such user" from "exists but tier denies you."
- `viewerCanSeeAuthor(viewerId, authorId)` — per-pair gate for non-feed call sites.

Bulk variants for feed / search: `batchLoadVisibilities` + `resolveProfileViewerBulk` + `viewerFofAuthorSet`. Block-pair check (`anyBlockBetween` in `lib/userBlock.ts`) runs BEFORE the tier check.

Tier semantics, audit log, HoF/compare exceptions: see `docs/dev/profile-visibility.md` and `docs/dev/block.md`.

### Freemium split

- **Anonymous / free**: session-based, Redis only, 48h lifespan. No account.
- **Logged-in (free account)**: same live session + visits/ratings archived to Postgres. History, bookmarks, Hall of Fame, flavour profile persist indefinitely.
- **Pro** (`users.pro = true`): paid tier. Gates **blind tastings** (host pre-rates while wine identities are hidden from tasters until reveal) + extended lifespan (72h / 1w / unlimited beyond the 48h default).

### Session-deletion retention rule

When a host deletes a session: for each `(user, wine)` pair, the rating row is **kept** if the user bookmarked the wine (so the bookmark detail page still renders) and **deleted** otherwise. Hall of Fame follows the same rule. Wine rows are kept with `session_id = NULL` so bookmarked wines remain reachable from `/me/saved`. Lifetime counters never decrement.

Full impl, Redis wipe, participant bounce: see `docs/dev/session-deletion.md`.

## Rate limits

Production limits. Kept in root (via `@`-import) because design conversations about new endpoints often happen before any `app/api/` file is opened, and the limit policy informs the design.

@app/api/rate-limits.md

**Patterns** (referenced when adding a new limited endpoint):
- **Recovery paths** (block DELETE) are intentionally uncapped — a burst-block attack must still leave the unblock path open.
- **Shared-counter pairs** prevent attackers from getting `N+N`. Implementation: both endpoints call `checkRate` with the **same Redis key string** — no special parameter, just literally the same key. Example: PATCH + DELETE in `app/api/me/account/route.ts` both write to `rl:account:user:${userId}:1h`. Currently used for account PATCH+DELETE, mutes POST+DELETE, bans POST+DELETE.
- **`peek-then-check-on-change`** (visibility PATCH inner): `peekRate` first; only `checkRate` if the value actually changes. Prevents no-op submits from burning slots.

Limiter helpers (`peekRate`, `checkRate`, `checkRates`, `formatWait`), bot defenses on `/api/auth/register`, `/api/auth/login-precheck`: see `app/api/CLAUDE.md` and `app/api/auth/CLAUDE.md`.

## Where to find detail

**Naming convention**: user-facing copy of moderation/privacy features lives at `docs/<name>.md` (kick-ban, block, mute, profile-visibility, roles). Developer implementation docs live at `docs/dev/<name>.md`. Grep for the wrong one will mislead — pointer indices below always reference the dev version.

### Area CLAUDE.md (lazy-loaded when Claude touches that subtree)

- `app/CLAUDE.md` — Next.js App Router routes, state management, fetch helpers, bootstrap URL params
- `app/api/CLAUDE.md` — authorization patterns, tier resolution, header conventions, rate-limit usage, anon rename
- `app/api/auth/CLAUDE.md` — register honeypot + signed-token bot defenses, login-precheck, NextAuth + anon-token mechanisms
- `components/CLAUDE.md` — shared visual primitives catalog (color tokens, StarRating, ScoreSlider, ConfirmDeleteButton, Modal, FlavorChips, Avatar, …) — use `var(--bg2)` etc., never raw hex
- `components/wine/CLAUDE.md` — wine modal: load-bearing pull-to-swap CSS (`touch-action: pan-y`, `overscroll-behavior: contain`, `overflow-y: auto`), `svh` sheet sizing, horizontal-drag pattern, slide-animation gotchas
- `lib/CLAUDE.md` — Redis key namespace, `KEEPTTL` semantics, SCAN helpers, `resolveIdentity` + `participantOrBanned` resolvers, rate-limit helper API
- `prisma/CLAUDE.md` — migration workflow, destructive-change procedure, schema check, schema notes for future features

### Feature deep dives (`docs/dev/`)

- [Kick & ban](docs/dev/kick-ban.md) — host moderation primitive, `X-Vr-Auth: removed` bounce protocol, lock + wipe ordering
- [Block](docs/dev/block.md) — bilateral invisibility, in-session render matrix, globally-subtracted counts, mutual-block resolver
- [Mute](docs/dev/mute.md) — feed-only filter, composes with the profile-visibility tier filter
- [Profile visibility](docs/dev/profile-visibility.md) — four tiers + FoF, chokepoint API, HoF exception, audit log
- [Session features](docs/dev/session-features.md) — blind tasting, hide-lineup, roles, lifespan, disambiguation, enumeration-oracle posture
- [Session codes](docs/dev/session-codes.md) — Crockford alphabet, 4/8-char canonical forms, three-forms rule, collision check
- [Session deletion](docs/dev/session-deletion.md) — retention rule implementation, Redis wipe, participant bounce
- [Account deletion](docs/dev/account-deletion.md) — Postgres transaction + Redis SCAN+decide+act loop, host tombstoning
- [Score system](docs/dev/score-system.md) — full validation pipeline, Decimal wire-format trap, HoF trigger
- [Social feed](docs/dev/social-feed.md) — follow graph, check-ins, mutual-follow tag gating, "had a sip" S3 copy flow
- [Avatars](docs/dev/avatars.md) — upload pipeline, MIME allow-list + magic-byte signatures, JPEG EXIF strip, account-delete reclaim
- [Flavour charts](docs/dev/flavour-charts.md) — polar vs radar, type-specific dimensions (FL_RED/WHITE/SPARK/ROSE/legacy)
- [iOS touch gestures](docs/dev/ios-touch-gestures.md) — pull-to-swap design history (architectures tried + discarded)
- [Deployment](docs/dev/deployment.md) — Deploio env vars, deploy story
- [Wine metadata](docs/dev/wine-metadata.md) — description/region/country/vinification/purchase_url specs, `cleanUrl` http(s)-only rule
