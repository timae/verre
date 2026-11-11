import { randomUUID } from 'node:crypto'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redis, k, scanKeys, lifespanTTL, createFailFastRedis, type FailFastRedis } from '@/lib/redis'
import { userIdentityId } from '@/lib/identity'
import { deleteAllNativeSessions } from '@/lib/identityStore'
import { withSessionLocks, scopedInvalidate, type LockedSession } from '@/lib/sessionMutation'
import { acquireSessionLock, releaseSessionLock, renewSessionLock, sessionLockHeld, sessionLockKey, fencedDel, lockTiming } from '@/lib/sessionLock'
import type { SessionMeta, WineMeta } from '@/lib/session'

export const TOMBSTONE_NAME = '[deleted]'

// Inlined S3 reclaim — same pattern as app/api/checkins/[id]/route.ts and
// lib/session.ts. Adding a third named export to lib/s3.ts trips a Next 15.5 /
// webpack 5.98 bundling bug; keeping copies here until that's fixed upstream.
const _S3_ENDPOINT = process.env.S3_ENDPOINT
const _S3_BUCKET = process.env.S3_BUCKET
const _s3 = _S3_ENDPOINT
  ? new S3Client({
      endpoint: _S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!_s3 || !_S3_BUCKET || !url || !_S3_ENDPOINT) return
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await _s3.send(new DeleteObjectCommand({ Bucket: _S3_BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] reclaimImage failed:', { key, err })
  }
}

// ── Account deletion (docs/dev/proposals/redis-rehydration.md § 6) ──────────────
//
// 🔒 ONE Postgres transaction over every session the user touched AND the user
// row. Nothing is committed per session: a failure anywhere rolls everything
// back and the deletion is retryable with no progress table (R6-1 — per-session
// commits detached a still-live account's ratings and let a retry mint a second
// tombstone identity for the same person in the same session).
//
//   discovery   plain SELECTs, outside any lock — a TENTATIVE plan whose only
//               output is the set of session codes to lock (and the size bound)
//   transaction withSessionLocks (advisory locks, then the live rows FOR UPDATE,
//               sorted) → the users row FOR UPDATE → the touched set re-read
//               (grew ⇒ retry) → per session, the branch DECIDED FROM STATE
//               RE-READ UNDER THE LOCKS: wipe (empty hosted session) /
//               anonymize / kicked hard-delete → account-level work → DELETE
//               FROM users (its FKs refuse if anything above was missed)
//   after COMMIT image reclaims; the d: migration of each live tombstoned
//               session's Redis copy; Redis-only registrations; the carousel key
//               — projections, best-effort and time-bounded
//
// The Redis lease, renew and 'replan' (release B, plan § 5). Discovery names the
// WIPE CANDIDATES — hosted live sessions with no Postgres rating by anyone else,
// plus every code reserved by an earlier 'replan' — and their
// lock:session:{CODE} leases are taken BEFORE the transaction, sorted, on the
// fail-fast client (a lease taken while holding advisory locks would invert the
// lock order: Redis → advisory → row). Under the locks every branch is decided
// fresh: a hosted session that is unengaged in Postgres is wiped only if it is
// LEASED (and its anonymous rating keys say unengaged too — read under the
// lease); one that became empty after discovery is a 'replan' (roll back,
// release, restart with the code reserved — bounded); one that became engaged is
// anonymized and its lease goes unused. Every held lease is renewed (fenced)
// before each session's work, and a refused renew rolls everything back
// (retryable). The wipe is a fenced DEL through the lease, INSIDE the
// transaction (the § 5.4 soft-delete rule). Redis unreachable or a lease busy
// → the deletion fails retryably — the fence is never waived for availability.
// A deletion that fails after its wipe leaves a live row whose next open
// rebuilds it (release A's caveat is closed by the rebuild).
//
// After COMMIT, each live tombstoned session's d: migration runs under that
// session's lease (the held one, or one acquired for it) and bumps the
// publication generation; busy or failed → scoped invalidation (meta DEL if
// it is still this incarnation + a generation bump), so the next open
// rebuilds from the record and a rebuild that read the pre-deletion record
// can never publish it.
//
// 🔒 Lock order and deadlocks: advisory (sorted) → sessions rows (sorted) →
// users row. A cycle can only involve the deleting user's OWN concurrent write
// whose FK checks lock a session we hold before the user row; Postgres aborts
// one side (40P01) and the whole deletion retries (bounded). Under release B
// every single-session writer takes its advisory lock first, so a writer on a
// touched session waits at the advisory lock (no cycle) and a writer on an
// untouched session waits only on the users row, which we never wait behind.
//
// HoF is excluded from the tombstone contract (deprecated surface, R3-10): its
// rows are tombstoned as before.

export const ACCOUNT_DELETE_MAX_WIPES = 25
const MAX_ATTEMPTS = 3
const MAX_REPLANS = 3
const REDIS_TIMEOUT_MS = 3000
const POST_COMMIT_BUDGET_MS = 8000
const NATIVE_REVOKE_TIMEOUT_MS = 10_000

export class AccountDeleteRetryableError extends Error {}
export class AccountDeleteTooManyWipesError extends AccountDeleteRetryableError {
  constructor(public readonly count: number, public readonly max: number) {
    super(`account deletion would delete ${count} empty moments (limit ${max}); delete some of them first`)
  }
}
class TouchedSetGrewError extends AccountDeleteRetryableError {}
// A hosted session that became empty in Postgres after discovery, without a
// lease: roll back, release, and restart with the code reserved.
class ReplanError extends Error {
  constructor(readonly code: string) { super(`replan: ${code} became a wipe candidate`) }
}

export type AccountDeleteHooks = {
  afterDiscovery?: () => Promise<void>
  afterLeases?: () => Promise<void>
  afterLocks?: () => Promise<void>
  afterSession?: (code: string) => Promise<void>
  beforeWipeDel?: (client: FailFastRedis) => Promise<void>
  beforeUserDelete?: () => Promise<void>
  // Test seams: make the post-commit projections (and their invalidation) fail; observe reclaims.
  failProjection?: boolean
  failInvalidation?: boolean
  onReclaim?: (url: string) => void
}

export type AccountDeleteOptions = {
  hooks?: AccountDeleteHooks
  maxWipes?: number
  // Test seam: a shorter interactive-transaction timeout.
  txTimeoutMs?: number
}

export type DeletePlan = {
  toDelete: string[]
  toPseudonymize: string[]
  scrubOnly: string[]
}

type SessionOutcome = {
  code: string
  createdAt: Date | null
  key: string
  hosted: boolean
  kicked: boolean
  hadRatings: boolean
}

export type AccountDeleteResult = {
  plan: DeletePlan
  sessions: SessionOutcome[]
}

export async function executeAccountDelete(userId: number, opts: AccountDeleteOptions = {}): Promise<DeletePlan> {
  // 🔒 Native sessions die FIRST, through Better Auth (never raw row deletes —
  // the Redis copies are the live read path). Must run BEFORE the transaction:
  // the users cascade removes the auth_sessions rows, after which there is
  // nothing left to sweep the Redis token copies from. Revoke-first is the safe
  // failure order: a throw aborts the deletion with the account intact
  // (retryable), and a rollback after a successful revoke merely costs native
  // re-logins. This pre-step is the only thing that commits before the
  // account transaction.
  // Bounded: with Redis unreachable BA's per-token delete would otherwise wait
  // in node-redis's offline queue indefinitely. A timeout fails retryably with
  // nothing durable done (any revoke that completes later is still a revoke).
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      deleteAllNativeSessions(userId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AccountDeleteRetryableError('native session revocation timed out')), NATIVE_REVOKE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return (await deleteAccountDurable(userId, opts)).plan
}

// The durable part — discovery, the one transaction, the post-commit
// projections. Exported for the integration suite's durable-work fixture.
export async function deleteAccountDurable(userId: number, opts: AccountDeleteOptions = {}): Promise<AccountDeleteResult> {
  // Images of rows that go unconditionally, captured before the transaction
  // (capture / commit / reclaim-after): standalone rating images (they cascade
  // with the ratings). Everything decided under the locks captures its images
  // in the transaction: the user's own profile photo + cover (under the users
  // row lock), and the wine photos of a moment wiped with the account (D8 / D9,
  // kept while another rating or bookmark references the wine). A moment that
  // SURVIVES the deletion (anonymised) keeps every wine photo: its line-up
  // still shows them. Reclaim fires only after COMMIT, and only the committed
  // attempt's set.
  const standaloneRatingImages = await prisma.$queryRaw<{ image_url: string }[]>`
    SELECT ri.image_url
    FROM rating_images ri
    JOIN ratings r ON r.id = ri.rating_id
    WHERE r.user_id = ${userId}
      AND r.session_id IS NULL
      AND ri.image_url IS NOT NULL`

  let committed: Committed | null = null
  const reserved = new Set<string>()
  for (let attempt = 1, replans = 0; ; attempt++) {
    try {
      committed = await attemptDelete(userId, opts, reserved)
      break
    } catch (err) {
      if (err instanceof ReplanError) {
        if (++replans > MAX_REPLANS) throw new AccountDeleteRetryableError('moments kept changing during the deletion; try again')
        reserved.add(err.code)
        attempt--
        console.warn('[accountDelete] replan', { code: err.code, replans })
        continue
      }
      const retry = err instanceof TouchedSetGrewError || isDeadlock(err)
      if (!retry || attempt >= MAX_ATTEMPTS) throw err
      console.warn('[accountDelete] retrying after', { attempt, reason: (err as Error).message })
    }
  }

  const reclaim = [
    ...standaloneRatingImages.map(r => r.image_url),
    ...committed.reclaimUrls,
  ]
  for (const url of reclaim) {
    if (!url) continue
    opts.hooks?.onReclaim?.(url)
    reclaimImage(url)
  }

  await projectAfterCommit(userId, committed, opts)
  return { plan: committed.plan, sessions: committed.sessions }
}

type Committed = {
  plan: DeletePlan
  sessions: SessionOutcome[]
  liveCodes: Set<string>
  reclaimUrls: string[]
  // Leases held through COMMIT, reused by the post-commit projections.
  leases: Map<string, string>
}

function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string }
  return e?.code === 'P2034' || e?.meta?.code === '40P01' || /deadlock detected/i.test(e?.message ?? '')
}

