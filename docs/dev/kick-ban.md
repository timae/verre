# Kick / ban (host moderation) — implementation

Host moderation primitive scoped per-session. Distinct from the user-level [Block](./block.md) primitive — block is bilateral and lives outside sessions; kick/ban is unilateral host action on session participants.

User-facing copy: `../kick-ban.md`.

## Schema (Redis only)

No Postgres changes for the gate itself.

- `s:<C>:bans` — Set of banned identity-ids. SISMEMBER on every `requireParticipant` + `POST /api/session/join`. Expires with the session lifespan.
- `s:<C>:kicked` — Set of kicked-but-not-banned identity-ids. Marker only — not an authorization gate; lets `/join/<C>?removed=1` identify a kicked user whose identity-hash entry was stripped, so the bounce screen can offer the right Keep/Delete prompt. Cleared on rejoin OR on `/leave?cleanup=full`.
- `s:<C>:lock:ban` — short-TTL advisory lock taken during a wipe so the wines JSON write-back doesn't race a concurrent host action.

## Schema (Postgres)

`wines.added_by_identity_id VARCHAR(64)` (nullable) — records who added each wine. Populated on wine POST from the resolved identity; preserved on ordinary edit. **Exception — host/cohost reassignment**: a host can change who brought each impression via an ownership-only `PATCH /wines/[wineId]` (`broughtByIdentityId`); it rewrites this field (and `added_by_display_name`) to the new owner, moving provider edit-rights + the ban-sweep filter. That reassign runs under the ban lock (serialized with `sessionWipe` + wine DELETE + role writes) and mirrors to PG synchronously with Redis-restore compensation on failure (bounded v1 — best-effort within the Redis→PG contract, `docs/dev/proposals/reassign-brought-by.md`). Existing pre-feature rows stay NULL and never match a "delete their wines" filter. Indexed on `(session_id, added_by_identity_id)`.

`wines.added_by_display_name VARCHAR(64)` (nullable) — snapshot of the adder's display name. Populated on POST from the live `s:{CODE}:identities` map, preserved verbatim on ordinary edit; **re-snapshotted to the new owner's current name on a reassignment** (same exception as `added_by_identity_id`). Pre-feature rows are NULL. Used as a fallback by the wire-time resolver when the adder has been kicked/banned and is no longer in the live identities map.

**Wire-time resolution of `addedByDisplayName`** (in `wineToWire`, the single sanctioned transform): priority is **live identities map → `users.name` lookup (only for `u:<id>` adders) → `addedByDisplayName` snapshot → null**. The live map wins so any future per-session rename surfaces immediately. The `users.name` fallback covers kicked logged-in adders (their identities entry is gone but the user row survives). The snapshot is the last-resort fallback for kicked anon adders (no users row exists). `redactWine` strips `addedByDisplayName` to `null` in blind mode — knowing "Alice brought this one" partially identifies a wine via her known preferences.

The raw `addedByIdentityId` is stripped from the wire by `wineToWire` (privacy: prevents anon-id correlation across wines from the same adder). Only the resolved display name surfaces. Display names are already public elsewhere (identities map, ratings list), so adding them to wines doesn't expand the leak surface.

## Two-flavor removal: kick vs ban

