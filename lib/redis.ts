import { createClient } from 'redis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const globalForRedis = globalThis as unknown as { redis: ReturnType<typeof createClient> }

export const redis =
  globalForRedis.redis ??
  createClient({
    url: REDIS_URL,
    socket: {
      tls: REDIS_URL.startsWith('rediss://'),
      rejectUnauthorized: false,
    },
  })

redis.on('error', (err) => console.error('redis err:', err))

if (!redis.isOpen) redis.connect()

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis

// ── Key helpers ────────────────────────────────
export const k = {
  meta:       (c: string) => `s:${c}:meta`,
  wines:      (c: string) => `s:${c}:wines`,
  // Rating key uses identity id (e.g. "u:42" or "a:<uuid>"), not display
  // name — names can collide between participants, ids cannot.
  rating:     (c: string, identityId: string, wid: string) => `s:${c}:r:${identityId}:${wid}`,
  // Identity model. Identities maps id (e.g. "u:42" or "a:<uuid>") to the
  // current display name; tokens maps an anon token to its identity id.
  identities: (c: string) => `s:${c}:identities`,
  tokens:     (c: string) => `s:${c}:tokens`,
  // Banned identity-ids for this session. Set membership; SISMEMBER on
  // every requireParticipant + join attempt. Expires with the session TTL.
  bans:       (c: string) => `s:${c}:bans`,
  // Kicked-but-not-banned identity-ids. Tracked so the bounce-screen on
  // /join can identify a freshly-kicked user (kick-keep removes them
  // from identities, so the only other anchor for "you were removed"
  // would be lost). Removed when the user re-joins or chooses Delete.
  kicked:     (c: string) => `s:${c}:kicked`,
  // Short-lived advisory lock taken during a kick/ban wipe so concurrent
  // host actions don't clobber the wines JSON write-back.
  banLock:    (c: string) => `s:${c}:lock:ban`,
}

export const TTL = 48 * 60 * 60  // default 48h

const LIFESPAN: Record<string, number> = {
  '48h':       48  * 60 * 60,
  '72h':       72  * 60 * 60,
  '1w':        7   * 24 * 60 * 60,
  'unlimited': 365 * 24 * 60 * 60,  // effectively permanent
}

export function lifespanTTL(lifespan?: string): number {
  return LIFESPAN[lifespan || '48h'] ?? TTL
}

export async function touchWithMeta(code: string) {
  const raw = await redis.get(k.meta(code))
  const meta = raw ? JSON.parse(raw) : {}
  const ttl = lifespanTTL(meta.lifespan)
  const keys = await redis.keys(`s:${code}:*`)
  for (const key of keys) await redis.expire(key, ttl)
}

// Non-blocking key enumeration via SCAN. KEYS holds the server thread for
// the duration of the scan over the whole keyspace — fine when the DB
// is small but blocks production-sized Redis. New callers should use
// scanKeys; old callers stay on `redis.keys` until each is converted.
//
// Deduplicates: SCAN can return the same key across iterations under
// keyspace mutation. Callers consuming the result as a count or a Set
// of keys expect uniqueness.
//
// Throws on maxIterations overflow: silent partial returns would let
// downstream callers (delete-set, count display) make wrong decisions
// without knowing the result was truncated. If hitting the cap is
// expected for a particular pattern, the caller should pass a larger
// maxIterations explicitly.
export async function scanKeys(pattern: string, opts: { count?: number; maxIterations?: number } = {}): Promise<string[]> {
  const count = opts.count ?? 100
  const maxIter = opts.maxIterations ?? 1000
  const seen = new Set<string>()
  let cursor = 0
  for (let i = 0; i < maxIter; i++) {
    const res = await redis.scan(cursor, { MATCH: pattern, COUNT: count })
    for (const key of res.keys) seen.add(key)
    cursor = res.cursor
    if (cursor === 0) return [...seen]
  }
  throw new Error(`scanKeys overflow: pattern=${pattern} hit ${maxIter} iterations without completing`)
}

// Yes/no variant — returns on the first matching key. Cheaper than
// scanKeys when the caller only needs existence.
export async function hasKey(pattern: string): Promise<boolean> {
  let cursor = 0
  for (let i = 0; i < 1000; i++) {
    const res = await redis.scan(cursor, { MATCH: pattern, COUNT: 50 })
    if (res.keys.length > 0) return true
    cursor = res.cursor
    if (cursor === 0) return false
  }
  return false
}