async function touchedLiveCodes(db: Prisma.TransactionClient | typeof prisma, userId: number): Promise<string[]> {
  const uid = userIdentityId(userId)
  const rows = await db.$queryRaw<{ code: string }[]>`
    SELECT s.code FROM sessions s WHERE s.deleted_at IS NULL AND s.host_user_id = ${userId}
    UNION
    SELECT s.code FROM session_members m JOIN sessions s ON s.code = m.session_code AND s.deleted_at IS NULL
     WHERE m.user_id = ${userId}
    UNION
    SELECT s.code FROM ratings r JOIN sessions s ON s.id = r.session_id AND s.deleted_at IS NULL
     WHERE r.user_id = ${userId}
    UNION
    SELECT s.code FROM wines w JOIN sessions s ON s.id = w.session_id AND s.deleted_at IS NULL
     WHERE w.added_by_identity_id = ${uid}`
  return rows.map(r => r.code).sort()
}

async function attemptDelete(userId: number, opts: AccountDeleteOptions, reserved: Set<string>): Promise<Committed> {
  const hooks = opts.hooks ?? {}
  const maxWipes = opts.maxWipes ?? ACCOUNT_DELETE_MAX_WIPES
  const uid = userIdentityId(userId)

  // ── Discovery (tentative). Decides nothing: it names the codes to lock and
  // the WIPE CANDIDATES to lease (hosted, no Postgres rating by anyone else ∪
  // the codes reserved by a 'replan'). Both size bounds fail BEFORE any durable
  // statement (R7-1B — no pre-pass): the candidate count here, the decided
  // wipe count under the locks.
  const codes = await touchedLiveCodes(prisma, userId)
  const candidates = [...new Set([...(await unengagedHosted(prisma, userId)), ...[...reserved].filter(c => codes.includes(c))])].sort()
  await hooks.afterDiscovery?.()
  if (candidates.length > maxWipes) throw new AccountDeleteTooManyWipesError(candidates.length, maxWipes)

  // Redis for the durable path is a dedicated FAIL-FAST connection, opened only
  // when there is a wipe candidate (the PG-only path issues no Redis command at
  // all) and closed when the attempt ends. The leases are taken on it, sorted,
  // BEFORE the transaction.
  const durable = new DurableRedis()
  const leases = new Map<string, string>()
  let committed = false
  try {
    for (const code of candidates) {
      const token = await durable.step(`lease ${code}`, (c) => acquireSessionLock(code, { waitMs: REDIS_TIMEOUT_MS - 500, client: c }))
      if (!token) throw new AccountDeleteRetryableError(`moment ${code} is busy; try again`)
      leases.set(code, token)
    }
    await hooks.afterLeases?.()
    const out = await prisma.$transaction(async (tx): Promise<Committed> => {
      const locked = await withSessionLocks(tx, codes)
      // Entry checks for the leased codes, inside the locks: the lease is still
      // ours and the cache holds this incarnation (or nothing).
      for (const [code, token] of leases) {
        const row = locked.get(code)
        await durable.step(`entry ${code}`, async (c) => {
          if (!(await sessionLockHeld(code, token, c))) throw new AccountDeleteRetryableError(`lease on ${code} was lost`)
          const raw = await c.get(k.meta(code))
          if (raw && row?.createdAt && (JSON.parse(raw) as SessionMeta).createdAt !== row.createdAt.getTime()) {
            throw new AccountDeleteRetryableError(`moment ${code} changed incarnation`)
          }
        })
      }
      await hooks.afterLocks?.()

      // The users row, AFTER the session locks (module header: lock order). From
      // here no new rating, member row or brought-by reassignment can reference
      // this user (their FK/existence checks take KEY SHARE on it), so the
      // touched-set re-read below is final. The profile photo + cover are read
      // under this lock (lib/profileImage.ts): a replace that waited on it finds
      // no row and reclaims its own upload, so nothing is orphaned.
      const me = await tx.$queryRaw<{ id: number; image_url: string | null; cover_photo_url: string | null }[]>`
        SELECT id, image_url, cover_photo_url FROM users WHERE id = ${userId} FOR UPDATE`
      if (!me[0]) throw new AccountDeleteRetryableError('user row is gone')
      const now = await touchedLiveCodes(tx, userId)
      if (now.some(code => !locked.has(code))) throw new TouchedSetGrewError('a session was touched after discovery')

      const plan: DeletePlan = { toDelete: [], toPseudonymize: [], scrubOnly: [] }
      const sessions: SessionOutcome[] = []
      const reclaimUrls: string[] = []
      // D8 / D9 phase 1: (wine id, url) of every wiped moment's wines, captured
      // before the wipe orphans them. Filtered after the users cascade below.
      const wineCandidates: { id: string; image_url: string }[] = []
      const liveCodes = new Set<string>()

      // DECIDE every branch first, from state read under the locks, with no
      // durable statement yet — so the size bound below holds for the ACTUAL
      // wipe set (a session engaged at discovery may be empty now), and a
      // refusal leaves nothing to undo but locks.
      type Decision = { row: LockedSession; hosted: boolean; kicked: boolean; wipe: boolean }
      const decisions: Decision[] = []
      for (const code of [...locked.keys()]) {
        const row = locked.get(code)
        if (!row) continue  // soft-deleted since discovery: handled by the session-less pass below
        const hosted = row.hostUserId === userId
        const member = await tx.$queryRaw<{ removed_state: string | null }[]>`
          SELECT removed_state FROM session_members WHERE user_id = ${userId} AND session_code = ${code} FOR UPDATE`
        const kicked = member[0]?.removed_state === 'kicked'
        // hosted ∧ unengaged in Postgres: wipe only under a lease (then the
        // anonymous rating keys decide), else 'replan' — never take a lease
        // while holding advisory locks.
        let wipe = false
        if (hosted && !(await engagedInPostgres(tx, row, userId))) {
          const token = leases.get(code)
          if (!token) throw new ReplanError(code)
          wipe = !(await engagedInRedis(row, userId, durable))
        }
        decisions.push({ row, hosted, kicked, wipe })
      }
      const wipes = decisions.filter(d => d.wipe).length
      if (wipes > maxWipes) throw new AccountDeleteTooManyWipesError(wipes, maxWipes)

      for (const { row, hosted, kicked, wipe } of decisions) {
        const code = row.code
        liveCodes.add(code)
        // Every held lease is renewed (fenced) before each session's work — a
        // refused renew means a lease was lost: everything rolls back.
        for (const [c, token] of leases) {
          await durable.step(`renew ${c}`, async (cl) => {
            if (!(await renewSessionLock(c, token, lockTiming.leaseMs, cl))) throw new AccountDeleteRetryableError(`lease on ${c} was lost`)
          })
        }
        if (wipe) {
          const wiped = await wipeEmptySession(tx, row, userId, durable, leases.get(code)!, hooks)
          reclaimUrls.push(...wiped.urls)
          wineCandidates.push(...wiped.wines)
          plan.toDelete.push(code)
        } else {
          const key = `d:${randomUUID()}`
          let hadRatings = false
          if (kicked) {
            // Kicked-then-deleted (R2-7): the ratings were kept only for the
            // user's own history, which goes with the account — hard-delete them,
            // or a rebuild would resurrect them into other tasters' compare.
            const imgs = await tx.$queryRaw<{ image_url: string }[]>`
              SELECT ri.image_url FROM rating_images ri JOIN ratings r ON r.id = ri.rating_id
               WHERE r.user_id = ${userId} AND r.session_id = ${row.id} AND ri.image_url IS NOT NULL`
            reclaimUrls.push(...imgs.map(i => i.image_url))
            await tx.$executeRaw`DELETE FROM ratings WHERE user_id = ${userId} AND session_id = ${row.id}`
          } else {
            const n = await tx.$executeRaw`
              UPDATE ratings SET user_id = NULL, rater_name = ${TOMBSTONE_NAME}, tombstone_key = ${key}
               WHERE user_id = ${userId} AND session_id = ${row.id}`
            hadRatings = n > 0
          }
          // Provenance moves with the identity (R3-5): wineToWire falls back to
          // the stored snapshot, so the real name must not survive here.
          await tx.$executeRaw`
            UPDATE wines SET added_by_identity_id = ${key}, added_by_display_name = ${TOMBSTONE_NAME}
             WHERE session_id = ${row.id} AND added_by_identity_id = ${uid}`
          if (hosted) {
            await tx.$executeRaw`UPDATE sessions SET host_user_id = NULL, host_name = ${TOMBSTONE_NAME} WHERE id = ${row.id}`
          }
          await tx.$executeRaw`DELETE FROM session_bans WHERE session_code = ${code} AND identity_id = ${uid}`
          sessions.push({ code, createdAt: row.createdAt, key, hosted, kicked, hadRatings })
          ;(hosted ? plan.toPseudonymize : plan.scrubOnly).push(code)
        }
        await hooks.afterSession?.(code)
      }

      // Soft-deleted sessions keep their ratings (rewire § 8): stamp one key per
      // (user, session) there too. No code, no lock: nothing projects them and no
      // writer changes a rating's identity.
      const dead = await tx.$queryRaw<{ session_id: number }[]>`
        SELECT DISTINCT r.session_id FROM ratings r JOIN sessions s ON s.id = r.session_id
         WHERE r.user_id = ${userId} AND s.deleted_at IS NOT NULL`
      for (const { session_id } of dead) {
        await tx.$executeRaw`
          UPDATE ratings SET user_id = NULL, rater_name = ${TOMBSTONE_NAME}, tombstone_key = ${`d:${randomUUID()}`}
           WHERE user_id = ${userId} AND session_id = ${session_id}`
      }

      // Account-level work. Standalone ratings hard-cascade (their feed_items and
      // rating_images go with them — images captured before the transaction).
      await tx.$executeRaw`DELETE FROM ratings WHERE user_id = ${userId} AND session_id IS NULL`
      await tx.$executeRaw`UPDATE hall_of_fame SET user_id = NULL, rater_name = ${TOMBSTONE_NAME} WHERE user_id = ${userId}`
      // Session-less (orphaned) wines the user added: no session, no key — the
      // snapshot is the only place the name would survive.
      await tx.$executeRaw`
        UPDATE wines SET added_by_identity_id = NULL, added_by_display_name = ${TOMBSTONE_NAME}
         WHERE session_id IS NULL AND added_by_identity_id = ${uid}`
      await tx.$executeRaw`DELETE FROM session_bans WHERE identity_id = ${uid}`
      await hooks.beforeUserDelete?.()

      // DELETE FROM users cascades: feed_items, bookmarks, likes, tags, follows,
      // badges, session_members, mutes, blocks, user_sessions, auth_accounts,
      // auth_sessions. ratings.user_id and sessions.host_user_id are NO ACTION:
      // a session rating or hosted session missed above makes this refuse.
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`
      for (const u of [me[0].image_url, me[0].cover_photo_url]) if (u) reclaimUrls.push(u)
      // 🔒 D8 / D9 phase 2, AFTER the rating deletes / tombstones (the wipe
      // deletes the host's own ratings) AND the users cascade (the host's own
      // bookmarks): keep a wiped moment's wine photo while any rating or
      // bookmark still references the wine.
      if (wineCandidates.length > 0) {
        const unused = await tx.$queryRaw<{ image_url: string }[]>`
          SELECT w.image_url FROM wines w
           WHERE w.id = ANY(${wineCandidates.map(c => c.id)}::text[]) AND w.image_url IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id)
             AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = w.id)`
        reclaimUrls.push(...unused.map(u => u.image_url))
      }
      return { plan, sessions, liveCodes, reclaimUrls, leases }
    }, { timeout: opts.txTimeoutMs ?? 60_000, maxWait: 10_000 })
    committed = true
    return out
  } finally {
    // An attempt that did not commit releases its leases here; a committed one
    // hands them to the post-commit projections (released there).
    if (!committed) for (const [code, token] of leases) await releaseQuietly(code, token)
    await durable.close()
  }
}

// Best-effort lease release on the shared client — skipped when it is offline
// (it would queue the command indefinitely) and bounded; an unreleased lease
// simply expires (15 s).
async function releaseQuietly(code: string, token: string): Promise<void> {
  if (!redis.isReady) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([releaseSessionLock(code, token), new Promise(r => { timer = setTimeout(r, 1000) })])
    .catch(() => {}).finally(() => timer && clearTimeout(timer))
}

// Hosted live sessions with no Postgres rating by anyone else (tombstones
// count) — the wipe candidates of discovery. Tentative: decided again under
// the locks.
async function unengagedHosted(db: typeof prisma, userId: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ code: string }[]>`
    SELECT s.code FROM sessions s
     WHERE s.deleted_at IS NULL AND s.host_user_id = ${userId}
       AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.session_id = s.id AND (r.user_id IS NULL OR r.user_id <> ${userId}))`
  return rows.map(r => r.code)
}

// Engagement of a hosted session, decided under its locks: any Postgres rating
// by someone else (tombstones count) — authoritative, every rating writer takes
// the session's advisory lock this transaction holds — and, only when Postgres
// says empty and the session is leased, any rating key in Redis from another
// identity (anonymous raters live only there). A Redis failure throws: the wipe
// decision cannot be made, the deletion fails retryably.
async function engagedInPostgres(tx: Prisma.TransactionClient, row: LockedSession, userId: number): Promise<boolean> {
  const others = await tx.$queryRaw<{ x: number }[]>`
    SELECT 1 AS x FROM ratings WHERE session_id = ${row.id} AND (user_id IS NULL OR user_id <> ${userId}) LIMIT 1`
  return !!others[0]
}

async function engagedInRedis(row: LockedSession, userId: number, durable: DurableRedis): Promise<boolean> {
  const mine = `s:${row.code}:r:${userIdentityId(userId)}:`
  const keys = await durable.step(`engagement ${row.code}`, (c) => scanAll(c, `s:${row.code}:r:*`))
  return keys.some(key => !key.startsWith(mine))
}

// The soft-delete of an empty hosted session inside the account transaction.
// Same scrub contract as DELETE /api/session/:code (rewire § 8) plus the
// registry row; the host's own ratings go with it (there are no others). The
// Redis keys are deleted HERE, before COMMIT (§ 5.4): if that fails, the throw
// rolls the whole account deletion back. Returns the URLs to reclaim, and the
// moment's wine photos as CANDIDATES (D8 / D9: the caller keeps the ones a
// rating or bookmark still references once the users cascade has run).
async function wipeEmptySession(tx: Prisma.TransactionClient, row: LockedSession, userId: number, durable: DurableRedis, token: string, hooks: AccountDeleteHooks): Promise<{ urls: string[]; wines: { id: string; image_url: string }[] }> {
  const imgs = await tx.$queryRaw<{ image_url: string }[]>`
    SELECT ri.image_url FROM rating_images ri JOIN ratings r ON r.id = ri.rating_id
     WHERE r.session_id = ${row.id} AND r.user_id = ${userId} AND ri.image_url IS NOT NULL`
  const wines = await tx.$queryRaw<{ id: string; image_url: string }[]>`
    SELECT id, image_url FROM wines WHERE session_id = ${row.id} AND image_url IS NOT NULL`
  await tx.$executeRaw`DELETE FROM ratings WHERE session_id = ${row.id} AND user_id = ${userId}`
  await tx.$executeRaw`DELETE FROM hall_of_fame WHERE session_code = ${row.code}`
  await tx.$executeRaw`UPDATE wines SET session_id = NULL WHERE session_id = ${row.id}`
  await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${row.code}`
  await tx.$executeRaw`DELETE FROM session_bans WHERE session_code = ${row.code}`
  if (row.createdAt) {
    await tx.$executeRaw`
      INSERT INTO session_tombstones (code, created_at) VALUES (${row.code}, ${row.createdAt})
      ON CONFLICT DO NOTHING`
  }
  await tx.$executeRaw`
    UPDATE sessions
      SET deleted_at = NOW(),
          code = NULL,
          host_user_id = NULL,
          host_name = NULL,
          blind = NULL,
          blind_for_everyone = NULL,
          created_at = NULL,
          archived_at = NULL,
          name = NULL,
          address = NULL,
          date_from = NULL,
          date_to = NULL,
          timezone = NULL,
          description = NULL,
          link = NULL,
          cover_photo_url = NULL,
          category = NULL,
          lifespan = NULL,
          hide_lineup = NULL,
          hide_lineup_minutes_before = NULL,
          show_provenance = NULL
     WHERE id = ${row.id}`
  await durable.step(`wipe ${row.code}`, async (c) => {
    const keys = await scanAll(c, `s:${row.code}:*`)
    await hooks.beforeWipeDel?.(c)
    // The transaction must still be ours at the moment of the DEL: a backend
    // that died or a transaction that hit its timeout while this step awaited
    // Redis has already released its locks, and other participants may have
    // committed engagement since — the wipe must not run. (The irreducible
    // window is the one round trip between this check and the DEL — the § 5.4
    // "after the wipe, before COMMIT" row: an absence the record repairs.)
    await tx.$queryRaw`SELECT 1`
    // Fenced through the lease: a holder that lost it deletes nothing.
    for (let i = 0; i < keys.length; i += 500) await fencedDel(row.code, token, keys.slice(i, i + 500), c)
    if (keys.length === 0 && !(await sessionLockHeld(row.code, token, c))) throw new AccountDeleteRetryableError(`lease on ${row.code} was lost`)
  })
  return { urls: [...imgs.map(i => i.image_url), row.coverPhotoUrl].filter((u): u is string => !!u), wines }
}

