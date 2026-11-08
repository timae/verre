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
- `DATABASE_CONNECTION_LIMIT` / `DATABASE_POOL_TIMEOUT` / `DATABASE_STATEMENT_TIMEOUT_MS` (all optional) — database pool + runaway-query controls (`lib/prisma.ts`). Since Prisma 7 the pool is node-postgres's (`@prisma/adapter-pg`), so the knobs map onto pg `PoolConfig` fields instead of URL parameters: the limit → `max`, the pool timeout (seconds) → `connectionTimeoutMillis`, the statement timeout → the `statement_timeout` connection parameter, which pg sends at connection STARTUP so every pooled backend gets it (re-verified on the adapter across 5 distinct backends; a post-connect `SET` reaches exactly ONE and leaves the rest on the default). ⚠️ **Unset means Prisma 6's defaults, not pg's.** pg defaults to `max 10` and a connection wait of *forever*; `lib/prisma.ts` always sets `max` = **physical** cores × 2 + 1 (replicating Prisma 6's `num_cpus::get_physical`: distinct physical-id/core-id pairs from `/proc/cpuinfo`, logical count as the fallback where those lines are absent, e.g. arm64 — Node alone would report logical CPUs and double the pool on an SMT host) and a 10 s wait (Prisma's documented defaults). Scripts and CI suites (`scripts/lib/prismaClient.mjs`) get the same 10 s bounded wait on pg's default pool of 10, so an exhausted pool still fails fast — now as pg's `timeout exceeded when trying to connect` rather than `P2024`. 🔒 **Why they exist:** the app previously set no `connection_limit` at all; a pool queues FIFO but the queue needs a deadline. Measured against a large catalog, concurrent expensive searches exhausted the pool and a majority timed out rather than completing slowly. ⚠️ These knobs BOUND the failure; they do not create capacity — for real horizontal scale the answer is a pooled endpoint (PgBouncer in transaction mode) with a separate direct URL kept for migrations. `DATABASE_CONNECTION_LIMIT` is per app instance, so size it as `(max_connections − headroom) / instances`; setting it too high is not more throughput, it risks exhausting the server's connection slots and locking out migrations. `DATABASE_STATEMENT_TIMEOUT_MS` is the backstop a pool size cannot provide — it bounds a single runaway query that would otherwise hold its connection indefinitely. Set it generously — a fence, not a latency target (realistic catalog search measures 0.9–41 ms at 300k rows). `DATABASE_URL`'s own query parameters (`sslmode`, any `options`) are parsed by pg and left untouched.
- `DATABASE_CA_CERT` (optional; PEM text) — CA certificate for TLS to the database (`lib/pgTls.mjs` `pgTlsConfig`, shared by `lib/prisma.ts`, `scripts/lib/prismaClient.mjs` and the TLS probe). When present, node-postgres connects with TLS, verifies the server certificate chain against THIS CA and skips only the hostname check (libpq `verify-ca` semantics) — Nine's Economy Postgres uses a self-signed certificate whose CA does not match the hostname, so this is the strongest check it allows, and stronger than Prisma 6's never-verified `prefer`. Falls back to any `NINE_PGDB_<NAME>_CA_CERT` Deplo.io injects, so **prod needs no new variable** (`NINE_PGDB_VERRE_CA_CERT` is already there). 🔒 Keep `DATABASE_URL` free of `sslmode`/`ssl`/`sslrootcert` while a CA variable is set: pg lets URL parameters REPLACE the `ssl` option, and the code only warns. Unset ⇒ plaintext (local dev, CI). The migration job is unaffected either way (the Prisma CLI's native engine keeps the `prefer` default). See § Prisma 7 → TLS.
- `ATTRIBUTIONS_PATH` (optional) — absolute path to a JSON file overriding the bundled legal attribution entries (`lib/attributions.ts`). Unset ⇒ the entries committed in that module are used, which is the normal case. Deliberately a file rather than an env var: `licence.text` is a multi-line verbatim legal block (the MIT notice is 1072 bytes with hard newlines) and shell quoting would silently corrupt a string we are legally required to reproduce exactly. The value is process-cached after first read.

  🔒 **An override is a COMPLETE REPLACEMENT, not a patch, and it is validated as one.** `getAttributions` swaps the whole list, so a file containing one valid new source would otherwise DELETE X-Wines, LWIN, BC Liquor and Open Brewery DB. The loader therefore rejects an override that: omits any bundled source, repeats a source, carries `verified: false`, has blank `notes`, or uses a non-`http(s)` URL in `sourceUrl` or `licence.url` (both render as tappable links). Rejection is **atomic** — the whole override is discarded and the bundled entries are used, never a merge of the two. Pinned by `scripts/tests/attributions-override-units.ts`.

  🔒 **On any failure it falls back to the bundled entries and logs loudly** — missing file, bad JSON, schema mismatch, empty list, failed validation. Failing closed would render a blank legal page and breach the very licences the surface exists to satisfy.

  ⚠️ **What "ops change, not a release" does and does not mean — stated with the caches, not without them.** Correcting a source here needs no app release, but "immediately" would be false: there are **three caches** between editing the file and a native screen, all deliberate and all tested.

  1. **The server process-caches the parsed file** (`getAttributions`, first read wins). Changing the file therefore requires a **process restart** before even the web surface reflects it.
  2. **`GET /api/legal/attributions` sends `max-age=3600, stale-while-revalidate=86400`.**
  3. **The native client keeps a LIVE result fresh for one hour** (`apps/mobile/src/lib/api/legalQuery.ts`), so it does not refetch on every mount or foreground. A *bundled* result is stale immediately, which is what makes failure recovery work.

  The honest contract, and the wording to reuse:

  - **Web** reflects the **running server's** snapshot (restart to pick up a changed file).
  - **Online native** refreshes **subject to its client and API caches** — so an online client can briefly show superseded text.
  - **When fetching fails**, native falls back to the **release-time bundle** compiled into the binary (`apps/mobile/src/lib/api/legal.ts`) and links to the server-published web page. ⚠️ Within one app session a previously-fetched live value may persist instead of the bundle (the query cache is in-memory, with no persister — a cold launch while offline gets the bundle).

  Only a **native release** can change the bundled snapshot itself. Do not write "immediately", "always current", or "purely ops-only" anywhere about this surface.
- `CATALOG_PUBLIC_ENABLED` (optional — **leave unset until the model-change phase ships**) — the wine-catalog release fence (`lib/catalogGate.ts`). Only the literal string `'true'` opens catalog search + entry creation to ordinary users; anything else (including unset) returns **404** — not 403, so an unreleased surface isn't advertised. **Staff (`staff_roles` curator or admin) bypass the switch always**, so the add-flow can be dogfooded and the matcher tuned while it is closed to everyone else.

  🔒 **Preconditions before setting this to `'true'`** (`docs/dev/proposals/wine-catalog-model-change.md` § 7):
  1. ✅ **DONE (PR #93, 2026-07-27) — attributions surface live** in web + native. A licence obligation, not a courtesy. ⚠️ Still a standing precondition, not a one-time tick: if a source is ever ADDED to the corpus, its entry must ship (and reach clients) before that data does.
  2. **First catalog fill done**, ending with `VACUUM ANALYZE` on the catalog tables.
  3. **Model change shipped**, including its release conditions (version gate covering the changed endpoints, min-version floor raised).
  4. **Interleaved concurrent-PATCH test** run — it gates this flag opening, not phase 3.

  🔒 **OPENING THIS FLAG IS THE IRREVERSIBLE STEP — decide it BEFORE the fill, not as a checkbox after** (data side, 2026-07-26; recorded because it existed only in conversation and is the key input to this decision).

  **A conflated producer is PERMANENT once users attach data, and the window closes on user activity — not at a phase boundary.** The measured failure is *several real producers collapsed into one row*, which is the OPPOSITE direction from a duplicate. `linksTo` merges a false split (two rows that should be one); a conflation is one row that should be several, and **a merge given one row has nothing to merge**. Repair would need a SPLIT: mint the missing producer, divide products and provenance, decide what happens to facts accumulated on the conflated row, reassign user-linked data, and be auditable and reversible. **No such machinery exists on either side, and none is planned in phase 3.**

  Two consequences worth holding onto:
  - ⚠️ **Conflations never surface in the review queue.** There is one row and nothing looks wrong with it. So phase-3 queue sizing should NOT assume they arrive as duplicates — imported-producer *merges* are a separate, real, steady workload; conflations are invisible.
  - The practical lever is *when* users can start attaching data, which is exactly what this flag controls. Once attached, the cheap fix is gone.

  ⚠️ **The earlier "not before phase 3" rule is SUPERSEDED** (2026-07-25). It read: phase 3 adds the review queue, and *publicly searchable user-authored content with no moderation path* is not a valid steady state. That reasoning is sound but was outweighed by scale — at a handful of testers the accumulation risk is negligible. **What must still hold:** entries minted before the queue exists stay `provisional` and are recorded as awaiting review, so nothing is silently treated as reviewed. If usage grows before phase 3 lands, unset this again rather than letting the backlog grow unbounded.

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

## Prisma 7 (ORM + CLI, pinned 7.10.1)

Upgraded 2026-11-06 (`docs/dev/proposals/dependency-upgrades.md` Phase 1). What an operator needs to know:

- **Pins are exact**: `prisma`, `@prisma/client` and `@prisma/adapter-pg` at `7.10.1`, no caret. Prisma's `latest` dist-tag points at an **8.0 release candidate**; never `npm i prisma@latest`. The generator stays `prisma-client-js` (deprecated upstream, works on 7, kept deliberately — the proposal's decision D1).
- **The query engine is gone; the pool is node-postgres.** `lib/prisma.ts` builds the client over `@prisma/adapter-pg`; the pool knobs above are pg `PoolConfig`. `Prisma.Decimal` is still decimal.js and still serialises to a JSON string, so the root CLAUDE.md `Number()` coercion rule is unchanged. Scripts and CI suites build their client through `scripts/lib/prismaClient.mjs` (the adapter is mandatory, so there is exactly one place that wires it).
- **`prisma.config.ts` (repo root) owns the datasource.** `schema.prisma` has no `url` (one there is a validation error on 7). The file carries `datasource.url` ← `DATABASE_URL`, `datasource.shadowDatabaseUrl` ← `SHADOW_DATABASE_URL` (CI only — the `check-schema.yml` drift gate; not a Deplo.io variable), and `migrations.path`. The 7 CLI does **not** load `.env`; the config loads it itself via `dotenv` (quiet, never overriding a variable already in the environment, so the Deplo.io process env wins). It reads `process.env` rather than Prisma's `env()` helper on purpose: `env()` throws while the config loads when the variable is missing, which would break `prisma generate` in the image's builder stage (no database there); with a plain read `generate` runs and every migrate/db command still fails loud (`datasource.url property is required`).
- **Image layout.** `/migrate` carries `prisma/`, `prisma.config.ts`, `scripts/` and the full `node_modules`; the deploy job and the cleanup cron `cd /migrate` so the CLI finds the config in its cwd. The CLI's **schema engine is still a native binary linked against OpenSSL 3** (only the application query engine went Rust-free); `node:24-alpine` ships `libssl3`, so nothing to add — and nothing to strip on the assumption that 7 is engine-free.
- **CLI flag changes already applied**: `db execute` takes `--file`/`--stdin` only (`--schema`/`--url` are gone — `.deploio.yaml` cron, the local harness and `scripts/tests/ba-session-lifetime.mjs` updated); `migrate diff`'s file destination is `--to-schema` (CI; `--to-config-datasource` would introspect a live database and change what the gate means) and `--shadow-database-url` moved into the config. `migrate reset --skip-seed` is gone (seeding only runs when the config sets `migrations.seed`; the local harness dropped the flag). `migrate deploy`, `migrate status`, `migrate resolve --applied | --rolled-back` are unchanged, so the P3009 runbook below still holds (re-verified from `/migrate` in the built image).
- **Error surface for code that inspects Prisma errors**: codes are unchanged (`P2002` unique, `P2003` FK, `P2025` not found, raw failures `P2010` with the SQLSTATE in the message) and the app branches only on codes. What changed is the TEXT: a `P2002` message names the **constraint** (`users_email_key`) instead of the column list, and a raw 23505 message is Postgres's own `violates unique constraint "<name>"` without the `DETAIL: Key (…)=(…) already exists` line the Rust engine used to fold in. The two catalog integration suites assert on constraint names for that reason.
- **Raw result typing** is the same as on 6 (verified through the real client): `COUNT(*)::bigint` → `BigInt`, `numeric` → `Decimal`, timestamps → `Date`, arrays → arrays, a NULL array → `null`.

### 🔒 TLS to Nine's Postgres — DECIDED and shipped (verify-ca via the environment CA)

Prisma 6's Rust engine did **not** verify the server certificate under `sslmode=require`. node-postgres 8.x **does**: it treats `require`, `prefer` and `verify-ca` as `verify-full` (chain + hostname against Node's bundled CAs) and prints a one-time startup warning saying so; `sslmode=no-verify` / `ssl=no-verify` disable verification; `uselibpqcompat=true` switches to libpq semantics (`require` = encrypted, unverified; `verify-ca` + `sslrootcert` = chain verified, hostname skipped).

**What Nine documents for Economy Postgres** (docs.nine.ch, on-demand-services/postgresql/economy, read 2026-11-06): TLS is enforced; the Deplo.io DSN template uses `sslmode=require`; **the server certificate is self-signed**; the CA is available in Cockpit under the resource's *Certificate* tab (and injected into Deplo.io apps as `NINE_PGDB_<NAME>_CA_CERT` when present); and *"the CA certificate will not match the hostname of the service — you may need to disable hostname verification explicitly."*

**Consequence** (reproduced 2026-11-06 against a self-signed Postgres 17 with the real probe): with the DSN as documented, Prisma 7 fails to connect — `DEPTH_ZERO_SELF_SIGNED_CERT`. Supplying the CA alone (`NODE_EXTRA_CA_CERTS` or `sslrootcert`) still fails on the hostname: `ERR_TLS_CERT_ALTNAME_INVALID`. The migration job is unaffected (the Prisma CLI's native schema engine keeps Prisma 6's behaviour). Two configurations work:

| Option | URL parameters | Verifies | Code change |
|---|---|---|---|
| **verify-ca** (preferred) | `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=<CA file>` | chain against Nine's CA; hostname skipped | small: the CA arrives as PEM text in an env var, pg wants a file — pass it through the adapter `ssl` option in `lib/prisma.ts` |
| **unverified** (fallback = today's posture) | `uselibpqcompat=true&sslmode=require` | nothing (encrypted only) | none, URL edit only |

**Check**: run `.local/tls-probe.mjs` (gitignored) with the production `DATABASE_URL`. It opens one node-postgres connection from the same config pg derives for `lib/prisma.ts` (URL + `PGSSLMODE`, normalised by pg itself) and reads the verdict off the live TLS socket (`encrypted`, `authorized`, `authorizationError`), prints the server certificate's subject/issuer/fingerprint, and never prints key material. `pg_stat_ssl` is shown as a cross-check only — it reports `ssl = true` for an unverified link too. **Probe result against production (owner, 2026-11-06, from a Mac — the FQDN is public):** PostgreSQL 17.11 on x86_64, TLS 1.3 (`TLS_AES_256_GCM_SHA384`), chain VERIFIED against the CA from Cockpit's Certificate tab (issuer CN `PostgreSQL CA`, server cert CN `PostgreSQL Server`, valid to 2055-06-11), hostname check skipped — i.e. the verify-ca option works against the real server. **Also established: the production `DATABASE_URL` carries NO `sslmode`.** It works on Prisma 6 only because the Rust engine defaults to `prefer`; node-postgres attempts plaintext without an `sslmode` and Nine accepts TLS only, so the unchanged URL would fail outright on Prisma 7. Deplo.io injects `NINE_PGDB_VERRE_CA_CERT` (PEM text), so the preferred implementation is the adapter `ssl` option in `lib/prisma.ts` fed from that variable (no URL change). **Decision (owner, 2026-11-06): verify-ca via the adapter `ssl` option, shipped in Phase 1** — `lib/pgTls.mjs` `pgTlsConfig()` (one definition for the app client, the script factory and the probe) reads `DATABASE_CA_CERT` or any `NINE_PGDB_<NAME>_CA_CERT` (an empty value counts as unset) and sets `{ ca, checkServerIdentity: () => undefined }`; `DATABASE_URL` stays as it is (no `sslmode`). Tested against a self-signed Postgres 17: CA set → TLS 1.3 + chain verified; wrong CA → `TlsConnectionError`; no CA → plaintext; `sslmode` in the URL → warning + the URL wins. The probe above proved the same CA against production.

## Next.js 16 (web framework, pinned 16.4.5)

- **Pins are exact**: `next` and `eslint-config-next` at `16.4.5`, `eslint` at `10.14.0`, `typescript` at `6.0.3`. React stays at exactly `19.3.0` (the Expo SDK pin; see `docs/dev/proposals/dependency-upgrades.md` § 1).
- **Turbopack builds the image** (the Next 16 default for `next build` and `next dev`). `next build --webpack` is the one-flag fallback if a Turbopack build ever breaks; using it is recorded tech debt, not a silent switch.
- 🔒 **Standalone size is a tracing signal.** `.next/standalone` is ~60 MB. Turbopack traces any `fs` call whose path it cannot scope, and an env-driven path (`GEO_DATA_DIR` in `lib/geoData.ts`) made it copy the whole repo (1.1 GB, `apps/` and `ios/` included) until the call got a `/*turbopackIgnore: true*/` hint. The build prints a "matches N files" / "causes tracing of the whole project" warning when this happens; treat it as a failure. A new runtime-data path outside the project needs the same hint.
- **`proxy.ts` replaces `middleware.ts`** and runs on the Node runtime (matcher `/me/:path*`, JWT presence only; see `lib/CLAUDE.md`). A leftover `middleware.ts` would still run with a deprecation warning, and both files together fail the build.
- **`next build` no longer runs ESLint.** `npm run lint` (`eslint .`) is the only lint entry point, gated in CI by `.github/workflows/check-lint.yml` (errors fail, the warning baseline is accepted). The same run enforces the import allowlists on `proxy.ts`, `auth.config.ts` and `instrumentation.ts` that replace the old Edge-build failure, and `scripts/tests/lint-boundary-units.mjs` pins those allowlists against mutation cases (a weakened selector would still lint the real files clean).
- `experimental.serverActions.allowedOrigins` + `SERVER_ACTIONS_ALLOWED_ORIGINS` are unchanged in 16.

## Postgres extensions (`unaccent`, `pg_trgm`)

The schema declares two contrib extensions (`prisma/schema.prisma` datasource `extensions = [pg_trgm, unaccent]`); each migration that first needs one issues `CREATE EXTENSION IF NOT EXISTS …`. Both ship in the standard `postgresql-contrib` package and are enabled on Nine's managed Postgres — `pg_trgm` has been live in prod since the privacy-tiers migration (it backs `/api/users/search`), and `unaccent` was added for accent-insensitive moments search (`GET /api/me/sessions?q`, moments-server-filtering.md Part B). Availability was verified on a matching Postgres 17 image (`unaccent` is contrib, installs + folds cleanly) before shipping. If a future managed-Postgres change ever restricted contrib extensions, the deploy would fail loud at `migrate deploy` (the migration gates the release) rather than silently — the failure is the signal to escalate to Nine.

### 🔒 PRE-DEPLOY CHECK — the three catalog migrations require EMPTY catalog tables

**Run this against the target database BEFORE merging anything that carries `20260725140000_catalog_fold_order`, `20260725160000_catalog_gist_knn`, or `20260725220000_catalog_fold_whitespace`:**

```sql
-- Schema-qualified deliberately: an altered `search_path` would otherwise
-- let this count the WRONG relations and report a false all-clear. The
-- migrations check `public.*` explicitly, so this must match them.
SELECT (SELECT count(*) FROM public.producers)     AS producers,
       (SELECT count(*) FROM public.wine_products) AS wine_products;
-- Both MUST be 0. If either is non-zero, STOP — do not deploy.
```

Why this is a human step even though the migrations enforce it themselves: the migrations abort *at deploy time*, which on Deplo.io means **a failed release plus a `P3009`-blocked pipeline** needing the manual recovery below. Checking first turns that into a decision made before anything is at stake. The enforced preflight inside each migration is the backstop against someone skipping this — not a replacement for it.

**These three migrations are NOT generally applicable to a populated catalog.** All three drop/recreate objects under `ACCESS EXCLUSIVE`, and the total work is larger than a glance suggests: each fold migration rewrites **five generated columns** and recreates its indexes (the whitespace one recreates all four, and also swaps four CHECK constraints and drops the superseded `f_unaccent_arr`); the GiST one performs **six index operations in one transaction** — creating two GiST and two covering B-tree indexes while dropping two GIN. ⚠️ The only figure measured is **~6 s for a single GiST build at 500k rows**; it is NOT the total, and the B-tree builds and column rewrites are unmeasured. Treat the whole window as unknown on a populated table — which is the point: it would have to be measured before such a deploy, not estimated from here. They are safe *only* because the catalog is empty while `CATALOG_PUBLIC_ENABLED` is unset and no import has run. If a populated catalog ever needs equivalent changes, that is a **separately planned maintenance migration** — measured rewrite window, `CREATE INDEX CONCURRENTLY` (which cannot run inside a transaction), a verified backup/restore, and a rollback procedure — not a re-run of these files.

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

🔒 **Applies to any migration that takes an explicit lock** — currently `20260725140000_catalog_fold_order`, `20260725160000_catalog_gist_knn`, and `20260725220000_catalog_fold_whitespace`, all of which `LOCK TABLE` the catalog tables behind a 5s `lock_timeout`. The timeout protects the *database* (a stale reader can no longer hang the deploy indefinitely); it does **not** protect the *pipeline*. Verified end-to-end against PG16:

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
   Verified: the schema is undamaged (all three migrations are wrapped in `BEGIN`/`COMMIT`, so nothing partially applied) and the redeploy applies cleanly.

⚠️ **`--rolled-back`, never `--applied`.** `--rolled-back` is truthful here *because* the migrations are transactional — nothing landed. `--applied` would mark the work done without doing it, leaving the schema permanently out of step with migration history.


The `f_unaccent(text)` IMMUTABLE wrapper (pins unaccent's dictionary arg so it's index-safe) lives in raw migration SQL, not `schema.prisma` — Prisma's datamodel can't express a SQL function or a functional expression index, and `prisma migrate diff` ignores both, so they never register as schema drift (verified against the `check-schema.yml` CI command).

## Redis rehydration release A — post-deploy backfill (one-shot)

Release A (`docs/dev/proposals/redis-rehydration.md` § 10) adds `sessions.lifespan`, `hide_lineup`, `hide_lineup_minutes_before`, `show_provenance`. Sessions that were live when it deployed have NULL there while Redis still holds the real values, so **right after the deploy, while Redis is still warm**, run once from a checkout against prod (same runner as the planned operator script — the Deplo.io image carries no `lib/`):

```bash
DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-session-meta.mts           # dry run: what would change
DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-session-meta.mts --apply   # write
```

Idempotent (a re-run reports `changed: 0`). Re-run the dry run immediately before release B and confirm `changed: 0`. The migration itself also stamps legacy tombstoned ratings (`tombstone_key`, one per session) and logs the counts with `RAISE NOTICE`.

## Session-row cleanup (bounded retention)

A **daily scheduled job** (`.deploio.yaml` `scheduledJobs` → `cleanup-revoked-sessions`, 03:00) prunes `user_sessions` rows revoked >90 days: `prisma db execute --file prisma/maintenance/cleanup-revoked-sessions.sql`. A scheduled-job failure never affects the release. Because it's a real daily cron (not deploy-driven), retention is a true 90-day floor. This keeps revoked rows (a per-user login ledger: device label, country, timestamps) from accumulating indefinitely — the same privacy reason the audit-log table was dropped. Active rows are never touched. (pg_cron isn't on Nine's Postgres, but Deplo.io's native `scheduledJobs` is the scheduler.) See `prisma/maintenance/cleanup-revoked-sessions.sql`. **Expired native `auth_sessions` are NOT pruned by this job** — the cron image has no `lib/`, and a raw SQL delete there can strand a Redis session copy. They are retired in-process (`lib/nativeSessionPrune.ts` → `pruneExpiredNativeSessions`, via Better Auth's both-store delete): once ~5 min after boot, then daily, de-duplicated across replicas by the `lock:native-session-prune` Redis NX lock.
