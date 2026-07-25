import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

// ── Connection pool + statement timeout ────────────────────────────────────
//
// 🔒 WHY THIS EXISTS. The app sets no `connection_limit` anywhere, so Prisma's
// defaults apply. Prisma DOES queue requests FIFO when the pool is exhausted —
// the failure mode is not "no queuing", it is that the queue has a deadline:
// after `pool_timeout` (default 10 s) a waiting request fails with **P2024**.
// Measured against a large catalog, 50 concurrent expensive searches exhausted
// the pool and a majority of them timed out rather than completing slowly.
//
// ⚠️ These knobs BOUND the failure; they do not create capacity. For real
// horizontal scale the answer is a pooled endpoint (PgBouncer in transaction
// mode) with a separate direct URL kept for migrations — not a bigger number
// here. Sizing must be budgeted across EVERY app instance, since each one
// opens its own pool.
//
// Two knobs, both opt-in so this changes nothing until deliberately configured
// (and so a bad value can be reverted by unsetting an env var rather than
// shipping code):
//
//   • DATABASE_CONNECTION_LIMIT — pool size per app instance. Sizing rule:
//     total connections across ALL instances must stay under the database's
//     `max_connections`, so this is (max_connections − headroom) / instances.
//     Too HIGH is not "more throughput" — it is CPU thrashing plus a real risk
//     of exhausting the server's connection slots and locking out migrations.
//   • DATABASE_POOL_TIMEOUT — seconds a queued request waits for a free
//     connection before failing with P2024 (Prisma's default is 10). Raising it
//     converts a fast failure into a slow success under bursts; it does not
//     create capacity.
//
// ⚠️ Written into the URL rather than passed as client options because Prisma
// reads these from the connection string. Existing query parameters are
// preserved (Nine's managed Postgres URL carries `sslmode`), and an existing
// `options` value is APPENDED to rather than replaced.
function buildDatasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL
  if (!base) return undefined
  const limit = process.env.DATABASE_CONNECTION_LIMIT
  const poolTimeout = process.env.DATABASE_POOL_TIMEOUT
  const statementTimeoutMs = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS)
  const wantsTimeout = Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
  if (!limit && !poolTimeout && !wantsTimeout) return undefined  // unset ⇒ Prisma defaults
  try {
    const url = new URL(base)
    // ⚠️ Validate rather than pass through: a non-numeric `connection_limit`
    // is silently ignored by the driver, which would leave the pool on its
    // default while the deploy believes it was configured.
    const posInt = (v: string | undefined, name: string) => {
      if (!v) return undefined
      if (!/^\d+$/.test(v) || Number(v) < 1) {
        console.warn(`[prisma] ignoring invalid ${name}=${JSON.stringify(v)} (want a positive integer)`)
        return undefined
      }
      return v
    }
    const validLimit = posInt(limit, 'DATABASE_CONNECTION_LIMIT')
    const validPoolTimeout = posInt(poolTimeout, 'DATABASE_POOL_TIMEOUT')
    if (validLimit) url.searchParams.set('connection_limit', validLimit)
    if (validPoolTimeout) url.searchParams.set('pool_timeout', validPoolTimeout)
    // 🔒 A STATEMENT TIMEOUT IS THE BACKSTOP THE POOL SIZE CANNOT PROVIDE. Pool
    // limits bound how many queries run CONCURRENTLY; they do nothing about ONE
    // query running for minutes while holding its connection, which degrades
    // every request queued behind it.
    //
    // ⚠️ Set through libpq's `options`, NOT by issuing `SET statement_timeout`
    // after connecting. Verified: a `SET` at module init reached exactly ONE
    // pooled backend, so every other connection kept the default — a guard that
    // silently protects a fraction of traffic. With `options` the server applies
    // it as each connection is established: measured across 5 distinct backends,
    // all reported the configured value.
    //
    // Deliberately generous when set — a runaway fence, not a latency target.
    // Realistic catalog search measures 0.9–41 ms at 300k rows.
    // 🔒 APPEND to any existing `options`, never replace it. A managed
    // database's URL can already carry startup options, and overwriting the
    // parameter would silently discard them.
    if (wantsTimeout) {
      const existing = url.searchParams.get('options')
      const ours = `-c statement_timeout=${Math.floor(statementTimeoutMs)}`
      url.searchParams.set('options', existing ? `${existing} ${ours}` : ours)
    }
    return url.toString()
  } catch {
    // A malformed DATABASE_URL is the deploy's problem, not this helper's —
    // fall through to the unmodified value so the failure surfaces where it
    // normally would rather than as a confusing URL-parse error here.
    return undefined
  }
}

const datasourceUrl = buildDatasourceUrl()

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(datasourceUrl ? { datasourceUrl } : {}),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