// Bounded Redis access for the durable path, on a dedicated fail-fast client
// (lib/redis.ts createFailFastRedis): a command issued while disconnected
// fails instead of being queued, and a step that times out DISCONNECTS the
// client — mid-handshake included — rejecting anything still pending, so no
// wipe can be replayed after the transaction it belonged to rolled back. (A
// command Redis already received is the one irreducible case: its effect is an
// absence, the § 5.4 caveat.) Exported for the integration suite only.
export class DurableRedis {
  private client: FailFastRedis | null = null
  private connecting: Promise<unknown> | null = null
  private dead = false
  constructor(private readonly url?: string) {}
  async step<T>(label: string, fn: (c: FailFastRedis) => Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
    if (this.dead) throw new AccountDeleteRetryableError(`${label}: Redis connection was abandoned`)
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AccountDeleteRetryableError(`${label}: Redis timed out after ${ms} ms`)), ms)
    })
    try {
      if (!this.client) {
        this.client = createFailFastRedis({ url: this.url })
        this.connecting = this.client.connect()
      }
      await Promise.race([this.connecting, timeout]).catch((err) => {
        throw err instanceof AccountDeleteRetryableError ? err : new AccountDeleteRetryableError(`${label}: Redis is not reachable`)
      })
      const client = this.client
      return await Promise.race([fn(client), timeout]).catch((err) => {
        throw err instanceof AccountDeleteRetryableError ? err : new AccountDeleteRetryableError(`${label}: ${(err as Error).message}`)
      })
    } catch (err) {
      this.dead = true
      await this.close()
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // Destroys the socket (never QUIT — see createFailFastRedis). Every step has
  // settled by the time the transaction ends, so nothing is pending to lose.
  async close() {
    const c = this.client
    this.client = null
    this.connecting?.catch(() => {})
    if (c?.isOpen) await c.disconnect().catch(() => {})
  }
}

