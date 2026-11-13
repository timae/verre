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

// The wrong-code budget (leak-fixes F2, lib/sessionRoute.ts openSessionCharged),
// as a RESERVATION taken before the moment is opened, so a parallel burst can
// get no more requests past the entrance than the budget has room for (a read
// first and a charge after the open let every request of a burst read "not
// spent" before any charge landed). KEYS = [seen marker, the counters…]; the
// counters' maxima, then the window, in ARGV.
//   'seen'     the marker is set: this caller already paid to learn this code
//              is absent (a deleted moment's poll, the web's 404 → /join
//              bounce): nothing reserved, the open decides.
//   'spent'    a counter is AT its max (+ its 1-based index): nothing
//              incremented (a spent account never pushes the address counter).
//   'reserved' every counter incremented (EXPIRE on the first).
// The boundary matches checkRate (count > max after the INCR) and peekRate
// (count >= max before it): the max-th miss still answers 404, the next 429.
const RESERVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return { 'seen', 0 } end
for i = 2, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[i - 1]) then return { 'spent', i - 1 } end
end
for i = 2, #KEYS do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[#KEYS]) end
end
return { 'reserved', 0 }`

// Settling a reservation: ARGV[1] 'keep' (the code was absent) sets the seen
// marker, unless a concurrent duplicate already did (then this one is
// refunded: one charge per caller and code); 'refund' (the code was live) gives
// it back. A refund never takes a counter below 0. Accepted edge: a request in
// flight across its counter's expiry refunds into the NEXT window (at most one
// charge per such request erased); a process killed between the reservation
// and the settle leaves the charge in place (fails closed, for the window).
const SETTLE_SCRIPT = `
local function refund()
  for i = 2, #KEYS do
    if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then redis.call('DECR', KEYS[i]) end
  end
end
if ARGV[1] == 'keep' then
  if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[2]) then return 'charged' end
  refund()
  return 'seen'
end
refund()
return 'refunded'`

// The charge for a caller ADMITTED on a spent budget whose moment turned out
// absent (a member of a moment deleted meanwhile): the marker → free;
// a counter at its max → refused, nothing incremented; else INCR + marker.
const MISS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return { 'seen', 0 } end
for i = 2, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[i - 1]) then return { 'limited', redis.call('TTL', KEYS[i]) } end
end
for i = 2, #KEYS do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[#KEYS]) end
end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[#KEYS + 1])
return { 'charged', 0 }`

export type MissCounter = { key: string; max: number }
type MissWindow = { windowSeconds: number; seenSeconds: number }
export type MissReservation = { outcome: 'seen' | 'reserved' } | { outcome: 'spent'; key: string }
export type MissCharge = { outcome: 'seen' | 'charged' } | { outcome: 'limited'; retryAfter: number }

// Give back one charge of a checkRate-style counter (never below 0): a
// reservation that did not go through, or was refused (the guest-join cap).
// Never on a success. The cross-expiry edge of SETTLE_SCRIPT applies here too.
const REFUND_SCRIPT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end
return 0`

export async function refundRate(key: string): Promise<void> {
  try {
    await redis.eval(REFUND_SCRIPT, { keys: [key], arguments: [] })
  } catch (err) {
    console.error('rateLimit refundRate error:', err)
  }
}

// Fail open like checkRate: a Redis error reserves nothing and refuses nothing.
export async function reserveMiss(seenKey: string, counters: MissCounter[], { windowSeconds }: MissWindow): Promise<MissReservation | null> {
  try {
    const [outcome, i] = (await redis.eval(RESERVE_SCRIPT, {
      keys: [seenKey, ...counters.map(c => c.key)],
      arguments: [...counters.map(c => String(c.max)), String(windowSeconds)],
    })) as [string, number]
    if (outcome === 'spent') return { outcome, key: counters[Number(i) - 1].key }
    return { outcome: outcome === 'seen' ? 'seen' : 'reserved' }
  } catch (err) {
    console.error('rateLimit reserveMiss error:', err)
    return null
  }
}

export async function settleMiss(seenKey: string, counters: MissCounter[], keep: boolean, { seenSeconds }: MissWindow): Promise<'charged' | 'seen' | 'refunded'> {
  try {
    return String(await redis.eval(SETTLE_SCRIPT, {
      keys: [seenKey, ...counters.map(c => c.key)],
      arguments: [keep ? 'keep' : 'refund', String(seenSeconds)],
    })) as 'charged' | 'seen' | 'refunded'
  } catch (err) {
    console.error('rateLimit settleMiss error:', err)
    return keep ? 'charged' : 'refunded'
  }
}

export async function chargeMissOnce(seenKey: string, counters: MissCounter[], { windowSeconds, seenSeconds }: MissWindow): Promise<MissCharge> {
  try {
    const [outcome, ttl] = (await redis.eval(MISS_SCRIPT, {
      keys: [seenKey, ...counters.map(c => c.key)],
      arguments: [...counters.map(c => String(c.max)), String(windowSeconds), String(seenSeconds)],
    })) as [string, number]
    if (outcome === 'limited') return { outcome, retryAfter: Math.max(Number(ttl), 1) }
    return { outcome: outcome === 'seen' ? 'seen' : 'charged' }
  } catch (err) {
    console.error('rateLimit chargeMissOnce error:', err)
    return { outcome: 'charged' }
  }
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
export function getClientIp(req: { headers: Pick<Headers, 'get'> }): string {
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
