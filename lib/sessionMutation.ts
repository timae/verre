import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { redis, k, lifespanTTL } from '@/lib/redis'
import { acquireSessionLock, releaseSessionLock, sessionLockHeld, sessionLockKey, fencedExec, LockLost, type RedisClient } from '@/lib/sessionLock'
import { readGrant, grantStatus, authorized, cacheAdmission, type AuthorizedIdentity, type GrantStatus } from '@/lib/sessionGrant'
import { readLiveRow, type SessionRow } from '@/lib/sessionRecord'
import type { Identity } from '@/lib/identity'
import { authInvalid, authRemoved } from '@/lib/authResponses'
import type { SessionMeta } from '@/lib/session'

// The session mutation contract (docs/dev/proposals/redis-rehydration.md § 5.4;
// release-B plan § 1.2). EVERY durable writer of a session participates:
//
//   1. the fenced Redis lock lock:session:{CODE}, when the writer writes a
//      shared-state key (meta, wines, identities, bans, kicked) — Busy if held
//   2. BEGIN + pg_advisory_xact_lock(hashtext('session:' || code))
//   3. entry checks INSIDE both locks: the lease is still ours; meta read
//      (incarnation); the live row FOR UPDATE; the caller re-resolved with a
//      FRESH grant read (§ 4.7) — every gating decision is made from these
//   4. work(tx, ctx): every Postgres decision + write; content and
//      deny-direction Redis writes (fenced) — plan § 1.4
//   5. COMMIT — the only atomic point. A throw in 3–4 → ROLLBACK
//   6. projection(ctx, result): grant-direction Redis writes of the COMMITTED
//      state, fenced. A failure → scoped invalidation of a Postgres-backed
//      session's meta (the next request rebuilds and reconciles)
//   7. release (compare-and-delete)
//
// 🔒 There is no cross-store transaction (§ 3): a Redis EXEC before COMMIT
// survives a rollback or a process death. That is why only content (repaired by
// the next list write) and denials (fail closed) may be written before COMMIT,
// and why nothing is ever GRANTED from the cache for a `u:` caller of a
// Postgres-backed session — the grant read is the authority.
//
// 🔒 Lock order: Redis lock → advisory lock → row lock. Never take a Redis lock
// while holding an advisory lock (account deletion's 'replan' exists for that).
// Promotion runs BEFORE a route's own contract — the locks are not re-entrant.

export class ContractBusy extends Error {}
// A rating-key write found another generation bump since this contract's own
// (ratingKeyWrite): a busy-class refusal (503 + Retry-After), re-run once first.
export class ContractSuperseded extends ContractBusy {}
// The session is gone for this caller: no meta and no live row, or the code now
// belongs to another incarnation than the one the caller started from.
export class ContractGone extends Error {}
// A Postgres-backed session whose cache is (partly) missing: the request answers
// via ensureSessionLive — a rebuild then 503, never a 404 for a live row.
export class ContractCold extends Error {}
// A contract that took no Redis lock tried to DELETE a rating key — re-run with
// the lock (withSessionMutation does, once).
export class ContractNeedsLease extends Error {}
// Cache and record disagree on the incarnation (never expected — create claims
// codes under these locks). Fail closed: 503.
export class ContractConflict extends Error {}
// A decision made under the locks said no; `response` is what the route sends.
export class ContractRefused extends Error {
  constructor(readonly response: NextResponse) { super(`refused: ${response.status}`) }
}
export { LockLost }

export function refuse(status: number, error: string, headers: Record<string, string> = {}): ContractRefused {
  return new ContractRefused(NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } }))
}

// The caller's admission under the locks (ctx.callerStatus): banned/kicked →
// the `removed` bounce, anything else not 'ok' → `invalid`. Returns the
// admitted caller.
export function admitted(ctx: MutationCtx): AuthorizedIdentity {
  if (ctx.callerStatus === 'ok' && ctx.caller) return ctx.caller
  if (ctx.callerStatus === 'banned' || ctx.callerStatus === 'kicked') throw new ContractRefused(authRemoved('removed from session'))
  throw new ContractRefused(authInvalid())
}