async function scanAll(c: FailFastRedis, pattern: string): Promise<string[]> {
  const seen = new Set<string>()
  let cursor = 0
  for (let i = 0; i < 1000; i++) {
    const res = await c.scan(cursor, { MATCH: pattern, COUNT: 200 })
    for (const key of res.keys) seen.add(key)
    cursor = res.cursor
    if (cursor === 0) return [...seen]
  }
  throw new Error(`scan overflow: ${pattern}`)
}

// ── After COMMIT: projections of the committed record into the cache ───────────
//
// Each is best-effort, fenced by value (compare-and-set), idempotent and
// bounded in time; a projection that fails is logged and leaves the cache
// stale only in presentation — the record already holds the tombstone keys and
// wineToWire renders the '[deleted]' snapshot from it. Release B's
// reconciliation repairs whatever these miss.

// The d: migration of one live tombstoned session (§ 4.3), FENCED by the
// session lease (`token`: KEYS[1] must still hold it — 'lost' otherwise) and
// bumping the publication generation (KEYS[2]) so a rebuild that read the
// pre-deletion record can never publish it (r4-2). Validates EVERY
// compare-and-set before mutating anything and reports a conflict explicitly
// (Node re-reads and retries); then, atomically: the user's rating keys are
// RENAMEd to the d: identity (skip missing; an existing target wins) — or
// DELETED where the record hard-deleted them (kicked); the identities entry is
// swapped (only when the user has tombstoned ratings there, and never creating
// a TTL-less hash); lastseen + kicked entries and the kick version (KEYS[8],
// in the same fenced step — r6) go; rating-key pairs start at KEYS[9]; meta and wines are written
// with KEEPTTL. JSON stays in Node: cjson would re-encode an empty array as
// `{}`, turning `coHostIds: []` into an object.
export const D_MIGRATION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[10] then return 'lost' end
local meta = redis.call('GET', KEYS[3])
if meta ~= ARGV[1] then return 'conflict' end
local wines = redis.call('GET', KEYS[4])
if ARGV[3] == '__absent__' then
  if wines then return 'conflict' end
