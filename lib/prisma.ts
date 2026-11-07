import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import type { PoolConfig } from 'pg'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { pgTlsConfig } from './pgTls.mjs'

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
// `DATABASE_URL`'s own query parameters (Nine's `sslmode`, any `options`) are
// parsed by pg from the connection string and are not touched here.
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
  return {
    connectionString: process.env.DATABASE_URL,
    ...(ssl ? { ssl } : {}),
    max: limit ?? physicalCpuCount() * 2 + 1,
    connectionTimeoutMillis: (poolTimeout ?? 10) * 1000,
    ...(wantsTimeout ? { statement_timeout: Math.floor(statementTimeoutMs) } : {}),
  }
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(buildPoolConfig()),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