// A best-effort CONTENT mirror inside the contract (§ 3 "best-effort
// mirrors"): its Postgres statements run under a SAVEPOINT, so a failure rolls
// back only the mirror — logged with the code and object kind — and the rest of
// the transaction still commits. The next successful write of the same list
// projects the whole array again and repairs it.
// Returns whether the mirror landed — a caller whose after-COMMIT effect
// depends on the record having changed (an S3 reclaim) must check it (r4 P1-1).
export async function bestEffortMirror(tx: Prisma.TransactionClient, code: string, kind: string, fn: () => Promise<unknown>): Promise<boolean> {
  await tx.$executeRawUnsafe('SAVEPOINT best_effort_mirror')
  try {
    await fn()
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT best_effort_mirror')
    return true
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT best_effort_mirror')
    console.error('[mirror] best-effort content mirror failed — the next list write repairs it', { code, kind, err })
    return false
  }
}

export type Fence = {
  code: string
  token: string
  client: RedisClient
  exec: (build: Parameters<typeof fencedExec>[2], opts?: { watch?: string[]; expect?: Record<string, string | null> }) => Promise<unknown[]>
}

export type MutationCtx = {
  code: string
  meta: SessionMeta | null
  row: SessionRow | null
  // The caller re-resolved under the locks: its grant is FRESH (read in this
  // transaction) when the live row exists and the caller is `u:`.
  caller: AuthorizedIdentity | null
  // Admission of the caller under the locks: from the grant for `u:` with a
  // live row (a Redis ban still denies first), from Redis otherwise. null when
  // no caller was given or the contract is PG-only.
  callerStatus: GrantStatus | null
  fence: Fence | null
  // The generation token THIS contract set (bumpGen) — the fence of its
  // rating-key writes (ratingKeyWrite). null when it set none (or the
  // best-effort bump failed).
  gen: string | null
}

export type MutationOpts = {
  label: string
  redisLock?: false | { waitMs?: number }
  expectedCreatedAt?: number
  // 'require' (default): meta must exist — absent with a live row → Cold,
  // without → Gone. 'optional': meta read into ctx.meta (may be null), the
  // writer checks availability itself (create, rebuild, Redis-only re-seeds).
  // false: PG-only, no Redis command at all.
  readMeta?: 'require' | 'optional' | false
  caller?: Identity | null
  // Advisory-only writers (no Redis lease) set the publication generation
  // s:{C}:gen before their first durable statement, so a rebuild whose backend
  // died but whose lease lives cannot publish over their change (plan § 3).
  bumpGen?: boolean | 'best-effort'
  timeoutMs?: number
}

// Test seam (cutover suite): a no-op unless a suite replaces `at`.
// 'recordRead' fires inside the rebuild's plan right after its record reads.
export type HookPoint = 'beforeLock' | 'beforeGen' | 'locked' | 'recordRead' | 'beforePublish' | 'beforeCommit' | 'afterCommit' | 'beforeProjection'
export const mutationHooks: { at: (point: HookPoint, code: string, label: string) => Promise<void> } = {
  at: async () => {},
}

export function advisoryLockKey(code: string): string {
  return `session:${code}`
}

export function makeFence(code: string, token: string, client: RedisClient = redis): Fence {
  return { code, token, client, exec: (build, o = {}) => fencedExec(code, token, build, { client, ...o }) }
}

