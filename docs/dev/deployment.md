# Deployment (Deploio / Nine)

- Hosted on Deploio, deployed from `main` on push (Dockerfile build).
- Postgres + Redis + S3-compatible Object Storage all on Nine. Specific app names, project IDs, hostnames, and live URLs are intentionally not in this file — see the Deploio dashboard.

## Env vars set on Deploio (values not stored in repo)

- `REDIS_URL`, `DATABASE_URL` — service connections.
- `AUTH_SECRET` — NextAuth + register-token HMAC. (`NEXTAUTH_SECRET` / `JWT_SECRET` accepted as fallback names by `auth.ts` and `lib/registerToken.ts`.)
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` — Object Storage.
- `SERVER_ACTIONS_ALLOWED_ORIGINS` — comma-separated extra origins for Server Actions CSRF (deployed hostname; `localhost:8080` always allowed; no scheme).
- `PUBLIC_HOSTNAME` — used as contact info in the Nominatim User-Agent header when `GOOGLE_PLACES_API_KEY` is unset; falls back to `'self-hosted'`.
- `GOOGLE_PLACES_API_KEY` (optional) — when set, `/api/places` uses Google Places; when unset, falls back to OSM Overpass + Nominatim.
- `NEXT_TELEMETRY_DISABLED=1` — opts out of Next.js anonymous build/usage telemetry.
- `GEO_DATA_DIR` (optional) — where the app keeps the downloaded IP→country lookup files; defaults to `/tmp/verre-geo`. Must be a writable dir. Override only if `/tmp` isn't writable on the runner.

## Geo IP→country data (Connected-devices labels)

The "logged in from <country>" labels resolve IPs to countries **in-process** from a self-hosted dataset — the IP never leaves the server (no geo API). Delivery:

1. **Weekly scheduled job** (`.deploio.yaml` `scheduledJobs` → `refresh-geo-data`, Sun 04:00): `node scripts/refresh-geo-data.mjs` fetches public RIR delegated-stats, builds the binary lookup tables, and uploads them to fixed S3 keys (`geo/geo-v4.bin`, `geo/geo-v6.bin`, `geo/geo-cc.json`). Best-effort: any failure (source down, timeout, S3 error) is swallowed and the existing S3 copy is kept.
2. **App at boot** (`instrumentation.ts` → `lib/geoData.ts` `ensureGeoData`): downloads those files from S3 to `GEO_DATA_DIR`. **If the set is incomplete (cold start before the first weekly run, or a partial S3 upload), it kicks off a one-time seed (generate+upload) in the BACKGROUND** so a fresh deploy isn't blank — without blocking boot on a ~50MB fetch. The seed writes to S3, so the boot then **polls S3 (a few times, ~60s apart, non-blocking)** to pull the freshly-seeded files onto *this* instance's disk — so the instance self-heals without waiting for a restart. `lib/geo.ts` queries the files on disk; missing files → "Unknown location".

**Outbound egress requirement**: the refresh fetches the NRO combined file from `ftp.ripe.net` (fallback: `ftp.arin.net`, `ftp.apnic.net`, `ftp.lacnic.net`, `ftp.afrinic.net`). If the scheduled-job environment has no egress to these hosts, the refresh no-ops and geo stays on the last-good S3 copy (or blank on a never-yet-seeded cold start). Manual refresh from anywhere with egress: `node scripts/generate-geo-table.mjs <dir>` then upload. Data is stable; weekly is ample.

## Session-row cleanup (bounded retention)

A **daily scheduled job** (`.deploio.yaml` `scheduledJobs` → `cleanup-revoked-sessions`, 03:00) prunes `user_sessions` rows revoked >90 days: `prisma db execute --file prisma/maintenance/cleanup-revoked-sessions.sql`. A scheduled-job failure never affects the release. Because it's a real daily cron (not deploy-driven), retention is a true 90-day floor. This keeps revoked rows (a per-user login ledger: device label, country, timestamps) from accumulating indefinitely — the same privacy reason the audit-log table was dropped. Active sessions are never touched. (pg_cron isn't on Nine's Postgres, but Deplo.io's native `scheduledJobs` is the scheduler.) See `prisma/maintenance/cleanup-revoked-sessions.sql`.