- **Kick** (`mode: 'kick'`) — strip the participant from identities + cohost list, drop their `session_members.role` to `taster`. Their ratings, hall_of_fame, bookmarks, session_members row all **stay**. Add to `s:<C>:kicked` so the bounce can identify them. They can rejoin (kicked is not an authorization gate). On the bounce screen they choose Keep (no-op) or Delete (`POST /leave?cleanup=full`, runs the `kick-delete` wipe path).
  - **Kept ratings leave the LIVE views while off the roster** (2026-07-18): `buildRatingsView` (`lib/sessionState.ts`) drops rating keys whose identity has no `identities` entry, so a kicked user's ratings vanish from compare, participants, and every aggregate derived from that view (averages, charts, aroma consensus) — without deleting the keys. Rejoin re-adds the identities entry and the ratings reappear. Every legitimate rater has an entry (join writes it; only kick/ban removes it), so a missing entry is always "removed", never a false positive.
  - **A kicked user can still edit their own rating from the feed** — the session-rating PATCH (`/api/checkins/:id`, `kind='session'`) is owner-gated, not roster-gated (their post, their rating). The live Redis mirror is **roster-independent** (PR #81 review — supersedes the earlier skip-while-off-roster rule, which left a stale payload that resurfaced on rejoin showing the pre-edit rating): updates and the reap DEL both maintain the caller's OWN retained key, which the roster guard hides from every live view anyway. Deliberately NOT a 403. Roster-independence stops at the key: the session-wide TTL refresh (`touchWithMeta`) is gated on identities membership, so an off-roster editor can't keep the whole session alive by repeatedly saving their post — their mirrored key is instead clamped to the meta key's remaining TTL (it dies with the session, never outlives it onto a recycled code).
- **Ban** (`mode: 'ban'`) — same strip as kick PLUS delete their ratings, hall_of_fame, bookmarks (for wines in this session), session_members row in one Postgres transaction. Add to `s:<C>:bans`. They cannot rejoin. Anon tokens are kept on ban so a logged-in user reusing their cookie is recognised on the next request and bounced; anon users who clear localStorage and rejoin with a fresh `a:<uuid>` get through (documented weakness — no anti-fingerprint or auth-required setting yet).

## Wine-orphan toggle (`deleteAddedWines`)

Applies to both kick and ban — the host owns the call regardless of mode. Wines added by the target get `session_id = NULL` (orphaned, not hard-deleted), so third-party bookmarks survive in `/me/saved`. The wine record itself stays so other tasters who rated/bookmarked it keep their references; the live session's wines JSON gets the wine filtered out so the live tasting doesn't keep showing it.

## Authorization (`POST /bans`, `DELETE /bans/:identityId`)

- Strict host: can kick/ban anyone except self.
- Cohost: can kick/ban regular tasters and providers. Banning a cohost requires **strict host** (matches the existing cohost-role-assignment rule — banning a cohost is an implicit demotion). Providers themselves have no moderation powers — they cannot kick/ban anyone.
- Self-target: rejected 400.
- Targeting the strict host: rejected 400.

## Rate limits

60 actions / 10 min / caller, shared between POST `/bans` (kick or ban) and DELETE `/bans/:identityId` (unban). DELETE intentionally shares the budget (unlike block DELETE which is uncapped) — moderation is bounded both ways.

## Bounce protocol (`X-Vr-Auth: removed`)

New header distinct from `invalid`. Existing `invalid` clears local state on the client (`vr_anon_*`, `vr_name_*`, `vr_id_*`) and bounces to `/join/<C>`. The new `removed` header **preserves local state** and bounces to `/join/<C>?removed=1` so the page can identify the user via the preserved token + cookie and render the right copy (`<RemovedView>`). Both polled GETs (`/api/session/<C>`, `/wines`, `/ratings`) AND state-changing endpoints (`/rate` POST/DELETE, `/wines` POST + `/wines/<id>` PATCH/DELETE, `/wines/reorder`, `/wines/<id>/reveal`, `/wines/{reveal,hide}-all`, `/settings`, `/name`) emit `removed` for banned/kicked callers — without this, a banned user could keep writing data until their next poll. `lib/identity.ts` `participantOrBanned()` is the resolver returning `'ok' | 'banned' | 'kicked' | 'invalid'`; `authRemoved()` builds the response. **`/visit` also consults bans + kicked** so a removed user opening the session URL can't re-admit themselves via the identities-hash write that visit otherwise performs.

## Removed-bounce client behaviour

`<RemovedView>` strips the `?removed=1` query param on mount via `window.history.replaceState` (NOT `router.replace` — that triggers a Next.js navigation which re-runs the SSR page, sees no `removed=1`, and falls through to `<JoinClient>` instead of staying on the prompt). The URL bar updates without a re-render. The "back to home" button branches on `isLoggedIn` (passed in from the SSR page): logged-in → `/me`, anon → `/`. `<JoinClient>` (the regular invite form) also catches `403 {error: 'banned'}` from manual rejoin attempts and redirects to `?removed=1` so the user lands on the full RemovedView rather than seeing a small inline "banned" message.

## Order of operations (ban wipe)

1. `SADD bans` — smallest Redis op, idempotent. Bans-Set membership alone is the authoritative gate, so even on partial failure the user can't rejoin.
2. `SADD kicked` (for both kick variants).
3. `prisma.$transaction`: delete user's ratings + hof + bookmarks (for wines in this session) + session_members. If `deleteAddedWines`: orphan their wines.
4. Redis cleanup (idempotent): delete per-rating keys, drop from identities, strip from `coHostIds` AND `providerIds` (one read-modify-write to meta), filter wines JSON.

The full wipe runs under `s:<C>:lock:ban` (`SET NX EX 10`) so two concurrent host actions on the same session don't clobber each other's wines JSON write-back.

## API surface

- `GET /api/session/<C>/bans` — host or cohost. Lists banned identities.
- `POST /api/session/<C>/bans` — host or cohost. Body `{identityId, mode: 'kick'|'ban', deleteAddedWines?: boolean}`. Strict-host required when targeting a cohost.
- `DELETE /api/session/<C>/bans/:identityId` — host or cohost. Lifts the ban-Set entry; data is already gone (deleted at ban time) and not restored.
- `GET /api/session/<C>/bans/preview/:identityId` — host or cohost. Returns `{identityId, displayName, ratingCount, addedWines}` for the host-side modal.
- `GET /api/session/<C>/removed-state` — caller's own state. Returns `{state: 'banned'|'kicked'|'none', identityId?, hasRatings?}`. Used by `<RemovedView>` on the `/join/<C>?removed=1` bounce screen.
- `POST /api/session/<C>/leave?cleanup={keep|full}` — kicked-user self-service. `keep` is a no-op (default). `full` runs the `kick-delete` wipe (ratings + hof + bookmarks + session_members). Authorization: caller must be in `bans` or NOT in identities (active participants can't use this path).

## Ghost-rater UX note

Kick-keep strips the identity from `s:<C>:identities` but leaves ratings + hof + session_members. **Superseded 2026-07-18 (the roster guard above): compare/live views no longer render those retained ratings while the rater is off the roster** — `buildRatingsView` drops keys with no identities entry, so "Keep means keep" preserves the DATA (Redis keys + PG rows survive; rejoin makes them reappear) without ghost rows in other tasters' live views. If the kicked user later chooses Delete (via `/leave?cleanup=full`), everything goes.

## Kicked moments drop from the kicked user's Moments list

`GET /api/me/sessions` **filters out any session the caller is currently kicked from** (Simon's ruling 2026-07-05): a kicked user shouldn't see the moment in their Moments home (carousel + lists + count badges) — they were kicked. They can still **rejoin by code/link**, which clears the kicked flag, so the moment returns.

**Kick-state is DURABLE in Postgres — `session_members.removed_state`.** Kick-keep leaves the `session_members` row (so the SQL join returns it), so the kick is mirrored into `removed_state = 'kicked'` (a slice of the durable-sessions workstream — Postgres-authoritative moderation state). Every query in `/api/me/sessions` — the two row queries AND the cheap bucket-count query — excludes `sm.removed_state = 'kicked'` in SQL, so kicked moments drop from the lists, the carousel, AND the count badges **exactly**, and **durably past Redis expiry** (unlike the old Redis-only marker, which vanished when `s:<C>:kicked` TTL'd out and let the moment reappear). Write sites, mirroring the Redis kicked set 1:1:
- **kick-keep** (`lib/sessionWipe.ts`, in the txn beside the role reset) sets `removed_state = 'kicked'`.
- **rejoin** (`app/api/session/join/route.ts`, beside the Redis `sRem`) resets it to `NULL`. The invite-LINK path (`app/join/[code]/page.tsx`) is made kick-aware for this: a logged-in member is normally blind-redirected into the session (skipping the join POST), but a `removed_state='kicked'` row falls through to `<JoinClient>` instead so the join POST actually runs and clears the flag — otherwise a kicked user clicking the link would `/visit`, get bounced with `?removed=1`, and `<RemovedView>` (Keep/Delete only) would never re-join them, leaving the moment durably hidden. `/visit` ALSO self-heals: reaching its `session_members` upsert means the kicked gate already passed (Redis-active), so a lingering `removed_state='kicked'` (the rejoin partial-failure window — Redis cleared, PG write failed) is cleared by a separate `updateMany` there (NOT the create-only role upsert). Between the join-POST clear, the link fall-through, and the `/visit` self-heal, every re-entry path converges the mirror.
- **kick-delete / ban** delete the row entirely, so they never carry a value — the SQL join drops them directly.

The `removed_state` exclusion also applies to the **"Friends there" people facet + the per-moment people list**: the `EXISTS (session_members sm2 …)` friend-attendance filter and the enrichment member query both exclude `removed_state = 'kicked'`, so a friend who was kicked from a moment isn't shown as having been "there" and doesn't make the moment match "moments Anna was at." This keeps the Postgres-derived people data consistent with the live `s:<C>:identities` hash (which strips kicked users) — without it, the PG-member branch of the `liveIdentities ∪ PG members` union would resurrect a kicked person the Redis branch correctly omitted.

The Redis `s:<C>:kicked` set stays (it's the `/join` + `/visit` re-entry gate + the bounce-screen marker), and `/api/me/sessions` keeps a per-row `SISMEMBER` check as a **live belt**: in `sessionWipe` the Redis kicked-SADD runs BEFORE the Postgres txn (same partial-failure discipline as bans), so a kick whose PG write failed leaves Redis=kicked / PG=not — the belt still drops the row (and fixes the count) in that window. Common case (PG mirror set), the SQL exclusion already handled it and the belt is a no-op. **Pre-migration caveat:** kick-keep rows created before the `removed_state` column read `NULL` (active) — those legacy kicks are unrecoverable (the source lived only in the now-expired Redis set) and would resurface until re-kicked; accepted (rare; the prod dump had none).