// A contract that finds the cache COLD (meta or wines missing for a live row)
// rolls back, releases its locks, lets ensureSessionLive rebuild, and retries
// ONCE — every decision is re-made under the locks on the retry. Without this a
// successor whose predecessor's refused projection invalidated meta (plan
// § 1.5) would answer 503 instead of proceeding (B1 schedules 1 and 2).
export async function withSessionMutation<T>(
  code: string,
  opts: MutationOpts,
  work: (tx: Prisma.TransactionClient, ctx: MutationCtx) => Promise<T>,
  projection?: (ctx: MutationCtx, result: T) => Promise<void>,
): Promise<T> {
  // Each recovery is bounded on its OWN (r2 N3: a cold lineup followed by a
  // lease upgrade must not exhaust a shared counter).
  let o = opts
  let cold = 0, lease = 0, superseded = 0
  for (;;) {
    try {
      return await attemptMutation(code, o, work, projection)
    } catch (err) {
      // A writer that skipped the Redis lock but turned out to DELETE a rating
      // key (ratingKeyWrite refuses that unleased) re-runs once WITH the lock.
      if (err instanceof ContractNeedsLease && !o.redisLock && lease++ === 0) { o = { ...o, redisLock: { waitMs: 3000 } }; continue }
      // A rating-key write superseded by another generation bump: re-run once
      // (a fresh bump, every decision re-made).
      if (err instanceof ContractSuperseded && superseded++ === 0) continue
      if (!(err instanceof ContractCold) || cold++ > 0) throw err
      const { ensureSessionLive } = await import('@/lib/sessionRehydrate')
      if ((await ensureSessionLive(code)) !== 'live') throw err
    }
  }
}

