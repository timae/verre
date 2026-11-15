// Usernames, server side (docs/dev/proposals/usernames.md § 8).
//
// 🔒 This module is the ONLY app code that writes `users.username`, besides
// the two sign-up inserts (Better Auth's own, and app/api/auth/register).
// CI-pinned: scripts/check-username-writes.mjs.
//
// 🔒 Every write is a MODEL call (`tx.user.update`), never a raw statement: a
// taken name (the unique index) and a HELD one (the trigger, same SQLSTATE)
// both surface as P2002 through a model call, but as P2010 through `$executeRaw`.
// And never inside a transaction above READ COMMITTED: the hold trigger refuses
// (its queries must see a hold committed while the write waited on the index).
//
// The quota lives here, not in the trigger: an operator rename must not spend
// the person's budget. Holds live in the database (prisma/CLAUDE.md § Usernames).

import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

export const USERNAME_CHANGE_LIMIT = 5
export const USERNAME_CHANGE_WINDOW_DAYS = 90
const WINDOW_MS = USERNAME_CHANGE_WINDOW_DAYS * 24 * 3600 * 1000

type Db = Prisma.TransactionClient

// The ONE pre-check: someone else's live name, or a live hold by someone else
// (`username_is_held`, the trigger's own predicate, so the two can't
// disagree). `forUser`'s own name and own held name are not taken. Advisory:
// the write's answer from the database is the authority.
export async function usernameTaken(name: string, forUser?: number | null, db: Db = prisma): Promise<boolean> {
  const me = forUser ?? null
  const rows = await db.$queryRaw<{ taken: boolean }[]>`
    SELECT (EXISTS (SELECT 1 FROM users WHERE username = ${name} AND (${me}::int IS NULL OR id <> ${me}::int))
         OR username_is_held(${name}, ${me}::int)) AS taken`
  return rows[0].taken
}

// ANY unique violation, in either shape: P2002 from a model call (the adapter
// maps every SQLSTATE 23505, the trigger's included), P2010 carrying the
// original code from a raw statement. It does not look at WHICH constraint
// (Prisma's error shape depends on the driver adapter), so only use it around
// a write whose sole unique column is the username (`changeUsername`'s
// update); the web register, whose insert can also collide on the email,
// re-runs the pre-check instead.
export function isUsernameConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null
  if (!e || typeof e !== 'object') return false
  if (e.code === 'P2002') return true
  return e.code === 'P2010' && (e.meta?.code === '23505' || e.meta?.driverAdapterError?.cause?.originalCode === '23505')
}

export type UsernameState = {
  username: string | null
  changesLeft: number
  // When the next change is possible, once none is left; else null.
  nextChangeAt: string | null
  // Your most recent old name while it is held for you ("switch back").
  previous: { username: string; heldUntil: string } | null
}

async function quota(userId: number, db: Db): Promise<{ used: number; nextChangeAt: Date | null }> {
  const rows = await db.$queryRaw<{ used: number; oldest: Date | null }[]>`
    SELECT count(*)::int AS used, min(changed_at) AS oldest
      FROM username_changes
     WHERE user_id = ${userId} AND changed_at > now() - make_interval(days => ${USERNAME_CHANGE_WINDOW_DAYS}::int)`
  const { used, oldest } = rows[0]
  // + 1 ms: `changed_at` carries microseconds and a JS Date drops them, so the
  // date handed out is never a moment BEFORE the database lets the change through.
  return { used, nextChangeAt: used >= USERNAME_CHANGE_LIMIT && oldest ? new Date(oldest.getTime() + WINDOW_MS + 1) : null }
}

export async function usernameState(userId: number, db: Db = prisma): Promise<UsernameState | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { username: true } })
  if (!user) return null
  const q = await quota(userId, db)
  const held = await db.$queryRaw<{ username: string; held_until: Date }[]>`
    SELECT username, held_until FROM username_holds
     WHERE user_id = ${userId} AND username IS NOT NULL AND held_until > now()
     ORDER BY held_until DESC LIMIT 1`
  return {
    username: user.username,
    changesLeft: Math.max(0, USERNAME_CHANGE_LIMIT - q.used),
    nextChangeAt: q.nextChangeAt ? q.nextChangeAt.toISOString() : null,
    previous: held[0] ? { username: held[0].username, heldUntil: held[0].held_until.toISOString() } : null,
  }
}

export type ChangeUsernameResult =
  | { status: 'ok'; changed: boolean }
  | { status: 'taken' }
  | { status: 'quota'; nextChangeAt: string }
  | { status: 'not-found' }
  // `expectedCurrent` no longer matched under the row lock: nothing written.
  | { status: 'moved'; current: string | null }

