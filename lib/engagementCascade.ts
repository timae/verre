// Engagement-deletion cascade — rewire.md §3 lines 360-388.
//
// When a user's session rating ends up empty (score 0/NULL + no chips +
// no aromas + no notes), the row is reaped. If it was the user's only rating in the
// session, the session feed_item is reaped too. S3 reclaim runs AFTER
// commit so a rollback never leaves "DB row + dead bytes" inconsistency.
//
// Two trigger sites:
//   1. POST /api/session/[code]/rate — after the upsert lands an empty
//      payload (user cleared score + chips + notes and saved).
//   2. DELETE /api/session/[code]/rate/[wineId] — the explicit reset
//      path. The empty-payload predicate is the safety net here: a Reset
//      on a still-engaged row will no-op rather than wiping it.
//
// The CTE pattern earlier drafts used had a subtle MVCC bug — CTE
// sub-statements share a snapshot, so a `NOT EXISTS (SELECT FROM ratings)`
// in the same CTE as a `DELETE FROM ratings` would still see the just-
// deleted row in its snapshot. Two SEPARATE auto-commit statements
// avoid this; do NOT wrap them in prisma.$transaction.

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '@/lib/prisma'

// Inlined S3 reclaim — see comment in lib/accountDelete.ts. Tracked for
// extraction in .local/future-work-rewire.md once the Next/webpack
// bundling bug is fixed upstream.
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

/**
 * Run the engagement-deletion cascade against a single rating row.
 *
 * Two trigger sites — different semantics for the rating delete itself,
 * shared semantics for the feed_item cleanup and S3 reclaim:
 *
 * - mode='empty-only' (POST path): only deletes the rating if it's
 *   actually empty (score 0/NULL + no chips + no aromas + no notes). Safe to call
 *   after every upsert; no-ops when the row still carries data. The
 *   empty-payload SQL predicate IS the gate on destruction.
 *
 * - mode='force' (DELETE path / Reset): deletes the rating
 *   unconditionally. The user has explicitly asked to wipe it; we
 *   trust the gate that fired the DELETE (origin check, participant
 *   check, identity check) and run the delete regardless of payload.
 *
 * Application-level ordering, mirroring lib/accountDelete.ts:
 *   1. Capture rating_images.imageUrl into memory.
 *   2. Statement 1 — DELETE FROM ratings WHERE id=... [+ empty predicate].
 *   3. If step 2 returned a row, Statement 2 — DELETE FROM feed_items
 *      WHERE no other ratings remain for (user, session).
 *   4. AFTER step 3, fire reclaimImage on each captured URL.
 *
 * Two separate auto-commit statements (NOT wrapped in $transaction):
 * Postgres CTE sub-statements share an MVCC snapshot, so step 2's
 * NOT EXISTS would still see the just-deleted row from step 1 if
 * they shared a transaction. The id<>$ratingId self-exclusion in
 * step 2 is belt-and-suspenders against any visibility lag.
 *
 * Returns true if a row was deleted. Caller may want to know to refresh
 * client caches.
 */
export async function engagementDeletionCascade(
  ratingId: number,
  mode: 'empty-only' | 'force' = 'empty-only',
): Promise<boolean> {
  // 1. Capture image URLs before the DELETE.
  const images = await prisma.ratingImage.findMany({
    where: { ratingId },
    select: { imageUrl: true },
  })
  const imageUrls = images.map(i => i.imageUrl).filter((u): u is string => !!u)

  // 2. Statement 1 — DELETE the rating. Empty-only mode adds the
  // payload guard; force mode bypasses it.
  const deleted = mode === 'force'
    ? await prisma.$queryRaw<{ user_id: number | null; session_id: number | null }[]>`
        DELETE FROM ratings
         WHERE id = ${ratingId}
         RETURNING user_id, session_id`
    : await prisma.$queryRaw<{ user_id: number | null; session_id: number | null }[]>`
        DELETE FROM ratings
         WHERE id = ${ratingId}
           AND (score = 0 OR score IS NULL)
           AND flavors = '{}'::jsonb
           AND aromas = '[]'::jsonb
           AND (notes IS NULL OR notes = '')
         RETURNING user_id, session_id`

  if (deleted.length === 0) return false

  const { user_id, session_id } = deleted[0]
  // Anon ratings (user_id NULL) or standalone (session_id NULL) don't
  // have feed_items to clean up. S3 reclaim still fires below.
  if (user_id != null && session_id != null) {
    // 3. Statement 2 — drop the session feed_item if no other ratings
    // remain for (user, session). The id<>$ratingId self-exclusion in
    // NOT EXISTS guards against MVCC visibility lag.
    await prisma.$executeRaw`
      DELETE FROM feed_items
       WHERE user_id = ${user_id}
         AND session_id = ${session_id}
         AND NOT EXISTS (
           SELECT 1 FROM ratings
            WHERE user_id = ${user_id}
              AND session_id = ${session_id}
              AND id <> ${ratingId}
         )`
  }

  // 4. S3 reclaim AFTER commit. Fire-and-forget; if S3 fails the DB
  // row is already gone — orphan bytes for a future cleanup, never
  // broken DB state.
  for (const url of imageUrls) reclaimImage(url)

  return true
}
