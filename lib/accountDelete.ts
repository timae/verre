import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import { userIdentityId } from '@/lib/identity'
import type { SessionMeta } from '@/lib/session'

export const TOMBSTONE_NAME = '[deleted]'

type ScanHit = {
  code: string
  meta: SessionMeta
}

// SCAN is O(active sessions); revisit if we ever ship a u:<id>→sessions reverse index.
async function scanSessions(): Promise<ScanHit[]> {
  const hits: ScanHit[] = []
  for await (const key of redis.scanIterator({ MATCH: 's:*:meta', COUNT: 200 })) {
    const keys = Array.isArray(key) ? key : [key]
    for (const single of keys) {
      const raw = await redis.get(single)
      if (!raw) continue
      let meta: SessionMeta
      try { meta = JSON.parse(raw) as SessionMeta } catch { continue }
      const code = single.split(':')[1]
      if (!code) continue
      hits.push({ code, meta })
    }
  }
  return hits
}

function isHostOfSession(meta: SessionMeta, userId: number): boolean {
  return meta.hostIdentityId === userIdentityId(userId)
}

function isCohostOfSession(meta: SessionMeta, userId: number): boolean {
  const id = userIdentityId(userId)
  return !!meta.coHostIds?.includes(id)
}

// Engagement = at least one rating from a non-host identity. Host pre-ratings
// don't count — a session where only the host has rated is still empty.
async function sessionHasEngagement(code: string, hostIdentityId: string | undefined): Promise<boolean> {
  const pattern = `s:${code}:r:*`
  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    const keys = Array.isArray(key) ? key : [key]
    for (const single of keys) {
      // identityId itself contains a colon ("u:4"), so slice off the prefix
      // and use the LAST colon to split off the wineId suffix.
      const rest = single.slice(`s:${code}:r:`.length)
      const lastColon = rest.lastIndexOf(':')
      if (lastColon < 1) continue
      const ratingIdentity = rest.slice(0, lastColon)
      if (ratingIdentity !== hostIdentityId) return true
    }
  }
  return false
}

async function deleteSessionFromRedis(code: string): Promise<void> {
  const keys = await redis.keys(`s:${code}:*`)
  if (keys.length > 0) await redis.del(keys)
}

// Drop the Postgres archive of a session that's being deleted whole. Without
// this, /me/history would keep showing the session for participants whose
// session_members rows survive — they'd click rejoin and hit 404. By
// definition (toDelete = no engagement from non-host identities), there are
// no other-user ratings or HoF entries worth preserving here.
async function deleteSessionFromPostgres(code: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.session.findUnique({ where: { code }, select: { id: true } })
    if (!row) return
    const sid = row.id
    // Order matters: drop ratings (referenced by wine.id) before we orphan
    // wines, otherwise the subquery in the DELETE finds no rows.
    await tx.$executeRaw`
      DELETE FROM ratings WHERE wine_id IN (SELECT id FROM wines WHERE session_id = ${sid})
    `
    await tx.$executeRaw`DELETE FROM hall_of_fame WHERE session_code = ${code}`
    await tx.$executeRaw`UPDATE wines SET session_id = NULL WHERE session_id = ${sid}`
    await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${code}`
    await tx.$executeRaw`DELETE FROM sessions WHERE id = ${sid}`
  })
}

// Keep the user's rating keys + identity map entry (relabeled to [deleted]).
// Other tasters' compare views still see the rated data, just attributed to
// the tombstone. Tombstone host fields and remove from cohost list as needed.
async function pseudonymizeSessionInRedis(code: string, userId: number, meta: SessionMeta): Promise<void> {
  const id = userIdentityId(userId)
  await redis.hSet(k.identities(code), id, TOMBSTONE_NAME)

  let dirty = false
  if (isHostOfSession(meta, userId)) {
    meta.host = TOMBSTONE_NAME
    meta.hostUserId = null
    meta.hostIdentityId = undefined
    dirty = true
  }
  if (meta.coHostIds?.includes(id)) {
    meta.coHostIds = meta.coHostIds.filter(x => x !== id)
    dirty = true
  }
  if (dirty) {
    const ttl = await redis.ttl(k.meta(code))
    const opts = ttl > 0 ? { EX: ttl } : undefined
    await redis.set(k.meta(code), JSON.stringify(meta), opts)
  }
}

export type DeletePlan = {
  toDelete: string[]
  toPseudonymize: string[]
  scrubOnly: string[]
}

// Single-pass scan + decide + act. The decision is made from the meta we
// just read and acted on, so there's no TOCTOU window between plan and apply.
async function applyRedisCleanup(userId: number): Promise<DeletePlan> {
  const plan: DeletePlan = { toDelete: [], toPseudonymize: [], scrubOnly: [] }
  const sessions = await scanSessions()

  for (const { code, meta } of sessions) {
    try {
      if (isHostOfSession(meta, userId)) {
        const engaged = await sessionHasEngagement(code, meta.hostIdentityId)
        if (engaged) {
          await pseudonymizeSessionInRedis(code, userId, meta)
          plan.toPseudonymize.push(code)
        } else {
          // Drop Postgres archive too so the session disappears from
          // participants' /me/history; otherwise it lingers as an
          // un-rejoinable phantom.
          try { await deleteSessionFromPostgres(code) }
          catch (err) { console.error(`[accountDelete] postgres cleanup failed code=${code}`, err) }
          await deleteSessionFromRedis(code)
          plan.toDelete.push(code)
        }
      } else if (isCohostOfSession(meta, userId)) {
        await pseudonymizeSessionInRedis(code, userId, meta)
        plan.scrubOnly.push(code)
      } else {
        const inIdentities = await redis.hExists(k.identities(code), userIdentityId(userId))
        if (inIdentities) {
          await pseudonymizeSessionInRedis(code, userId, meta)
          plan.scrubOnly.push(code)
        }
      }
    } catch (err) {
      console.error(`[accountDelete] redis cleanup failed code=${code}`, err)
    }
  }
  return plan
}

// Postgres transaction is the GDPR-relevant step (atomic). Redis cleanup
// runs after, best-effort — Redis state is bounded by session lifespan TTL.
export async function executeAccountDelete(userId: number): Promise<DeletePlan> {
  await prisma.$transaction(async (tx) => {
    // UPDATE before DELETE because ratings/hof/sessions FK constraints are
    // ON DELETE NoAction — Postgres won't drop the user row otherwise.
    // Cascades on bookmarks/user_badges/session_members fire on the DELETE.
    await tx.$executeRaw`UPDATE ratings SET user_id = NULL, rater_name = ${TOMBSTONE_NAME} WHERE user_id = ${userId}`
    await tx.$executeRaw`UPDATE hall_of_fame SET user_id = NULL, rater_name = ${TOMBSTONE_NAME} WHERE user_id = ${userId}`
    await tx.$executeRaw`UPDATE sessions SET host_user_id = NULL, host_name = ${TOMBSTONE_NAME} WHERE host_user_id = ${userId}`
    await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`
  })

  return applyRedisCleanup(userId)
}
