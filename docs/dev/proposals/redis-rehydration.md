# Live-moment recovery: Postgres as the record, Redis as the cache

**Status:** SHIPPED — release A (PR #101), release B (PR #103, merge `7d0c2a7`, deployed and verified in production 2026-11-08) and release C, the operator script (§ 7; plan `.local/redis-rehydration-release-c-plan.md`, as built in `docs/dev/deployment.md` § "Redis rehydration release C"). This file stays as the rationale-of-record. Design review closed at revision 8 after eight Codex rounds (`.local/redis-rehydration-codex-review.md`, `…-round-2.md` … `…-round-8.md`). Rulings from the owner are marked **RULED**. Where the as-built release B deviates from the text below — deny-first cache writes before COMMIT (D1, incl. tightened visibility flags), record-first reassign (D2), meta of a Postgres-backed session always written from the record (D4), the publication generation `s:{C}:gen`, a contract retrying once after a rebuild when it finds the cache cold, the feed reveal by record dates (Q5) — the build log and `lib/CLAUDE.md` are the record. The implementation keeps two distinctions the review kept finding violated: tentative plans made outside a lock never decide anything, and no durable write commits outside the transaction that owns it.

Supersedes the 2026-11-06 rough idea. The next project after `dependency-upgrades.md`.

## 1. The problem

A moment lives in Redis (`s:{CODE}:*`). Every live read — `GET /api/session/:code`,
`/state`, `/wines`, `/ratings`, the join and visit routes — opens with
`redis.get(s:{CODE}:meta)` and returns **404** when the key is missing. Mobile renders that
404 as *"This moment has ended"*. Nothing on that path consults the Postgres `sessions`
row, even though for every moment a logged-in user has touched Postgres holds the session,
its wines, the logged-in ratings and the member list.

So anything that empties the key-value store — a Valkey restart, a failover, memory
eviction, the dev harness's per-section `FLUSHALL` — ends every live moment at once, and
there is no way back. Observed in dev on 2026-11-06 after the Phase 1 harness run: every
moment "ended"; the pre-run `pg_dump` restored accounts and history but the moments stayed
dead. The same failure class exists in prod — and in prod it is not hypothetical: the
instance's eviction policy drops keys one at a time under memory pressure (§ 5.5).

**Owner's requirement (2026-11-07):** *if it is in the database, it must be available to
the user.* For every asset that has a Postgres home, there must be a way back into Redis.

## 2. Rulings (owner, 2026-11-07)

1. **RULED — Self-heal on read, plus an operator script.** One rebuild function in `lib/`.
   The single-moment read path calls it on a Redis miss when a live Postgres row exists.
   The same function backs a CLI for bulk warm-up after a wipe. Users never see the gap.
2. **RULED — Any non-deleted Postgres moment is reopenable, whatever its age.** Lifespan
   stops being an expiry for Postgres-backed moments and becomes the *cache* TTL only.
   Rationale: registered users are the point of persistence; mobile has only registered
   users and no lifespan picker at all (every native create is `unlimited`). "This moment
   has ended" is reserved for anonymous-only moments that TTL'd out and for soft-deleted
   moments.
3. **RULED — Anonymous data is accepted as lost, and documented.** Anonymous participants,
   their tokens and their ratings are Redis-only by design and stay that way. After a wipe
   an anonymous taster rejoins with the code as a new identity; their ratings are gone.
   Wines *added by* anonymous participants in a Postgres-backed moment are the one
   exception: they are mirrored (§ 4.4), so the lineup survives.
4. **RULED — Anon-hosted moments rebuild without a strict host; mirrored cohosts keep
   cohost powers and may delete.** Logged-in members get the moment back (view, rate,
   compare). Cohosts keep everything `isHostByIdentity` grants (wines, settings, reveals,
   kick/ban of tasters) and additionally the delete (§ 4.5). Strict-host-only actions
   (cohost assignment, banning a cohost) have no holder. Ownership is never silently
   reassigned.
5. **RULED — Design for eviction; keep the instance's `allkeys-lru` policy.** The whole
   project is a design for data that is no longer in Redis; a cache that degrades and
   heals beats one that refuses writes once full. `noeviction` was considered (revision 2
   called it a prerequisite) and rejected: with the belts in § 5.5 the correctness line
   holds under LRU, and the one thing `noeviction` adds is a hard outage mode. Consequence:
   the design must survive the loss of **any single key**, not only a whole session.

## 3. The model after this project

This is the explicit version of what root `CLAUDE.md` § Two-tier persistence implies but
the read path never honoured:

| Session class | Record of truth | Redis role | Lifetime |
|---|---|---|---|
| Anonymous-only (no `sessions` row) | Redis | The data | Lifespan TTL, then gone |
| Postgres-backed (`sessions` row, `deleted_at IS NULL`) | **Postgres** | Rebuildable cache | Until soft-deleted |

🔒 **Mode is decided by whether the `sessions` row exists, never by the current caller's
login state.** This is the same rule `wine-catalog-model-change.md` § 8a fixes for
occurrences; this project applies it to the rest of the session and adds the rebuild
path. The model change later makes wines a *revision-stamped* cache; the rebuild
function here is what it calls when the stamp is missing. Nothing here competes with it.

**Cache-aside, rebuild on miss.** Standard practice for a durable store fronted by an
in-memory one: the miss is a rebuild, not an error; the rebuild is serialized per session
so concurrent misses do one rebuild; the rebuild is idempotent — content fills holes,
authorization state is reconciled (§ 5.1) — so a repeat is a no-op and a partial loss is
as recoverable as a total one.

🔒 **There is no cross-store transaction, and the design never pretends there is**
(R5-1). A Postgres transaction and a Redis `MULTI` are two atomic units in two systems;
nothing makes them one. A process can die between them, a `COMMIT` can fail after an
`EXEC` succeeded, and a Redis `MULTI` does not roll back its earlier commands on a
runtime error. Every rule below is written so that it holds *when the handler never gets
to run its cleanup*:

- **Durable state is decided and committed in Postgres**, serialized per session by the
  mutation contract (§ 5.4). That is the only atomic unit.
- **The cache is a projection of committed state**, written after `COMMIT`, fenced, and
  separately recoverable: a projection that never ran is repaired by reconciliation
  (§ 5.1), not by the dead handler.
- 🔒 **For logged-in identities in a Postgres-backed session, authorization is read from
  committed Postgres state, never from the cache** (§ 4.7). A cached entry can only
  *deny* (a Redis ban still bounces), never *grant* what the record denies. This is the
  rule that makes the crash windows above safe without any cleanup at all. Anonymous
  identities and Redis-only sessions have no record and keep today's Redis authority
  (ruling 3).

**Two kinds of mirror, stated plainly.**

- **Record-first mirrors (security-relevant).** The Postgres write happens first and is
  committed; the cache projection follows. This set is **bans and kicks** (§ 4.2, § 4.7),
  **roles** (§ 4.7) and **membership** (§ 4.4). The rule: anything whose stale restoration
  could grant a privilege is decided in the record, and — per the rule above — the
  record is also what grants.
- **Best-effort mirrors (content).** Wines, settings, positions: Redis first, Postgres
  after, inside the same contract so mirrors are ordered, but a mirror failure is logged
  (code + object kind) and repaired by the next successful write of the same list — every
  list mirror projects the *whole* current array, so one later write of any wine repairs
  all. "Postgres is the record" means *the record of everything that was successfully
  mirrored*. Turning a content-mirror failure into a request failure with Redis
  compensation is the authoritative-write matrix of the model change (§ 8a "Error
  handling"), not this project.

**Three mechanisms, each with one job** (§ 5.4 has the detail):

1. **A structural rule on the keys themselves — NX to create, XX to update.** The create
   route, promotion and rebuild write `meta` and `wines` with `NX`; every later writer
   writes them with `XX KEEPTTL`. A key that is gone cannot be brought back by a stale
   writer, whatever lock it does or does not hold.
2. **A fenced Redis lock** `lock:session:{CODE}` (replacing `s:{CODE}:lock:ban`), with a
   lease, whose holders perform **every** write to a *shared-state* key — `meta`, `wines`,
   `identities`, `bans`, `kicked` — and the rebuild's publish as a fenced write (`WATCH`
   the lock, check the token, `MULTI`, `EXEC`), so a holder that outlived its lease cannot
   write. Its job is the *cache*: it fences Redis commands and it makes waiting cheap.
   Revision 5 limited it to `meta`/`wines`; R5-2 showed that `identities`/`bans`/`kicked`
   are authorization-shaped cache and need the same fence.
3. **The session mutation contract — one Postgres advisory transaction lock per session**
   `pg_advisory_xact_lock(hashtext('session:' || code))`, precedent `lib/staffRole.ts:154`,
   **taken by every durable writer**, inside whose transaction every *decision* (does the
   row exist, what is the current role, is this identity eligible, is this the same
   incarnation) and every Postgres write happens, and whose COMMIT is the point at which
   a change exists. Its job is the *record*. Taken always *after* the Redis lock (fixed
   order, no deadlock), plus the `session_tombstones` registry so a delete that already
   committed is visible to a promotion that comes later.

**What "live" means in `/api/me/sessions` does not change in this revision** (§ 8, open
point 1).

## 4. Make Postgres sufficient first

A rebuild can only restore what Postgres holds. Checked field by field against
`SessionMeta` / `WineMeta` / `RatingMeta` (`lib/session.ts`) and `prisma/schema.prisma`
on 2026-11-07:

### 4.1 Already durable — nothing to do

- `sessions`: `host_name`, `host_user_id`, `name`, `blind`, `blind_for_everyone`,
  `created_at`, `archived_at` (= promotion time), `address`, `date_from`, `date_to`,
  `timezone`, `description`, `link`, `cover_photo_url`, `category`.
- `session_members.role` — `host` / `co_host` / **`provider`** / `taster`. The rough idea
  said providers were not mirrored; they are (`app/api/session/[code]/route.ts` set-role
  mirror, create-only snapshot on `/visit`).
- `session_members.removed_state = 'kicked'` — the kick-keep mirror (`docs/dev/kick-ban.md`).
- `wines`: every `WineMeta` field incl. `revealed_at`, provenance (`added_by_identity_id`,
  `added_by_display_name`), catalog link, `style` (= `type`). `image` is a transient
  base64 field that is empty at rest — rebuilt as `''`.
- `ratings` for logged-in raters: `score`, `flavors`, `aromas`, `notes`, `rated_at`.

### 4.2 Gaps — new columns, two tables, one constraint

| Gap | Fix | Written where |
|---|---|---|
| Lifespan | `sessions.lifespan varchar(16) NULL` | create, promotion, settings PATCH (it accepts `lifespan`) |
| Hide-lineup | `sessions.hide_lineup bool NULL`, `sessions.hide_lineup_minutes_before int NULL` | create (it accepts both via `applySessionFields`), promotion, settings PATCH |
| Show-provenance | `sessions.show_provenance bool NULL` | promotion, settings PATCH |
| Rating mirror token | `ratings.mirror_at timestamptz NULL` | rate POST upsert, check-in PATCH (§ 4.3) |
| Tombstone rater identity | `ratings.tombstone_key varchar(40) NULL` (release A) + CHECK `ratings_session_rater_known` (release B, § 4.3) | account delete + a legacy backfill |
| Wine order | `wines.position int NULL` | every wine-list write on a Postgres-backed session (§ 4.6) |
| Membership on every entry | `session_members` row from `/join` and `/rate`, not only `/visit` | § 4.4 |
| Bans | new table `session_bans` | `sessionWipe` ban txn; unban route; promotion; session soft-delete; account delete |
| Delete fence | new table `session_tombstones` | both soft-delete paths, incl. the anonymous-only branch (§ 5.4) |

🔒 **One spelling of the meta → columns mapping** (R1-11): a helper
`sessionMetaToColumns(meta)` in `lib/session.ts` returns the full column set from a
`SessionMeta`, and the logged-in create, the promotion create and the settings PATCH
mirror all write *that*. Today the three sites each list columns by hand and have drifted
(create omits the hide-lineup pair and lifespan; the settings mirror omits lifespan,
show-provenance and hide-lineup; the upsert's update arm is name-only). A field added to
`SessionMeta` then needs exactly one mapping change — and the coverage check in § 5.2
fails until it gets one.

**Backfill for sessions that are live when the additive release deploys** (R1-11): their
new columns are NULL while Redis still holds the real values, and a later rebuild would
default `hideLineup`/`showProvenance` to *shown* — exposing a lineup the host hid. The
additive release ships a one-shot `scripts/backfill-session-meta.mts` (same runner as the
operator script, § 7) that projects every live Postgres-backed session's Redis meta into
the new columns, run **once, right after that deploy, while Redis is still warm**, and
re-validated immediately before the behaviour cutover (§ 10).

Every new `sessions` column is nullable — the soft-delete scrub contract (`rewire.md`
§ 8) nulls every column but `id` and `deleted_at`, and the scrub statements in
`app/api/session/[code]/route.ts` DELETE and `lib/accountDelete.ts` add the new columns to
their `SET` lists. `lifespan` is cosmetic after ruling 2 (it only sizes the cache TTL and
the "expires in" display); kept because it is one column and a rebuilt pro moment then
looks like it did.

**`session_bans`:**

```
session_bans (
  session_code  varchar(16) NOT NULL,
  identity_id   varchar(64) NOT NULL,   -- 'u:<id>', 'a:<uuid>' or 'd:<uuid>' (§ 4.3), same shape as the Redis set
  banned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_code, identity_id)
)
```

- 🔒 **Rows exist only for Postgres-backed sessions** (R1-9). A ban in an anonymous-only
  session stays Redis-only (Redis *is* that session's data, § 3); promotion copies the
  Redis bans set into the table together with the wines (§ 4.4). So every row has a live
  `sessions` row behind it, and the two soft-delete paths are the complete cleanup set.
- 🔒 **Written and committed inside the moderation transaction, which is a
  mutation-contract transaction** (R1-9, § 5.4), before the Redis projection. For a
  logged-in target the row *is* the ban (§ 4.7); the Redis set is its cache.
- 🔒 **Codes are recycled after soft-delete.** Both soft-delete paths `DELETE FROM
  session_bans WHERE session_code = $code` in the scrub transaction. With the rule above
  there is no third lifecycle (expiry) to cover: a Postgres-backed session never expires.
- No FK to `sessions` (keyed by code, like `session_members`), no FK to `users` (identity
  ids are strings). Account deletion removes rows with `identity_id = 'u:<id>'` of the
  deleted user (minimal data; ids are never reused).
- Unban deletes the row (committed) and then projects the `SREM`. An unban whose
  projection never ran leaves a Redis entry that *denies* a user the record admits —
  fail-closed until reconciliation, which is the right direction for the cache to err.
- Anonymous ids are stored too. After a wipe the banned anon's token is gone anyway, so
  the row is moot for them — but the write path should not special-case identity kinds.

**`session_tombstones`** — see § 5.4. `(code varchar(16), created_at timestamptz,
deleted_at timestamptz DEFAULT now(), PRIMARY KEY (code, created_at))`. Written by every
soft-delete, including the anonymous-only branch that has no `sessions` row; read only by
promotion. Rows older than a year can be pruned by the existing cleanup cron — nothing
promotes a session that old.

### 4.3 Ratings: the mirror token and the tombstone identity

**`rated_at` is not the mirror-ordering token** (R1-3, confirmed). The rate route's
upsert writes `rated_at = NOW()` — transaction start — but the token it stamps into Redis
`at` and compares in its post-commit re-assert is `clock_timestamp()` taken *after* the
row update (`rate/route.ts:252`, `:333`); the check-in PATCH does the same with a separate
`SELECT clock_timestamp()` after its update (`checkins/[id]/route.ts:455`, `:550`,
`:663`) and never touches `rated_at`. Two writers serialized on the same row can therefore
have `rated_at(v2) < token(v1)`: v2's transaction started (and took its `NOW()`) while it
waited on v1's row lock. A rebuild that stamped `at = rated_at(v2)` would then lose to
v1's delayed mirror — a stale value overwriting the newer reconstructed one.

Fix: **the token becomes durable.** `ratings.mirror_at` is set *in the same statement*
that produces it — the rate upsert adds `mirror_at = clock_timestamp()` to its `DO UPDATE`
/ `INSERT` and keeps `RETURNING … mirror_at AS ts`; the check-in PATCH folds its
`clock_timestamp()` select into the `UPDATE … SET mirror_at = clock_timestamp() RETURNING`
(one raw statement replacing the Prisma update + separate select, same transaction). The
rebuild writes `at = epoch_ms(mirror_at)`; a delayed mirror with an older token loses, a
live write committed after the rebuild carries a newer token and wins. Rows from before
the column (`mirror_at IS NULL`) fall back to `rated_at` — safe, because no delayed
mirror of a row written before the deploy can still be in flight.

**Tombstoned ratings stay visible, under one canonical identity, and the deleted
person's name does not leak through provenance** (R1-4, R2-3, R2-6, R2-7, R2-8, R3-5,
R3-10, R5-3). Account deletion nulls `ratings.user_id`, sets `rater_name = '[deleted]'`,
and — in Redis — *keeps* the rating keys under the old `u:<id>` while rewriting that
identities entry to `[deleted]` (`lib/accountDelete.ts:165`), so other tasters keep seeing
those ratings in compare. A rebuild has no `user_id` to key on.

- **The durable identity.** Account deletion sets `ratings.tombstone_key = 'd:' ||
  gen_random_uuid()`, **one key per (deleted user, session)** — not per user (that would
  re-link a deleted account's sessions through a shared key) and not per rating (compare
  groups by rater). The rebuild projects each distinct key as an identities entry
  `d:<uuid> → '[deleted]'` and writes its ratings under `s:{C}:r:d:<uuid>:<wineId>`.
- 🔒 **It is a database invariant, not a convention — enforced only once every writer
  honours it** (R5-3, R6-2): `CHECK ratings_session_rater_known: session_id IS NULL OR
  user_id IS NOT NULL OR tombstone_key IS NOT NULL`. Together with the existing
  `ratings.user_id → users` FK (`NO ACTION`, `prisma/schema.prisma:465`), the database
  itself refuses the two bad end states: a session rating with no rater identity, and a
  user row deleted while session ratings still reference it. Account deletion (§ 6) is
  structured around those two refusals. **The CHECK ships in release B, not A**: Deplo.io
  runs the migration job *before* the new release goes live (`.deploio.yaml:5`) and the
  previous release keeps serving — and today's account-delete writer sets `user_id =
  NULL` without a key (`lib/accountDelete.ts:319`), so a CHECK added in A's migration
  would reject every account deletion served by the old release during the rollout, for
  as long as it lasted if the A application deploy failed. `NOT VALID` does not help (it
  still enforces on new and updated rows). So: A adds the nullable column, the legacy
  backfill and the compatible writer; B's migration repeats the legacy catch-up (for any
  tombstone minted by the old writer during A's overlap interval), validates zero
  remaining rows, and adds the CHECK. The CHECK body joins the contract-shape gate that
  `check-schema.yml` runs (`scripts/check-catalog-contract-checks.mjs` or a sibling
  snapshot for `ratings`), since `prisma migrate diff` is blind to CHECK predicates.
- 🔒 **Provenance moves with it** (R3-5, confirmed: `wineToWire` falls back to the stored
  `addedByDisplayName` snapshot when the identities map has no entry, `lib/session.ts:166`
  — so removing the `u:<old>` entry alone would replace today's "[deleted]" attribution
  with the person's real name). The same durable step rewrites, for every wine in the
  session the deleted user added, `wines.added_by_identity_id = <that session's tombstone
  key>` and `added_by_display_name = '[deleted]'`. "Who brought it" lives on the
  per-session wine instance today (and on the occurrence after the model change); this is
  that field, never a catalog record.
- 🔒 **The live copy is migrated to the same identity — as a projection after the durable
  step committed** (R2-3, R5-1): one fenced step per live session that `RENAME`s each
  rating key to its `d:` twin, swaps the identities entry, swaps `coHostIds`/`providerIds`
  if present, and rewrites provenance inside the `wines` array. It is written as a Lua
  script that **skips keys that do not exist and is idempotent**, because a Redis `MULTI`
  does not roll back on a runtime error and a partially evicted session must not abort
  the whole batch (R5-1). A projection that never ran is covered by the belt: **a
  `u:<id>` identity whose `users` row no longer exists is never legitimate after this
  project** — reconciliation (§ 5.1) deletes such entries and their rating keys and
  projects the `d:` groups from the record, while `wineToWire` treats a `u:` provenance
  whose user is gone as `'[deleted]'`.
- **Legacy tombstones** (R2-6): rows with `user_id IS NULL AND tombstone_key IS NULL` exist
  from deletions before the column. The migration backfills them with **one key per
  session** (`'d:' || gen_random_uuid()` grouped by `session_id`) — the original per-user
  split is unrecoverable, so all legacy tombstones in a session collapse into one
  "[deleted]" person, and two of them rating the same wine keep the later one. Counted
  and logged by the migration; accepted as the best available projection of data whose
  rater key was never kept. Legacy `wines` rows whose `added_by_identity_id` names a user
  that no longer exists get the same session key and the `'[deleted]'` snapshot.
- **Kicked-then-deleted** (R2-7): kick-keep hides a rater from the roster
  (`removed_state = 'kicked'`) while keeping their ratings for *their own* history; account
  deletion cascades the member row, so the rebuild would resurrect those ratings into
  other tasters' compare. The only reason they were kept was the deleted user's own view,
  which is gone with the account. So the durable step **hard-deletes the user's ratings in
  sessions where their member row carries `removed_state = 'kicked'`** before tombstoning
  the rest — and it must run *before* the member row cascades, which is why § 6 orders
  the per-session durable work ahead of the user-row delete.
- **`d:` is a valid identity for targeting, never for authenticating** (R2-8):
  `isValidIdentityId` accepts `d:<uuid>`; no cookie or token ever resolves to one.
  `sessionWipe` gains a `d:` branch — **ratings by `tombstone_key` within the session,
  wines' provenance untouched, Redis rating keys by identity** — used by **kick-delete
  only**: a tombstone cannot rejoin, so ban and kick-keep are rejected for it with the
  existing 400. **Hall-of-Fame rows are not part of this contract** (R3-10): the wall is
  a deprecated surface (`project_verre_hof_perfect5s_deprecation`), its tombstoned rows
  already read "[deleted]", and it gets no column. Documented in `docs/dev/kick-ban.md`.
- `score NULL` (chips-only) rebuilds as `0`, which is what the live path stores for
  "not rated".

### 4.4 Promotion is a snapshot inside the contract; mirrors key on row existence

Today's "archival" is two separate things wearing one function: `pgUpsertSession` both
*creates* the `sessions` row (promotion: Redis-only → Postgres-backed) and *updates* it.
Verified defects (R1-1, R1-5, R2-1, R2-5, R2-9, R3-1, B1):

- `/visit` promotes by creating the row **without copying the lineup**
  (`visit/route.ts:76`). Wines added by anyone before the first logged-in visit — including
  the anon host's own — never reach Postgres unless a later edit mirrors them.
- The wine routes mirror only `if (session?.user)` (`wines/route.ts:142`,
  `[wineId]/route.ts:153`), so an anonymous participant's wine in a Postgres-backed session
  is never mirrored either.
- `pgUpsertSession` is an upsert by code, so a rate POST holding live meta in memory can
  *re-create* the row after a soft-delete scrubbed it (the DELETE route's documented
  "phantom row" race, `lib/session.ts:525`, `rate/route.ts:159`) — and with rebuild-on-miss
  that phantom is no longer dead weight, it is reopenable.
- `/join` registers a logged-in identity in Redis **without** a `session_members` row
  (`join/route.ts:79`), and `/rate` promotes and archives without `/visit`
  (`rate/route.ts:156`). The web and native clients always `/visit` on entry, so the row
  usually exists — but nothing guarantees it (R2-5).
- `pgUpsertWine` separates its live-row lookup from its upsert (`lib/session.ts:669`,
  `:674`), so the decision "does this session have a row" and the write that depends on
  it are two unordered operations — the shape B1 names.

Fix — promotion is one unit of work inside the mutation contract (§ 5.4), and the wine
routes' mirror decisions live in the same contract:

```
ensurePromoted(code, expectedCreatedAt)       // replaces pgUpsertSession's create arm
  row = live sessions row by code?  → return row.id             (no lock; the common case)
  withSessionMutation(code, { redisLock: true, expectedCreatedAt }, async (tx, fence, ctx) => {
    -- inside: Redis lock held, advisory lock held, incarnation checked
    re-check the row                 → return it if it appeared
    tombstone(code, meta.createdAt) exists?  → 'gone'   (deleted; a stale caller cannot
                                                 promote what a delete removed)
    wines = GET s:{CODE}:wines, bans = SMEMBERS s:{CODE}:bans   (read inside, R2-9)
    INSERT sessions          (sessionMetaToColumns(meta))      -- the fresh meta, not a param
    INSERT wines             for every wine, position = array index
    INSERT session_bans      for every member of bans
    INSERT session_members   for the caller (role snapshot)    -- promotion is always a
                                                                -- logged-in act
  }, projection: fence.set(meta, { ...meta, promotedAt: row.archived_at }, XX KEEPTTL))
                                               -- after COMMIT; refused ⇒ logged, reconciled later
```

- **Trigger stays "a logged-in caller acted"** — visit, join, rate, wine add/edit,
  bookmark — exactly as today, so an anonymous-only session is never promoted (root
  `CLAUDE.md` "anonymous sessions stay Redis-only" holds). Only the *mirror* of
  individual objects moves to row existence: `pgUpsertWine` runs for every caller and
  decides on the row *inside the contract*.
- 🔒 **Serialization is the advisory lock, not the Redis lease** (B1's second schedule).
  The add's row decision and the promotion's commit are both inside advisory-locked
  transactions on the same key, so they cannot overlap: the add either commits before
  promotion takes the advisory lock (its Redis write is in the snapshot) or after
  promotion committed (its mirror finds the row). The Redis lease plays no part in that
  ordering; its job here is to keep a stale promotion from *projecting* (`promotedAt`)
  over a successor's cache — and a projection that is refused is only a missing
  presentation stamp, reconciled by the next rebuild. The **durable** fence against a
  stale promotion is the registry + incarnation check inside the transaction.
- 🔒 **The tombstone registry fences a promotion that comes after a committed delete**
  (R2-1, R3-7) — including a delete of an anonymous-only session that never had a row,
  because the delete's Redis-only branch writes the registry too (§ 5.4). The incarnation
  check catches the other direction: a stale caller whose code was recycled finds a meta
  with a different `createdAt` and stops.
- **The lineup copy is what makes rebuild complete** (R1-5): every wine present at
  promotion gets its Postgres row; every wine added after it is mirrored by its own
  route's contract transaction.
- **Membership on every entry** (R2-5): a shared `ensureMember(userId, code, meta)`
  (create-only role snapshot + the kicked-flag self-heal, lifted out of `/visit`) is called
  by `/visit`, the logged-in `/join` path and the logged-in `/rate` path, inside the
  contract. The eligibility rule (§ 5.1) additionally unions rating authors into the
  roster, so pre-existing rows without a member row still rebuild.
- `pgUpsertSession`'s update arm survives as `pgTouchSession` (name only, as today);
  settings changes keep their own mirror through `sessionMetaToColumns`.
- **As built since (§ 11 item 2):** the INSERT writes `lifespan = 'unlimited'` whatever
  the guest moment had, and the projection re-stamps every `s:{CODE}:*` key to that TTL
  after the meta rewrite (the meta write is XX KEEPTTL, so the guest TTL would survive
  it). A failed projection leaves the record right; the next record-sourced meta write
  plus a touch, or the rebuild once the old TTL lapses, catches the cache up.

### 4.5 Host-less sessions: fix a display-name branch

`DELETE /api/session/:code` lets a cohost delete only when
`!meta.hostIdentityId && !meta.hostUserId && meta.host === TOMBSTONE_NAME`. The last
clause branches on a **display name**, which the trust model forbids (root `CLAUDE.md`
§ Trust model: display names carry zero trust). A rebuilt anon-hosted moment has
`hostIdentityId` and `hostUserId` both unset and `host` = the anon host's snapshot name,
so the cohost would be locked out. Drop the name clause: *no host identity at all* is the
condition, regardless of why. Ruling 4 depends on this. (With § 4.7 the check reads the
record for `u:` callers: `sessions.host_user_id IS NULL` and no `hostIdentityId` in meta.)

### 4.6 Wine order: renormalize every time, inside the contract

`position` cannot be "write the new wine's slot" (R1-10): the wine POST supports
insertion at an arbitrary index for hosts (`wines/route.ts:122`), so an insert displaces
every later wine; a session untouched since the deploy has all-NULL positions, and
`NULLS LAST` would then sort one freshly positioned wine *ahead* of the older ones; and
two mirrors completing out of order would leave Postgres with the earlier permutation.

Rule: **after every wine-list mutation on a Postgres-backed session — add, edit, delete,
reorder, reveal/hide (they go through `mutateWines` too), ban-wipe — write the position
of every wine from the committed array** (`UPDATE wines … FROM (VALUES …)`, n ≤ a few
dozen), **inside the route's contract transaction**, after the fenced `mutateWines`. The
advisory lock orders the mirrors (B1's third schedule: an old mirror paused before its
Postgres update cannot run concurrently with a successor's — it runs before or after,
and whichever runs last projects the newest array). A session's positions are either all
set (after its first post-cutover write) or all NULL (never written; `created_at, id`
order, today's Postgres read order). `wines.position` is the column the model change
plans for occurrences (its field table lists *position* as "has no durable home today");
it migrates with the rest of `wines`.

`mutateWines` itself changes in one way at the cutover: **an absent `wines` key is a
reject, never a create** (`SET … XX KEEPTTL`; today a bare `SET … KEEPTTL` on an absent
key creates it with no expiry). The route maps the reject to `ensureSessionLive`'s answer
for the session — a rebuild, a 503 or a 404 — which is why this change ships with the
rebuild (B3) and not before it.

### 4.7 Authorization: the record grants, the cache only denies

R2-4 and R5-1, confirmed. `PATCH /api/session/:code` set-role writes `session_members.role`
best-effort and then writes Redis meta regardless (`[code]/route.ts:205`, `:220`); every
privilege check then reads Redis — `isHostByIdentity` / `isProviderById`
(`lib/session.ts:332`, consumed by e.g. wine DELETE at `[wineId]/route.ts:328` and by the
blind-redaction bypass in `buildWinesView`), and `participantOrBanned` reads the bans set
and the identities hash (`lib/identity.ts:135`). Revision 5 tried to make the two stores
agree by writing Redis before `COMMIT` inside one handler; R5-1's schedule — process dies
after the Redis `EXEC` and before the Postgres `COMMIT` — leaves a cohost grant in the
cache that the record never had, with no handler left to clean it up and no readiness key
missing to trigger a rebuild. No ordering of two non-atomic writes fixes that. The fix is
on the **read** side:

🔒 **For a logged-in identity in a Postgres-backed session, every authorization decision
derives from committed Postgres state.** Loaded once per request, inside the existing
resolver, and carried on the identity:

```
participantOrBanned(code, req, session)   -- unchanged signature
  identity = resolveIdentity(...)
  if identity is u: and a live sessions row exists:
    grant = SELECT s.host_user_id, m.role, m.removed_state,
                   EXISTS(session_bans b WHERE b.session_code = code AND b.identity_id = 'u:<id>') AS banned,
                   EXISTS(ratings r WHERE r.session_id = s.id AND r.user_id = <id>) AS author
              FROM sessions s LEFT JOIN session_members m ON (m.session_code, m.user_id) = (code, <id>)
             WHERE s.code = code AND s.deleted_at IS NULL            -- one indexed round trip
    banned  → 'banned'   (and project SADD bans, fenced, best-effort — § 5.5)
    kicked  → 'kicked'
    not a member and not an author → 'invalid'  (never registered in this session)
    else    → 'ok', identity.grant = { strictHost: host_user_id = <id>, role }
            and, if the identities hash lacks them, the per-user heal (§ 5.1) re-registers
  else (a: identity, or Redis-only session): today's Redis path, unchanged
```

- `isHostByIdentity(meta, identity)` and `isProviderById` become: **if `identity.grant`
  is present, answer from it** (`strictHost`, `role ∈ {co_host}` → host powers, `role =
  provider` → provider powers); otherwise from `meta` as today. The blind-redaction
  bypass in `buildWinesView` uses the same function, so a cached cohost entry the record
  lacks does not see blind identities either.
- **Mechanical audit for the cutover** (R6, no design change): the grant must reach
  *every* privilege check, and some helpers do not take an identity today.
  `isProviderById(meta, identityId: string)` (`lib/session.ts:362`) is called with a bare
  id by wine PATCH/DELETE (`[wineId]/route.ts:43`, `:329`) — its signature changes to take
  the resolved `Identity` (or an explicit grant); it never recovers a grant from a
  module-level variable and never silently falls back to the cached provider list for a
  `u:` caller. The same audit covers `isStrictHost` and `isCohostId`
  (`lib/session.ts:339`, `:348`), the inline role-array branches in
  `app/api/session/[code]/route.ts:112` / `:283`, and moderation targeting in
  `app/api/session/[code]/bans/route.ts:83`. Rule for *targets*: a logged-in moderation
  target's current role is read fresh from `session_members` inside the mutation
  transaction (the strict-host-only "banning a cohost" check must not consult a cached
  array); the caller's privilege is the caller's grant. Cached arrays stay presentation.
  A stale-*provider* cache test joins the stale-cohost tests (§ 9).
- **The cache can deny but not grant.** A Redis ban entry still bounces (bans check stays
  first, as today); a missing identities entry for an eligible user is healed, not
  trusted as a denial; a cached `coHostIds` entry for a `u:` user is **presentation only**
  (badges, `/me/sessions` labels, the roster) once the record exists. Anonymous
  identities keep Redis as their authority — they have no record (ruling 3) — and so do
  all callers of a Redis-only session.
- **Cost**: one indexed round trip per *authenticated* session request. Every
  authenticated request already pays a Postgres round trip for the `user_sessions`
  revocation gate (`lib/CLAUDE.md` "never cache `auth()`"), so this is the second of two,
  not the first of one. Measured at the cutover (§ 10).

**Role changes, kicks and bans are now simple** because nothing security-relevant rides
on the projection:

```
withSessionMutation(code, { redisLock: true, expectedCreatedAt }, async (tx, fence, ctx) => {
  -- advisory lock held; incarnation checked; fresh grant read for the CALLER from the record
  authorize the caller (strict host / cohost) from ctx.callerGrant
  UPDATE session_members SET role = $new … (u: targets)        -- or the sessionWipe txn body
}, projection: fence.set(meta, metaWithRoleApplied, XX KEEPTTL))   -- after COMMIT, fenced
```

- **Postgres commits first; the projection runs after** (R5-1's recommended order). A
  projection that is refused (lease lost), fails, or never runs (process death) leaves
  the cache stale in *presentation* only; the next poll's grant read, the next rebuild or
  `force` reconciles it (§ 5.1). A Postgres failure returns 500 with nothing changed.
- B1's first schedule still holds on the durable side: A's stale `UPDATE` is serialized
  behind B's by the advisory lock, so A either commits before B (and B overwrites from
  current state) or after B — but *after* means A's transaction entered the lock after B
  committed, and its entry check (`ctx.callerGrant`, fresh) and target re-read see B's
  state; A's write is a stale intent applied to fresh state, which for a role change
  means "set role = X" and is exactly what the host asked for. The schedule's harm was
  the *cache* restoring B's revoked privilege — and the cache no longer grants.
- `a:` targets have no Postgres row; their role changes are Redis-only inside the same
  contract transaction (for ordering and fencing), with no durable write, and Redis
  stays their authority.
- **Kicks and bans** (`sessionWipe`): the Postgres transaction (member row / ban row /
  rating deletes) is the contract transaction and commits first; the Redis cleanup
  (`SADD` bans/kicked, `HDEL` identities, rating-key deletes, meta list edits) is the
  fenced projection after it. A kick whose projection never ran is still a kick: the
  next poll's grant read answers `kicked`, and reconciliation removes the roster entry.
  B2's first schedule ("kick's Redis cleanup fails") is therefore no longer a privilege
  problem, only a roster-presentation lag until the next poll of that user or the next
  reconciliation.

## 5. The rebuild

### 5.1 `lib/sessionRehydrate.ts` — `ensureSessionLive`, the eligibility rule, reconciliation

**One eligibility rule (B2).** `eligibleRoster(sessionId)`, in `lib/sessionRehydrate.ts`,
is the single definition of who belongs in `s:{CODE}:identities` for a Postgres-backed
session, used by the full rebuild, by `force` repair, by the per-user heal and — as the
single-user form — by the grant read in § 4.7:

```
eligible(u) ⇔ u ∈ (session_members.user_id ∪ DISTINCT ratings.user_id) for this session
            ∧ users row exists
            ∧ NOT (session_members.removed_state = 'kicked')
            ∧ NOT ('u:<u>' ∈ session_bans)
kicked(u)   ⇔ session_members.removed_state = 'kicked'
banned(id)  ⇔ id ∈ session_bans
```

Tombstone groups (`d:<key>`) are always eligible. Anonymous entries have no record and
are never touched by any of the three (ruling 3).

**Reconciliation, not insertion** (B2): the rebuild projects identities as
`HSETNX` for every eligible user **and `HDEL` for every `u:` entry already in the hash
that is not eligible** (kicked, banned, or whose user is gone — the orphan case of
§ 4.3), and deletes an orphan's rating keys. Kicked users' rating keys are *kept* (kick-keep
semantics; the roster guard hides them) — only their roster entry goes. `bans` and
`kicked` sets are reconciled both ways against the record (`SADD` missing, `SREM` `u:`/`d:`
entries not in the record; anonymous entries untouched). `coHostIds`/`providerIds` in
meta are reconciled for `u:` entries the same way when meta is rewritten. Content
(`wines`, rating keys) stays NX. So the cache converges on the record even over a
partially-live session — and, per § 4.7, nothing is *granted* from it in the meantime.

```
ensureSessionLive(code, { force = false }): Promise<'live' | 'absent' | 'restoring'>
1. unless force: s:{CODE}:meta AND s:{CODE}:wines present → 'live'   (the readiness pair)
2. SELECT the live row: sessions WHERE code = $c AND deleted_at IS NULL.
   None → 'absent'  (the caller 404s exactly as today).
3. withSessionMutation(code, { redisLock: true }, …)  — Redis lock (bounded wait ~3 s →
   'restoring'), advisory lock; inside:
4.   unless force, re-check the readiness pair (lost the race → 'live'); re-check the row
     (a soft-delete landed → 'absent').                               (R3-6: force skips BOTH)
5.   Load: eligibleRoster; kicked; session_bans; wines ORDER BY position NULLS LAST,
     created_at, id; ratings WHERE session_id = $id AND (user_id IS NOT NULL OR
     tombstone_key IS NOT NULL).
6.   Build the Redis values (§ 5.2).
7.   Publish as ONE fenced MULTI: SET wines NX; identities reconciled (HSETNX eligible,
     HDEL ineligible u:); SET each rating key NX; DEL orphan rating keys; bans/kicked
     reconciled; EXPIRE each key to lifespanTTL(row.lifespan) — and SET meta NX LAST.
     Fenced out → 'restoring' (someone else owns the session now).
8. COMMIT (the transaction held only the lock and a consistent read); release. Log one
   structured line: code, counts rebuilt / reconciled / not recoverable.
```

The rebuild's publish is a projection like any other: it runs under the Redis lease,
fenced, and a refused publish writes nothing. A rebuild whose Postgres transaction died
after its read (R3-2) still holds — or has lost — its Redis lease, and that lease is what
decides whether its publish lands; it never decides anything durable.

Meta is written last because meta is the existence signal every reader keys on: a
rebuild that dies half-way leaves keys nothing reads (they TTL out) and the next miss
redoes the whole thing.

**The readiness pair is meta + wines, not meta + wines + identities** (R2-10). Redis
cannot hold an empty hash, so an anon-hosted session whose recoverable roster is empty
would never satisfy a three-key check and would rebuild on every open. `wines` is a
string (`'[]'` is a value), so the pair is always representable.

**The per-user heal is a fenced projection of the grant read** (R3-8, B2, R5-2). When a
`u:` identity has no identities entry, `participantOrBanned` has already decided the
answer from the record (§ 4.7). If that answer is `ok`, the heal registers them: it takes
`lock:session:{CODE}` (bounded wait; on timeout it answers `ok` *without* registering — the
grant is already decided, the roster entry is presentation and the next poll retries),
re-reads eligibility inside the contract transaction, and writes the `HSET` as a **fenced**
write. R5-2's schedule — the heal's Postgres transaction is aborted after its eligibility
read, a kick completes, the heal's callback resumes — is closed by the fence: the kick
took the Redis lock, so the resumed callback's `WATCH`/token check fails and its `HSET` is
refused. The healthy-transaction ordering (kick blocks on the advisory lock until the
heal commits, then removes the entry) still holds. The same fenced form applies to the
registration writes in `/visit`, `/join` and `ensureMember`. Mobile treats `X-Vr-Auth:
invalid` as fatal ("Not part of this moment", polling stops — `useSessionPoll`), so the
heal must be server-side. Anonymous identities have no record and stay `invalid`.

**A ratings-only loss is a rebuild trigger as well** (ruling 5 — single-key eviction):
`buildRatingsView` already SCANs `s:{C}:r:*`; when the scan returns no key for a
Postgres-backed session that has ratings in Postgres (one `EXISTS` on `ratings` by
`session_id`, only on the empty-scan path), it calls `ensureSessionLive(code, { force:
true })`. A single evicted rating key among surviving ones is the residual gap: it is
restored on the next trigger of any kind, and it is in the user's history meanwhile.

🔒 **`'restoring'` is a 503 with `Retry-After: 1`, never a 404** (R1-8). Mobile maps 404
to the terminal "This moment has ended" and web clears local identity and redirects on
it; both treat other 5xx as retryable (mobile's `http` kind shows "Try Again"; the web
poll simply polls again). A live Postgres row must never produce a 404.

🔒 **The rebuild never writes Postgres.** It is a pure projection of the record into the
cache. No `rehydrated_at` column, no counters, no `archived_at` touch.

### 5.2 Field mapping

**`s:{CODE}:meta`** from the row + members:

| `SessionMeta` | Source |
|---|---|
| `host` | `host_name` (`'[deleted]'` for a tombstoned host, as account-delete leaves it) |
| `hostUserId` | `host_user_id` |
| `hostIdentityId` | `u:<host_user_id>` when set; **absent** for an anon host (ruling 4) |
| `name`, `createdAt`, `blind`, `blindForEveryone`, `address`, `dateFrom`, `dateTo`, `timezone`, `description`, `link`, `coverPhotoUrl`, `category` | the columns, ISO strings / epoch ms as the create route writes them |
| `promotedAt` (new, § 4.4) | `archived_at` |
| `lifespan`, `hideLineup`, `hideLineupMinutesBefore`, `showProvenance` | the new columns (NULL → absent, which the readers already treat as the default) |
| `coHostIds`, `providerIds` | `session_members.role` ∈ {`co_host`, `provider`}, as `u:<user_id>`, filtered by `eligible` — presentation for `u:` (§ 4.7) |

The inverse of `sessionMetaToColumns` (§ 4.2) lives beside it, and the coverage check
below holds the pair together.

**`s:{CODE}:wines`** — `WineMeta` per row in position order; `type ← style`,
`image ← ''`, nulls → `''` for the string fields the create path writes as `''`
(`producer`, `vintage`, `grape`, `imageUrl`), optional fields absent when NULL.

**`s:{CODE}:identities`** — `u:<user_id> → users.name` for every eligible user (§ 5.1),
plus `d:<tombstone_key> → '[deleted]'` for every distinct tombstone key in the session's
ratings (§ 4.3). Collisions get the emoji suffix via the existing
`disambiguateDisplayName` logic applied in insertion order (the live map is non-unique by
design; only the suffix rule must match). A tombstoned *host* has no member row (cascade)
and no entry beyond its tombstone group — matches what `lib/accountDelete.ts` leaves.

**`s:{CODE}:r:<identity>:<wineId>`** — `{score: Number(score ?? 0), flavors, aromas,
notes: notes ?? '', at: epoch_ms(mirror_at ?? rated_at)}`, where `<identity>` is
`u:<user_id>` or `d:<tombstone_key>` (§ 4.3).

**`s:{CODE}:kicked`** ← `removed_state = 'kicked'`. **`s:{CODE}:bans`** ← `session_bans`.

🔒 **Field coverage is checked by the compiler, not by a fixture** (R1-13).
`lib/sessionRehydrate.ts` declares

```ts
const SESSION_META_FIELDS: Record<keyof SessionMeta, 'rebuilt' | 'ephemeral'> = { … }
```

and the same for `WineMeta` and `RatingMeta`. `Record<keyof T, …>` is exhaustive: adding
an optional field to `SessionMeta` fails `tsc` until the field is classified. Same lesson
as `redactWine`'s `...rest`: a field nobody classified is a field that silently disappears
on the first wipe. The runtime suite (§ 9) then checks that every `'rebuilt'` field
round-trips.

### 5.3 Where the read path calls it

`ensureSessionLive` is the first call in **every** route under `app/api/session/**` after
`normalizeCode` — not a replacement of `getSessionMeta` inside them (R1-7: the rate POST
runs `participantOrBanned` before it ever reads meta, the rate DELETE never reads meta at
all, and both would reject a cold-cache participant as `invalid` before any rebuild). Then
the route proceeds exactly as today; the raw `redis.get(k.meta(c))` / `getSessionMeta`
calls that follow keep working because the keys now exist. Two non-API readers get the
same call: the invite page `app/join/[code]/page.tsx` (it reads meta server-side and
disables joining when absent — `JoinClient`'s `isExpired`), and the `/join` POST.

🔒 **List and enrichment reads never rebuild.** `/api/me/sessions` reads meta per row to
compute `status` / `pinned`; a rebuild there would resurrect every past moment in the
list on each home load (N rebuilds per page) and would make Redis presence meaningless
as a warmth signal. It keeps its raw `redis.get` and its "no meta → not live" branch.
The rebuild is triggered only by opening one moment.

**Cost on a hostile miss.** The ensure runs before any participant check, so an attacker
probing random codes now costs one unique-index probe on `sessions.code` per miss instead
of one Redis GET. Both are O(1) and the 404 is identical either way (the enumeration
posture in `docs/dev/session-features.md` is unchanged). No negative cache in v1 — a
deliberate call, and an unmeasured one (R1-c): the cutover checklist includes a load
probe of the miss path (§ 10) so the decision rests on a number.

### 5.4 The session mutation contract

This section is the B1 contract: which writers participate, where decisions happen, what
is serialized through COMMIT, and how lease loss, wipe failure and invalidation
terminate. Everything in § 4 and § 5.1 that says "inside the contract" means this.

**`withSessionMutation(code, { redisLock, expectedCreatedAt?, readMeta? }, work, projection?)`** —
`lib/sessionMutation.ts`. It also has a form that joins an **existing** transaction
(`withSessionLocks(tx, codes, …)`): the same locks and entry checks, taken for several
codes in sorted order, with no `BEGIN`/`COMMIT` of its own — account deletion (§ 6) is
its only caller, and it exists so that one account deletion stays one Postgres
transaction (R6-1).

```
1. if redisLock: acquire lock:session:{CODE}  (mechanism 2; token T; bounded wait → 429/503)
2. BEGIN; pg_advisory_xact_lock(hashtext('session:' || code))         (mechanism 3)
3. entry checks, INSIDE the locks — reject before any side effect:
     a. if redisLock: GET lock:session:{CODE} === T, else 'lost'      (an already-stale holder
                                                                       starts nothing)
     b. if readMeta (default true): meta = GET s:{CODE}:meta; if expectedCreatedAt given
        and meta.createdAt differs → 'gone'  (incarnation check: the code has been recycled
        under this caller). readMeta: false is the PG-only form — no Redis command at all
        — used by durable work that must not depend on Redis being reachable (§ 6).
     c. row = live sessions row FOR UPDATE (may be none: Redis-only session)
     d. ctx.callerGrant = the § 4.7 grant read for the caller, when the row exists
4. work(tx, fence, ctx) — every Postgres decision and write. Content writers also make
   their Redis writes here (mechanism 1 + fence.*), because for content Redis is written
   first by design and its mirror follows; a refused fence throws 'lost'.
5. COMMIT.  Any throw in 3–4 → ROLLBACK, mapped to: 'lost' → 503 Retry-After (or the
   mutation routes' 429); 'gone' → 404; other → 500. Nothing durable happened; content
   Redis writes made in step 4 are the best-effort-mirror case (§ 3), repaired by the next
   write of that list.
6. projection (optional): the fenced Redis apply of the COMMITTED durable change —
   security-relevant state is projected HERE, after COMMIT, never before (R5-1). A refused
   or failed projection is logged; reconciliation repairs it; nothing is granted from a
   missing or stale projection (§ 4.7).
7. if redisLock: release (compare-and-delete).
```

🔒 **The two sides are not one unit, and the contract does not say they are** (R5-1). Step
5 is the only atomic point. What the contract guarantees: durable decisions are
serialized and committed under one lock; projections of security state come after the
commit and can be lost without granting anything; content projections come before and
can be lost without losing durable truth.

**Who participates** — every writer whose correctness the proposal relies on. The Redis
lock is taken by every writer of a **shared-state key** (`meta`, `wines`, `identities`,
`bans`, `kicked`) — R5-2 widened this from "readiness keys" to the authorization-shaped
keys too:

| Writer | Redis lock | Contract txn | Durable (step 4) | Projection (step 6) |
|---|---|---|---|---|
| create route | — | — | — | `NX` writes; nothing to race |
| promotion (§ 4.4) | yes | yes | row, wines, bans, member; registry + incarnation checks | `promotedAt` stamp |
| rebuild (§ 5.1) | yes | yes | reads only | the fenced publish |
| soft-delete, both paths | yes | yes | scrub or registry row; **the fenced wipe is in step 4** (see protocol) | — |
| wine-list mutations, ban-wipe wines write-back | yes | yes | fenced `mutateWines` (content: Redis first), row decision, `pgUpsertWine`, positions | — |
| set-role, settings PATCH, name PATCH | yes | yes | fresh grant, Postgres write | fenced `XX` meta apply |
| kick/ban/unban (`sessionWipe`) | yes | yes | member/ban rows, rating deletes | fenced Redis cleanup |
| `/visit`, `/join`, `ensureMember`, per-user heal | yes | yes | member row, eligibility | fenced identities `HSET` |
| rate POST / DELETE, bookmark | — | yes | row decision, rating upsert / delete | rating-key write (not shared state) |
| account deletion (§ 6) — ONE transaction over all the user's sessions | only for sessions being soft-deleted | one, via `withSessionLocks` in sorted code order | tombstone/provenance/kicked rows per session; soft-delete scrub + fenced wipe for empty hosted sessions; the user row last | fenced `d:` migration script per live session, from the committed mapping |
| `touchWithMeta`, `bumpLastSeen`, rate-limit keys | — | — | — | ephemeral |

Reads never take anything; a `u:` caller's authorization is the grant read (§ 4.7), a
plain `SELECT`.

**Walking B1's schedules through it** (unchanged in outcome, corrected in mechanism):

- *Role A pauses before its Postgres write; lease expires; B completes; A resumes; rebuild.*
  B takes the Redis lock and blocks on the advisory lock A holds. A commits its `UPDATE`
  (its entry check passed when it entered); its projection is refused (B's token). B then
  enters, reads the current state A left, applies the host's intent, commits, projects.
  Both stores end with B's role; and at no point did the cache *grant* anything the
  record denied, because it cannot. **Met.**
- *Promotion snapshots, pauses, loses its lease; anonymous add; promotion resumes.* The
  add's contract transaction blocks on the advisory lock promotion holds; promotion
  commits (durable); its `promotedAt` projection is refused (presentation only); the add
  proceeds, finds the row, mirrors. **Met.**
- *Old content mirror paused before its Postgres update; successor completes; old resumes.*
  Serialized by the advisory lock; whichever commits last projected the newest array
  (§ 4.6). **Met.**
- *DELETE loses its lease before or during the wipe.* The fenced `DEL` batches throw
  `'lost'` → ROLLBACK of the scrub and the registry row → 503. Keys already deleted are a
  partial cache loss over a still-live row → rebuild. **Met.**
- *Old session A's role apply after A was deleted and its code reallocated to B.* A's entry
  check 3b fails (`'gone'`); and a projection that somehow ran would be refused by B's
  lock holder or, unowned, land on a `meta` whose `createdAt` it does not match — the
  `XX` apply carries the incarnation in its value, and the fenced writer compares before
  writing. **Met.**

**The soft-delete protocol**, both paths (`app/api/session/[code]/route.ts` DELETE,
`lib/accountDelete.ts`), keeps its wipe *inside* step 4 — the one deliberate exception to
"projections after COMMIT", because here the Redis side is not a projection of new state
but the removal of all state, and the registry row is what makes a committed delete
visible afterwards:

```
withSessionMutation(code, { redisLock: true, expectedCreatedAt }, async (tx, fence, ctx) => {
  if row:        scrub it; orphan wines; delete session_members / session_bans / hall_of_fame …
                 INSERT session_tombstones (code, row.created_at)
  else if meta:  INSERT session_tombstones (code, meta.createdAt)          -- anonymous-only (R3-7)
  else:          throw 'gone'                                               -- 404
  capture cover URL (row or meta)
  fence.del(SCAN s:{CODE}:*)        -- fenced batches; refused ⇒ 'lost' ⇒ ROLLBACK
})
reclaimImage(cover)                 -- after COMMIT, as today
```

Crash analysis (process death; ordinary failures are the ROLLBACK branch above):

| Dies… | Postgres | Redis | Next state |
|---|---|---|---|
| before the wipe | rolled back | intact | nothing happened; retryable |
| mid-wipe | rolled back | partial | readiness pair missing → rebuild (Postgres-backed) or the anonymous-only session is gone — its data was never durable (ruling 3) |
| after the wipe, before COMMIT | rolled back (row live, no registry row) | empty | next open rebuilds — the delete did not happen, consistently |
| after COMMIT | tombstoned + registry row | empty | done; a late promotion finds the registry row → no row; a late content writer finds no `meta`/`wines` to `XX` into |

No window leaves a committed scrub with surviving readiness keys, and no window lets a
stale promotion commit after a committed delete. (The "after the wipe, before COMMIT"
row is a Redis side effect surviving a Postgres rollback — which is fine *here* because
the surviving effect is an absence that the record repairs, the opposite of R5-1's grant
that survives.)

**Mechanism 1 — NX to create, XX to update** — enforced by a lint rule on
`redis.set(k.meta(` / `k.wines(` call sites (like the `check-identity-writes` gate): the
create route, promotion and the rebuild write `meta` and `wines` with `NX`; every other
writer — settings PATCH (today `{ EX: ttl }`), name PATCH, set-role, `sessionWipe`,
account-delete pseudonymize, `mutateWines` — writes them with `XX KEEPTTL` (the settings
PATCH's lifespan change becomes `XX` + a separate `EXPIRE`). A wiped or evicted key cannot
be recreated by any later writer.

**Mechanism 2 — the fenced Redis lock.** `s:{CODE}:lock:ban` is the precedent and has
three defects (R1-2, R3-3): a blind `DEL` release lets a holder that outlived its lease
delete the *next* holder's lock; the writes a holder performs are not checked against
ownership, so a stale holder's `SET` lands over a successor's; and it lives under
`s:{CODE}:`, where `touchWithMeta` SCANs and re-EXPIREs every key to the full session
lifespan (`lib/redis.ts:78`). `lock:session:{CODE}` replaces it: outside the session prefix
(never touched, never wiped; `lock:` keys are self-TTL'd and never SCAN-swept, precedent
`lock:native-session-prune`), random token value, 15 s lease, bounded wait. It fences
*Redis* commands on shared-state keys and it is where contention waits. **It orders
nothing durable** — that is the advisory lock's job — and **nothing is granted on the
strength of what it fenced** — that is § 4.7's job.

**Mechanism 3's registry** (`session_tombstones`) is read only by promotion (§ 4.4).

### 5.5 Eviction is the normal case (ruling 5)

**What the instance does.** Prod Redis is Nine's On-Demand Key-Value Store, Valkey 9
(docs read 2026-11-07, `docs.nine.ch/docs/on-demand-services/key-value-store`): *"Stored
keys and values are persisted across instance restarts, but no backups are created"*;
*"By default, the policy `allkeys-lru` is used … Adjusting the max-memory policy will
cause the instance to restart"*; 256 MB RAM; `FLUSHALL` is prohibited on the service
(`FLUSHDB` allowed — relevant to the operator script, § 7). So: a restart keeps data, a
crash may lose the last writes, and under memory pressure the least-recently-read keys go
first, one at a time, with no regard for TTLs. At Verre's size (a session is a few KB)
pressure is far away, but the design must not depend on that.

**What LRU evicts first in a live session** — the keys the polls never read. The 5-second
`/state` poll touches meta, wines, identities and every rating key (MGET), so those are the
hottest keys in the instance. `bans` and `kicked` are cold. With § 4.7 that stops
mattering for logged-in users — their bans and kicks are read from the record on every
authenticated request — and matters only for anonymous identities, whose bans are
Redis-only by ruling 3.

**Three belts, in order of strength:**

1. **The record decides for logged-in users** (§ 4.7) — on every authenticated request,
   not only at entry points. A Redis `bans` miss cannot admit a banned `u:` user; a
   `kicked` miss cannot admit a kicked one on `/visit` (automatic) while `/join`
   (explicit) still clears the kick, exactly as `docs/dev/kick-ban.md` specifies (R3-9).
   The grant read also **re-seeds** the missing Redis entry it answers from (fenced,
   best-effort), so the cheap anonymous-path `SISMEMBER` is correct again from that
   moment (R2-11).
2. **Rebuild on readiness-pair loss, reconciliation, the ratings-scan trigger and
   `force`** (§ 5.1). Meta or wines gone → full projection, which reconciles bans, kicked,
   identities and meta lists against the record. Ratings gone → full projection.
   Identities gone → per-user heal.
3. **Per-key TTL drift is removed.** The only way a session key can expire on its own
   while its siblings live is a write that sets a TTL other than the session's: the rate
   route's re-assert writes its rating key with `EX: TTL` (48 h flat, `rate/route.ts:335`)
   instead of `KEEPTTL`; fixed at the cutover while in the file. `bumpLastSeen` sets its
   own TTL correctly.

**The residual, named:** a single evicted rating key among surviving ones is not restored
until the next trigger of any kind; a single evicted anonymous ban is gone (ruling 3,
unchanged from today). Anonymous data has no copy and is gone when evicted. `noeviction`
would remove the rating-key residual at the price of an outage mode and is rejected
(ruling 5); if the residual ever matters, the cheaper fix is a periodic `force` fill of
live sessions from the operator script, not a policy change.

## 6. Account deletion: one Postgres transaction, then cache projection

R1-12, R2-5, R5-3 and R6-1, confirmed. Today `lib/accountDelete.ts` finds the deleted
user's sessions by SCANning Redis and decides per session from Redis ratings; its
Postgres step keeps the global tombstone `UPDATE` (`:319`) and the `DELETE FROM users`
(`:349`) in **one transaction** (`:306`). That atomic boundary is the thing to keep.
Revision 6 split the durable work into one transaction per session and committed each
before deleting the user; R6-1's schedule shows why that is destructive: S1's ratings are
detached from a still-live account, S2 fails on every retry, the user signs in and rates
S1 again, and the retry mints a second tombstone for the same person in the same session
— the FK and the CHECK accept all of it. So:

🔒 **All irreversible durable per-session cleanup and the user-row deletion are one
Postgres transaction.** `withSessionLocks(tx, codes)` (§ 5.4) takes the per-code advisory
locks **in sorted code order** inside it (deterministic order → no deadlock with the
single-session writers, which take one lock each, nor with another account deletion,
which sorts the same way). Nothing is committed per session; a failure anywhere rolls
back everything, the user and every reference stay exactly as they were, and the
deletion is retryable without a progress table or a retry identity.

```
discovery (plain SELECTs, outside any lock) — a TENTATIVE plan, used only to reserve leases:
  hosted     = sessions WHERE host_user_id = $me AND deleted_at IS NULL
  touched    = session_members WHERE user_id = $me
             ∪ DISTINCT session_id FROM ratings WHERE user_id = $me
             ∪ DISTINCT session_id FROM wines   WHERE added_by_identity_id = 'u:<me>'
  candidates = hosted sessions that LOOK unengaged right now (no ratings row with
               user_id <> $me, tombstones counted; and, if live in Redis, no anon rating key)
Redis leases for `candidates` only, in sorted order (a wipe is a fenced Redis write; the
  Redis-before-advisory order holds)                                  -- 'lost' ⇒ abort, retryable
BEGIN
  withSessionLocks(tx, sorted(hosted ∪ touched))   -- advisory locks; entry checks per code
                                                   -- (readMeta only for leased codes; the rest is PG-only)
  for each session, in that order — DECIDE FRESH, UNDER THE LOCKS (R7-1A):
    re-read: live row, incarnation, engagement (ratings with user_id <> $me, tombstones
             counted; anon rating keys if the code is leased and live)
    hosted ∧ unengaged NOW ∧ leased:
              scrub, orphan wines, delete members/bans/hof, INSERT session_tombstones,
              capture cover URL, fenced DEL s:{CODE}:*   (refused ⇒ 'lost' ⇒ ROLLBACK)
    hosted ∧ unengaged NOW ∧ NOT leased  (became empty after discovery):
              throw 'replan'  ⇒ ROLLBACK, release leases, restart from discovery with this
              code added to the reservation set (bounded attempts, then fail retryably).
              Never take a Redis lease while holding advisory locks — the lock order holds.
    hosted ∧ engaged NOW  (someone rated between discovery and the lock, R7-1A):
              anonymize — exactly the `else` branch below; a reserved lease it no longer
              needs is simply released after COMMIT
    kicked (removed_state = 'kicked'): hard-delete the user's ratings here (§ 4.3)
    else:     mint tombstone_key K_s; stamp the user's ratings; rewrite provenance on the
              user's wines (K_s, '[deleted]'); null host columns if hosted; delete the
              session_bans row for 'u:<me>'
  account-level work as today (standalone ratings cascade, feed, follows, avatar, …)
  DELETE FROM users WHERE id = $me          -- the FK (and, after release B, the CHECK)
                                            -- refuses if anything above was missed
COMMIT                                      -- returns the mapping { code → K_s, wipedCodes }
release the leases
after COMMIT:  reclaimImage(covers)  ·  per live tombstoned session, the fenced d:
               migration script (§ 4.3) from the committed mapping  ·  DEL u:{me}:carouselhidden
```

🔒 **The outside-lock plan reserves; the inside-lock read decides** (R7-1A). Discovery
cannot be the engagement decision: another member can rate a hosted session between
discovery and the advisory lock, and a wipe based on the stale classification would
delete their engaged moment. So every per-session branch is chosen from state read
*under the session's advisory lock*, and the only thing the tentative plan contributes is
which Redis leases to hold before `BEGIN` — because a lease taken after the advisory lock
would invert the lock order. A session that became empty after discovery is a `'replan'`,
not an in-place lease grab; a session that became engaged is anonymized with the lease
unused.

- **Redis and the transaction.** Durable anonymization is PG-only: `withSessionLocks`
  skips the meta read for sessions that are not being wiped (`readMeta: false`), so a
  Redis outage does not touch the tombstone path. The **wipe** of an empty hosted session
  is the one Redis-dependent step and it is *inside* the transaction by the § 5.4 rule for
  deletes (the surviving effect of a crash is an absence the record repairs). If Redis is
  unreachable or a lease is lost, the whole account deletion fails **retryably** —
  the deletion fence is not waived to buy availability (R6-1). The migration scripts and
  the carousel key are projections after `COMMIT`: refused or failed → logged, and
  reconciliation (§ 5.1) or the operator script's `force` finishes them from the record,
  since the record already holds `K_s` and `wineToWire` already renders "[deleted]" for a
  gone user.
- **Lease duration — no pre-pass, no second transaction boundary** (R7-1B). The leases
  cover only the wipe candidates; the transaction renews them with a fenced `EXPIRE`
  between sessions, and a refused renew is `'lost'` → the whole transaction rolls back.
  Revision 7 had a fallback that pre-deleted a large wipe set in separately committed
  session DELETEs before the account transaction; that re-created exactly the boundary
  problem R6-1 fixed (S1 durably scrubbed — including the host's own ratings — then the
  account transaction fails and the account survives). It is gone. If a size or time bound
  is needed, it is enforced **before any durable change**: a candidate set larger than
  `ACCOUNT_DELETE_MAX_WIPES` (tens; the lifetime counters give the number up front) fails
  the request retryably with a message naming the count, and the owner's recourse is the
  ordinary per-session DELETE *as a separate, explicit action* with its own semantics —
  never as a silent implementation detail of account deletion.
- **Why not per-session commits with a retry identity**: it would need a durable
  "deletion in progress" marker on the account, a rule that stops a half-deleted account
  from rating again, and a way to re-associate retries with already-minted keys — three
  new concepts to replace one transaction boundary the current code already has.

`docs/dev/account-deletion.md` is rewritten accordingly.

## 7. Operator script

`scripts/rehydrate-sessions.mts` — run from a checkout with `tsx` against the target
`DATABASE_URL` + `REDIS_URL` (the Deplo.io image carries no `lib/`, so this cannot be a
scheduled job; it imports `lib/sessionRehydrate.ts` directly, which is the point — one
code path, not a second implementation). The sandbox or a dev machine must be on the
instance's allowed addresses; `FLUSHALL` is refused by the service, so the dev harness's
reset is not portable to prod and the script never needs it.

- Input: explicit codes, or `--active-since <days>` (live rows with a member joined,
  wine created or rating written in the window). Dry-run by default; `--apply` writes.
- Per code it prints: rebuilt (members / wines / ratings / bans / kicked), reconciled
  (entries removed), not-recoverable (tombstone groups, orphans), and reports codes whose
  keys already exist as no-ops. With `--force` it runs the reconciling fill over live
  sessions too — the periodic-fill option § 5.5 names if the residual ever matters, and
  the tool that finishes any deferred account-delete projection (§ 6, after COMMIT).
- Purpose: bulk warm-up after a known wipe so the Moments home does not show every moment
  as past until each is opened; and a verification tool during the build.

`scripts/backfill-session-meta.mts` (§ 4.2) is its sibling on the same runner.

**As built (release C).** How to run it, what `--force` may and may not change, the output and the exit codes: `docs/dev/deployment.md` § "Redis rehydration release C". The dry run shares the rebuild's planning step: `planPublish` (reads only) → `applyPublish` (the fenced MULTI, unchanged). It runs the same contract entry minus the Redis lease and writes nothing. The script never rebuilds a code without a live row, never retries a busy or refused code, and adds no Postgres write. Its Postgres sessions carry server-side timeouts, so a partition cannot hold a session's advisory lock past statement_timeout + idle_in_transaction_session_timeout. Tests: the `operatorScript` section of `scripts/tests/redis-rehydration-cutover.mts`.

## 8. Consequences to record

1. **"Live" in `/api/me/sessions` is unchanged in v1 — open point.** `status` and
   `pinned` still gate on `ttlAlive` (Redis presence). After a wipe a Postgres-backed
   moment reads `past` until someone opens it, then flips back on the next home load.
   Acceptable for v1; the clean follow-up is to define live by date window + membership
   for Postgres-backed moments and treat Redis presence as warmth only (the
   "new live definition" the 2026-06-12 durable-sessions note names). Needs its own
   ruling because it changes the carousel.
2. **The pro "extended lifespan" gate is vestigial for logged-in hosts** (ruling 2). It
   still sizes the cache TTL and the "expires in" display. Whether the web create keeps
   the picker is a product decision, not for this project; root `CLAUDE.md` § Freemium
   split must say what lifespan now means. (Ruled and shipped since: § 11 item 2.)
3. **Docs to update at the cutover**: root `CLAUDE.md` § Trust model gains "for a
   logged-in identity in a Postgres-backed session, authorization derives from committed
   Postgres state; the cache can deny, never grant" and § Two-tier persistence gets the
   § 3 table, the no-cross-store-transaction rule, the two mirror kinds and the three
   mechanisms; `app/api/CLAUDE.md` § Authorization tier resolution gets the grant read;
   `lib/CLAUDE.md` key namespace gains `lock:session:{CODE}`, the NX/XX rule, the mutation
   contract and its participation table, `d:` identities, and the "lists never rebuild"
   rule; `docs/dev/kick-ban.md` gains the `session_bans` mirror, record-decides for `u:`,
   the `d:` kick-delete branch and the Hall-of-Fame carve-out; `docs/dev/session-deletion.md`
   gets the contract transaction, the registry and the crash table;
   `docs/dev/account-deletion.md` gets § 6; `docs/dev/deployment.md` records the Valkey
   facts and ruling 5.
4. **Anonymous tasters after a wipe** hit `X-Vr-Auth: invalid` on their next call
   (token hash gone) and are bounced to `/join/<C>` as the existing protocol does; they
   rejoin as a new identity. This is the documented loss of ruling 3. The web copy on that
   bounce may deserve a line ("the moment was restored; please join again") — UI follow-up.
5. **The dev harness fix falls out for free.** `FLUSHALL` between sections no longer kills
   Postgres-backed moments; only anonymous fixtures need re-seeding. A pre-run Redis
   snapshot is no longer a prerequisite.
6. **Nine Valkey configuration — verified and ruled** (§ 5.5): persisted across restarts,
   no backups, `allkeys-lru`, 256 MB, kept as-is. Cockpit shows no memory usage; at a few
   KB per session the instance is at a small fraction of its size. If a real number is
   ever wanted, the cheapest way is a staff-gated diagnostics read of `INFO memory` from
   inside the app (Deplo.io containers are on the allow-list by default) — not in scope.
7. **Per-request and per-write cost.** Every authenticated session request now adds one
   indexed Postgres round trip (the grant read, § 4.7) beside the one it already pays for
   the revocation gate; every durable session write opens a short Postgres transaction
   with an advisory lock, including writes on anonymous-only sessions. Reads by anonymous
   identities, which are the bulk of a live tasting's polls, take nothing new. The
   cutover checklist measures both (§ 10).

## 9. Tests

One integration suite in `scripts/tests/` against real Postgres + Redis (CI runs the DB
suites with a throwaway Redis), wired into `check-schema.yml` like the catalog suites,
**run per deployable tree** (B3): the additive-release suite is the subset that holds
without the rebuild; the cutover suite is the whole list.

**Test orchestration for every "A pauses, B proceeds" schedule** (R5, amendment 4): the
harness pauses A at a named hook *while A holds its locks*, starts B, **asserts B is
blocked** (B's advisory-lock wait has not returned within a short bound), then releases or
aborts A, then awaits B. Never await B's completion before releasing A — that is a
harness deadlock, not a finding. Crash schedules kill A's **backend** (`pg_terminate_backend`)
or A's **worker process**, as named, and the asserting request is issued from a
**separate worker** so no cleanup of A's can run.

**Additive release (holds without any rebuild):**

- **Mirror completeness.** Every wine, ban and member written in a Postgres-backed session
  through the real routes has its row with the right `position`; anonymous adds included;
  `/join`- and `/rate`-only members have rows. The backfill script projects every live
  session's meta; re-running it is a no-op.
- **Stale-mirror token.** `mirror_at` equals the Redis `at` token for every write path.
- **Tombstones.** Account delete sets one `tombstone_key` per (user, session), rewrites
  provenance in Postgres and in a live Redis session, hard-deletes kicked-session
  ratings; the legacy migration leaves no `user_id NULL AND tombstone_key NULL` row; a
  brought-by wine reads "[deleted]" (R3-5). **One transaction (R6-1)**: user with ratings
  in S1 and S2, a kicked-session rating in S3 and a contributed wine; force a failure
  *after S1's durable statements have run* (hook inside the transaction before S2) → the
  attempt fails, the user and every durable reference are byte-for-byte unchanged; the
  user rates S1 again; retry → exactly one `d:` identity for them per session, S3's
  ratings gone, provenance "[deleted]", and warm vs rebuilt state agree. Kill the worker
  at the same boundary and repeat the assertions from another worker. **Redis** : force
  only the post-commit projection to fail → deletion completes, the record is correct, a
  later `force` rebuild projects the `d:` group that warm repair also shows; Redis
  unreachable with no empty hosted session → deletion completes (PG-only path, no Redis
  command issued — asserted via MONITOR); Redis unreachable *with* an empty hosted
  session → deletion fails retryably, nothing changed. **Fresh decisions (R7-1A)**: pause
  the deletion after discovery classifies hosted S as a wipe candidate; another member
  rates S; resume → the account is deleted, S stays live with the other member's rating
  and an anonymized host, and the unused lease is released. Pause after discovery
  classifies S as engaged; the only other rater deletes their rating; resume → `'replan'`:
  no durable change from the first attempt, the restart reserves S and wipes it; assert
  no Redis lease is ever acquired while an advisory lock is held (MONITOR order). **No
  pre-pass (R7-1B)**: force the large-candidate path — the request fails *before* any
  durable statement; with the bound raised, let S1's scrub statements run, fail at S2 and
  separately kill the worker → user row and every session's durable state unchanged; a
  later retry completes once and projects the mapping only after the single commit.
- **Old writer against A's schema (R6-2).** Run today's account-delete SQL
  (`SET user_id = NULL, rater_name = '[deleted]'`, no key) against release A's expanded
  schema for a user with a session rating → it succeeds (no CHECK yet). Then with A's
  writer deployed, plant a legacy both-NULL tombstone as the overlap interval would, apply
  B's migration → catch-up stamps it, validation passes, the CHECK is added; a new
  session rating with both identities NULL is then rejected; a valid deletion succeeds.
  Include "A's application deploy failed after A's migration ran": the old writer keeps
  working until a compatible release lands.
- **Registry.** Both delete paths write `session_tombstones`, including for an
  anonymous-only session.

**Cutover (everything above plus):**

- **Round trip.** Create a logged-in-hosted moment through the real code: cohost +
  provider + taster, a rater who only `/join`ed and rated (no `/visit`), wines in a
  reordered order with one inserted mid-list, one brought by the soon-deleted user, one
  revealed, ratings incl. a chips-only one, one kicked member, one banned identity, one
  tombstoned rater. Snapshot every `s:{CODE}:*` key, `FLUSHALL`, call `ensureSessionLive`,
  diff key by key. Expected differences: `tokens`, `lastseen`, anon entries — and nothing
  else.
- **Field coverage.** `tsc` (the `Record<keyof …>` constants); plus a runtime check that
  every `'rebuilt'` field round-trips in the fixture above.
- **Record grants, cache denies (R5-1)**: (1) kill the worker after a cohost grant's Redis
  `EXEC`-equivalent (test hook: perform the projection *before* commit to simulate the old
  order, then kill before `COMMIT`) — from a separate worker, a privileged request by that
  user (settings PATCH, wine delete, blind wines GET) is 403 / redacted, with `meta` and
  `wines` untouched; (2) the same with the projection landed and the commit *succeeded* →
  200; (3) an unban whose Postgres transaction is aborted after the Redis `SREM` → the
  user's `/visit` and poll are still bounced; (4) a cached `coHostIds` entry inserted by
  hand for a `u:` user the record has as taster → 403 on every host action, badge still
  shown until the next reconciliation; (4b) the same with a cached `providerIds` entry →
  the wine PATCH/DELETE own-wine checks are 403 (the `isProviderById` signature change,
  § 4.7); (5) an anonymous cohost (`a:`) keeps host powers from meta alone; (6) a
  strict-host "ban a cohost" check against a target whose cached role is cohost but whose
  record says taster → treated as a taster (fresh target read inside the transaction).
- **Idempotent / no-op.** Readiness pair present → zero writes (MONITOR tap); two
  concurrent ensures → one rebuild; `force` over a session with only `bans` missing
  re-seeds bans and changes nothing else (R3-6); an empty-roster anon-hosted session
  rebuilds once and reads `'live'` afterwards (R2-10).
- **Soft-deleted → `'absent'`**; **anon-only (no row) → `'absent'`**; lock held past the
  wait → `'restoring'` and the route answers 503 + `Retry-After`, never 404.
- **NX/XX.** After a wipe, a settings PATCH / set-role / `mutateWines` call built on stale
  in-memory meta creates nothing; the lint gate fails on a `redis.set(k.meta(` without
  `NX` or `XX`.
- **B1 schedules** (§ 5.4), each with a pause hook and the orchestration rule above:
  (1) role A paused holding the advisory lock before its Postgres write, B asserted
  blocked, A's lease expired, A released → A commits, A's projection refused, B proceeds
  → both stores hold B's role, and at no instant did a request from a third worker get
  cohost powers for the target beyond what the record said; (2) promotion paused after
  its snapshot, anonymous add asserted blocked, promotion's lease expired, released → the
  wine is in Postgres exactly once; (3) old content mirror paused, successor blocked,
  released → Postgres holds the successor's array; (4) DELETE loses its lease before /
  during the wipe → row live, no registry row, 503, next open rebuilds; (5) session A
  deleted and its code reallocated to B, then A's delayed projection runs → B's keys
  intact.
- **Deletion races and crashes** (R2-1, R2-2, R3-2, R3-7): rebuild in flight vs DELETE;
  rate POST holding live meta vs DELETE (no new row); promotion paused after its checks
  vs DELETE (registry row, nothing created); ban in flight vs DELETE (no ban row
  survives); DELETE's worker killed after its wipe before COMMIT (row live, rebuild);
  rebuild whose backend was terminated after the read and whose lease expired, DELETE
  completes, rebuild's callback publishes → `EXEC` null, nothing written; anonymous-only
  DELETE → keys gone, registry row, a later stale promotion creates nothing.
- **B2 schedules** (§ 5.1): (1) kick committed, projection forced to fail → the user's
  next poll answers `removed` (grant read), their retained ratings are hidden from live
  views after the next reconciliation and present in their own history; (2) evict only
  identities for a historical rating author without a member row → next poll answers
  200 and the hash holds them; (3) **healer with a dead backend (R5-2)**: terminate the
  healer's backend after its eligibility read, complete a kick (which takes the Redis
  lock), resume the healer's callback → its fenced `HSET` is refused, the user's poll
  stays `removed`; (3b) healthy healer paused holding the advisory lock, kick asserted
  blocked, healer released → kick removes the entry after the heal; (4) explicit `/join`
  after a kick re-admits; `/join` while banned is rejected.
- **Fencing (Redis lock).** Holder sleeps past the lease; a second holder acquires and
  performs a role change; the first holder's fenced projection is refused; its release
  does not delete the second holder's lock (R3-3).
- **Stale-mirror ordering** (R1-3). Rating v1 committed, v2 committed with `rated_at(v2) <
  mirror_at(v1)`, flush, rebuild, replay v1's delayed re-assert → Redis holds v2.
- **Tombstones, live.** Partial rebuild over a session with a live-migrated `d:` rater →
  exactly one roster entry (R2-3); a `u:<id>` entry whose user is gone is removed and its
  wine reads "[deleted]"; the migration script over a session with half its rating keys
  evicted completes for the rest and is a no-op when re-run; host kick-deletes a `d:`
  identity → its ratings removed, wines' provenance untouched; ban/kick-keep of a `d:` →
  400 (R2-8).
- **Roster** (R3-4). A kick-keep user with retained ratings is absent from the rebuilt
  identities and present in `kicked`; their poll answers `kicked`; their explicit `/join`
  re-admits them.
- **Anon host.** Rebuilt meta has no `hostIdentityId`; a cohost's DELETE succeeds and its
  wine edit succeeds; a taster's DELETE and settings PATCH are 403.
- **Eviction belts** (R1-6, R2-11, R3-9). Delete only `bans`: the banned `u:` identity's
  `/visit`, `/join` and poll are bounced and the set contains them again. Delete only
  `kicked`: `/visit` bounces and re-seeds; `/join` admits and clears `removed_state`.
  Delete only the rating keys: the next `/ratings` read restores them.

Keep it proportionate: one suite, one fixture, the invariants above. No per-route
permutation testing — the route changes are mechanical call-site insertions.

## 10. Rollout: one additive release, one behaviour cutover

B3 (closed in round 5): **nothing that refuses, invalidates or expects a rebuild ships
before the rebuild.**

| Release | Ships | Gate |
|---|---|---|
| **A — additive** | Migration (§ 4.2: columns, `session_bans`, `session_tombstones`, the legacy tombstone + provenance backfill — **no CHECK yet**, R6-2) · `sessionMetaToColumns` at all three sites · row-existence mirrors (`pgUpsertWine` for every caller) · `ensureMember` on visit/join/rate · position renormalization on every list write · `session_bans` writes in the ban txn / unban / both deletes · `session_tombstones` writes in both deletes incl. the anonymous-only branch · `mirror_at` writes · **account deletion as § 6** (one transaction; the account-level advisory locks are the only part of the contract that ships here, taken with `withSessionLocks` against today's single delete transaction) with the `d:` identity support · the backfill script. **No** NX/XX rule, **no** Redis lock replacement, **no** grant read, no behaviour change a user can see. The old writer and A's writer are both valid against A's schema. | Additive suite green (§ 9) incl. the old-writer compatibility case; `check-schema.yml` green; deploy; **run the backfill** |
| **B — cutover** | Migration: **legacy catch-up + validation + the CHECK** (R6-2), its body added to the contract-shape gate · `lib/sessionMutation.ts` (the contract, the fenced lock replacing the ban lock, the participation table) · **the grant read in `participantOrBanned` and the helper-signature audit** (§ 4.7) · promotion inside the contract with the registry check and `promotedAt` · roles / kicks / bans as commit-then-project · the NX/XX rule, its lint gate, `mutateWines` reject-on-absent · the soft-delete protocol · `lib/sessionRehydrate.ts` with the eligibility rule and reconciliation · `ensureSessionLive` first in every session route and the join page · the fenced per-user heal · the ratings-scan trigger · the entry-point re-seeds · the DELETE name-branch fix (§ 4.5) · the rate re-assert TTL fix · scoped invalidation · the cutover suite · the doc updates (§ 8.3) | Cutover suite green on the exact tree being deployed; **backfill re-validated** (every live session's meta columns non-NULL; zero both-NULL session ratings before the CHECK is added); miss-path load probe, per-request grant-read cost and per-write contract cost recorded; dev: `FLUSHALL` then open a moment; inject a role-projection failure and a wines-only eviction on the staged tree → next request heals or returns 503, never a 404 for a live durable session, and no privilege the record lacks |
| **C — tooling** | Operator script (§ 7) | — |

Release A is safe on its own: every change is an extra column, an extra row, an extra
mirror write on a path that already mirrors, or a restructuring of account deletion that
makes it stricter (it can now stop and report instead of half-applying). Release B is
the behaviour change and is tested as the tree it is. Branch `feature/redis-rehydration`
for each; the diffs touch auth-adjacent code (bans, roles, delete authorisation, account
deletion) and schema, so each gets the reviewer rule.

## 11. Open items (all RULED, owner, 2026-11-08)

1. `/me/sessions` live definition (§ 8.1). **RULED: no change.** `status` and `pinned`
   stay on Redis presence (`ttlAlive`): wipes are rare, the operator script warms after
   one, and item 2 removes natural expiry for every logged-in moment.
2. Web lifespan picker after ruling 2 (§ 8.2). **RULED and SHIPPED** (branch
   `feature/web-lifespan-unlimited`): every logged-in create, web and native, is
   `unlimited` (a body `lifespan` is ignored); PROMOTION sets the row to `unlimited` and
   re-stamps every key's TTL after COMMIT (`expireSessionKeys`, fenced, inside
   `ensurePromoted`'s projection); anonymous (Redis-only) moments keep 48h and any other
   value is a 403. The picker is gone from the web create, the web settings and the
   anonymous lobby (replaced there by "Guest moments last 48 hours. Sign in to keep
   yours."). Pro no longer includes a lifespan. Existing moments keep their stored
   lifespan (no backfill); the settings PATCH `lifespan` path is vestigial, kept for API
   stability.
3. The anonymous-taster bounce after a wipe (§ 8.4). **RULED: no change** (no "moment
   restored, please rejoin" copy).

## 12. Review findings and resolutions

Every finding was re-checked against the cited lines before being accepted; all held.

**Round 1** (revision 1 → 2, `.local/redis-rehydration-codex-review.md`):

| # | Finding (short) | Resolution (where it lives now) |
|---|---|---|
| R1-1 | P1 — `pgUpsertSession` re-creates a scrubbed row; rebuild makes the phantom reachable | § 4.4 promotion inside the contract + registry + incarnation |
| R1-2 | P1 — lease without fencing; `touchWithMeta` extends lock TTLs | § 5.4 mechanism 2 |
| R1-3 | P1 — `rated_at` is not the mirror token | § 4.3 `ratings.mirror_at` |
| R1-4 | P1 — skipping tombstoned ratings removes data survivors see | § 4.3 `ratings.tombstone_key` |
| R1-5 | P1 — dropping the login gate ≠ promotion; `/visit` copies no lineup | § 4.4 promotion snapshot; mirrors on row existence |
| R1-6 | P1 — partial eviction of `bans` is an authorization hole | § 4.7 record decides; § 5.5 belt 1 |
| R1-7 | P2 — chokepoint misses entry paths | § 5.1/5.3 `ensureSessionLive` first in every route |
| R1-8 | P2 — contention must not be 404 | § 5.1 `'restoring'` → 503 |
| R1-9 | P2 — ban rows outlive anon-only sessions; in-flight bans | § 4.2 rows only for Postgres-backed sessions, contract txn |
| R1-10 | P2 — position insert/NULL/ordering | § 4.6 renormalize inside the contract |
| R1-11 | P2 — write matrix incomplete; live sessions need a backfill | § 4.2 `sessionMetaToColumns` + backfill script |
| R1-12 | P2 — account deletion discovers via Redis SCAN | § 6 Postgres discovery |
| R1-13 | P2 — fixture reflection cannot enforce coverage | § 5.2 `Record<keyof T, …>` |
| R1-a–d | best-effort mirrors; ruling-4 wording; miss load unmeasured; Valkey unverified | § 3 two mirror kinds; ruling 4; § 10 load probe; § 5.5 verified |

**Round 2** (revision 2 → 3, `…-round-2.md`):

| # | Finding (short) | Resolution |
|---|---|---|
| R2-1 | P1 — Redis fencing does not protect the promotion's Postgres commit | § 4.4/§ 5.4 advisory lock to COMMIT + registry |
| R2-2 | P1 — scrub-then-wipe not crash-safe | § 5.4 wipe inside the delete transaction; crash table |
| R2-3 | P1 — partial rebuild duplicates deleted raters | § 4.3 live migration to `d:`; orphan `u:` reconciliation |
| R2-4 | P1 — best-effort role mirror restores revoked cohost | § 4.7 record grants, cache denies |
| R2-5 | P2 — `/join` and `/rate` leave no member row | § 4.4 `ensureMember`; § 5.1 eligibility union |
| R2-6 | P2 — legacy tombstoned rows still vanish | § 4.3 one `d:` per session backfill + CHECK |
| R2-7 | P2 — tombstone groups resurrect kicked raters | § 4.3 kicked-then-deleted ratings hard-deleted |
| R2-8 | P2 — `d:` identities fail validation / cannot be moderated | § 4.3 `d:` valid for targeting; kick-delete branch |
| R2-9 | P2 — promotion persists the caller's stale meta | § 4.4 snapshot inside the contract |
| R2-10 | P2 — empty roster can never satisfy a three-key readiness check | § 5.1 readiness pair = meta + wines |
| R2-11 | P2 — bans-only test contradicts the algorithm | § 5.5 belt 1 re-seeds; `force` |

**Round 3** (revision 3 → 4, `…-round-3.md`):

| # | Finding (short) | Resolution |
|---|---|---|
| R3-1 | P1 — locks serialize nothing between promotion and content writers; stale writers recreate keys | § 5.4 contract + mechanism 1 |
| R3-2 | P1 — aborted Postgres transaction releases the advisory lock while the process can still publish | § 5.1/§ 5.4 publish fenced by the Redis token; nothing durable rides on it |
| R3-3 | P1 — the Redis lock fences release only | § 5.4 every shared-state write fenced |
| R3-4 | P1 — rating-author union re-admits kicked users | § 5.1 eligibility rule; § 4.7 record decides |
| R3-5 | P1 — deleted person's name leaks via wine provenance | § 4.3 provenance rewrite; gone-user fallback |
| R3-6 | P2 — `force` exits at the second readiness check | § 5.1 `force` skips both |
| R3-7 | P2 — anonymous-only sessions become undeletable | § 5.4 Redis-only branch writes the registry |
| R3-8 | P2 — identities-hash eviction is fatal on mobile | § 5.1 per-user heal, fenced |
| R3-9 | P2 — kick entry check blocks the permitted rejoin | § 5.5 belt 1 kick/ban asymmetry |
| R3-10 | P2 — Hall-of-Fame has no tombstone key | § 4.3 HoF excluded |
| R3-11 | P2 — tombstone stamping in phase 2 leaves a backfill gap | § 10 release A carries the stamping |

**Round 4** (revision 4 → 5, `…-round-4.md`) — three consolidated contracts:

| # | Contract | Resolution |
|---|---|---|
| B1 | P1 — a Redis fence cannot order Postgres decisions | § 5.4 `withSessionMutation`: every durable writer participates, decisions inside, COMMIT serialized; `'lost'` → ROLLBACK; DELETE rolls back on a refused wipe; incarnation check; scoped invalidation (failure behaviour corrected in R5-1) |
| B2 | P1 — authorization repair must reconcile, not insert | § 5.1 one `eligibleRoster` rule; identities/bans/kicked/meta lists reconciled both ways; heal inside the contract (fenced per R5-2) |
| B3 | P2 — phase 1 shipped behaviour whose recovery is in phase 2 | § 10 release A additive only; release B everything together, tested as the deployed tree — **closed in round 5** |

**Round 5** (revision 5 → 6, `…-round-5.md`) — three amendments:

| # | Finding (short) | Verified? | Resolution |
|---|---|---|---|
| R5-1 | P1 — a Redis `EXEC` before Postgres `COMMIT` is not undone by rollback; process death leaves a cached grant the record never had; `MULTI` does not roll back on runtime errors | Yes: `isHostByIdentity` reads only meta (`lib/session.ts:332`); no handler survives a kill | § 3 no cross-store transaction, ever; § 4.7 **the record grants, the cache only denies** — grant read once per authenticated request in `participantOrBanned`, `isHostByIdentity`/`isProviderById` answer from it for `u:` callers; security projections after COMMIT; § 4.3 the `d:` migration is an idempotent, skip-missing Lua script; independent-worker crash tests in § 9 |
| R5-2 | P1 — the advisory-only heal can `HSET` after its transaction died | Yes: same class as R3-2 | § 5.1 heal (and `/visit`, `/join`, `ensureMember` registration) takes the Redis lock and writes fenced; § 5.4 Redis-lock criterion widened to every shared-state key; dead-backend test in § 9 |
| R5-3 | P1 — "retry, then leave the session untouched and proceed" skips mandatory durable cleanup; the global tombstone UPDATE would then strand rows with no identity, or the `users` FK would fail | Yes: `lib/accountDelete.ts:319`, FK `NO ACTION` | § 6 durable per-session work is a prerequisite of the user-row delete and stays retryable on failure (made one transaction in R6-1); § 4.3 CHECK `ratings_session_rater_known` makes the bad end state unrepresentable (enforced in release B per R6-2); exhausted-retry and Redis-unreachable tests in § 9 |
| R5-4 | test orchestration — awaiting B before releasing A deadlocks the harness | Yes | § 9 orchestration rule: assert blocked, release A, then await B |

**Round 6** (revision 6 → 7, `…-round-6.md`) — R5-1 and R5-2 closed; two local corrections:

| # | Finding (short) | Verified? | Resolution |
|---|---|---|---|
| R6-1 | P1 — per-session commits make a failed account deletion destructive (S1 detached from a live account, S2 fails, user rates S1 again, retry mints a second `d:` for the same person); the Redis-outage promise contradicted the wipe branch and the helper's unconditional meta read | Yes: today's delete is one transaction (`lib/accountDelete.ts:306`, `:319`, `:349`); the rate upsert is unique only for non-NULL `user_id` (`rate/route.ts:244`) | § 6 one Postgres transaction over all sessions + the user row, advisory locks via `withSessionLocks` in sorted code order, mapping returned for post-commit projection; § 5.4 `readMeta: false` PG-only form; a wipe needs its lease and fails retryably when Redis is down — the fence is not waived; lease renewal and the many-empty-sessions bound stated |
| R6-2 | P2 — the CHECK in release A rejects the old writer's `SET user_id = NULL` during Deplo.io's migrate-before-release interval | Yes: `.deploio.yaml:5`; `lib/accountDelete.ts:319` | § 4.3/§ 10 CHECK moves to release B after a catch-up backfill + validation; its body joins the contract-shape gate; old-writer compatibility test in § 9 |
| R6-m | mechanical — `isProviderById` takes a bare id; `isStrictHost`/`isCohostId`/inline role arrays/ban targeting must consume the grant; targets read fresh in the transaction | Yes: `lib/session.ts:362`, `[wineId]/route.ts:43`, `:329` | § 4.7 audit list; stale-provider and stale-target tests in § 9 |

**Round 7** (revision 7 → 8, `…-round-7.md`) — R6-2 closed; two edits in § 6:

| # | Finding (short) | Verified? | Resolution |
|---|---|---|---|
| R7-1A | P1 — `toWipe` decided outside the locks and acted on without revalidation: a member who rates between discovery and the lock has their engaged moment deleted | Yes — a decide-outside-lock bug of my own making | § 6 discovery is a tentative plan that only reserves leases; every branch is decided from state re-read under the advisory lock; became-engaged → anonymize; became-empty-without-lease → `'replan'` (rollback, restart with the revised reservation; never a lease grab under advisory locks) |
| R7-1B | P1 — the many-empty-sessions fallback pre-committed session deletes before the account transaction, re-creating R6-1's boundary problem | Yes | § 6 fallback removed; a size bound, if any, fails the request before any durable statement; per-session DELETE remains a separate explicit action, never an implementation detail of account deletion |
