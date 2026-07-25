# Deployment (Deploio / Nine)

- Hosted on Deploio, deployed from `main` on push (Dockerfile build).
- Postgres + Redis + S3-compatible Object Storage all on Nine. Specific app names, project IDs, hostnames, and live URLs are intentionally not in this file — see the Deploio dashboard.

## 🔒 Trusted-proxy / client-IP posture (load-bearing for rate limiting)

Rate-limit keys are derived from the client IP (`lib/rateLimit.ts` `getClientIp` — used by the web **login** throttle (`auth.ts`), register, session create/join, AND Better Auth's native atomic floor). The IP is trustworthy **only because Deplo.io's TLS-termination proxy overwrites `X-Forwarded-For` with the real connecting client IP** and parks any client-supplied value in a *separate* header `X-Original-Forwarded-For` ([docs.nine.ch HTTP headers](https://docs.nine.ch/docs/deplo-io/http-headers/)). So `X-Forwarded-For` as the app receives it is a **single trusted IP**; the leftmost entry is set by the proxy, not the client. `getClientIp` reads it accordingly and treats a *multi-entry* XFF as untrusted (falls back to `X-Real-Ip`, then a shared `unknown` bucket).

**Invariant — do not violate without re-auditing rate-limit keying:**

1. **No untrusted CDN/proxy in front of Deplo.io.** Today Verre is served directly by Deplo.io's ingress (no Cloudflare etc.). Putting an untrusted proxy in front would let a client spoof `X-Forwarded-For`, and rate-limit/geo keying would trust the forged value. If a CDN is ever added, it must be a *trusted* proxy and `getClientIp` must be updated to skip the now-additional hop.
2. **Never read `X-Original-Forwarded-For`** as the client IP — that header IS the client-supplied (untrusted) value Deplo.io deliberately moved aside.
3. **The `unknown` fallback is fail-safe ONLY while the overwrite invariant holds.** Behind Deplo.io a multi-entry XFF can't occur (proxy overwrites → single entry), so `getClientIp` never actually reaches the shared `unknown` bucket on a real request. If multi-entry XFF ever becomes reachable in prod (a CDN added, the proxy reconfigured), the `unknown` fallback turns into a shared-bucket lever an attacker can deliberately land in to exhaust the limit for other `unknown`-bucketed callers — re-audit the fallback then (prefer per-trusted-hop keying over `unknown`).

⚠️ **Two-layer native limiter, different keying on the untrusted edge.** Better Auth's *own* limiter (the belt) uses its `getIp`, which trusts the **leftmost** XFF entry even on a multi-entry header — it was NOT hardened like `getClientIp`. Verre's atomic floor (the braces, the before-hook in `lib/betterAuth.ts`) uses the hardened `getClientIp`. On the expected single-entry XFF both agree; they diverge only on a (currently-unreachable) multi-entry XFF, where the belt keys on the spoofable leftmost and the floor keys on `unknown`. Harmless to the cap — the floor still applies and fails closed — but the two layers are NOT identical in keying; don't assume the belt inherits the hardened posture.

## Env vars set on Deploio (values not stored in repo)

- `REDIS_URL`, `DATABASE_URL` — service connections.
- `AUTH_SECRET` — NextAuth + register-token HMAC. (`NEXTAUTH_SECRET` / `JWT_SECRET` accepted as fallback names by `auth.ts` and `lib/registerToken.ts`.) Better Auth (`lib/betterAuth.ts`) signs with the same secret.
- `AUTH_URL` — public base URL; Better Auth builds callback/redirect URLs from it (fallback chain: `AUTH_URL` → `BETTER_AUTH_URL` → `NEXTAUTH_URL` → dev `http://localhost:3000`). Prod already sets `NEXTAUTH_URL`, which the chain picks up; setting `AUTH_URL` explicitly is still preferred.
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` — Object Storage.
- `SERVER_ACTIONS_ALLOWED_ORIGINS` — comma-separated extra origins for Server Actions CSRF (deployed hostname; `localhost:8080` always allowed; no scheme).
- `PUBLIC_HOSTNAME` — used as contact info in the Nominatim User-Agent header when `GOOGLE_PLACES_API_KEY` is unset; falls back to `'self-hosted'`.
- `GOOGLE_PLACES_API_KEY` (optional) — when set, `/api/places` uses Google Places; when unset, falls back to OSM Overpass + Nominatim.
- `NEXT_TELEMETRY_DISABLED=1` — opts out of Next.js anonymous build/usage telemetry.
- `GEO_DATA_DIR` (optional) — where the app keeps the downloaded IP→country lookup files; defaults to `/tmp/verre-geo`. Must be a writable dir. Override only if `/tmp` isn't writable on the runner.
- `NATIVE_MIN_VERSION_IOS` / `NATIVE_MIN_VERSION_ANDROID` (optional — **unset in prod until a non-redeployable install exists**) — min-supported native client version (`lib/clientVersion.ts`). When set, native requests whose `X-Verre-Client` header reports an older version get a structured 426 at the `/api/auth/native/*` chokepoint and the app shows its blocking update screen. Unset ⇒ no enforcement (web traffic is never affected — it sends no header).
- `NATIVE_STORE_URL_IOS` / `NATIVE_STORE_URL_ANDROID` (optional) — App Store / Play link embedded in the 426 body; the update screen's button. Meaningless until the app is in a store.
- `DATABASE_CONNECTION_LIMIT` / `DATABASE_POOL_TIMEOUT` / `DATABASE_STATEMENT_TIMEOUT_MS` (all optional; unset ⇒ Prisma's defaults, unchanged) — database pool + runaway-query controls (`lib/prisma.ts`). 🔒 **Why they exist:** the app previously set no `connection_limit` at all, so Prisma queues FIFO but the queue has a deadline: after `pool_timeout` (default 10 s) a waiting request fails with **`P2024`**. Measured against a large catalog, concurrent expensive searches exhausted the pool and a majority timed out rather than completing slowly. ⚠️ These knobs BOUND the failure; they do not create capacity — for real horizontal scale the answer is a pooled endpoint (PgBouncer in transaction mode) with a separate direct URL kept for migrations. `DATABASE_CONNECTION_LIMIT` is per app instance, so size it as `(max_connections − headroom) / instances`; setting it too high is not more throughput, it risks exhausting the server's connection slots and locking out migrations. `DATABASE_STATEMENT_TIMEOUT_MS` is the backstop a pool size cannot provide — it bounds a single runaway query that would otherwise hold its connection indefinitely. ⚠️ It is applied via libpq `options` on the connection string, **not** by issuing `SET statement_timeout` after connecting: verified that a post-connect `SET` reaches exactly ONE pooled backend and leaves every other connection on the default. Set it generously — a fence, not a latency target (realistic catalog search measures 0.9–41 ms at 300k rows).
- `CATALOG_PUBLIC_ENABLED` (optional — **leave unset until wine-catalog phase 3 ships**) — the wine-catalog release fence (`lib/catalogGate.ts`). Only the literal string `'true'` opens catalog search + entry creation to ordinary users; anything else (including unset) returns **404** — not 403, so an unreleased surface isn't advertised. **Staff (`staff_roles` curator or admin) bypass the switch always**, so the add-flow can be dogfooded and the matcher tuned while it is closed to everyone else. 🔒 The default-off state is a deliberate release boundary, not caution: phase 2 lets users mint catalog entries, and phase 3 is what adds the review queue that confirms/merges/rejects them — an *unreviewed provisional* is a valid steady state, whereas *publicly searchable user-authored content with no moderation path* is not. Flipping this on before phase 3 leaves no supported way to handle abuse, junk, or duplicate accumulation. Setting it to `'true'` for one deploy is also how a limited external cohort would get access.

### Mobile app build-time env (`apps/mobile`, NOT Deploio server vars)

`EXPO_PUBLIC_*` vars are **inlined into the JS bundle at build/export time** — set in `apps/mobile/.env.local` (gitignored; `.env.example` is the template) or per build command, never on the server. Change one ⇒ rebuild.

- `EXPO_PUBLIC_API_URL` — backend the app talks to (Simulator → `localhost:3000`; device → Mac LAN IP).
- `EXPO_PUBLIC_WEB_URL` — public web origin for shareable links (the `/join/<code>` invite). Set to the real domain for prod/TestFlight builds; falls back through `app.json` `extra.webBaseUrl` → `EXPO_PUBLIC_API_URL` so local-deployment links resolve against the same backend.

**The backend hosts are deliberately NOT committed.** `eas.json` build profiles carry no `env` block — the preview (staging) and production URLs live outside the repo so the hosts aren't tracked. Where they come from depends on the build path:

- **Local builds** (Metro, `expo run:ios`, local Xcode archive) — Expo auto-loads `apps/mobile/.env.local` (gitignored). Put the prod values there for a local TestFlight archive.
- **EAS cloud builds** (`eas build --profile <profile>`) — `.env.local` is gitignored, so it is **not uploaded** to the EAS build servers. Set the values in **EAS-hosted env** instead. ⚠️ **EAS selects the environment by build profile, and our profiles set no `environment` key** — so `--profile preview` (internal distribution) resolves to the **`preview`** EAS environment, and `--profile production` (store distribution) to **`production`**. They are SEPARATE stores: a var set only under `production` is invisible to a `preview` build, which then falls through to `localhost` (`src/lib/config.ts`). Set each environment explicitly:

  ```bash
  # preview → staging backend
  eas env:create --environment preview    --visibility plaintext --name EXPO_PUBLIC_API_URL --value https://<staging-host>
  eas env:create --environment preview    --visibility plaintext --name EXPO_PUBLIC_WEB_URL --value https://<staging-host>
  # production → prod backend
  eas env:create --environment production --visibility plaintext --name EXPO_PUBLIC_API_URL --value https://<prod-host>
  eas env:create --environment production --visibility plaintext --name EXPO_PUBLIC_WEB_URL --value https://<prod-host>
  ```

  `--visibility plaintext` is deliberate: `EXPO_PUBLIC_*` are inlined into the public JS bundle, so they carry no secrecy — keep them readable in the EAS dashboard/logs rather than letting EAS default them to a protected level. (Confirm the flag spelling against your installed `eas-cli` — the three-level visibility model is stable; the exact flag is version-ish.) Or set them in the EAS dashboard per environment. A cloud build whose environment has neither the EAS-hosted vars nor an `env` block in `eas.json` ships pointing at `localhost` — verify the values resolve on the first build of **each** profile before trusting a TestFlight (or internal preview) upload.

## Geo IP→country data (Connected-devices labels)

The "logged in from <country>" labels resolve IPs to countries **in-process** from a self-hosted dataset — the IP never leaves the server (no geo API). Delivery:

1. **Weekly scheduled job** (`.deploio.yaml` `scheduledJobs` → `refresh-geo-data`, Sun 04:00): `node scripts/refresh-geo-data.mjs` fetches public RIR delegated-stats, builds the binary lookup tables, and uploads them to fixed S3 keys (`geo/geo-v4.bin`, `geo/geo-v6.bin`, `geo/geo-cc.json`). Best-effort: any failure (source down, timeout, S3 error) is swallowed and the existing S3 copy is kept.
2. **App at boot** (`instrumentation.ts` → `lib/geoData.ts` `ensureGeoData`): downloads those files from S3 to `GEO_DATA_DIR`. **If the set is incomplete (cold start before the first weekly run, or a partial S3 upload), it kicks off a one-time seed (generate+upload) in the BACKGROUND** so a fresh deploy isn't blank — without blocking boot on a ~50MB fetch. The seed writes to S3, so the boot then **polls S3 (a few times, ~60s apart, non-blocking)** to pull the freshly-seeded files onto *this* instance's disk — so the instance self-heals without waiting for a restart. `lib/geo.ts` queries the files on disk; missing files → "Unknown location".

**Outbound egress requirement**: the refresh fetches the NRO combined file from `ftp.ripe.net` (fallback: `ftp.arin.net`, `ftp.apnic.net`, `ftp.lacnic.net`, `ftp.afrinic.net`). If the scheduled-job environment has no egress to these hosts, the refresh no-ops and geo stays on the last-good S3 copy (or blank on a never-yet-seeded cold start). Manual refresh from anywhere with egress: `node scripts/generate-geo-table.mjs <dir>` then upload. Data is stable; weekly is ample.

## Postgres extensions (`unaccent`, `pg_trgm`)

The schema declares two contrib extensions (`prisma/schema.prisma` datasource `extensions = [pg_trgm, unaccent]`); each migration that first needs one issues `CREATE EXTENSION IF NOT EXISTS …`. Both ship in the standard `postgresql-contrib` package and are enabled on Nine's managed Postgres — `pg_trgm` has been live in prod since the privacy-tiers migration (it backs `/api/users/search`), and `unaccent` was added for accent-insensitive moments search (`GET /api/me/sessions?q`, moments-server-filtering.md Part B). Availability was verified on a matching Postgres 17 image (`unaccent` is contrib, installs + folds cleanly) before shipping. If a future managed-Postgres change ever restricted contrib extensions, the deploy would fail loud at `migrate deploy` (the migration gates the release) rather than silently — the failure is the signal to escalate to Nine.

### 🔒 PRE-DEPLOY CHECK — the two catalog migrations require EMPTY catalog tables

**Run this against the target database BEFORE merging anything that carries `20260725140000_catalog_fold_order` or `20260725160000_catalog_gist_knn`:**

```sql
-- Schema-qualified deliberately: an altered `search_path` would otherwise
-- let this count the WRONG relations and report a false all-clear. The
-- migrations check `public.*` explicitly, so this must match them.
SELECT (SELECT count(*) FROM public.producers)     AS producers,
       (SELECT count(*) FROM public.wine_products) AS wine_products;
-- Both MUST be 0. If either is non-zero, STOP — do not deploy.
```

Why this is a human step even though the migrations enforce it themselves: the migrations abort *at deploy time*, which on Deplo.io means **a failed release plus a `P3009`-blocked pipeline** needing the manual recovery below. Checking first turns that into a decision made before anything is at stake. The enforced preflight inside each migration is the backstop against someone skipping this — not a replacement for it.

**These two migrations are NOT generally applicable to a populated catalog.** Both drop/recreate objects under `ACCESS EXCLUSIVE`, and the total work is larger than a glance suggests: the fold migration rewrites **five generated columns** and recreates two indexes; the GiST one performs **six index operations in one transaction** — creating two GiST and two covering B-tree indexes while dropping two GIN. ⚠️ The only figure measured is **~6 s for a single GiST build at 500k rows**; it is NOT the total, and the B-tree builds and column rewrites are unmeasured. Treat the whole window as unknown on a populated table — which is the point: it would have to be measured before such a deploy, not estimated from here. They are safe *only* because the catalog is empty while `CATALOG_PUBLIC_ENABLED` is unset and no import has run. If a populated catalog ever needs equivalent changes, that is a **separately planned maintenance migration** — measured rewrite window, `CREATE INDEX CONCURRENTLY` (which cannot run inside a transaction), a verified backup/restore, and a rollback procedure — not a re-run of these files.

⚠️ **Also confirm nothing is holding a lock on those two tables**, or the 5s `lock_timeout` fires and you land in the recovery path below. 🔒 **`pg_locks` is CLUSTER-WIDE while `pg_class`/`pg_namespace` are PER-DATABASE**, so joining them without `l.database` matches FOREIGN OIDs against LOCAL names. Verified against a `TEMPLATE`-cloned database where `public.producers` had an IDENTICAL OID: the unscoped query returned sessions from BOTH databases, indistinguishably. Every query below therefore joins `pg_database` on `l.database`, filters `nspname = 'public'`, and exposes `l.granted`. This has to join `pg_locks` — a plain `pg_stat_activity` age filter answers a different question ("what is old?") and cannot tell you what touches the catalog: verified with one transaction on `producers` and one on `users`, the age filter returned both while the query below correctly returned only the `producers` one.

```sql
SELECT a.pid, c.relname, l.mode, l.granted, a.state, a.xact_start,
       left(a.query, 60) AS query
  FROM pg_locks l
  JOIN pg_database d ON d.oid = l.database AND d.datname = current_database()
  JOIN pg_class c ON c.oid = l.relation
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE c.relname IN ('producers', 'wine_products')
   AND a.pid <> pg_backend_pid()
   AND a.xact_start IS NOT NULL
 ORDER BY l.granted DESC, a.xact_start;
-- Any row here means STOP. `granted = t` HOLDS a lock; `granted = f` is
-- itself WAITING for one — both indicate contention on these tables, but
-- only a holder is a blocker (see the recovery section).
```

### A blocked migration leaves the deploy pipeline stuck (P3009) — recovery

🔒 **Applies to any migration that takes an explicit lock** — currently `20260725140000_catalog_fold_order` and `20260725160000_catalog_gist_knn`, both of which `LOCK TABLE` the catalog tables behind a 5s `lock_timeout`. The timeout protects the *database* (a stale reader can no longer hang the deploy indefinitely); it does **not** protect the *pipeline*. Verified end-to-end against PG16:

1. The blocked deploy fails with a generic **`current transaction is aborted`**, not the lock-timeout message — so that output does not name the real cause. Find the blocker with:
   ```sql
   -- 🔒 `granted` is what separates a HOLDER from a WAITER. Without it both
   -- appear identical and an operator can terminate the wrong pid — verified:
   -- a plain reader and a queued LOCK TABLE both showed up as blockers.
   -- Only `granted = t` rows hold anything.
   SELECT a.pid, c.relname, l.mode, l.granted, a.state, a.xact_start,
          left(a.query, 60)
     FROM pg_locks l
     JOIN pg_database d ON d.oid = l.database AND d.datname = current_database()
     JOIN pg_class c ON c.oid = l.relation
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE c.relname IN ('producers', 'wine_products')
      AND l.granted                      -- holders only
      AND a.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL
    ORDER BY a.xact_start;

   -- Definitive, if something is already stuck in the queue: Postgres names
   -- the blocker directly. 🔒 SCOPED to the catalog relations — bare
   -- `pg_blocking_pids()` over pg_stat_activity is CLUSTER-WIDE and returns
   -- every wait chain in the database (verified: with simultaneous contention
   -- on `producers` and on `users`, it returned both), which on a busy
   -- production database points an operator at unrelated pids. The join
   -- through UNGRANTED pg_locks rows is what restricts it to sessions waiting
   -- on THESE tables.
   SELECT a.pid AS waiting_pid, c.relname,
          pg_blocking_pids(a.pid) AS blocked_by, left(a.query, 60) AS query
     FROM pg_stat_activity a
     JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
     JOIN pg_database d ON d.oid = l.database AND d.datname = current_database()
     JOIN pg_class c ON c.oid = l.relation
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relname IN ('producers', 'wine_products')
      AND a.datname = current_database()
      AND cardinality(pg_blocking_pids(a.pid)) > 0;
   ```
2. Prisma **records the migration as failed**, so every subsequent deploy aborts with **`P3009`** — including long after the blocker is gone. **This does not self-heal.**
3. Recovery, once the blocker is cleared:
   ```bash
   npx prisma migrate resolve --rolled-back <migration_name>
   npx prisma migrate deploy
   ```
   Verified: the schema is undamaged (both migrations are wrapped in `BEGIN`/`COMMIT`, so nothing partially applied) and the redeploy applies cleanly.

⚠️ **`--rolled-back`, never `--applied`.** `--rolled-back` is truthful here *because* the migrations are transactional — nothing landed. `--applied` would mark the work done without doing it, leaving the schema permanently out of step with migration history.


The `f_unaccent(text)` IMMUTABLE wrapper (pins unaccent's dictionary arg so it's index-safe) lives in raw migration SQL, not `schema.prisma` — Prisma's datamodel can't express a SQL function or a functional expression index, and `prisma migrate diff` ignores both, so they never register as schema drift (verified against the `check-schema.yml` CI command).

## Session-row cleanup (bounded retention)

A **daily scheduled job** (`.deploio.yaml` `scheduledJobs` → `cleanup-revoked-sessions`, 03:00) prunes `user_sessions` rows revoked >90 days: `prisma db execute --file prisma/maintenance/cleanup-revoked-sessions.sql`. A scheduled-job failure never affects the release. Because it's a real daily cron (not deploy-driven), retention is a true 90-day floor. This keeps revoked rows (a per-user login ledger: device label, country, timestamps) from accumulating indefinitely — the same privacy reason the audit-log table was dropped. Active sessions are never touched. (pg_cron isn't on Nine's Postgres, but Deplo.io's native `scheduledJobs` is the scheduler.) See `prisma/maintenance/cleanup-revoked-sessions.sql`.