// Test seams (scripts/tests/usernames-section.mts § 21 d): the quota race
// needs a fixed schedule, and its negative control needs the row lock off.
// 🔒 Never set outside a test: `lockRow: false` removes what serialises two
// changes by one account.
export const usernameChangeSeams: { afterQuotaRead: () => Promise<void>; lockRow: boolean } = {
  afterQuotaRead: async () => {},
  lockRow: true,
}

// Set or change a username. `name` is CANONICAL (the caller validated it:
// `validateUsername`, or the format alone for an operator's reserved name).
// One READ COMMITTED transaction: lock the user's row (two changes by one
// account serialise, so the quota can't be raced), stop if unchanged, check
// the quota, write through the model, record the change. A refused change
// (taken, held) rolls back: no quota spent, no row left. A first choice from
// NULL is free; every later change counts, switching back included.
// `skipQuota` is the operator's rename. `blockOld` (operator, a moderation
// rename) takes the old name away for good: the trigger has just held it FOR
// its former owner, who could switch straight back; in the same transaction
// that hold loses its owner and its clear text and gets NO END DATE
// (`NO_END`), so it refuses everyone until `releaseUsernameHold`.
// 🔒 `expectedCurrent` (operator): the name the caller READ before deciding.
// Checked under the row lock; if the person renamed meanwhile the answer is
// `moved` and nothing is written. A moderation rename must pass it: otherwise
// a rename that lands between the operator's read and this transaction makes
// `blockOld` block a different name (or none, when they took the destination
// themselves) while the offending one stays held FOR them.
export const USERNAME_HOLD_NO_END = '9999-12-31T00:00:00Z'
export async function changeUsername(userId: number, name: string, opts: { skipQuota?: boolean; blockOld?: boolean; expectedCurrent?: string | null } = {}): Promise<ChangeUsernameResult> {
  try {
    return await prisma.$transaction(async (tx): Promise<ChangeUsernameResult> => {
      const rows = usernameChangeSeams.lockRow
        ? await tx.$queryRaw<{ username: string | null }[]>`SELECT username FROM users WHERE id = ${userId} FOR UPDATE`
        : await tx.$queryRaw<{ username: string | null }[]>`SELECT username FROM users WHERE id = ${userId}`
      if (rows.length === 0) return { status: 'not-found' }
      const current = rows[0].username
      if (opts.expectedCurrent !== undefined && current !== opts.expectedCurrent) return { status: 'moved', current }
      if (current === name) return { status: 'ok', changed: false }
      const counted = current !== null && !opts.skipQuota
      if (counted) {
        const q = await quota(userId, tx)
        await usernameChangeSeams.afterQuotaRead()
        if (q.nextChangeAt) return { status: 'quota', nextChangeAt: q.nextChangeAt.toISOString() }
      }
      await tx.user.update({ where: { id: userId }, data: { username: name }, select: { id: true } })
      if (counted) await tx.usernameChange.create({ data: { userId }, select: { id: true } })
      if (opts.blockOld && current !== null) {
        await tx.$executeRaw`
          UPDATE username_holds SET user_id = NULL, username = NULL, held_until = ${USERNAME_HOLD_NO_END}::timestamptz
           WHERE name_hash = username_hash(${current})`
      }
      await tx.$executeRaw`
        DELETE FROM username_changes
         WHERE user_id = ${userId} AND changed_at <= now() - make_interval(days => ${USERNAME_CHANGE_WINDOW_DAYS}::int)`
      return { status: 'ok', changed: true }
    }, { isolationLevel: 'ReadCommitted' })
  } catch (e) {
    if (isUsernameConflict(e)) return { status: 'taken' }
    throw e
  }
}

// Expired holds, deleted outside any username write: the daily in-process
// prune (lib/nativeSessionPrune.ts), so a deleted account's hash and a
// rename's clear-text old name are gone within a day or two of their 14. A
// moderation block (`blockOld`) has no end date and stays until released.
export async function pruneExpiredUsernameHolds(): Promise<number> {
  return prisma.$executeRaw`DELETE FROM username_holds WHERE held_until <= now()`
}

// Operator only (scripts/set-username.mts --release-hold): frees a held name
// at once, whoever held it, a moderation block included.
export async function releaseUsernameHold(name: string): Promise<number> {
  return prisma.$executeRaw`DELETE FROM username_holds WHERE name_hash = username_hash(${name})`
}

// Lookup by canonical username (FORMAT-checked by the caller, never the
// reserved list). A held or renamed-away name resolves to nothing: no
// redirect from an old name, ever.
export async function userForUsername(name: string, db: Db = prisma): Promise<{ id: number; publicId: string } | null> {
  return db.user.findUnique({ where: { username: name }, select: { id: true, publicId: true } })
}
