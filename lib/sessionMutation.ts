import type { Prisma } from '@prisma/client'

// The session mutation contract (docs/dev/proposals/redis-rehydration.md § 5.4).
//
// Release A ships ONLY the form that joins an existing transaction —
// `withSessionLocks` — and account deletion is its only caller, so that one
// account deletion stays ONE Postgres transaction over every session the user
// touched (R6-1). `withSessionMutation` (the per-route form with the Redis lock,
// the incarnation check and the commit-then-project step) is release B.
//
// 🔒 Lock order: advisory locks first, in SORTED code order, then the live
// sessions rows FOR UPDATE, in the same order. Two account deletions sort the
// same way, and release B's single-session writers take one advisory lock each
// before any row lock — so neither can wait on the other in a cycle. Callers
// that also lock a users row do it AFTER this (see lib/accountDelete.ts).
//
// PG-only by design: no Redis command, so the durable work of account deletion
// does not depend on Redis being reachable (§ 6, `readMeta: false`).

export type LockedSession = {
  id: number
  code: string
  hostUserId: number | null
  createdAt: Date | null
  coverPhotoUrl: string | null
}

export function sessionLockKey(code: string): string {
  return `session:${code}`
}

export async function withSessionLocks(
  tx: Prisma.TransactionClient,
  codes: Iterable<string>,
): Promise<Map<string, LockedSession | null>> {
  const sorted = [...new Set(codes)].sort()
  for (const code of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionLockKey(code)}))`
  }
  const out = new Map<string, LockedSession | null>()
  for (const code of sorted) {
    const rows = await tx.$queryRaw<{ id: number; host_user_id: number | null; created_at: Date | null; cover_photo_url: string | null }[]>`
      SELECT id, host_user_id, created_at, cover_photo_url
        FROM sessions WHERE code = ${code} AND deleted_at IS NULL
         FOR UPDATE`
    const r = rows[0]
    out.set(code, r ? { id: r.id, code, hostUserId: r.host_user_id, createdAt: r.created_at, coverPhotoUrl: r.cover_photo_url } : null)
  }
  return out
}
