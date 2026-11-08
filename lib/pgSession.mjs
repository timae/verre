// Postgres SESSION settings every Prisma connection must carry — one
// definition, shared by the app client (lib/prisma.ts) and the script factory
// (scripts/lib/prismaClient.mjs). Plain ESM, like lib/pgTls.mjs, because the
// scripts run under bare `node`.
//
// 🔒 TimeZone = UTC. @prisma/adapter-pg (7.x) assumes a UTC session: on READ
// it replaces the offset Postgres returns for a timestamptz with `+00:00`
// (`normalize_timestamptz`), and Date parameters are sent WITHOUT an offset, so
// on WRITE Postgres interprets them in the session zone. Production Postgres
// runs `Europe/Zurich`: since the Prisma 7 upgrade, app-written timestamps were
// stored 1–2 h early and database-stamped / older ones read 1–2 h late (typed
// write → typed read round trips cancel, which is why it looked fine). Measured
// on prod 2026-11-08: session TimeZone Europe/Zurich, read shift +60 min.
// Pinned in CI by scripts/tests/pg-timezone-integration.mjs against a database
// whose default zone is Europe/Zurich.
//
// Sent as the `options` STARTUP parameter, so the server applies it to every
// pooled connection as it is established (a `SET` after connecting reaches
// one backend only — see the statement_timeout note in lib/prisma.ts). The pin
// goes after PGOPTIONS, so a `-c TimeZone=…` there loses to it.
//
// ⚠️ pg lets the URL win: an `options` query parameter in the connection
// string REPLACES the `options` config (an empty one falls through to
// PGOPTIONS), and a NUL byte in any startup field (e.g. `application_name`)
// injects a separate `TimeZone` startup parameter, which Postgres applies after
// `options`. Either silently drops the pin. Rather than re-implement pg's URL
// parsing (repeated keys, encoded names, host-less URLs), ask pg itself: build
// the exact startup message pg would send for the caller's COMPLETE config
// (TLS included — pg validates it, e.g. PGSSLNEGOTIATION=direct needs `ssl`)
// and throw unless it carries our options untouched and no NUL. The Prisma
// client is then never built, so every route that loads it fails loudly
// instead of running on Zurich time. Session options belong in PGOPTIONS,
// which is merged here (an explicit `options` config replaces it in pg).
import pg from 'pg'
import ConnectionParameters from 'pg/lib/connection-parameters.js'

const PIN = '-c TimeZone=UTC'

/** @template {import('pg').PoolConfig} T @param {T} config @returns {T & { options: string }} */
export function withSessionPin(config) {
  const options = [process.env.PGOPTIONS, PIN].filter(Boolean).join(' ')
  const pinned = { ...config, options }
  const startup = pg.Client.prototype.getStartupConf.call({ connectionParameters: new ConnectionParameters(pinned) })
  if (startup.options !== options) {
    throw new Error('DATABASE_URL carries an `options` parameter, which would replace the UTC session pin (pg lets the URL win) — move it to PGOPTIONS')
  }
  if (Object.values(startup).some((v) => String(v).includes('\0'))) {
    throw new Error('a database connection parameter contains a NUL byte, which would inject startup parameters past the UTC session pin')
  }
  return pinned
}
