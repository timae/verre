import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import type { PoolConfig } from 'pg'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { pgTlsConfig } from './pgTls.mjs'
import { withSessionPin } from './pgSession.mjs'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

// ── Connection pool + statement timeout ────────────────────────────────────
//
// Prisma 7 has no built-in pool: queries go through node-postgres via
// `@prisma/adapter-pg`, and the pool is pg's `Pool`, configured here. The three
// env knobs keep their names and meaning from the Prisma 6 days; only the
// mechanism changed (pg `PoolConfig` fields instead of URL query parameters).
//
// 🔒 WHY THIS EXISTS. A pool queues requests FIFO when it is exhausted — the
// failure mode is not "no queuing", it is that the queue needs a deadline: a
// waiting request must fail after a bound rather than hang. Measured on Prisma
// 6 against a large catalog, 50 concurrent expensive searches exhausted the
// pool and a majority of them timed out (P2024) rather than completing slowly.
//
// ⚠️ These knobs BOUND the failure; they do not create capacity. For real
// horizontal scale the answer is a pooled endpoint (PgBouncer in transaction
// mode) with a separate direct URL kept for migrations — not a bigger number
// here. Sizing must be budgeted across EVERY app instance, since each one
// opens its own pool.
//
//   • DATABASE_CONNECTION_LIMIT → `max`: pool size per app instance. Sizing
//     rule: total connections across ALL instances must stay under the
//     database's `max_connections`, so this is (max_connections − headroom) /
//     instances. Too HIGH is not "more throughput" — it is CPU thrashing plus a
//     real risk of exhausting the server's connection slots and locking out
//     migrations.
//   • DATABASE_POOL_TIMEOUT → `connectionTimeoutMillis`: seconds a queued
//     request waits for a free connection before failing. Raising it converts
//     a fast failure into a slow success under bursts; it does not create
//     capacity.
//
// ⚠️ UNSET MEANS PRISMA 6's DEFAULTS, NOT pg's. pg defaults to `max: 10` and
// `connectionTimeoutMillis: 0` — a request waits for a free connection
// FOREVER, which would turn the bounded failure into an unbounded hang under
// exactly the burst these knobs exist for. So both are always set: `max` =
// PHYSICAL cores × 2 + 1 (Prisma's documented default pool size) and a 10 s
// wait (Prisma's default `pool_timeout`). An exhausted pool now surfaces as pg's "timeout exceeded
// when trying to connect" instead of P2024 — same shape: fail fast, never
// queue without bound.
//
// `DATABASE_URL`'s own query parameters (Nine's `sslmode` etc.) are parsed by
// pg from the connection string and are not touched here — except that one
// carrying `options` makes building the client throw, because pg would let it replace the
// UTC session pin (lib/pgSession.mjs).
//
// ⚠️ Validate rather than pass through: a non-numeric value would silently
// leave the pool on its default while the deploy believes it was configured.
// Prisma 6 sized its default pool from `num_cpus::get_physical()`, which on
// Linux counts distinct physical-id/core-id pairs in /proc/cpuinfo and falls
// back to the logical count when those lines are absent (arm64, some VMs).
// Replicated here because Node only exposes logical CPUs, and on an SMT host
// that would silently double the pool (8c/16t: 17 → 33 connections per
// instance) the moment the limit is unset. Review finding, 2026-11-06.
function physicalCpuCount(): number {
  const logical = os.cpus().length || 1
  try {
    const cores = new Set<string>()
    let socket = ''
    for (const line of readFileSync('/proc/cpuinfo', 'utf8').split('\n')) {
      if (line.startsWith('physical id')) socket = line.split(':')[1].trim()
      else if (line.startsWith('core id')) cores.add(`${socket}:${line.split(':')[1].trim()}`)
    }
    return cores.size > 0 ? cores.size : logical
  } catch {
    return logical
  }
}

function posInt(v: string | undefined, name: string): number | undefined {
  if (!v) return undefined
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    console.warn(`[prisma] ignoring invalid ${name}=${JSON.stringify(v)} (want a positive integer)`)
    return undefined
  }
  return Number(v)
}