async function attemptMutation<T>(
  code: string,
  opts: MutationOpts,
  work: (tx: Prisma.TransactionClient, ctx: MutationCtx) => Promise<T>,
  projection?: (ctx: MutationCtx, result: T) => Promise<void>,
): Promise<T> {
  const readMeta = opts.readMeta ?? 'require'
  let token: string | null = null
  await mutationHooks.at('beforeLock', code, opts.label)
  if (opts.redisLock) {
    token = await acquireSessionLock(code, { waitMs: opts.redisLock.waitMs ?? 3000 })
    if (!token) throw new ContractBusy(`${opts.label}: session ${code} is busy`)
  }
  const fence = token ? makeFence(code, token) : null
  try {
    let ctx!: MutationCtx
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey(code)}))`
      if (token && !(await sessionLockHeld(code, token))) throw new LockLost(code)
      const row = await readLiveRow(tx, code, 'update')
      const expectedCreatedAt = opts.expectedCreatedAt ?? incarnationOf(opts.caller)
      let meta: SessionMeta | null = null
      if (readMeta) {
        const raw = await redis.get(k.meta(code))
        meta = raw ? JSON.parse(raw) as SessionMeta : null
        if (!meta && readMeta === 'require') throw row ? new ContractCold(code) : new ContractGone(code)
        if (meta && expectedCreatedAt !== undefined && meta.createdAt !== expectedCreatedAt) throw new ContractGone(code)
        if (meta && row?.createdAt && meta.createdAt !== row.createdAt.getTime()) {
          console.error('[contract] incarnation mismatch', { code, label: opts.label })
          throw new ContractConflict(code)
        }
      } else if (expectedCreatedAt !== undefined && row?.createdAt && row.createdAt.getTime() !== expectedCreatedAt) {
        throw new ContractGone(code)
      }
      const { caller, status } = await resolveCaller(tx, code, row, opts.caller ?? null, !!readMeta)
      ctx = { code, meta, row, caller, callerStatus: status, fence, gen: null }
      if (opts.bumpGen) {
        await mutationHooks.at('beforeGen', code, opts.label)
        ctx.gen = await bumpGeneration(code, row, opts.bumpGen === 'best-effort')
        // A Postgres round trip AFTER the bump, before any Redis content write
        // (r3 P2-3): a writer whose backend died before its bump fails HERE —
        // its bump may have overwritten a successor's token (harmless), but it
        // never reaches a Redis write under it. A backend that dies after this
        // point lets a successor bump again, which refuses this writer's writes.
        if (ctx.gen) await tx.$queryRaw`SELECT 1`
      }
      await mutationHooks.at('locked', code, opts.label)
      const out = await work(tx, ctx)
      await mutationHooks.at('beforeCommit', code, opts.label)
      return out
    }, { timeout: opts.timeoutMs ?? 10_000, maxWait: 5_000 })
    await mutationHooks.at('afterCommit', code, opts.label)
    if (projection) {
      await mutationHooks.at('beforeProjection', code, opts.label)
      try {
        await projection(ctx, result)
      } catch (err) {
        console.error('[contract] projection failed — record committed, cache invalidated for rebuild', { code, label: opts.label, err })
        if (ctx.row?.createdAt) await scopedInvalidate(code, ctx.row.createdAt.getTime()).catch(e => console.error('[contract] invalidation failed', { code, e }))
      }
    }
    return result
  } finally {
    if (token) await releaseSessionLock(code, token).catch(() => {})
  }
}

// The incarnation an admitted caller was bound to at admission (none for a raw
// identity) — the default expectedCreatedAt of every contract it enters.
function incarnationOf(caller: Identity | null | undefined): number | undefined {
  return caller && 'incarnation' in caller ? (caller as AuthorizedIdentity).incarnation : undefined
}

// The caller under the locks. `u:` with a live row → the grant read in THIS
// transaction (+ the Redis ban first — the cache can deny). Anyone else → the
// Redis authority of today (bans, identities, kicked), when Redis is in play.
async function resolveCaller(
  tx: Prisma.TransactionClient, code: string, row: SessionRow | null, caller: Identity | null, useRedis: boolean,
): Promise<{ caller: AuthorizedIdentity | null; status: GrantStatus | null }> {
  if (!caller) return { caller: null, status: null }
  if (caller.kind === 'user' && row) {
    const fresh = await readGrant(tx, code, Number(caller.id.slice(2)))
    const cachedBan = !!fresh && useRedis && await redis.sIsMember(k.bans(code), caller.id)
    const grant = fresh && cachedBan ? { ...fresh, banned: true } : fresh
    const out = authorized(caller, grant, incarnationOf(caller), cachedBan)
    if (!grant) return { caller: out, status: 'invalid' }
    return { caller: out, status: grantStatus(grant) }
  }
  if (!useRedis) return { caller: authorized(caller, null, incarnationOf(caller)), status: null }
  // A cache-authority caller that is not admitted (banned, kicked, off the
  // roster) is `denied` for the privilege helpers: a stale role entry in meta
  // grants nothing (r4 N1).
  // A meta-proven strict host missing from the roster (an evicted identities
  // hash, no removal marker) is admitted under the locks (r5/r6) — its
  // host-only writes (ban, unban) require 'ok'.
  const r = await cacheAdmission(code, caller.id, undefined)
  const inc = incarnationOf(caller)
  if (r === 'ok' || r === 'host') return { caller: authorized(caller, null, inc), status: 'ok' }
  return { caller: authorized(caller, null, inc, true), status: r === 'banned' || r === 'kicked' ? r : 'invalid' }
}

// The publication generation (plan § 3, r4-1/r4-2): a fresh random token under
// s:{C}:gen. A rebuild records it under its locks and publishes only while it is
// unchanged, so every writer that changes durable state WITHOUT holding the
// Redis lease refuses any rebuild that read the record before that change.
export async function bumpGeneration(code: string, row: SessionRow | null, bestEffort = false, client: RedisClient = redis): Promise<string | null> {
  try {
    const pttl = Number(await client.pTTL(k.meta(code)))
    const ttlMs = pttl > 0 ? pttl : lifespanTTL(row?.lifespan ?? undefined) * 1000
    const token = randomUUID()
    await client.set(k.gen(code), token, { PX: ttlMs })
    return token
  } catch (err) {
    if (!bestEffort) throw err
    console.warn('[contract] generation bump failed (best-effort)', { code, err })
    return null
  }
}

// A rating-key write (SET, or DEL with value null) of a contract that bumped
// the generation, fenced by THAT bump (code review r1 P2-6): it lands only while
// `s:{C}:gen` still holds this contract's token — and its lock token, when it
// holds a lease. The advisory lock alone is no fence for Redis: a writer whose
// Postgres backend died lost it while its Node code ran on, and a successor
// may already have committed and cached a newer version; the successor's own
// bump makes the stale write a no-op. A DEL is never done without the lease
// (a terminated rebuild could republish the deleted rating) — it throws
// ContractNeedsLease, and withSessionMutation re-runs once with the lock.
// `onlyIfExists`: skip an absent key (a cold cache is filled by the next
// rebuild from the record this write commits). Returns whether it wrote; a
// superseded write throws ContractSuperseded (rolled back, re-run once).
const RATING_KEY_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -2 end
if ARGV[5] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[5] then return -1 end
if ARGV[4] == 'xx' and redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end
return 1`

