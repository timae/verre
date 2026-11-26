// The version check of session ratings (docs/dev/rating-saves.md; tasting
// feedback 2026-11-25, ruled by Simon over a table of finished operation ids).
//
// `rating_versions` holds ONE row per person and bottle: `version` (bumped by
// every write of that person's signed-in session rating of a Postgres-backed
// moment, in the SAME transaction as the rating change) and `last_op_id` (the
// app's `opId` of the write that set it, NULL for a writer without one). A save
// that says which version it was based on (`baseVersion`) is refused with 409
// when the current version differs; a re-sent op that had committed meets its
// own `lastOpId` there and the app adopts the answer.
//
// 🔒 Every writer of a signed-in session rating calls one of the bump helpers
// below (or copies the rows on a re-mint), in the transaction of the change; the
// CI census `scripts/check-rating-writes.mjs` lists each write site as BUMPS,
// COPIES or EXEMPT. Each helper is ONE atomic statement (`INSERT … ON CONFLICT
// DO UPDATE … version + 1`): the post edit of a soft-deleted moment runs without
// the session lock, so never read-then-write.
//
// Versions exist ONLY for Postgres-backed moments (a signed-in rating is never
// written to a Redis-only one any more: the rate POST and the Reset answer 503),
// where a bottle id is the `wines` primary key, so (user, wine) is enough. The
// row has no foreign key to `wines`: bottles are deleted and re-minted, and the
// row must outlive them (the fence for late requests). It cascades with the user.
import type { Prisma } from '@prisma/client'
import type { RatingMeta } from '@/lib/session'

type Db = Prisma.TransactionClient

// The app's op ids: a plain UUID (`uuid.v4()` from expo), never the 21-character
// client id. Postgres's `uuid` type takes any of these spellings.
const OP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isOpId = (v: unknown): v is string => typeof v === 'string' && OP_ID.test(v)
// 0 = no version row (never rated, or rated before this release with no write since).
export const isBaseVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export async function readRatingVersion(tx: Db, userId: number, wineId: string): Promise<{ version: number; lastOpId: string | null }> {
  const rows = await tx.$queryRaw<{ version: number; last_op_id: string | null }[]>`
    SELECT version, last_op_id::text AS last_op_id FROM rating_versions WHERE user_id = ${userId} AND wine_id = ${wineId}`
  return rows[0] ? { version: Number(rows[0].version), lastOpId: rows[0].last_op_id } : { version: 0, lastOpId: null }
}

// One write of one person's rating of one bottle (the rate POST, the Reset, the
// post edit). Returns the new version.
export async function bumpRatingVersion(tx: Db, userId: number, wineId: string, opId: string | null): Promise<number> {
  const rows = await tx.$queryRaw<{ version: number }[]>`
    INSERT INTO rating_versions (user_id, wine_id, version, last_op_id) VALUES (${userId}, ${wineId}, 1, ${opId}::uuid)
    ON CONFLICT (user_id, wine_id) DO UPDATE SET version = rating_versions.version + 1, last_op_id = EXCLUDED.last_op_id
    RETURNING version`
  return Number(rows[0].version)
}

// A wipe that deletes one rater's ratings of a moment (kick or ban with delete,
// a full leave): every bottle they rated there, BEFORE the delete. Otherwise an
// entry that waited offline through the kick and a rejoin would re-create the
// deleted rating on its old version.
export async function bumpRaterVersions(tx: Db, userId: number, sessionId: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO rating_versions (user_id, wine_id, version, last_op_id)
    SELECT DISTINCT ${userId}::int, r.wine_id, 1, NULL::uuid FROM ratings r WHERE r.user_id = ${userId} AND r.session_id = ${sessionId}
    ON CONFLICT (user_id, wine_id) DO UPDATE SET version = rating_versions.version + 1, last_op_id = NULL`
}

// The host's bottle DELETE, before its cascade: every rater of the bottle and
// every version row it already has (the add path can re-insert a supplied id,
// lib/occurrences.ts insertOccurrence, so the fence must move for all of them).
export async function bumpBottleVersions(tx: Db, wineId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO rating_versions (user_id, wine_id, version, last_op_id)
    SELECT s.user_id, ${wineId}, 1, NULL::uuid FROM (
      SELECT r.user_id FROM ratings r WHERE r.wine_id = ${wineId} AND r.user_id IS NOT NULL
      UNION SELECT v.user_id FROM rating_versions v WHERE v.wine_id = ${wineId}) s
    ON CONFLICT (user_id, wine_id) DO UPDATE SET version = rating_versions.version + 1, last_op_id = NULL`
}

// The bottle re-mint (lib/occurrences.ts copyCachedLineup): the ratings of
// `orig` moved to `id` in this transaction, so the raters' version rows are
// COPIED with them (the copied keys' `v` still matches). The old id keeps its
// rows as the fence for late requests addressed to it.
export async function copyRatingVersions(tx: Db, sessionId: number, orig: string, id: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO rating_versions (user_id, wine_id, version, last_op_id)
    SELECT v.user_id, ${id}, v.version, v.last_op_id FROM rating_versions v
     WHERE v.wine_id = ${orig}
       AND v.user_id IN (SELECT r.user_id FROM ratings r WHERE r.session_id = ${sessionId} AND r.wine_id = ${id} AND r.user_id IS NOT NULL)
    ON CONFLICT DO NOTHING`
}

// The canonical rating, the shape of the rating key (`RatingMeta`): what a
// committed merge answers, what the 409 carries, and what the key holds.
export type RatingRowValues = { score: unknown; flavors: unknown; aromas: unknown; notes: string | null }
export function canonicalRating(row: RatingRowValues, at: number, v: number): RatingMeta & { v: number } {
  return {
    score: row.score == null ? 0 : Number(row.score),
    flavors: (row.flavors && typeof row.flavors === 'object' && !Array.isArray(row.flavors) ? row.flavors : {}) as Record<string, number>,
    aromas: Array.isArray(row.aromas) ? row.aromas as RatingMeta['aromas'] : [],
    notes: row.notes ?? '',
    at,
    v,
  }
}

// The caller's stored rating in this moment, canonical, or null (the 409's body).
export async function readCanonicalRating(tx: Db, userId: number, sessionId: number, wineId: string, v: number): Promise<(RatingMeta & { v: number }) | null> {
  const rows = await tx.$queryRaw<(RatingRowValues & { at: Date | null })[]>`
    SELECT score, flavors, aromas, notes, COALESCE(mirror_at, rated_at) AS at
      FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${sessionId} LIMIT 1`
  return rows[0] ? canonicalRating(rows[0], rows[0].at ? rows[0].at.getTime() : 0, v) : null
}
