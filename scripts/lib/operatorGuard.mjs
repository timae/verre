// Guards shared by the catalogue model change's prod operator scripts
// (scripts/backfill-model-change.mjs, scripts/catalog-columns-update.mjs).
//
// - DATABASE_URL must come from the operator's environment: scripts/lib/
//   prismaClient.mjs would otherwise fall back to the checkout's .env, quietly.
//   Once it is confirmed, .env is loaded exactly as prismaClient.mjs will load it
//   (never overriding the environment) BEFORE the target is resolved: a host-less
//   URL takes PGHOST / PGPORT from the environment, and .env could otherwise move
//   the connection after the check (Codex r2).
// - The target (host, port, database, TLS; never the password) is printed to
//   stderr BEFORE anything connects, read from pg's OWN resolved configuration
//   (pg/lib/connection-parameters.js, the object the client connects with), never
//   from a parse of our own: the URL's query can override the host (`?host=`,
//   percent-encoded too) and TLS (`?sslmode=`), and pg follows it, and --apply requires --expect-db <host>/<db>:
//   the host must be the URL's, the database current_database(), checked inside
//   the transaction before any write. --apply to a host that is not loopback
//   needs the CA (DATABASE_CA_CERT or Deplo.io's NINE_PGDB_*_CA_CERT), as the
//   runbook exports it, and a URL with no TLS parameters of its own: pg lets the
//   URL's `sslmode` & co. replace the CA, so either way TLS would be whatever the
//   URL says (possibly plaintext or unverified).
// - Server-side bounds for the transaction, so an operator connection that drops
//   (a sleeping laptop, a dead network) cannot hold its locks: the server ends an
//   idle transaction after 30 s and any one statement after 120 s. Printed back as
//   the server applied them.

import { config as loadEnv } from 'dotenv'
import ConnectionParameters from 'pg/lib/connection-parameters.js'
import { pgTlsConfig } from '../../lib/pgTls.mjs'

/** An error as one line: the Postgres / Prisma code and the whole message (Prisma's
 * raw-query errors start with a newline, so a first line alone is empty). */
export function errText(e) {
  const code = e?.meta?.code ?? e?.code
  const msg = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 500)
  return [code, msg || 'unknown error'].filter(Boolean).join(': ')
}

export function argValue(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  return v === undefined || v.startsWith('--') ? null : v
}

export function targetFromEnv(script) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error(`${script}: DATABASE_URL is not set in the environment (refusing the checkout's .env)`)
    process.exit(2)
  }
  loadEnv({ quiet: true })
  let cp, ssl
  try {
    ssl = pgTlsConfig(url)
    cp = new ConnectionParameters({ connectionString: url, ...(ssl ? { ssl } : {}) })
  } catch (e) { console.error(`${script}: DATABASE_URL does not parse (${errText(e)})`); process.exit(2) }
  const host = String(cp.host), db = String(cp.database)
  // Verified only when pg kept OUR CA object: a TLS parameter in the URL replaces it.
  const verified = !!ssl && cp.ssl === ssl
  const tls = verified ? 'verify-ca (CA from the environment)'
    : !cp.ssl ? (ssl ? 'none: the URL turns TLS off, which replaces the CA' : 'none (no CA in the environment, no TLS in the URL)')
      : `set by the URL (${JSON.stringify(cp.ssl)}), which replaces any CA`
  console.error(`${script}: target ${host}:${cp.port}/${db}, tls ${tls}`)
  const loopback = host.startsWith('/') || /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/.test(host)
  return { host, db, loopback, verified }
}

/** --apply's target check before connecting: `<host>/<db>` as the URL has it, and a CA off loopback. */
export function checkApplyTarget(script, target, expect) {
  if (`${target.host}/${target.db}` !== expect) {
    console.error(`${script}: --expect-db ${expect} is not the target (${target.host}/${target.db})`)
    process.exit(1)
  }
  if (!target.loopback && !target.verified) {
    console.error(`${script}: --apply to ${target.host} needs the database CA in the environment (DATABASE_CA_CERT) and no TLS parameters in DATABASE_URL, as the runbook has it`)
    process.exit(1)
  }
}

/** Inside the transaction, before any write. Returns what to print. */
export async function boundTransaction(tx, { apply, expectDb }) {
  const expectName = expectDb?.slice(expectDb.lastIndexOf('/') + 1)
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`)
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`)
  await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '30s'`)
  const [r] = await tx.$queryRawUnsafe(`
    SELECT current_database() AS db, current_setting('lock_timeout') AS lock,
           current_setting('statement_timeout') AS stmt, current_setting('idle_in_transaction_session_timeout') AS idle`)
  if (apply && r.db !== expectName) {
    throw Object.assign(new Error(`--expect-db ${expectDb} does not match the database connected to (${r.db})`), { refused: true })
  }
  return { database: r.db, bounds: `lock_timeout ${r.lock}, statement_timeout ${r.stmt}, idle_in_transaction_session_timeout ${r.idle}` }
}
