# Dependency upgrade plan (web + mobile), November 2026

**Status**: IN PROGRESS on `feature/deps-2026-11` (revision 3 + as-built notes). Phase 0 committed (`0c7c855`). Phase 1 built, verified locally and TLS-verified against production on 2026-11-06 (see § 4 "As built"); three Codex review rounds closed, awaiting commit. Phases 2–3 not started. Inventory taken 2026-11-06 against npm, vendor support pages and upstream advisories (Claude's pass plus the Codex pass in `.local/dependency-review-2026-11-06.md`). Revisions 2 and 3 fold in the two Codex reviews of the plan (`.local/dependency-plan-review-2026-11-06.md`, `.local/dependency-plan-review-r2-2026-11-06.md`): every finding was re-verified against the repo, the published package dists, or a scratch build before being applied. Revision 3's main change is D1 (keep `prisma-client-js` on Prisma 7), which removes the import rename, the `tsx` runner change and the `/migrate` packaging question from Phase 1.

**Goal**: get every dependency onto a supported line with the smallest number of manual test passes. Phases pack updates by *which surface they can break*, so each surface is tested once. Default rule: an upgrade must leave behaviour identical; anything that changes what a user sees or how the app behaves is listed under "Improvements to discuss" and is opt-in.

## 1. Where we stand

### Dated deadlines

| Component | Current | Supported until | Target |
|---|---|---|---|
| Prisma | 6.19.3 | 2026-11-19 (security only) | 7.10.1 |
| Next.js | 15.5.29 | 2027-01-31 (security only) | 16.4.x |
| ESLint | 9.39.5 | EOL since 2026-08-06 | 10.x |
| Actions checkout/setup-node | v4 | Node 20 runtime removed 2026-09-23 | v7 |

Prisma's `latest` dist-tag currently points at an **8.0 release candidate** (`8.0.0-rc.30`). Every install must name `7.10.1` explicitly; never `prisma@latest`.

On the Prisma 6 date: the docs release-status page (https://www.prisma.io/docs/orm/release-status) states verbatim "Prisma ORM 6 receives security patches, but no other updates, for 12 months after the release of Prisma ORM 7, a period that ends on 19 November 2026". The repo-side policy files (`SECURITY.md`, `docs/oss/versioning.md`) list only Prisma 7 and 8 as supported lines and do not mention 6 at all. Read together: 6 is at best two weeks from losing security patches and at worst already outside the written security policy. Either reading says the same thing, move off 6; the exact date only affects how D2 is framed.

### Security advisories (from `npm audit`, 17 entries, 1 critical)

- **better-auth 1.6.15** (critical + high). All four advisories need plugins we do not enable: magic link, email OTP, social/generic OAuth, device code. Not exploitable in Verre's config. Fixed from 1.7.7; target 1.7.18. Server, mobile, `@better-auth/core`, `@better-auth/expo` and the root `overrides` entry must move together.
- **zod 3.25.76** (high, memory exhaustion on oversized constrained arrays). No 3.x fix exists. Verre's own user-facing schemas are flat strings (`register`, `login-precheck`, `auth.ts`); the one array schema validates a deploy-time config file. Low exposure. Target 4.6.7 (already resolved inside the Better Auth subtree).
- **postcss ≤ 8.5.22** bundled inside `next` (high, source-map path traversal). Build-time only. Gone with Next 16.3+.
- **deepmerge-ts 7** via `@prisma/config` (high, stack exhaustion). CLI only. Gone with Prisma 7.10.1.
- **glob / minimatch** via Expo CLI and typescript-eslint (moderate, DoS). Dev tooling only. No upstream fix on the SDK 58 line; `npm audit fix --force` would downgrade Expo and must never be run.

### Supported, no deadline

- Node 24 (Docker base, CI, `engines`): Maintenance LTS until 2028-04-30. Node 26 is Active LTS since 2026-10-28.
- next-auth 5.0.0-beta.32: patched (July 2026 Auth.js security update), still a beta, maintained by the Better Auth team for security only.
- Expo SDK 58 / React Native 0.88 / router 58 / reanimated 4.7 / screens / safe-area: current. `expo install --check` is clean.
- TypeScript: web 5.9.3, mobile 6.0.3. TS 7.0 is GA but has no compiler API, so **typescript-eslint cannot run on it** (needs TS 7.1). Web goes to 6.x; 7 waits.
- redis client 4.7.1 (v6 current), Tailwind 3.4.19 (v4 current), framer-motion 12 (renamed `motion`, v14), nanoid 3.3.20 (patched legacy line), react-easy-crop 5 (v6), AWS SDK one patch behind.
- Nine's key-value store is **Valkey 9** (confirmed, see below). The node-redis v4 client speaks RESP2 and is fine against it.
- **React stays at exactly 19.3.0 in both workspaces.** Expo SDK 58's bundled-modules map pins `react` / `react-dom` to 19.3.0, and the mobile workspace requires the web pin to match exactly (a second React version nests the Expo tree and breaks the renderer). 19.3.1 also changes the React Server Components transport protocol, so it is not a "Fast Refresh only" patch. It waits for the Expo map to move, then rides the next SDK bump.
- iOS: Xcode 27 satisfies Apple's Xcode 26 floor (since 2026-04-28). CocoaPods trunk goes read-only on **2026-12-02**: `pod install` keeps working (CDN stays up), only new pod versions stop flowing through trunk. Track, no action.
- Local dev only: the `minio/minio` image is archived (repo read-only since 2026-04-25, "no longer maintained"). Production is Nine object storage, unaffected.

### Confirmed from Cockpit / Nine docs (2026-11-06)

- **Production Postgres is major 17** (owner, from Cockpit). CI now runs `postgres:17-alpine`, and the sandbox's local dev database was moved 16 → 17 by dump/restore in Phase 0 (all rows and both extensions intact; the 16 container is kept stopped as `verre-pg16-retired` for rollback).
- **Key-value store is Valkey 9** per Nine's On-Demand Key-Value Store page (docs.nine.ch/docs/on-demand-services/key-value-store, "Valkey remains compatible with Redis"). The exact patch level is not exposed; nothing in the plan depends on it.
- Still unread: the deployed Alpine/Node image digest (Nine's side), irrelevant while the Dockerfile pins `node:24-alpine`.

### Verified in a scratch build (2026-11-06, Prisma 7.10.1 against the real `schema.prisma`)

- `prisma generate` with `previewFeatures = ["postgresqlExtensions"]` and `extensions = [pg_trgm, unaccent]` succeeds unchanged on 7.10.1, with either generator. The extensions question is settled (Codex reproduced it independently).
- **The deprecated `prisma-client-js` generator still works on 7.10.1**: it emits plain JavaScript into `node_modules/.prisma/client`, the query layer is a WASM compiler (no Rust query-engine binary), and a plain-Node `.mjs` script imports `PrismaClient`, `Prisma.sql` and `Prisma.Decimal` from `@prisma/client` and constructs a client with `@prisma/adapter-pg` exactly as today. Prisma marks it "to be removed in a future release", not removed in 7.
- The new `prisma-client` generator emits TypeScript only. Plain-Node loading depends on the generator's module settings: with inferred settings it fails (extensionless `./enums` import, reproduced by both reviewers); with `moduleFormat = "esm"` + `importFileExtension = "ts"` Codex loads it on the official Node 24.16.0 and 24.22.2 binaries. Claude's scratch run on the same Node 24.16.0 failed with the explicit settings too; the cause was the scratch package carrying an explicit `"type": "commonjs"` (npm 11's `npm init -y` default), which forces the generated ESM `.ts` files to be parsed as CommonJS (the misleading `does not provide an export named 'Prisma'` is the symptom). With the field absent, as in Verre's root `package.json`, Node loads the output with a `MODULE_TYPELESS_PACKAGE_JSON` warning; a `"type": "module"` marker in the output directory removes the warning. Not a Node-version limitation. `tsx` loads it regardless. None of this bears on D1 any more; it is recorded so nobody re-derives it.
- `Prisma.Decimal` is still `decimal.js` in the v7 client under both generators, and `JSON.stringify` of a Decimal still yields a string, so the `Number()` coercion rule in root CLAUDE.md keeps its meaning.
- The Prisma 7 **CLI** still ships a native schema engine (`@prisma/engines` → `schema-engine-linux-*-openssl-3.0.x`, linked against `libssl.so.3` / `libcrypto.so.3`). Only the application query engine went Rust-free.

## 2. Principles

1. **One manual pass per surface.** Automated suites (`.local/test-env/scripts/run-all.sh`, the CI gates, the catalog integration scripts, the Better Auth e2e scripts) are cheap and run per branch. The expensive thing is the manual web regression (`regression.md`, 60–90 min) and a device pass. The phases are cut so each of those runs once.
   ⚠️ **`run-all.sh` currently counts a crashed section as a pass**: it discards each child's exit status and only counts `❌` assertion lines, so a module-resolution error or an early setup crash (exactly what an import-path change produces) reports green. Codex reproduced this with a child exiting 42. Fixing the runner (propagate exit status, fail on non-zero, print the crash output) is a Phase 0 prerequisite; until then no automated pass in this plan counts as evidence.
2. **Behaviour-preserving by default.** Each phase ships with code adapted so nothing a user can observe changes. New capabilities a version unlocks are listed in §6 and only taken after a yes.
3. **Pin targets, don't float.** Exact versions in `package.json` for the majors in flight (Prisma, Next, Better Auth), so a re-install cannot pull an RC or a newer major.
4. **Branch per phase, review per phase.** Every phase touches auth, schema or a shared primitive, so each gets a review before merge (Codex or a spawned reviewer, owner's choice per the root reviewer rule). Deplo.io deploys on merge to `main`, so merge order is deploy order.

## 3. Phase 0: hygiene, no test pass

Zero behavioural surface. Verified by CI going green.

- `actions/checkout@v7`, `actions/setup-node@v7` in all 11 workflows (removes the Node 20 forced-runtime warning).
- `@aws-sdk/*` patch bump, `@types/bcrypt` 6. (React stays 19.3.0, see §1.)
- **Fix `run-all.sh`** so a section's non-zero exit is a failure and its output is shown. Prerequisite for every later phase's acceptance.
- README + test-env README: local S3 image per decision D6 — **done: RustFS 1.0.4** (`rustfs/rustfs:1.0.4`, container `verre-s3`), verified as a drop-in (bucket, the same public-read policy, upload, anonymous path-style GET). ⚠️ Trap found while swapping: deleting the bucket *directory* inside the container orphans the bucket ("orphaned bucket generation requires administrator recovery"); every wipe goes through the S3 API now (`.local/test-env/scripts/_s3-wipe.mjs`, the CLAUDE.md LAN gotcha, the harness reset). CI Postgres pinned to `postgres:17-alpine` (prod major).
- Nothing else. This phase exists so the later branches have a clean diff and a trustworthy runner.

## 4. Phase 1: data layer (Prisma 7)

**Deadline-driven.** Scope is Prisma only; it is the riskiest migration and deserves its own diff.

### Code changes

- `prisma` + `@prisma/client` 7.10.1, add `@prisma/adapter-pg` (brings `pg`). Remove `datasource.url` from `schema.prisma`; new `prisma.config.ts` at repo root carries `datasource.url`, `shadowDatabaseUrl` (CI) and `migrations.path`. Prisma 7 loads no env files itself: the config imports `dotenv/config` for local dev; in Deplo.io the vars are already in the process env.
- **Generator: keep `prisma-client-js`** (decision D1, flipped in revision 3). It still works on 7.10.1 with the adapter and loads from plain Node (§1), so the 13 app/lib imports, the 6 `.mjs` scripts, the gitignored harness and the CI `node scripts/…` steps keep their import paths and runners. Prisma 8's documented migration replaces the generator model altogether (`contract emit`, no generated `PrismaClient`, imports a Prisma 7 schema directly), so switching to `prisma-client` now would be a 19-file rename that 8 discards. The deprecation is a known debt: when Prisma announces the removal release, or when 8 is adopted, the generator question is revisited then.
- **Script execution**: unchanged. The one addition is a small shared factory (`scripts/lib/prismaClient.mjs`) that builds the adapter-backed `PrismaClient` so the five scripts and the CI integration suites construct it one way. **Boundary**: Prisma-client scripts run from a full checkout (CI, local). The `/migrate` directory in the image hosts only the Prisma CLI (`migrate deploy`, `db execute`) and the geo refresh script, which uses no Prisma; nothing in `.deploio.yaml` or the docs runs a Prisma-client script from `/migrate`, and the plan does not add one. The built-image check is therefore: `migrate deploy` + `db execute --file` from `/migrate`, with the native schema engine present (the full `node_modules` copy already brings `@prisma/engines`; keep OpenSSL 3 in the runner image).
- `lib/prisma.ts`: the pool knobs move from URL params to the adapter. Mapping per the v7 pool guide: `DATABASE_CONNECTION_LIMIT` → `max` (pg default 10, v6 default was cpus×2+1), `DATABASE_POOL_TIMEOUT` → `connectionTimeoutMillis` (pg default 0 = wait forever, v6 default was 10 s). Set both explicitly so the P2024-style bounded failure is preserved. The statement timeout keeps its contract via pg's `options` / `statement_timeout` connection config, which pg sends as a startup parameter, so it reaches every pooled backend like the libpq `options` did. Re-run the 5-backend check from the comment block.
- **TLS to Nine's Postgres**: v7 routes through `node-pg`, whose certificate validation differs from the Rust engine (the upgrade guide documents connections that worked on 6 failing on 7 with `P1010`). Nine's URL carries `sslmode`. Before the first production deploy: connect with the production URL from the built image (a one-off Deploio job or a local run with the real CA), decide between `NODE_EXTRA_CA_CERTS` with Nine's CA (preferred, keeps validation) and the adapter's `ssl` option, and record the choice in `docs/dev/deployment.md`. A green local non-TLS migration proves nothing here.
- `Dockerfile`: copy `prisma.config.ts` into `/migrate`; `.deploio.yaml` deploy job and the `cleanup-revoked-sessions` cron must run with the config discoverable (run from `/migrate` or pass `--config`). `db execute` loses `--schema` and `--url` in v7; the cron command changes to `--file` only. The gitignored harness has the same two `db execute --schema` call sites (`section-maintenance-cleanup.sh`) plus six `.ts` scripts importing `@prisma/client`; they migrate in the same branch so the runner stays meaningful.
- `.github/workflows/check-schema.yml`: the drift gate today is `--from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url … --exit-code`, i.e. migrations versus the checked-in schema file. In v7 the destination flag is **`--to-schema prisma/schema.prisma`** (not `--to-config-datasource`, which would introspect a database and change what the gate means); `--shadow-database-url` moves into `prisma.config.ts`; `--from-migrations` and `--exit-code` stay. The gate must keep exactly today's contract.
- Alpine image: the application query engine goes away (WASM compiler), but the CLI's schema engine in `/migrate` is still a native binary linked against OpenSSL 3. Keep `libssl3` in the runner stage; do not strip it on the assumption that 7 is engine-free. The app stage may get smaller; no action beyond that.

### What can break (and is tested)

- **Raw SQL result typing.** 60 `$queryRaw` / `$executeRaw` sites now go through the `pg` driver instead of the Rust engine. Count/bigint, `numeric` → Decimal, timestamps, arrays and `NULL` scalar lists are where drivers disagree. Drive the actual query strings through the real client (not reconstructions) for every site: the catalog suites, `section-score-validation.sh`, the aroma/compare aggregate units, `section-rewire-*`.
- **Decimal wire-format trap** (root CLAUDE.md): confirm the v7 client still returns `Decimal` objects so every `Number()` coercion still applies, and that JSON serialisation still yields a string so nothing silently "fixes" itself and masks a missed coercion.
- Migrations: `migrate deploy` from `/migrate` in the built image, including the P3009 recovery path in `docs/dev/deployment.md`, re-verified against a local Postgres, plus the TLS connection check above against the real database.
- The `prevent_session_hard_delete` trigger, deferred triggers, partial uniqueness and `NULLS NOT DISTINCT` invariants are covered by `check-schema.yml`'s integration jobs; they must stay green unchanged.

### Verification

- Automated: `check-schema.yml` (all jobs), `run-all.sh`, `scripts/tests/*.mjs`, `npm run build`, a Docker build + `migrate deploy` against a fresh local Postgres.
- Manual: **none on its own** if D2 is "stack with Phase 2". Otherwise a 15-minute smoke: login, join a session, rate, compare, feed, catalog search.

### As built (Phase 1, 2026-11-06) — deltas from the plan above

Everything in "Code changes" landed as written except where noted; each note is a fact found while building, recorded so the next phase doesn't re-derive it.

- **`env()` from `prisma/config` is not lazy.** It throws while the config file loads if the variable is unset, which would break `prisma generate` in the Docker builder stage (no database there). `prisma.config.ts` reads `process.env.DATABASE_URL` directly: `generate` runs without a URL and every migrate/db command still fails loud (`datasource.url property is required`), verified on 7.10.1.
- **The 7 CLI does not load `.env`, and neither does the 7 client.** Prisma 6's *client* loaded `.env` by itself, which is what the harness's bare `npx tsx` calls relied on. Three places now load it (quietly, never overriding a set variable): `prisma.config.ts` (CLI), `scripts/lib/prismaClient.mjs` (scripts), and the gitignored `_lib.sh` (exports the dev `.env` for every section, because sections that only import `lib/*` — the Better Auth e2e ones — build the app client at import time). `dotenv` is a direct devDependency for that reason.
- **Nine gitignored constructors, not six**: the six `.local/test-env/scripts/*.ts` plus `.local/seed-fixtures.ts` (the harness seed — load-bearing), `.local/swap-pwds.ts`, `.local/smoke-create-users.ts`. All on the factory, imported first so dotenv runs before `lib/prisma.ts` captures `DATABASE_URL`.
- **A third `db execute --schema` call site** existed in a tracked file: `scripts/tests/ba-session-lifetime.mjs` (the plan counted the cron + the two harness sites). Fixed; the suite aborted on it before the fix.
- **`migrate reset --skip-seed` is gone too** (seeding runs only when `prisma.config.ts` sets `migrations.seed`, which this repo does not). The harness `reset_state` passed it, so every section's reset printed the CLI help and exited 1 — caught by the runner fix from Phase 0, exactly the crash class it was built for. Flag dropped in the gitignored `_lib.sh`.
- **The harness had drifted from the app before this phase**: 32 session-create bodies across the gitignored sections sent no `dateFrom`, so since the 2026-07-06 required name+start-date rule every one of them got `400 Please set a start date` and the dependent assertions cascaded (empty codes → `308`s on `/api/session/`). Not a Prisma matter; patched locally (`"dateFrom":"2026-11-06"` prefixed into each body) so the runner could serve as acceptance evidence at all. The two Codex findings on the runner (crash = pass) and `reset_state` are what made this visible.
- **Harness result**: `run-all.sh` 34/34 sections green on Prisma 7 (31 in the full run; `section-input-hygiene-ratelimit` and `section-core-displayname` re-run after their create bodies were patched — the first contains a NUL byte, so a grep-gated loop had skipped it — and `section-better-auth-config` re-run after two stale assertions in the gitignored `_ba-e2e-signup.ts` were brought up to shipped rulings: native sign-up MIRRORS the hash into `users.password_hash` since `b7237d1`, and `/get-session` is live since iOS milestone 1). Run-to-run reruns of the Better Auth section trip the 10/min sign-in floor — clear `rl:*` first.
- **Codex review (2026-11-06), three P2 findings, all applied**: (1) the script factory inherited pg's unbounded connection wait — now `connectionTimeoutMillis: 10_000`, verified: the 11th of 11 concurrent queries on the 10-connection pool fails after 10 s; (2) the unset app pool default used logical CPUs where Prisma 6 used physical cores (8c/16t: 17 → 33) — `physicalCpuCount()` in `lib/prisma.ts` replicates `num_cpus::get_physical` (`/proc/cpuinfo` core-id pairs, logical fallback), and setting `DATABASE_CONNECTION_LIMIT` explicitly in prod remains the recommendation; (3) the TLS probe inferred "verified" from `pg_stat_ssl.ssl`, which is true for unverified links too — it now derives the verdict from pg's parsed client config (`no-verify` and `uselibpqcompat` classify as NOT verified) and prints the adapter's TLS failure reason.
- **Codex re-review, two P2 on the probe, applied**: the verdict is now read off the live TLS socket (`authorized` / `authorizationError`) from pg's own normalised config (so `ssl=no-verify` and `PGSSLMODE` are honoured), and the ssl config is logged as booleans only (an `sslkey` URL used to print the PEM). Proven against a self-signed Postgres 17: `sslmode=require` → `DEPTH_ZERO_SELF_SIGNED_CERT`; CA alone → `ERR_TLS_CERT_ALTNAME_INVALID`; `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=` → verified, hostname skipped; `uselibpqcompat=true&sslmode=require` → unverified. **Nine's Economy Postgres is self-signed with a hostname-mismatched CA (their docs), so the plain DSN WILL fail on Prisma 7 — a configuration decision is required before merge** (`docs/dev/deployment.md` § TLS).
- **TLS decision taken and implemented (owner, 2026-11-06)**: the production `DATABASE_URL` carries NO `sslmode` (Prisma 6 worked via the engine's `prefer` default; pg would attempt plaintext and Nine accepts TLS only). The owner ran the probe against production with the CA from Cockpit: TLS 1.3, chain verified (issuer `PostgreSQL CA`), hostname skipped. Shipped as `tlsConfig()` in `lib/prisma.ts` — `DATABASE_CA_CERT` / `NINE_PGDB_*_CA_CERT` → adapter `ssl: { ca, checkServerIdentity }`; no URL change, no new Deplo.io variable. Five-case test against a self-signed Postgres 17 (CA ok / fallback var / wrong CA / no CA / URL override warning). `docs/dev/deployment.md` § Prisma 7 → TLS + env list.
- **Codex round 3, two P2, applied**: (1) an empty `DATABASE_CA_CERT` no longer masks the Nine variable (empty/whitespace counts as unset); (2) the TLS settings moved into one shared plain-ESM module, `lib/pgTls.mjs` (`pgTlsConfig`), used by `lib/prisma.ts`, `scripts/lib/prismaClient.mjs` and the probe — before, scripts (e.g. the production checksum verifier) attempted plaintext while the app had the CA. Re-tested against a self-signed Postgres 17: seven app-client cases, the factory, the checksum verifier (connects over TLS, then reports on migrations) and the probe. Stale "OPEN/pending" labels removed from deployment.md. The owner's probe CA file was moved from the repo root to the gitignored `.local/nine-pg-ca.pem`.
- **`--shadow-database-url` has no v7 equivalent flag**; the CI step sets `SHADOW_DATABASE_URL` as step env and the config forwards it. The gate was mutation-tested locally: in-sync chain → exit 0; a schema with an extra column → exit 2 naming the column.
- **Error TEXT changed, codes did not.** The pg driver surfaces the constraint NAME for a unique violation (`P2002` message: "on the constraint: `users_email_key`"; raw 23505: `violates unique constraint "<name>"`) and does not expose Postgres's `DETAIL: Key (…)=(…) already exists` line, which the Rust engine folded into the message. App code branches only on codes (`P2002`/`P2003`/`P2025`, all unchanged; raw failures are `P2010` with the SQLSTATE in the message). Nine expectations across `catalog-schema-integration.mjs` and `catalog-addflow-integration.mjs` moved from DETAIL text / column list to constraint names — equally specific (a different constraint has a different name), and the NULLS-NOT-DISTINCT proof is unchanged in strength because acceptance still fails the assertion.
- **Raw typing confirmed identical** through the real client: `bigint` → `BigInt`, `numeric` → `Decimal`, timestamps → `Date`, arrays → arrays, NULL array → `null`; `Prisma.Decimal` still stringifies in JSON.
- **Pool defaults are set explicitly** (CPUs × 2 + 1, 10 s wait) because pg's own defaults (`max 10`, wait forever) would silently remove the bounded failure. Measured: limit 1 + 1 s wait → the second of two concurrent 3 s queries fails with `timeout exceeded when trying to connect`; invalid values warn and fall back; `statement_timeout` reached 5/5 distinct backends and cut a runaway query with SQLSTATE 57014.
- **TLS check sharpened**: pg 8.x treats `sslmode=require|prefer|verify-ca` as *verify-full* (and warns once at startup); the 6 engine did not verify under `require`. The probe (`.local/tls-probe.mjs`) and the decision are in `docs/dev/deployment.md` § Prisma 7 — resolved the same day, see the TLS entries above.
- **Verified in the built image** (local build from a checkout-like context, `migrate deploy` into a fresh Postgres 17): `/migrate` has the config; the schema engine is `schema-engine-linux-musl-*-openssl-3.0.x` linked against the base image's `libssl3`; `db execute --file`; idempotent redeploy; a simulated failed migration is detected as P3009 and `migrate resolve` clears it; the Alpine runner serves a DB-backed page.
- **Pre-existing, unrelated**: the sandbox dev database's recorded checksum for `20260708204128_rating_aromas` differs from the file on disk (a fresh chain matches). The harness `migrate reset` clears it; noted so a future `migrate dev` prompt isn't blamed on Prisma 7.
- **Not done, by design**: no behaviour change for users; no `pg` direct dependency (the type import in `lib/prisma.ts` resolves through the adapter's own `@types/pg`); root CLAUDE.md dev commands untouched (they still hold; Phase 2 edits that file).

## 5. Phase 2: web framework (Next 16, ESLint 10, TypeScript 6)

Everything in this phase is verified by the same manual web regression, so it ships as one branch.

### Code changes

- `next` 16.4.x, `eslint-config-next` 16.4.x, `eslint` 10.x. Run the official `@next/codemod upgrade` first, then review its diff rather than trusting it.
- `middleware.ts` → `proxy.ts`. **Keep the lightweight instance**: today's file is `NextAuth(authConfig).auth` built from `auth.config.ts` (no Prisma, no bcrypt, `authorized()` only checks for a user on `/me/*`). The rename is `export const proxy = NextAuth(authConfig).auth` with the same `/me/:path*` matcher. The Auth.js guide's generic `export { auth as proxy }` recipe is wrong for this repo: it would re-export the full `auth.ts` instance, whose `jwt()` callback hits Postgres for the revocation gate and may update last-seen state, moving database work into the proxy and duplicating what the `/me` layout and `/api/me/*` already do. `proxy` runs on the Node runtime, so that call would even succeed, which is why the invariant has to be preserved by construction. `lib/CLAUDE.md`'s wording changes from "edge middleware" to "proxy" with the same rule: JWT presence only, never revocation. The signed-out redirect on `/me/*` is the canary.
- `next lint` is removed: `"lint": "eslint ."`, drop `@eslint/eslintrc` + `FlatCompat`, import the flat exports from `eslint-config-next` directly. CLAUDE.md's dev commands updated.
- Turbopack becomes the default for `next build`. No custom webpack config exists, Tailwind 3 runs through PostCSS, `output: 'standalone'` is supported. If the Docker build fails on Turbopack, `--webpack` is the one-flag fallback, recorded as tech debt.
- `experimental.serverActions.allowedOrigins` stays where it is (still under `experimental` in 16). Async request APIs: all 16 dynamic routes already use `Promise` params; the codemod confirms there is no leftover sync access.
- `next/image` is not used, no parallel routes, no `opengraph-image`, no `revalidateTag`, no `unstable_` imports, no `scroll-behavior` CSS. None of the 16 image/caching/scroll breaking changes apply.
- TypeScript 6.x for the web workspace. Known deltas for our tsconfig: `types` now defaults to `[]`, so add `"types": ["node"]`; `paths` already uses the `./*` form; `target ES2017` stays valid. `noUncheckedSideEffectImports` is on by default, so `import './globals.css'` needs the declaration `next-env.d.ts` provides. Fix every deprecation warning now so TS 7.1 later is a version bump.
- `@types/node` stays on 24 as long as the runtime does. React stays 19.3.0 (§1).

### What can break

- Auth routing: the proxy rename is the one place a silent failure is possible (a leftover `middleware.ts` is ignored). The `/me/*` redirect-when-logged-out check is the canary.
- Server Actions CSRF origin check behind Deplo.io (unchanged config, but re-check once on the deployed host).
- Build output shape for `standalone` under Turbopack (the Dockerfile copies `.next/standalone` and `.next/static`).
- Lint rule set changes between ESLint 9 and 10 flat configs may surface new errors; fix, don't disable.

### Verification

- Automated: `run-all.sh`, `npm run build`, `npx tsc --noEmit`, `npm run lint`, Docker build.
- Manual: **the full `regression.md` pass, once**, covering Phase 1 + Phase 2 together if D2 is "stack". §14 (rate limits) last, as the doc says.

## 6. Phase 3: auth + mobile (Better Auth 1.7, zod 4, mobile bumps)

Everything here is verified by the auth test scripts plus one device pass, so it ships as one branch.

### Code changes

- `better-auth`, `@better-auth/core`, `@better-auth/expo` 1.7.18 in both workspaces and the root `overrides`. Keep the vendored Expo origin bridge in `lib/betterAuth.ts` (it exists because the real plugin's zod-4 peer could not resolve next to zod 3; that blocker disappears with zod 4 below, but swapping the bridge for the real plugin is social-sign-in work, not an upgrade; see §7).
- Known 1.7 server deltas to check against our config: `baseURL` is set explicitly, so the new Host-derived default does not apply and `trustedProxyHeaders` is not needed; `generateId: 'serial'` is still a documented value (re-run the Int-PK round trip, `_ba-e2e-signup.ts` §9 and `_ba-e2e-step5.ts`); OAuth-state options moved from `advanced` to `account` (we set none); `oidcProvider` removed (unused). The `disabledPaths` clamp and the `check-better-auth-config` CI gate re-verify the surface.
- **Mobile client migration (breaking in `@better-auth/expo` 1.7.18, verified against the published dist):**
  - The `storage` option now requires `getItemAsync` and `setItemAsync` next to the sync pair. `src/lib/secureStorage.ts` adds both, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on the async write too.
  - `authClient.getCookie()` returns `Promise<string>`. Two call sites pass it synchronously into a header or a truthiness check: `apiFetch.ts` (the Cookie header on every Verre API call) and `freshInstall.ts` (the revoke-before-wipe gate). Both become `await`.
  - **Chunked Keychain values changed format.** 1.6.15 wrote `<key>.<i>` (64 slots probed by the wipe). 1.7.18 writes slot-addressed chunks `<key>.0.<i>` / `<key>.1.<i>` with an active-slot marker and up to 100 chunks, and still reads the legacy form. The reinstall wipe in `freshInstall.ts` must probe all three forms (legacy, slot 0, slot 1) across 100 slots, or an upgraded install can keep an old session's chunks after the wipe reports clean. Tests: sparse runs, missing base marker, partial delete failure, and an *existing install upgraded in place* (the current fresh-install-then-sign-up device pass does not exercise this).
  - **Session-cache seeding is now asynchronous.** 1.6.15 seeded the session atom synchronously inside `createAuthClient` at module init, and `apps/mobile/CLAUDE.md` + `bootGate.ts` are built around that (the wipe resets the seeded atom via `.value` before the first subscriber mounts; the first heartbeat fires from that seed and is held by the gate). In 1.7.18 the seed is `restoreSessionCache()`, awaited inside the client's `init` hook *before the first `/get-session` request is built*, reading `verre_session_data` via `getItemAsync`. Hazard: that read can happen before the wipe has cleared the key, and the restored session lands in the atom after the wipe's reset. The boot gate's ordering must be re-derived against the new sequence (restore → gate → fetch), and the wipe must clear storage before any request reaches `init`, or reset the atom again after the verdict. Device scenarios: existing-install upgrade, reinstall, offline cold launch, sign-out then sign-in race with a slow heartbeat.
  - Keychain storage calls are now serialised by the client; the `cookieIsStale()` check still reads synchronously, which stays valid as long as the sync `getItem` remains on the wrapper.
- `zod` 4.6.7 at the root. Four files: `z.string().email()` → `z.email()`, `safeParse` result shape is unchanged for how we read it, `EntriesSchema.parse` unchanged. Type-check catches the rest.
- Mobile minors: `react-native-gesture-handler` 3.5, `react-native-worklets` 0.13.1, `react-native-svg` 15.16.1, `@react-native-community/datetimepicker` 9.3. Each must pass `expo install --check` (it may pin them back; if so, leave them).
- `react-native-gesture-image-viewer` 2.3.2 → 2.6.0 (decision D4). Upstream 2.6 ships the `scheduleInitialScroll` fix our patch mirrors and an opt-in `panInertia`. The patch shrinks to the double-tap `maxDelay`/`maxDuration` and, if we keep our own glide, the `withDecay` block. 3.x is a paging-API rewrite and is out of scope.
- `@react-native-async-storage/async-storage` stays at 2.2.0. Version 3 changes the API (`createAsyncStorage(...)`) and the iOS backend (SQLite), and Expo SDK 58 pins 2.2.0. Deferred to §7; the fresh-install marker lives in it, so a future migration needs an existing-marker continuity test (losing the marker signs the user out).

### What can break

- Native sign-in / sign-up / heartbeat / change-password / sign-out-everywhere across both session stores (the identityStore chokepoint). The `active-sessions` and Redis-first invariants in root CLAUDE.md are the things a BA minor can shift.
- The 426 min-version gate at `/api/auth/native/*` (`lib/clientVersion.ts`), since the BA before-hook ordering is where it lives.
- Web register/login error copy through zod 4 (`register`, `login-precheck`, `auth.ts`).
- Gallery open-on-page-N, zoom/pan, double-tap; date picker; every RNGH gesture surface (pull-to-swap, bottom sheets, compare strips).

### Verification

- Automated: `section-native-auth-*.sh`, `section-identity-store.sh`, `section-better-auth-config.sh`, `_ba-e2e-signup.ts`, `_ba-e2e-step5.ts`, `section-auth-sessions*.sh`, `section-17-bot-defenses.sh`, `check-identity-writes.yml`, `check-better-auth-config.yml`, mobile `tsc` + `expo lint`.
- Manual: `regression.md` §1 and §17 on the web (short), and **one device pass** in three legs on the same build. The reinstall wipe only runs when the AsyncStorage marker is absent, so an in-place upgrade never exercises it; leg (b) exists for that.
  - (a) **Upgrade in place** over an installed 1.6.15 build with a live session: launch → the session survives (the marker is present, no wipe) → the app works end to end. Asserts that the chunk-format change reads legacy `<key>.<i>` material.
  - (b) **Reinstall with live credentials**: on that upgraded build, signed in, delete the app *without signing out* → reinstall the same build → cold-launch **offline** first, then online. Asserts: no previous identity renders, no stale cookie is sent (the boot gate), and after the wipe **no `verre_*` key in any of the three chunk formats holds credential material**. Precisely: every probed key is absent, or holds one of the two safe sentinels, the SDK's own `""` (its sign-out and chunk rotation write empty strings and leave keys in place) or our wipe's `'{}'` fallback (`clearKeys` overwrites a key the Keychain refuses to delete and accepts `'{}'` as cleared). "Key absent" is not the SDK's contract, and a bare "non-empty value" test would reject our own fallback, so the criterion is "nothing that parses to a cookie or a session". The chunk probe in `freshInstall.ts` extends to the slot formats with the same sentinel rule, and the partial-delete-failure tests assert the sentinel, not absence.
  - (c) **Fresh install** → sign up → sign in → background/foreground heartbeat → gallery + gestures + date picker (these live under the authenticated tabs) → change password → sign out.
  - "Sign out everywhere" has no native surface yet (the devices route documents native callers 401 there). Revoking every session for the test account is done from the web Connected-devices panel or a password change, then the device must land signed out on its next heartbeat.
  - The device pass needs the Mac rebuild (native deps changed).

## 7. Deferred, with the trigger that would pull each in

- **redis client 4 → 6.** Real migration (`executeIsolated` → pool, `scanIterator` yields arrays, several boolean→number returns, RESP3 default, 5 s default command timeout). No deadline, Valkey 9 is happy with v4. Trigger: a node-redis advisory, or needing client-side caching.
- **Node 26.** Maintenance LTS for 24 runs to April 2028. Trigger: a Node 24 CVE without backport, or a dependency raising its floor. When taken, it rides on whichever phase next runs `run-all.sh`.
- **TypeScript 7.** typescript-eslint needs the TS 7.1 compiler API. Microsoft's side-by-side setup (TS 7 as `tsc`, the TS 6 package aliased for tooling) is possible today, but it is a second toolchain to maintain for a type-check speedup this codebase does not need. Trigger: typescript-eslint releases 7.1 support.
- **async-storage 3.** API and iOS backend change; Expo SDK 58 pins 2.2.0. Trigger: the Expo map moves. Needs the fresh-install marker continuity test.
- **Tailwind 4, framer-motion → motion 14, react-easy-crop 6.** All visual. Fold into the planned web redesign; migrating twice is waste.
- **nanoid 6.** ESM-only, no advisory on the 3.x legacy line. Trigger: any 3.x advisory.
- **next-auth v5 beta → Better Auth for web.** Removes the one dependency with no stable future and the dual credential store. A project, not an upgrade; needs its own proposal.
- **Real `@better-auth/expo` plugin instead of the vendored bridge.** Arrives with social sign-in (mobile-app proposal step 6).
- **CocoaPods trunk read-only (2026-12-02).** Nothing to do now; matters only when SDK 59 or a pod bump needs a spec newer than the freeze. Expo's SPM tooling is the eventual exit.
- **Prisma 8.** Still RC, and a different model: no `generator` block, no generated `PrismaClient`, `prisma contract emit` + a hand-built client, config in `prisma.config.ts`, with a documented path that imports a Prisma 7 schema and runs 7 and 8 side by side per route. Revisit when GA plus one minor; Prisma 7 stays supported 18 months after 8 GA. The generator switch deferred in D1 is folded into this, not done ahead of it.

## 8. Improvements to discuss (opt-in, not in any phase by default)

Each of these changes behaviour, build characteristics, or what a user sees. None is required.

- **React Compiler** (`reactCompiler: true`, stable in Next 16): automatic memoisation, slower builds, possible re-render timing changes in the wine modal / pull-to-swap paths. Needs its own test pass; not bundled.
- **Turbopack filesystem cache** for `next build`: faster CI/Docker builds; safe but changes build-cache semantics in Docker layers.
- **`panInertia`** from image-viewer 2.6 instead of our `withDecay` glide: upstream deceleration curve differs from the clamp + rubber-band we tuned. Visible change, so it is a design decision, not an upgrade.
- **zod 4 features** (JSON Schema export, faster parsing): no consumer today.
- **Better Auth 1.7 features** (purpose-specific secrets, `account.storeStateStrategy`): relevant only once social sign-in exists.
- **Node 26** runtime perf: measurable but small; see §7.
- **Prisma 7 smaller image**: automatic, nothing to decide.
- **Tailwind 4 / motion 14**: redesign-time.

## 9. Decisions needed before starting

- **D1. Generator**: keep `prisma-client-js` on Prisma 7 (recommended as of revision 3: verified working on 7.10.1 with the adapter, zero import changes, scripts and `/migrate` untouched; Prisma 8 replaces the generator model anyway, so a switch now is discarded work) vs switch to `prisma-client` now (19-file import rename, TS-only output that needs explicit `moduleFormat` / `importFileExtension` settings or `tsx` for the `.mjs` scripts, and a generated client to ship into any image that runs those scripts). The deprecation is accepted debt tied to the Prisma 8 decision.
- **D2. Stacking**: Phase 1 and Phase 2 on one integration branch with **one** manual web regression (recommended; accepts ~2 weeks past the 2026-11-19 Prisma 6 cutoff, which is "no new patches", not a known runtime vulnerability), vs Phase 1 alone first with a 15-minute smoke and a second full pass after Phase 2.
- **D3. Phase 3 timing**: after Phase 2 (recommended, the server and mobile move together on an already-upgraded Next), vs before (clears the audit critical sooner; nothing exploitable is open).
- **D4. Image viewer**: 2.6.0 with a slimmer patch (recommended) vs stay on 2.3.2 + full patch vs 3.x (out of scope).
- **D5. Node 26**: defer (recommended) vs ride on Phase 1.
- **D6. Local S3 image**: switch to a maintained S3-compatible image (one-time README + bucket-policy rewrite; recommended, it is the only option that meets the "supported line" goal) vs pin a last-known-good `minio/minio` tag as an explicit local-dev exception (does not restore maintenance). Local dev only; production is Nine object storage.
- **D7. Reviewer per phase**: Codex or a spawned reviewer; the review for Phase 1 and 3 must be pointed at `prisma/CLAUDE.md`, `lib/CLAUDE.md`, `app/api/auth/CLAUDE.md`, `docs/dev/proposals/mobile-app/01-identity-and-auth.md`.

## 10. Run order (one day, 2026-11-06, owner + Claude together)

Everything runs in one sitting on one branch, `feature/deps-2026-11`, as four sequential commits so a failure is attributable. The phases are the same; only the clock changed. The owner's time is concentrated in two blocks.

| Step | Claude does | Owner does |
|---|---|---|
| 0 Hygiene | actions v7, runner fix, S3 image, pins | ✅ PG 17 read off Cockpit |
| 1 Prisma 7 | adapter, config, CLI flags, scripts, Docker | nothing until the TLS check |
| 1 TLS check | prepare the probe | run it against the prod URL |
| 2 Next 16 | codemod, proxy, lint, TS 6, build | **web regression, once** |
| 3 Auth + mobile | BA 1.7.18, zod 4, wipe rework, patch | Mac rebuild, **device pass ×3 legs** |
| Review | address findings | Codex review per phase |
| Merge | squash per phase, push | merge, watch the Prisma 7 `migrate deploy` in Cockpit |

Between steps, Claude runs the automated suites (`run-all.sh` after its fix, `check-schema.yml` locally where possible, `npm run build`, `tsc`, lint) so the owner's two manual blocks start from green. The web regression happens after Phase 2 and covers Phase 1 too; the device pass after Phase 3. Rate-limit sections of the regression run last, as the doc says.

Decisions implied by the one-day run: D2 = stack (one web pass), D3 = Phase 3 after Phase 2 in the same sitting, D7 = Codex, who already reviewed the plan three times. D1, D4, D5, D6 at their recommended values unless overridden before the branch is cut.

Deploy happens on merge, so the merge is the last step of the day and the Prisma 7 `migrate deploy` in production is watched live.

After shipping: this file stays as the rationale-of-record with a status line, per `docs/dev/proposals/README.md`. Version pins and the new `prisma.config.ts` get described in `docs/dev/deployment.md`; CLAUDE.md dev commands and the `lib/CLAUDE.md` proxy wording are updated in Phase 2.