// TLS: `pgTlsConfig` (lib/pgTls.mjs) — one definition shared with the script
// factory and the TLS probe. CA from `DATABASE_CA_CERT` / `NINE_PGDB_*_CA_CERT`
// ⇒ chain verified, hostname check skipped (Nine's self-signed setup).

function buildPoolConfig(): PoolConfig {
  const limit = posInt(process.env.DATABASE_CONNECTION_LIMIT, 'DATABASE_CONNECTION_LIMIT')
  const poolTimeout = posInt(process.env.DATABASE_POOL_TIMEOUT, 'DATABASE_POOL_TIMEOUT')
  const statementTimeoutMs = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS)
  const wantsTimeout = Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
  // 🔒 A STATEMENT TIMEOUT IS THE BACKSTOP THE POOL SIZE CANNOT PROVIDE. Pool
  // limits bound how many queries run CONCURRENTLY; they do nothing about ONE
  // query running for minutes while holding its connection, which degrades
  // every request queued behind it.
  //
  // ⚠️ Set as a pg connection parameter, NOT by issuing `SET statement_timeout`
  // after connecting. Verified on Prisma 6: a `SET` at module init reached
  // exactly ONE pooled backend, so every other connection kept the default — a
  // guard that silently protects a fraction of traffic. pg sends
  // `statement_timeout` as a STARTUP parameter, so the server applies it as
  // each connection is established — re-measured on the adapter across 5
  // distinct backends, all reported the configured value.
  //
  // Deliberately generous when set — a runaway fence, not a latency target.
  // Realistic catalog search measures 0.9–41 ms at 300k rows.
  const ssl = pgTlsConfig(process.env.DATABASE_URL)
  // 🔒 Session TimeZone = UTC — the adapter's timestamp conversions assume it
  // (lib/pgSession.mjs; prod Postgres defaults to Europe/Zurich). Wraps the
  // COMPLETE config: the guard checks what pg will actually send.
  // 🔒 IDLE CONNECTIONS STAY OPEN 5 MINUTES. pg-pool closes an idle client after
  // 10 s by default, so after any quiet spell the next request paid a new TLS
  // connection: measured from a 1/8-core container to staging (Nine), 103 ms
  // and 20 ms of CPU each, against 5 ms for a query on a warm one (model change
  // step 1). Kept below Nine's server-side `idle_session_timeout` (1 h, the
  // E57P05 log lines), and no `min`: a client held idle past that is killed by
  // the server. `max` still bounds how many are open. ⚠️ `allowExitOnIdle` goes
  // with it: an idle client otherwise holds the event loop, and every script or
  // suite that never calls `$disconnect()` hung for the whole 5 minutes (it was
  // 10 s before). The server is kept alive by its HTTP listener, not the pool.
  return withSessionPin({
    connectionString: process.env.DATABASE_URL,
    ...(ssl ? { ssl } : {}),
    max: limit ?? physicalCpuCount() * 2 + 1,
    idleTimeoutMillis: 5 * 60_000,
    allowExitOnIdle: true,
    // A 5-minute idle hold is only safe if a silently dropped flow (a stateful
    // hop timing out an idle connection) is noticed: TCP keepalive probes keep
    // such state warm and surface a dead peer as an error instead of a hang
    // (pg sets no keepalive unless asked; `statement_timeout` is server-side).
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    connectionTimeoutMillis: (poolTimeout ?? 10) * 1000,
    ...(wantsTimeout ? { statement_timeout: Math.floor(statementTimeoutMs) } : {}),
  })
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(buildPoolConfig()),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

// 🔒 CACHED IN PRODUCTION TOO: ONE CLIENT, ONE POOL PER PROCESS. The build
// compiles this module into separate chunks (API routes, server-rendered pages,
// instrumentation), each with its own module scope; with the cache set in
// development only, each made its own client and pool, so `DATABASE_CONNECTION_LIMIT=6`
// meant 12 or more connections per instance (measured: an API burst then a page
// burst on the standalone build held 12; model change step 1). The globalThis
// cache is what makes the copies share one.
globalForPrisma.prisma = prisma
