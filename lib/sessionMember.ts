import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import { userIdentityId } from '@/lib/identity'
import type { SessionMeta } from '@/lib/session'

export type EnsureMemberResult = 'ok' | 'no-session' | 'banned' | 'kicked'

// The durable membership row for a logged-in participant (redis-rehydration
// § 4.4, R2-5), shared by /visit, the logged-in /join path and the logged-in
// /rate path — /join and /rate used to register in Redis only, so a member who
// never /visit-ed had no row.
//
//  - Create-only role snapshot (host > cohost > provider > taster), never an
//    overwrite: the role route is the authoritative mirror for transitions, and
//    a re-entry carrying stale meta must not clobber a grant.
//  - First creation bumps lifetime_sessions_joined, decided by the INSERT
//    itself (RETURNING), so concurrent entries count once.
//  - Kicked-flag self-heal: a lingering removed_state='kicked' is cleared — the
//    rejoin partial-failure window (Redis cleared, Postgres not).
//
// 🔒 Every decision is made under the live sessions row's lock, inside this
// transaction (a decision made outside the lock it depends on decides nothing):
//  - Row existence. No live row → no write: session_members is keyed by code,
//    and a row written for a Redis-only session would attach this user to
//    whichever session later recycles the code. Both soft-delete paths take
//    the row FOR UPDATE, which conflicts with this FOR KEY SHARE.
//  - Admission. The caller's ban/kick gate ran earlier, against Redis. A ban or
//    kick that landed since must win: sessionWipe SADDs bans/kicked BEFORE its
//    row-locked transaction, so once this lock is held any committed or
//    in-flight removal is visible in Redis — re-read here, the member write and
//    the self-heal are skipped, and the caller bounces the request.
export async function ensureMember(userId: number, code: string, meta: SessionMeta): Promise<EnsureMemberResult> {
  const id = userIdentityId(userId)
  const isStrictHost = (meta.hostIdentityId && meta.hostIdentityId === id)
    || (meta.hostUserId && userIdentityId(meta.hostUserId) === id)
  const role = isStrictHost ? 'host'
    : meta.coHostIds?.includes(id) ? 'co_host'
    : meta.providerIds?.includes(id) ? 'provider'
    : 'taster'
  return prisma.$transaction(async (tx) => {
    const live = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM sessions WHERE code = ${code} AND deleted_at IS NULL FOR KEY SHARE`
    if (!live[0]) return 'no-session'
    if (await redis.sIsMember(k.bans(code), id)) return 'banned'
    if (await redis.sIsMember(k.kicked(code), id)) return 'kicked'
    const inserted = await tx.$queryRaw<{ user_id: number }[]>`
      INSERT INTO session_members (user_id, session_code, role) VALUES (${userId}, ${code}, ${role})
      ON CONFLICT (user_id, session_code) DO NOTHING
      RETURNING user_id`
    await tx.$executeRaw`
      UPDATE session_members SET removed_state = NULL
       WHERE user_id = ${userId} AND session_code = ${code} AND removed_state = 'kicked'`
    if (inserted.length > 0) {
      await tx.$executeRaw`
        UPDATE users SET lifetime_sessions_joined = lifetime_sessions_joined + 1 WHERE id = ${userId}`
    }
    return 'ok'
  })
}
