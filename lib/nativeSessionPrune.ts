import { redis } from '@/lib/redis'
import { pruneExpiredNativeSessions } from '@/lib/identityStore'

// In-process scheduler for the native-session prune (why it is not a raw SQL
// cron: pruneExpiredNativeSessions in identityStore). Runs from
// instrumentation-node.ts at boot: once after a short delay, then daily. The
// Deploio cron image carries prisma + scripts but no lib/, so the chokepoint
// can only run inside the app process — and multiple replicas / restarts are
// de-duplicated by a Redis NX lock that outlives the interval gap, so at most
// one run per ~day fleet-wide (a missed day is harmless: the prune is
// idempotent and purely retention). Timers are unref'd so they never hold the
// process open. Failures log and wait for the next tick.
const LOCK_KEY = 'lock:native-session-prune'
const LOCK_TTL_S = 20 * 3600
const BOOT_DELAY_MS = 5 * 60 * 1000
const INTERVAL_MS = 24 * 3600 * 1000

async function runOnce(): Promise<void> {
  try {
    const got = await redis.set(LOCK_KEY, String(Date.now()), { NX: true, EX: LOCK_TTL_S })
    if (got !== 'OK') return
    const n = await pruneExpiredNativeSessions()
    if (n > 0) console.log(`[native-session-prune] retired ${n} expired native session(s)`)
  } catch (e) {
    console.error('[native-session-prune] run failed', e)
  }
}

export function scheduleNativeSessionPrune(): void {
  setTimeout(() => void runOnce(), BOOT_DELAY_MS).unref()
  setInterval(() => void runOnce(), INTERVAL_MS).unref()
}