elseif wines ~= ARGV[3] then
  return 'conflict'
end
for i = 9, #KEYS, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    if ARGV[8] == 'delete' or redis.call('EXISTS', KEYS[i + 1]) == 1 then
      redis.call('DEL', KEYS[i])
    else
      redis.call('RENAME', KEYS[i], KEYS[i + 1])
    end
  end
end
if redis.call('EXISTS', KEYS[5]) == 1 then
  redis.call('HDEL', KEYS[5], ARGV[5])
  if ARGV[7] == '1' then redis.call('HSET', KEYS[5], ARGV[6], '${TOMBSTONE_NAME}') end
end
redis.call('HDEL', KEYS[6], ARGV[9])
redis.call('SREM', KEYS[7], ARGV[5])
redis.call('HDEL', KEYS[8], ARGV[5])
if ARGV[2] ~= ARGV[1] then redis.call('SET', KEYS[3], ARGV[2], 'KEEPTTL') end
if ARGV[3] ~= '__absent__' and ARGV[4] ~= ARGV[3] then redis.call('SET', KEYS[4], ARGV[4], 'KEEPTTL') end
local ttl = redis.call('PTTL', KEYS[3])
if ttl > 0 then redis.call('SET', KEYS[2], ARGV[11], 'PX', ttl) else redis.call('SET', KEYS[2], ARGV[11], 'PX', ARGV[12]) end
return 'ok'
`

// Redis-only registrations (a logged-in /join on a session with no Postgres
// trace of the user): no record to tombstone, so the cache is the only copy of
// the display name. Relabel the entry when the user has rating keys there
// (other tasters' compare keeps them, today's behaviour), else remove it.
// Fenced like every shared-state write (r1-11): under the session's lock
// (KEYS[4] must hold our token), the meta compare doubling as the incarnation
// check. Busy → skipped and logged (no record to invalidate from).
const SCRUB_REGISTRATION_SCRIPT = `
if redis.call('GET', KEYS[4]) ~= ARGV[6] then return 'lost' end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'conflict' end
if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
  if ARGV[5] == '1' then redis.call('HSET', KEYS[2], ARGV[3], '${TOMBSTONE_NAME}') else redis.call('HDEL', KEYS[2], ARGV[3]) end
