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
  // Per-user last-activity in this session: userId → ms timestamp. Bumped on
  // visit + any in-moment action (rate). Read by /me/sessions to pin a
  // date-less session as "Just visited" for 1h since the user's last touch.
  // Ephemeral by design — inherits the session TTL, dies with it, no cleanup.
  lastSeen:   (c: string) => `s:${c}:lastseen`,
  // Banned identity-ids for this session. Set membership; SISMEMBER on
  // every requireParticipant + join attempt. Expires with the session TTL.
  bans:       (c: string) => `s:${c}:bans`,
  // Kicked-but-not-banned identity-ids. Tracked so the bounce-screen on
  // /join can identify a freshly-kicked user (kick-keep removes them
  // from identities, so the only other anchor for "you were removed"
  // would be lost). Removed when the user re-joins or chooses Delete.
  kicked:     (c: string) => `s:${c}:kicked`,
  // Short-lived advisory lock serializing concurrent kick/ban wipes against
  // each other (the bans/kicked set + identities + meta write-back during a
  // wipe). The wines JSON write-back is NOT guarded by this lock — it goes
  // through `mutateWines`' WATCH/MULTI optimistic concurrency like every
  // other wine mutator, which is safe against writers that never take this
  // lock (the wine CRUD routes don't).
  banLock:    (c: string) => `s:${c}:lock:ban`,
  // USER-scoped (NOT s:{CODE}: — the first user-scoped session-related key):
  // the set of session codes this user dismissed from the Moments-home
  // highlight carousel. Must outlive any single session, so it can't ride a
  // session TTL; it carries its own rolling TTL (see hideCarousel). A hidden
  // code for a dead session is a harmless no-op against live rows.
  carouselHidden: (userId: number) => `u:${userId}:carouselhidden`,
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

// Refresh the TTL on every key of a session so routine activity (a rating,
// a wine edit) keeps the whole session alive for its full lifespan. SCAN +
// pipelined EXPIRE keeps this off `redis.keys` — it's on the rate hot path.
export async function touchWithMeta(code: string) {
  const raw = await redis.get(k.meta(code))
  const meta = raw ? JSON.parse(raw) : {}
  const ttl = lifespanTTL(meta.lifespan)
  const keys = await scanKeys(`s:${code}:*`)
  if (keys.length === 0) return
  const tx = redis.multi()
  for (const key of keys) tx.expire(key, ttl)
  await tx.exec()
}

// Record THIS user's last activity in a session (visit + in-moment actions).
// Hash userId → ms timestamp. The first write sets the hash's TTL to the
// session lifespan so it dies with the session — no cleanup. `touchWithMeta`
// also re-stamps it on later activity.
//
// This ALWAYS sets the TTL itself — it must not delegate the expiry to a
// `touchWithMeta` call elsewhere on the request. A first write can happen
// AFTER touchWithMeta's SCAN (e.g. a logged-in user's first rate without a
// prior /visit), and that scan only re-stamps keys it already saw — so a
// hash created afterwards would get no expiry and leak past the session
// (and onto a recycled code). The extra meta-read is cheap on these paths.
export async function bumpLastSeen(code: string, userId: number) {
  try {
    await redis.hSet(k.lastSeen(code), String(userId), Date.now())
    const raw = await redis.get(k.meta(code))
    await redis.expire(k.lastSeen(code), lifespanTTL(raw ? JSON.parse(raw).lifespan : undefined))
  } catch (err) {
    console.error('[redis] bumpLastSeen failed:', err)
  }
}

// Read a single user's last-seen ms for a session (0 = never / absent / on
// error — a missing signal correctly reads as "not recently seen").
export async function getLastSeen(code: string, userId: number): Promise<number> {
  try {
    const v = await redis.hGet(k.lastSeen(code), String(userId))
    return v ? Number(v) : 0
  } catch {
    return 0
  }
}

// Carousel-hidden set: codes the user dismissed from the home highlight strip
// (they stay in "All moments"). Rolling 60-day TTL refreshed on each hide so
// an abandoned entry self-cleans. All self-catching — a hide/unhide failure
// must never break the visit/rate/settings response that triggered it.
const CAROUSEL_HIDDEN_TTL = 60 * 24 * 60 * 60

export async function hideCarousel(userId: number, code: string) {
  try {
    // MULTI so the SADD and its TTL land atomically — a crash between them
    // would leave the set with no expiry, leaking it forever (the rolling TTL
    // is the ONLY thing that GCs an abandoned user's hidden set; see lib/CLAUDE.md).
    await redis.multi()
      .sAdd(k.carouselHidden(userId), code)
      .expire(k.carouselHidden(userId), CAROUSEL_HIDDEN_TTL)
      .exec()
  } catch (err) {
    console.error('[redis] hideCarousel failed:', err)
  }
}

export async function unhideCarousel(userId: number, code: string) {
  try {
    await redis.sRem(k.carouselHidden(userId), code)
  } catch (err) {
    console.error('[redis] unhideCarousel failed:', err)
  }
}

export async function getHiddenCarousel(userId: number): Promise<Set<string>> {
  try {
    return new Set(await redis.sMembers(k.carouselHidden(userId)))
  } catch {
    return new Set()
  }
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
// scanKeys when the caller only needs existence. Use for patterns
// with wildcards; for an exact key prefer `existsKey` (O(1)).
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

// Exact-key existence — O(1) via Redis EXISTS. Use this whenever the
// key string is fully resolved (no `*`/`?` glob). Avoids the SCAN
// overhead that `hasKey` pays for pattern matching.
export async function existsKey(key: string): Promise<boolean> {
  return (await redis.exists(key)) > 0
}
