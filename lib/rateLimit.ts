// Redis-backed rate limiter. Each call increments a counter for the given
// key and returns whether it's still under the limit. Atomic via a single
// Lua script — INCR + EXPIRE happen together, no race-condition gap.
//
// Fail-open: if Redis errors out, requests are allowed. Means a Redis
// outage briefly disables rate limiting rather than taking down auth.

import { redis } from '@/lib/redis'

// Lua script returns [count, ttlRemaining]. INCR creates the key with
// value 1 if missing; on the very first INCR we set the expiry. After
// that, the counter ticks until the EXPIRE fires.
const SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('TTL', KEYS[1])
  return { count, ttl }
`

export type RateCheck = {
  key: string
  max: number
  windowSeconds: number
}

export type RateResult = {
  allowed: boolean
  retryAfter: number   // seconds until the limit resets (0 if allowed)
}

// Check + increment a single rate-limit counter.
export async function checkRate(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateResult> {
  try {
    const result = (await redis.eval(SCRIPT, {
      keys: [key],
      arguments: [String(windowSeconds)],
    })) as [number, number]
    const [count, ttl] = result
    const allowed = count <= max
    return { allowed, retryAfter: allowed ? 0 : Math.max(ttl, 1) }
  } catch (err) {
    // Fail open: if Redis is down, don't block legitimate traffic.
    console.error('rateLimit checkRate error:', err)
    return { allowed: true, retryAfter: 0 }
  }
}

// Check multiple counters at once. Returns the first failure if any limit
// is exceeded, or { allowed: true } if all pass. Each counter is still
// incremented (an attacker hitting one limit should also accrue toward
// the others), but the response reports the most-blocking one.
export async function checkRates(checks: RateCheck[]): Promise<RateResult> {
  let worst: RateResult = { allowed: true, retryAfter: 0 }
  for (const c of checks) {
    const r = await checkRate(c.key, c.max, c.windowSeconds)
    if (!r.allowed && r.retryAfter > worst.retryAfter) {
      worst = r
    }
  }
  return worst
}

// Clear a counter. Used by the session-code limiter when the lookup hits
// a valid code — the user wasn't actually probing, just had typos before.
export async function resetRate(key: string): Promise<void> {
  try {
    await redis.del(key)
  } catch (err) {
    console.error('rateLimit resetRate error:', err)
  }
}

// Peek at a counter without incrementing. Used by login: we want to
// check if already-over-limit BEFORE running bcrypt, then only increment
// if bcrypt itself fails (so successful logins don't count).
export async function peekRate(
  key: string,
  max: number,
): Promise<RateResult> {
  try {
    const [count, ttl] = await Promise.all([
      redis.get(key).then((v) => (v ? Number(v) : 0)),
      redis.ttl(key),
    ])
    const allowed = count < max
    return { allowed, retryAfter: allowed ? 0 : Math.max(ttl, 1) }
  } catch (err) {
    console.error('rateLimit peekRate error:', err)
    return { allowed: true, retryAfter: 0 }
  }
}

// Same as peekRate for multiple keys. Returns first failure or all allowed.
export async function peekRates(checks: RateCheck[]): Promise<RateResult> {
  let worst: RateResult = { allowed: true, retryAfter: 0 }
  for (const c of checks) {
    const r = await peekRate(c.key, c.max)
    if (!r.allowed && r.retryAfter > worst.retryAfter) {
      worst = r
    }
  }
  return worst
}

// Pull the client IP from forwarding headers, for rate-limit keying.
//
// 🔒 Trusted-proxy posture (verified 2026-06-10, see docs/dev/deployment.md):
// Deplo.io's TLS-termination proxy OVERWRITES X-Forwarded-For with the real
// connecting client IP and parks any client-supplied XFF value in a SEPARATE
// header (X-Original-Forwarded-For, which we never read). So as Verre receives
// it, X-Forwarded-For is a SINGLE trusted IP — the leftmost entry is set by the
// trusted proxy, not the client. This holds ONLY while there is no untrusted
// CDN/proxy in front of Deplo.io (today: none — served directly by Deplo.io's
// ingress).
//
// A MULTI-entry XFF (contains a comma) therefore should not happen in prod, and
// if it does it's the signal that an untrusted hop was added — in that case the
// leftmost entry is attacker-controllable (the classic append-spoofing case), so
// we must NOT trust it. We fall back to X-Real-Ip (Deplo.io also sets this to the
// real IP; a client can't make the proxy append to a single-valued header it
// overwrites), then to a shared 'unknown' bucket. Never return a caller-supplied
// value as if it were trusted.
//
// 'unknown' buckets every unresolved caller into one shared rate-limit key —
// more permissive (one bucket for all) but safe: it fails CLOSED into a limit,
// never bypasses it.
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    // Single entry = the trusted-proxy-set real IP (the expected prod shape).
    // Multiple entries = an untrusted hop was added; the leftmost is spoofable,
    // so don't trust XFF at all — fall through to x-real-ip.
    if (!xff.includes(',')) {
      const ip = xff.trim()
      if (ip) return ip
    }
  }
  const real = req.headers.get('x-real-ip')
  if (real) {
    const ip = real.trim()
    if (ip) return ip
  }
  return 'unknown'
}

// Format a wait time for user-facing error messages. Seconds when under
// a minute; round up to the nearest minute otherwise so "59 minutes"
// reads better than "3527 seconds".
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const mins = Math.ceil(seconds / 60)
  return `${mins} minute${mins === 1 ? '' : 's'}`
}
