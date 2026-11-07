// TLS settings for EVERY node-postgres connection path — the app client
// (lib/prisma.ts), the script factory (scripts/lib/prismaClient.mjs) and the
// TLS probe — defined once so the paths cannot drift (review, 2026-11-06: the
// scripts attempted plaintext against a TLS-only server while the app had the
// CA). Plain ESM, not TypeScript, because the scripts run under bare `node`.
//
// 🔒 Why this exists: Nine's Economy Postgres presents a self-signed
// certificate whose CA does not match the hostname. Prisma 6's engine never
// verified it (`sslmode=prefer`); node-postgres attempts PLAINTEXT when the URL
// has no `sslmode` and verify-full when it does — both fail. With a CA in the
// environment, TLS is on, the chain is checked against THAT CA and only the
// hostname check is skipped (libpq `verify-ca`): stronger than the 6 posture.
// Deplo.io injects the CA as `NINE_PGDB_<NAME>_CA_CERT`; `DATABASE_CA_CERT` is
// the generic name. An EMPTY value counts as unset (an empty generic must not
// mask the Nine variable). Verified against production 2026-11-06.
//
// ⚠️ pg lets the URL win: an `sslmode`/`ssl`/`sslrootcert` query parameter
// REPLACES the `ssl` object, so the URL must stay free of TLS parameters while
// a CA variable is set — hence the warning.
const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * @param {string | undefined} url the connection string the caller will use
 * @returns {import('pg').PoolConfig['ssl']} the `ssl` option, or undefined
 */
export function pgTlsConfig(url) {
  const ca = nonEmpty(process.env.DATABASE_CA_CERT)
    ?? Object.entries(process.env).find(([k, v]) => /^NINE_PGDB_[A-Z0-9_]+_CA_CERT$/.test(k) && nonEmpty(v))?.[1]
  if (!ca) return undefined
  if (url && /[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/.test(url)) {
    console.warn('[pg] DATABASE_URL carries TLS parameters, which take precedence over the CA certificate from the environment')
  }
  return { ca, checkServerIdentity: () => undefined }
}
