// Engagement-deletion cascade — rewire.md §3 lines 360-388.
//
// When a user's session rating ends up empty (score 0/NULL + no chips +
// no aromas + no notes), the row is reaped. If it was the user's only rating in the
// session, the session feed_item is reaped too. S3 reclaim runs AFTER
// commit so a rollback never leaves "DB row + dead bytes" inconsistency.
//
// Three trigger sites, all the owner's own clear (`ownClear`, below):
//   1. POST /api/session/[code]/rate — after the upsert lands an empty
//      FULL payload (a merge save never reaps: docs/dev/rating-saves.md).
//   2. DELETE /api/session/[code]/rate/[wineId] — the explicit Reset ('force').
//   3. PATCH /api/checkins/[id] — a moment rating emptied in the post edit.
//
// The CTE pattern earlier drafts used had a subtle MVCC bug — CTE
// sub-statements share a snapshot, so a `NOT EXISTS (SELECT FROM ratings)`
// in the same CTE as a `DELETE FROM ratings` would still see the just-
// deleted row in its snapshot. Two SEPARATE auto-commit statements
// avoid this; do NOT wrap them in prisma.$transaction.

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Prisma } from '@prisma/client'
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

// The cascade inside a caller's transaction (the session mutation contract —
// redis-rehydration § 5.4: the rate and check-in writers commit their cascade
// with the rating write). Separate statements in one transaction see each
// other's effects; the id <> $ratingId self-exclusion stays as the belt. Returns
// the image URLs to reclaim AFTER COMMIT (capture / commit / reclaim-after), or
// null when nothing was reaped.
//
// Two modes for the rating delete itself:
// - 'empty-only' (the rate POST's empty full save, the post edit): deletes the
//   rating only if it IS empty (score 0/NULL + no chips + no aromas + no note);
//   the SQL predicate is the gate on destruction.
// - 'force' (the web's Reset DELETE): deletes it unconditionally (the gates
//   that fired the DELETE: origin, participant, identity).
//
// 🔒 `ownClear` (tasting feedback 2026-11-25: "could a reset rating just take
// away the xp?"): passed ONLY by the three paths where the owner clears their
// OWN rating (the empty save, the Reset, a moment rating emptied in the post
// edit). The owner is debited exactly the rating-action XP this row was credited
// (`ratings.rating_action_xp`, from the DELETE's RETURNING), floored at 0, in
// the caller's transaction. A retry or a repeat finds no row and debits nothing;
// a legacy row carries 0. Never for a host's bottle delete, a ban's wipe or an
// account deletion (they don't come through here). Counters never go down and
// earned badges stay.
export async function engagementCascadeIn(
  db: Prisma.TransactionClient | typeof prisma,
  ratingId: number,
  mode: 'empty-only' | 'force' = 'empty-only',
  { ownClear = false }: { ownClear?: boolean } = {},
): Promise<string[] | null> {
  const images = await db.ratingImage.findMany({ where: { ratingId }, select: { imageUrl: true } })
  const imageUrls = images.map(i => i.imageUrl).filter((u): u is string => !!u)
  type Deleted = { user_id: number | null; session_id: number | null; rating_action_xp: number }
  const deleted = mode === 'force'
    // rating-write: EXEMPT
    ? await db.$queryRaw<Deleted[]>`
        DELETE FROM ratings WHERE id = ${ratingId} RETURNING user_id, session_id, rating_action_xp`
    // rating-write: EXEMPT
    : await db.$queryRaw<Deleted[]>`
        DELETE FROM ratings
         WHERE id = ${ratingId}
           AND (score = 0 OR score IS NULL)
           AND flavors = '{}'::jsonb
           AND aromas = '[]'::jsonb
           AND (notes IS NULL OR notes = '')
         RETURNING user_id, session_id, rating_action_xp`
  if (deleted.length === 0) return null
  const { user_id, session_id } = deleted[0]
  const refund = Number(deleted[0].rating_action_xp ?? 0)
  if (ownClear && user_id != null && refund > 0) {
    await db.$executeRaw`UPDATE users SET xp = GREATEST(xp - ${refund}, 0) WHERE id = ${user_id}`
  }
  if (user_id != null && session_id != null) {
    await db.$executeRaw`
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
  return imageUrls
}

// Fire-and-forget S3 reclaim of rating photos, after the deleting COMMIT.
export function reclaimImages(urls: string[]): void {
  for (const url of urls) reclaimImage(url)
}

// The same, awaited: a write that failed after its upload reclaims the new
// object BEFORE it answers (model change § 8a, the S3→DB failure rule).
export async function reclaimImagesNow(urls: string[]): Promise<void> {
  await Promise.all(urls.map(reclaimImage))
}