end
redis.call('HDEL', KEYS[3], ARGV[4])
redis.call('SREM', KEYS[5], ARGV[3])
redis.call('HDEL', KEYS[6], ARGV[3])
if ARGV[2] ~= ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL') end
return 'ok'
`

function scrubMeta(meta: SessionMeta, userId: number, hosted: boolean): SessionMeta {
  const uid = userIdentityId(userId)
  const next: SessionMeta = { ...meta }
  if (hosted || next.hostUserId === userId || next.hostIdentityId === uid) {
    next.host = TOMBSTONE_NAME
    next.hostUserId = null
    delete next.hostIdentityId
  }
  if (next.coHostIds?.includes(uid)) next.coHostIds = next.coHostIds.filter(x => x !== uid)
  if (next.providerIds?.includes(uid)) next.providerIds = next.providerIds.filter(x => x !== uid)
  return next
}

export async function migrateTombstonedSession(userId: number, s: SessionOutcome, token: string): Promise<'ok' | 'skipped' | 'conflict' | 'lost'> {
  const uid = userIdentityId(userId)
  for (let attempt = 0; attempt < 5; attempt++) {
    const metaRaw = await redis.get(k.meta(s.code))
    // Cold (or another incarnation): nothing to migrate in place — but the
    // generation is still bumped and our incarnation's meta (if any) dropped.
    if (!metaRaw || !s.createdAt || (JSON.parse(metaRaw) as SessionMeta).createdAt !== s.createdAt.getTime()) {
      if (s.createdAt) await scopedInvalidate(s.code, s.createdAt.getTime())
      return 'skipped'
    }
    const meta = JSON.parse(metaRaw) as SessionMeta
    const winesRaw = await redis.get(k.wines(s.code))
    const nextMeta = JSON.stringify(scrubMeta(meta, userId, s.hosted))
    let nextWines = winesRaw ?? ''
    if (winesRaw) {
      const wines = JSON.parse(winesRaw) as WineMeta[]
      if (wines.some(w => w.addedByIdentityId === uid)) {
        nextWines = JSON.stringify(wines.map(w => w.addedByIdentityId === uid
          ? { ...w, addedByIdentityId: s.key, addedByDisplayName: TOMBSTONE_NAME }
          : w))
      }
    }
    const src = await scanKeys(`s:${s.code}:r:${uid}:*`)
    const keys = [sessionLockKey(s.code), k.gen(s.code), k.meta(s.code), k.wines(s.code), k.identities(s.code), k.lastSeen(s.code), k.kicked(s.code), k.kickv(s.code)]
    for (const key of src) keys.push(key, key.replace(`:r:${uid}:`, `:r:${s.key}:`))
    const res = await redis.eval(D_MIGRATION_SCRIPT, {
      keys,
      arguments: [
        metaRaw, nextMeta, winesRaw ?? '__absent__', nextWines, uid, s.key,
        s.hadRatings ? '1' : '0', s.kicked ? 'delete' : 'rename', String(userId),
        token, randomUUID(), String(lifespanTTL() * 1000),
      ],
    })
    if (res === 'ok' || res === 'lost') return res
  }
  return 'conflict'
}

async function scrubRedisOnlyRegistrations(userId: number, known: Set<string>, deadline: number): Promise<number> {
  const uid = userIdentityId(userId)
  let scrubbed = 0
  let cursor = 0
  do {
    if (Date.now() > deadline) { console.warn('[accountDelete] Redis-only registration scan hit its time budget'); break }
    const res = await redis.scan(cursor, { MATCH: 's:*:meta', COUNT: 200 })
    cursor = res.cursor
    for (const metaKey of res.keys) {
      const code = metaKey.split(':')[1]
      if (!code || known.has(code)) continue
      // Registered, or only a kick trace left (kicked marker / kick version — r5)
      if (!(await redis.hExists(k.identities(code), uid)) && !(await redis.sIsMember(k.kicked(code), uid)) && !(await redis.hExists(k.kickv(code), uid))) continue
      const token = await acquireSessionLock(code, { waitMs: 1000 })
      if (!token) { console.warn('[accountDelete] Redis-only registration scrub skipped: session busy', { code }); continue }
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          // Decided under the lease (r2 N7): a wine delete committed while the
          // scrub waited may have taken the user's last rating key.
          const relabel = (await scanKeys(`s:${code}:r:${uid}:*`)).length > 0
          const metaRaw = await redis.get(metaKey)
          if (!metaRaw) break
          const nextMeta = JSON.stringify(scrubMeta(JSON.parse(metaRaw) as SessionMeta, userId, false))
          const r = await redis.eval(SCRUB_REGISTRATION_SCRIPT, {
            keys: [metaKey, k.identities(code), k.lastSeen(code), sessionLockKey(code), k.kicked(code), k.kickv(code)],
            arguments: [metaRaw, nextMeta, uid, String(userId), relabel ? '1' : '0', token],
          })
          if (r === 'ok') { scrubbed++; break }
          if (r === 'lost') break
        }
      } finally {
        await releaseSessionLock(code, token).catch(() => {})
      }
    }
  } while (cursor !== 0)
  return scrubbed
}

async function projectAfterCommit(userId: number, committed: Committed, opts: AccountDeleteOptions): Promise<void> {
  const deadline = Date.now() + POST_COMMIT_BUDGET_MS
  // Each projection (and its invalidation fallback) is guarded the same way:
  // never on a disconnected client (the shared client QUEUES commands while
  // offline — an unbounded wait), and bounded by the remaining budget.
  const guarded = async (fn: () => Promise<unknown>) => {
    if (!redis.isReady) throw new Error('Redis is not reachable')
    const left = Math.max(250, deadline - Date.now())
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), left) }),
    ]).finally(() => timer && clearTimeout(timer))
  }
  const bounded = async (label: string, fn: () => Promise<unknown>, onFail?: () => Promise<unknown>) => {
    try {
      if (opts.hooks?.failProjection) throw new Error('injected projection failure')
      await guarded(fn)
    } catch (err) {
      console.error(`[accountDelete] post-commit projection failed (${label}) — record is correct, cache repairs on reconciliation`, { userId, err })
      if (onFail && !opts.hooks?.failInvalidation) await guarded(onFail).catch(e => console.error('[accountDelete] invalidation failed too', { label, e }))
    }
  }
  for (const s of committed.sessions) {
    let token = committed.leases.get(s.code) ?? null
    try {
      await bounded(`d: migration ${s.code}`, async () => {
        token ??= await acquireSessionLock(s.code, { waitMs: REDIS_TIMEOUT_MS })
        if (!token) throw new Error('session busy')
        const r = await migrateTombstonedSession(userId, s, token)
        if (r === 'conflict' || r === 'lost') throw new Error(`d: migration ${r}`)
      }, async () => {
        // Refused or failed: drop this incarnation's meta and bump the
        // generation — the next open rebuilds from the record (R7, r4-2).
        if (s.createdAt) await scopedInvalidate(s.code, s.createdAt.getTime())
      })
    } finally {
      if (token && !committed.leases.has(s.code)) await guarded(() => releaseSessionLock(s.code, token!)).catch(() => {})
    }
  }
  for (const [code, token] of committed.leases) await guarded(() => releaseSessionLock(code, token)).catch(() => {})
  await bounded('redis-only registrations', () => scrubRedisOnlyRegistrations(userId, committed.liveCodes, deadline))
  // User-scoped Redis keys are NOT under any `s:{code}:*` pattern — delete them
  // explicitly. Any future `u:{userId}:*` key MUST be added here (lib/CLAUDE.md).
  await bounded('carousel-hidden', () => redis.del(k.carouselHidden(userId)))
}
