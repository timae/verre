# Live-moment recovery: rehydrating Redis from Postgres

**Status:** ROUGH IDEA, not a proposal yet. Recorded 2026-11-06 as the next project after the dependency upgrades (`dependency-upgrades.md`). **The full proposal has to be written and reviewed before any code** — nothing below is a decision.

## Why

Live moments exist only in Redis/Valkey (`s:{CODE}:*`, TTL-bound); Postgres is an incremental archive, not something the live screens can serve from. Anything that empties the key-value store — a restart without persistence, a failover, memory eviction, a migration, or (in dev) the harness's per-section `FLUSHALL` — makes every live moment show "This moment has ended" with no recovery path. Observed 2026-11-06 in dev after the Phase 1 harness run: every moment ended; the pre-run `pg_dump` restored accounts and history but not the live state.

The structural fix stays the planned Postgres-authoritative session model (`wine-catalog-model-change.md` § Postgres-authoritative occurrences, Redis as a revision-stamped cache). This project is the smaller, earlier piece: an **operator recovery tool** that rebuilds what Postgres can prove, states what it cannot, and never pretends to be complete.

## What Postgres can rebuild today (checked against the schema, 2026-11-06)

- `s:{CODE}:meta` — from `sessions`: name, dates, timezone, address, description, link, category, cover photo, `blind`, `blind_for_everyone`, host name, `host_user_id` (→ `hostIdentityId = u:<id>` when the host was logged in). Cohosts from `session_members.role = 'co_host'`.
- `s:{CODE}:wines` — every archived `wines` row maps onto `WineMeta` (name, producer, vintage, grape, type, image URL, description, region, country, vinification, purchase URL, `revealed_at`, catalog links).
- `s:{CODE}:r:u:<id>:<wineId>` — logged-in users' `ratings` (score, flavors, aromas, notes, `rated_at`).
- `s:{CODE}:identities` — logged-in participants from `session_members` (display names from `users` / `rater_name`).

## What is NOT recoverable, or not to be taken for granted

Each of these needs its own answer in the full proposal — either a durable source is added to Postgres first, or the tool documents the loss explicitly and the UI copes with the gap.

- **Provider role assignments** — not in `session_members` (only `host` / `co_host` / `taster`). Either mirror providers to Postgres (the cohost mirror precedent: PR #66) or accept that providers come back as tasters.
- **Wine order** — Redis holds the array order; Postgres has `created_at` only. Reorders are lost unless a position column is archived.
- **Who-brought-what for anonymous adders** — `added_by_identity_id` / `added_by_display_name` survive for logged-in adders; anonymous `a:<uuid>` ids have no identities-map entry to resolve against after a wipe.
- **Last-seen stamps** — ephemeral by design (`s:{CODE}:lastseen`, never archived). Decide whether "Just visited" simply resets, and say so.
- **Kicks and bans** — `s:{CODE}:bans` / `s:{CODE}:kicked` are Redis-only. A rehydrated moment would silently re-admit banned identities unless bans are archived first. `session_members.removed_state` may cover part of this — verify.
- **Pro lifespan choice** — the TTL is not stored in Postgres; the tool has to pick one (default 48 h? the host's pro setting? unlimited?). Needs a ruling, and `KEEPTTL` semantics must hold after the rebuild.
- **Anonymous participants and their ratings** — never archived; gone. Anonymous *hosts* leave a moment nobody can administer.
- **Wines and ratings that never reached Postgres** — archival is incremental (logged-in rate/join only), so a moment with only anonymous activity archived nothing. The seed fixture (`.local/seed-fixtures.ts`) writes Redis directly and has the same blind spot.

## Shape to decide in the full proposal

- Operator-run script (`scripts/`), input = explicit list of codes, explicit TTL, logged-in data only, dry-run by default, prints per-moment what was rebuilt and what was lost. Not an endpoint.
- Whether to first archive the missing state (providers, bans, wine order) so the tool has a durable source — which is also a down payment on the Postgres-authoritative model.
- Prod prerequisites regardless of the tool: confirm Nine's Valkey persistence (RDB/AOF) and `noeviction` policy — neither is documented in the repo.
- Dev prerequisite: snapshot the dev Redis alongside the `pg_dump` before any harness run.
