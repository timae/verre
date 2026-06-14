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

### Mobile app build-time env (`apps/mobile`, NOT Deploio server vars)

`EXPO_PUBLIC_*` vars are **inlined into the JS bundle at build/export time** — set in `apps/mobile/.env.local` (gitignored; `.env.example` is the template) or per build command, never on the server. Change one ⇒ rebuild.

- `EXPO_PUBLIC_API_URL` — backend the app talks to (Simulator → `localhost:3000`; device → Mac LAN IP).
- `EXPO_PUBLIC_WEB_URL` — public web origin for shareable links (the `/join/<code>` invite). Set to the real domain for prod/TestFlight builds; falls back through `app.json` `extra.webBaseUrl` → `EXPO_PUBLIC_API_URL` so local-deployment links resolve against the same backend.

## Geo IP→country data (Connected-devices labels)

The "logged in from <country>" labels resolve IPs to countries **in-process** from a self-hosted dataset — the IP never leaves the server (no geo API). Delivery:

1. **Weekly scheduled job** (`.deploio.yaml` `scheduledJobs` → `refresh-geo-data`, Sun 04:00): `node scripts/refresh-geo-data.mjs` fetches public RIR delegated-stats, builds the binary lookup tables, and uploads them to fixed S3 keys (`geo/geo-v4.bin`, `geo/geo-v6.bin`, `geo/geo-cc.json`). Best-effort: any failure (source down, timeout, S3 error) is swallowed and the existing S3 copy is kept.
2. **App at boot** (`instrumentation.ts` → `lib/geoData.ts` `ensureGeoData`): downloads those files from S3 to `GEO_DATA_DIR`. **If the set is incomplete (cold start before the first weekly run, or a partial S3 upload), it kicks off a one-time seed (generate+upload) in the BACKGROUND** so a fresh deploy isn't blank — without blocking boot on a ~50MB fetch. The seed writes to S3, so the boot then **polls S3 (a few times, ~60s apart, non-blocking)** to pull the freshly-seeded files onto *this* instance's disk — so the instance self-heals without waiting for a restart. `lib/geo.ts` queries the files on disk; missing files → "Unknown location".

**Outbound egress requirement**: the refresh fetches the NRO combined file from `ftp.ripe.net` (fallback: `ftp.arin.net`, `ftp.apnic.net`, `ftp.lacnic.net`, `ftp.afrinic.net`). If the scheduled-job environment has no egress to these hosts, the refresh no-ops and geo stays on the last-good S3 copy (or blank on a never-yet-seeded cold start). Manual refresh from anywhere with egress: `node scripts/generate-geo-table.mjs <dir>` then upload. Data is stable; weekly is ample.

## Session-row cleanup (bounded retention)

A **daily scheduled job** (`.deploio.yaml` `scheduledJobs` → `cleanup-revoked-sessions`, 03:00) prunes `user_sessions` rows revoked >90 days: `prisma db execute --file prisma/maintenance/cleanup-revoked-sessions.sql`. A scheduled-job failure never affects the release. Because it's a real daily cron (not deploy-driven), retention is a true 90-day floor. This keeps revoked rows (a per-user login ledger: device label, country, timestamps) from accumulating indefinitely — the same privacy reason the audit-log table was dropped. Active sessions are never touched. (pg_cron isn't on Nine's Postgres, but Deplo.io's native `scheduledJobs` is the scheduler.) See `prisma/maintenance/cleanup-revoked-sessions.sql`.
