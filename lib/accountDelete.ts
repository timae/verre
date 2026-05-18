import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '@/lib/prisma'
import { redis, k, scanKeys } from '@/lib/redis'
import { userIdentityId } from '@/lib/identity'
import type { SessionMeta } from '@/lib/session'

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
  const keys = await scanKeys(`s:${code}:*`)
  if (keys.length > 0) await redis.del(keys)
}

// Tombstone the Postgres archive of a session that's being deleted whole as
// part of host account deletion. Without this, /me/history would keep showing
// the session for participants whose session_members rows survive — they'd
// click rejoin and hit 404. By definition (toDelete = no engagement from
// non-host identities), there are no other-user ratings, feed_items, or HoF
// entries worth preserving here.
//
// Soft-delete (not hard-delete) is the uniform contract: the DB-level trigger
// `prevent_session_hard_delete` (rewire phase 2 migration) blocks any DELETE
// against the sessions table. All session-deletion paths route through the
// same §8 data-survival scrub. Empty-session tombstones are the cost of the
// guarantee — at Tim+Simon scale they're invisible, and the periodic-cleanup
// runbook in docs/dev/session-deletion.md is the escape hatch.
//
// Already-soft-deleted sessions are skipped (deletedAt IS NULL filter): the
// scrub is idempotent but there's nothing to do.
async function deleteSessionFromPostgres(code: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.session.findFirst({
      where: { code, deletedAt: null },
      select: { id: true },
    })
    if (!row) return
    const sid = row.id
    // Wipe children that exist for these no-engagement sessions: ratings
    // (only the host's, by definition of "no other engagement"), HoF
    // entries the host filed, session_members. Wines orphan (sessionId
    // NULL) so any bookmarked wine remains reachable from /me/saved.
    await tx.$executeRaw`
      DELETE FROM ratings WHERE wine_id IN (SELECT id FROM wines WHERE session_id = ${sid})
    `
    await tx.$executeRaw`DELETE FROM hall_of_fame WHERE session_code = ${code}`
    await tx.$executeRaw`UPDATE wines SET session_id = NULL WHERE session_id = ${sid}`
    await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${code}`
    // Scrub the sessions row per the §8 data-survival contract. Same shape
    // as DELETE /api/session/[code]; uniform tombstone across all session-
    // deletion paths.
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
            link = NULL
       WHERE id = ${sid}
    `
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
          //
          // Order: Redis FIRST, Postgres second. Same reasoning as the
          // DELETE /api/session/[code] handler — Redis-first means a
          // concurrent rate POST in the window sees no meta → 404 → never
          // resurrects the session via pgUpsertSession. Postgres-first
          // would expose the phantom-resurrection race.
          await deleteSessionFromRedis(code)
          try { await deleteSessionFromPostgres(code) }
          catch (err) { console.error(`[accountDelete] postgres cleanup failed code=${code}`, err) }
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
//
// Per-row treatment after the rewire (see docs/dev/proposals/rewire.md §6
// phase 2 + root CLAUDE.md "Cascade vs tombstone"):
//
//   - Standalone ratings (session_id IS NULL): hard-cascade. No other user
//     depends on them. Their feed_items (kind='standalone', 1:1 via
//     ratingId) cascade on the rating delete; their rating_images cascade
//     via FK on ratings.id. The user's session feed_items (kind='session',
//     ratingId=null) cascade via `feed_items.user_id` on the user delete.
//
//   - Session ratings (session_id IS NOT NULL): tombstone. Other tasters'
//     compare views and the session's HoF need them. user_id → NULL,
//     rater_name → '[deleted]'. The rating_images attached to these stay
//     (their FK is ratings.id, not user_id).
//
//   - HoF rows: tombstone (today's behaviour preserved).
//
//   - Sessions hosted: tombstone host fields. Cohosts can administer.
export async function executeAccountDelete(userId: number): Promise<DeletePlan> {
  // Capture image URLs before the cascade fires. Reclaim happens AFTER commit
  // — fire-and-forget; if the transaction rolls back we haven't deleted any
  // S3 objects, and if S3 fails after commit the row is already gone (orphan
  // bytes that a future cleanup can sweep, never a broken DB state).
  //
  // Three sources of user-owned images to reclaim:
  //   1. Standalone rating_images (the user's photos attached to their own
  //      standalone ratings; cascade on rating delete).
  //   2. Wines added by sessions the user hosted (the host's "added wine"
  //      photos — orphan when the host's account dies, separate path from
  //      rating photos).
  //   3. The user's own avatar.
  //
  // Session-rating images are NOT captured: those ratings tombstone (the
  // rating stays alive, image stays attached, neither row goes away).
  const standaloneRatingImages = await prisma.$queryRaw<{ image_url: string }[]>`
    SELECT ri.image_url
    FROM rating_images ri
    JOIN ratings r ON r.id = ri.rating_id
    WHERE r.user_id = ${userId}
      AND r.session_id IS NULL
      AND ri.image_url IS NOT NULL`
  const hostedWineImages = await prisma.wine.findMany({
    where: { imageUrl: { not: null }, session: { hostUserId: userId } },
    select: { imageUrl: true },
  })
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { imageUrl: true },
  })

  await prisma.$transaction(async (tx) => {
    // Standalone ratings hard-cascade (no other user depends). Their
    // feed_items (kind='standalone', FK to ratings.id ON DELETE CASCADE)
    // and rating_images go with them. Done BEFORE the DELETE FROM users
    // so we don't fight the NoAction FK on ratings.user_id — the tombstone
    // UPDATE below handles the rows that survive.
    await tx.$executeRaw`
      DELETE FROM ratings
      WHERE user_id = ${userId}
        AND session_id IS NULL`

    // Session ratings tombstone. Other tasters' compare views still see
    // the rated data, attributed to the tombstone name.
    await tx.$executeRaw`
      UPDATE ratings
      SET user_id = NULL, rater_name = ${TOMBSTONE_NAME}
      WHERE user_id = ${userId}
        AND session_id IS NOT NULL`

    // HoF rows tombstone (today's behaviour preserved).
    await tx.$executeRaw`UPDATE hall_of_fame SET user_id = NULL, rater_name = ${TOMBSTONE_NAME} WHERE user_id = ${userId}`

    // Sessions hosted: tombstone host fields. Cohosts can administer.
    // Soft-deleted sessions already have host_user_id NULL, so the WHERE
    // clause naturally misses them.
    await tx.$executeRaw`UPDATE sessions SET host_user_id = NULL, host_name = ${TOMBSTONE_NAME} WHERE host_user_id = ${userId}`

    // DELETE FROM users cascades the rest:
    //   - feed_items.user_id CASCADE (all the user's session feed_items —
    //     standalone feed_items already gone above with their ratings)
    //   - bookmarks.user_id CASCADE
    //   - feed_item_likes.user_id CASCADE
    //   - feed_item_tags.user_id CASCADE
    //   - follows.followerId / followeeId CASCADE (both directions)
    //   - user_badges.user_id CASCADE
    //   - session_members.user_id CASCADE
    //   - user_mutes / user_blocks both directions CASCADE
    await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`
  })

  for (const ri of standaloneRatingImages) reclaimImage(ri.image_url)
  for (const w of hostedWineImages) reclaimImage(w.imageUrl)
  if (userRow?.imageUrl) reclaimImage(userRow.imageUrl)

  return applyRedisCleanup(userId)
}
