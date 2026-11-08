import { randomUUID } from 'node:crypto'
import { WatchError } from 'redis'
import { redis, type FailFastRedis } from '@/lib/redis'

// The fenced Redis lock `lock:session:{CODE}` (redis-rehydration § 5.4,
// mechanism 2). Its job is the CACHE: every write to a shared-state key of a
// session (meta, wines, identities, bans, kicked) is made by its holder as a
// fenced write — WATCH the lock, check the token, MULTI, EXEC — so a holder
// that outlived its lease cannot write. It orders nothing durable (that is the
// advisory lock in lib/sessionMutation.ts) and grants nothing (§ 4.7).
//
// Outside the `s:` prefix on purpose: touchWithMeta re-EXPIREs every
// `s:{CODE}:*` key to the session lifespan, and the wipes SCAN-delete them.
// `lock:` keys are self-TTL'd and never SCAN-swept (lib/CLAUDE.md).

export type RedisClient = typeof redis | FailFastRedis
type Multi = ReturnType<RedisClient['multi']>

export const LOCK_LEASE_MS = 15_000
// Test seam (cutover suite): lease-expiry schedules shorten the default lease.
export const lockTiming = { leaseMs: LOCK_LEASE_MS }

export function sessionLockKey(code: string): string {
  return `lock:session:${code}`
}

// The holder's lease is gone (expired, or another holder owns the key): any
// write it was about to make is refused.
export class LockLost extends Error {
  constructor(code: string, what = 'lease lost') { super(`session lock ${code}: ${what}`) }
}

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// SET NX PX loop with 25–50 ms jitter until the deadline. Returns the token, or
// null when the lock stayed busy for the whole wait.
export async function acquireSessionLock(
  code: string,
  { waitMs = 3000, leaseMs = lockTiming.leaseMs, client = redis }: { waitMs?: number; leaseMs?: number; client?: RedisClient } = {},
): Promise<string | null> {
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  for (;;) {
    if ((await client.set(sessionLockKey(code), token, { NX: true, PX: leaseMs })) === 'OK') return token
    if (Date.now() >= deadline) return null
    await sleep(25 + Math.random() * 25)
  }
}

// Compare-and-delete: a holder that outlived its lease never deletes the next
// holder's lock (the old ban lock's blind DEL did).
export async function releaseSessionLock(code: string, token: string, client: RedisClient = redis): Promise<boolean> {
  return Number(await client.eval(RELEASE_SCRIPT, { keys: [sessionLockKey(code)], arguments: [token] })) === 1
}

export async function renewSessionLock(code: string, token: string, leaseMs = lockTiming.leaseMs, client: RedisClient = redis): Promise<boolean> {
  return Number(await client.eval(RENEW_SCRIPT, { keys: [sessionLockKey(code)], arguments: [token, String(leaseMs)] })) === 1
}

export async function sessionLockHeld(code: string, token: string, client: RedisClient = redis): Promise<boolean> {
  return (await client.get(sessionLockKey(code))) === token
}

// A fenced write: on an isolated connection, WATCH the lock (plus `watch`),
// check the token (and any `expect`ed values of watched keys), then MULTI with
// the commands `build` queues, then EXEC. A changed or expired lock between the
// check and EXEC aborts the EXEC (an expiring WATCHed key counts as modified
// since Redis 6.0.9), so the write lands only while the lease is ours. Every
// refusal throws LockLost; nothing is written.
export async function fencedExec(
  code: string,
  token: string,
  build: (m: Multi) => void,
  { client = redis, watch = [], expect = {} }: { client?: RedisClient; watch?: string[]; expect?: Record<string, string | null> } = {},
): Promise<unknown[]> {
  const lockKey = sessionLockKey(code)
  try {
    return await client.executeIsolated(async (iso) => {
      await iso.watch([lockKey, ...watch])
      try {
        if ((await iso.get(lockKey)) !== token) throw new LockLost(code)
        for (const [key, value] of Object.entries(expect)) {
          if ((await iso.get(key)) !== value) throw new LockLost(code, `${key} changed`)
        }
        const m = iso.multi()
        build(m as unknown as Multi)
        const res = await m.exec()
        if (res === null) throw new LockLost(code, 'transaction aborted')
        return res as unknown[]
      } catch (err) {
        await iso.unwatch().catch(() => {})
        throw err
      }
    })
  } catch (err) {
    if (err instanceof WatchError) throw new LockLost(code, 'watched key changed')
    throw err
  }
}

// A fenced DEL as one Lua step (atomic, so no WATCH/isolated connection — used
// on account deletion's fail-fast client): deletes `keys` only while the lease
// is ours. Throws LockLost otherwise; nothing is deleted.
const FENCED_DEL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local n = 0
for i = 2, #KEYS do n = n + redis.call('DEL', KEYS[i]) end
return n`

export async function fencedDel(code: string, token: string, keys: string[], client: RedisClient = redis): Promise<number> {
  const n = Number(await client.eval(FENCED_DEL_SCRIPT, { keys: [sessionLockKey(code), ...keys], arguments: [token] }))
  if (n < 0) throw new LockLost(code)
  return n
}
