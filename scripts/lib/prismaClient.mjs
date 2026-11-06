// The one way scripts and CI suites build a PrismaClient. Prisma 7 has no
// built-in query engine: the client needs a driver adapter, and this is where
// the adapter is wired so the six scripts/ callers and the local test harness
// construct it identically. The app's own client (lib/prisma.ts) stays
// separate because it carries the production pool + statement-timeout knobs.
//
// Prisma 6's client loaded `.env` from the project root by itself, which is
// what let `node scripts/x.mjs` and the harness's bare `npx tsx` calls find
// DATABASE_URL. The 7 client doesn't, so dotenv restores that here — quietly,
// and never overriding a variable that is already set, so the documented
// `DATABASE_URL=… node scripts/x.mjs` form and CI's explicit env still win.
// Import this module BEFORE any lib/* module: lib/prisma.ts captures
// DATABASE_URL when it is first evaluated.
import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { pgTlsConfig } from '../../lib/pgTls.mjs'

loadEnv({ quiet: true })

/**
 * @param {{ url?: string } & Omit<import('@prisma/client').Prisma.PrismaClientOptions, 'adapter'>} [options]
 *   `url` defaults to DATABASE_URL; everything else is passed to PrismaClient.
 */
export function createPrismaClient({ url = process.env.DATABASE_URL, ...options } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set (export it or pass { url })')
  // Bounded wait: pg's default is to queue forever for a free connection; Prisma
  // 6 failed a queued request after 10 s (P2024). Without this a script or CI
  // suite hangs instead of failing during database trouble (review, 2026-11-06).
  const ssl = pgTlsConfig(url)
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, connectionTimeoutMillis: 10_000, ...(ssl ? { ssl } : {}) }), ...options })
}