export async function ratingKeyWrite(
  ctx: MutationCtx, key: string, value: string | null, { pxMs = 0, onlyIfExists = false }: { pxMs?: number; onlyIfExists?: boolean } = {},
): Promise<boolean> {
  if (value === null && !ctx.fence) throw new ContractNeedsLease(ctx.code)
  if (!ctx.gen) {
    console.warn('[contract] rating-key write skipped — no generation token', { code: ctx.code })
    return false
  }
  if (value !== null && !(pxMs > 0)) return false
  const client = ctx.fence?.client ?? redis
  const r = Number(await client.eval(RATING_KEY_SCRIPT, {
    keys: [k.gen(ctx.code), key, ctx.fence ? sessionLockKey(ctx.code) : key],
    arguments: [ctx.gen, value ?? '', String(Math.floor(pxMs)), onlyIfExists ? 'xx' : '', ctx.fence?.token ?? ''],
  }))
  if (r === -1) throw new LockLost(ctx.code)
  // Superseded (another bump since ours): never acknowledge a write that did
  // not land (r2 N2 — for an anonymous / Redis-only rating the key IS the
  // data) — roll back; withSessionMutation re-runs once.
  if (r === -2) throw new ContractSuperseded(`${ctx.code}: rating-key write superseded`)
  return r === 1
}

// Scoped invalidation (plan § 1.5): DEL the meta of a Postgres-backed session
// ONLY if it is still our incarnation, and bump the generation (also when meta
// is already absent — r4-2). Deliberately unfenced: we may have lost the lease,
// and deleting a Postgres-backed session's meta is always recoverable (the next
// request rebuilds and reconciles from the record). Never for a Redis-only
// session — there the cache is the data.
const INVALIDATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local ttl = tonumber(ARGV[3])
if raw then
  local ok, m = pcall(cjson.decode, raw)
  if not ok or type(m) ~= 'table' or string.format('%.0f', tonumber(m.createdAt) or -1) ~= ARGV[1] then return 'other' end
  local p = redis.call('PTTL', KEYS[1])
  if p > 0 then ttl = p end
  redis.call('DEL', KEYS[1])
end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
return 'ok'`

export async function scopedInvalidate(code: string, createdAt: number, client: RedisClient = redis): Promise<string> {
  return String(await client.eval(INVALIDATE_SCRIPT, {
    keys: [k.meta(code), k.gen(code)],
    arguments: [String(createdAt), randomUUID(), String(lifespanTTL() * 1000)],
  }))
}

// ── The form that joins an existing transaction (account deletion, § 6) ──────
//
// Advisory locks first, in SORTED code order, then the live rows FOR UPDATE in
// the same order. Two account deletions sort the same way and every
// single-session writer takes one advisory lock before any row lock, so neither
// can wait on the other in a cycle. Callers that also lock a users row do it
// AFTER this (see lib/accountDelete.ts). PG-only: no Redis command, so the
// durable work does not depend on Redis being reachable (`readMeta: false`).

export type LockedSession = {
  id: number
  code: string
  hostUserId: number | null
  createdAt: Date | null
  coverPhotoUrl: string | null
}

export async function withSessionLocks(
  tx: Prisma.TransactionClient,
  codes: Iterable<string>,
): Promise<Map<string, LockedSession | null>> {
  const sorted = [...new Set(codes)].sort()
  for (const code of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey(code)}))`
  }
  const out = new Map<string, LockedSession | null>()
  for (const code of sorted) {
    const r = await readLiveRow(tx, code, 'update')
    out.set(code, r ? { id: r.id, code, hostUserId: r.hostUserId, createdAt: r.createdAt, coverPhotoUrl: r.coverPhotoUrl } : null)
  }
  return out
}
