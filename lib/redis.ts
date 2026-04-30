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
  meta:   (c: string) => `s:${c}:meta`,
  wines:  (c: string) => `s:${c}:wines`,
  rating: (c: string, user: string, wid: string) => `s:${c}:r:${user}:${wid}`,
  users:  (c: string) => `s:${c}:users`,
}

export const TTL = 48 * 60 * 60  // default 48h

export const LIFESPAN: Record<string, number> = {
  '48h':       48  * 60 * 60,
  '72h':       72  * 60 * 60,
  '1w':        7   * 24 * 60 * 60,
  'unlimited': 365 * 24 * 60 * 60,  // effectively permanent
}

export function lifespanTTL(lifespan?: string): number {
  return LIFESPAN[lifespan || '48h'] ?? TTL
}

export async function touch(code: string, ttl?: number) {
  const effectiveTTL = ttl ?? TTL
  const keys = await redis.keys(`s:${code}:*`)
  for (const key of keys) await redis.expire(key, effectiveTTL)
}

export async function touchWithMeta(code: string) {
  const raw = await redis.get(k.meta(code))
  const meta = raw ? JSON.parse(raw) : {}
  const ttl = lifespanTTL(meta.lifespan)
  const keys = await redis.keys(`s:${code}:*`)
  for (const key of keys) await redis.expire(key, ttl)
}
