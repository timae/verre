// Native profile header extras (the app's "You" profile, step 1) — additive
// fields on the FULL (`ok`) GET /api/users/[id] payload. The web ignores them.
//
// Visibility gating is the caller's responsibility, exactly like loadProfile:
// only a `gate.status === 'ok'` viewer may reach this loader.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type ProfileTile = { count: number; imageUrl: string | null }

export type ProfileFace = { id: number; name: string; imageUrl: string | null }

export type ProfileHeaderExtras = {
  // Mutual follows, block-pair scrubbed like the follower/following counts
  // (globally symmetric: the same number for every viewer).
  friendsCount: number
  // Viewer's friends ∩ profile's friends. Omitted on your own profile and for
  // an anonymous viewer. Scrubbed against block pairs with BOTH the viewer and
  // the profile owner, so nobody either side blocked can surface here.
  inCommon?: { count: number; faces: ProfileFace[] }
  tiles: { impressions: ProfileTile; moments: ProfileTile; cravings: ProfileTile }
}

const FACES = 3

// 🔒 A tile photo must never leak an unrevealed blind wine. This is the SAFE
// SUBSET of the feed's redaction rule (lib/sessionFeedWines.ts): standalone,
// not blind, revealed, or a tombstoned moment. It deliberately skips the
// feed's host / wine-adder bypasses and the over-by-its-dates auto-reveal —
// over-redacting a tile photo costs nothing, a leaked label costs the tasting.
// Aliases: `w` = wines, `s` = sessions (LEFT JOINed on the wine's or rating's
// session).
const SAFE_PHOTO = Prisma.sql`(s.id IS NULL OR s.deleted_at IS NOT NULL OR s.blind IS NOT TRUE OR w.revealed_at IS NOT NULL)`

export async function loadProfileHeaderExtras(
  profileId: number,
  viewerId: number | null,
  impressionsCount: number,
): Promise<ProfileHeaderExtras> {
  const withInCommon = viewerId !== null && viewerId !== profileId
  const [friends, inCommonRows, impressionPhoto, moments, cravings] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM follows f1
      JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
      WHERE f1.follower_id = ${profileId}
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${profileId} AND b.blocked_id = f1.following_id)
             OR (b.blocker_id = f1.following_id AND b.blocked_id = ${profileId})
        )
    `,
    withInCommon
      ? prisma.$queryRaw<{ id: number; name: string; image_url: string | null; total: number }[]>`
          WITH pf AS (
            SELECT f1.following_id AS id FROM follows f1
            JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
            WHERE f1.follower_id = ${profileId}
          ), vf AS (
            SELECT f1.following_id AS id FROM follows f1
            JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
            WHERE f1.follower_id = ${viewerId}
          )
          SELECT u.id, u.name, u.image_url, COUNT(*) OVER ()::int AS total
          FROM pf
          JOIN vf ON vf.id = pf.id
          JOIN users u ON u.id = pf.id
          WHERE NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id IN (${profileId}::integer, ${viewerId}::integer) AND b.blocked_id = u.id)
               OR (b.blocked_id IN (${profileId}::integer, ${viewerId}::integer) AND b.blocker_id = u.id)
          )
          ORDER BY (u.image_url IS NULL), u.id DESC
          LIMIT ${FACES}
        `
      : Promise.resolve(null),
    // Latest impression photo: the rating's own first photo, else the wine's
    // (the feed card's image priority).
    prisma.$queryRaw<{ image_url: string }[]>`
      SELECT COALESCE(ri.image_url, w.image_url) AS image_url
      FROM ratings r
      JOIN wines w ON w.id = r.wine_id
      LEFT JOIN sessions s ON s.id = r.session_id
      LEFT JOIN LATERAL (
        SELECT image_url FROM rating_images WHERE rating_id = r.id ORDER BY sort_order ASC LIMIT 1
      ) ri ON true
      WHERE r.user_id = ${profileId}
        AND COALESCE(ri.image_url, w.image_url) IS NOT NULL
        AND ${SAFE_PHOTO}
      ORDER BY r.rated_at DESC
      LIMIT 1
    `,
    // Current memberships (the Moments-tab predicate: live moment, not
    // kicked), NOT the monotonic lifetime counter. Photo = the latest joined
    // moment that has a cover (a cover brands the moment; it is never
    // blind-redacted — schema note on sessions.cover_photo_url).
    prisma.$queryRaw<{ total: number; cover_photo_url: string | null }[]>`
      SELECT COUNT(*) OVER ()::int AS total, s.cover_photo_url
      FROM session_members sm
      JOIN sessions s ON s.code = sm.session_code
      WHERE sm.user_id = ${profileId} AND s.deleted_at IS NULL
        AND sm.removed_state IS DISTINCT FROM 'kicked'
      ORDER BY (s.cover_photo_url IS NULL), sm.joined_at DESC
      LIMIT 1
    `,
    // Bookmarks. Photo = the latest bookmarked wine whose photo is safe.
    prisma.$queryRaw<{ total: number; image_url: string | null }[]>`
      SELECT COUNT(*) OVER ()::int AS total,
             CASE WHEN ${SAFE_PHOTO} THEN w.image_url END AS image_url
      FROM bookmarks b
      JOIN wines w ON w.id = b.wine_id
      LEFT JOIN sessions s ON s.id = w.session_id
      WHERE b.user_id = ${profileId}
      ORDER BY (CASE WHEN ${SAFE_PHOTO} THEN w.image_url END) IS NULL, b.saved_at DESC
      LIMIT 1
    `,
  ])

  return {
    friendsCount: friends[0]?.n ?? 0,
    ...(inCommonRows
      ? {
          inCommon: {
            count: inCommonRows[0]?.total ?? 0,
            faces: inCommonRows.map(r => ({ id: r.id, name: r.name, imageUrl: r.image_url })),
          },
        }
      : {}),
    tiles: {
      impressions: { count: impressionsCount, imageUrl: impressionPhoto[0]?.image_url ?? null },
      moments: { count: moments[0]?.total ?? 0, imageUrl: moments[0]?.cover_photo_url ?? null },
      cravings: { count: cravings[0]?.total ?? 0, imageUrl: cravings[0]?.image_url ?? null },
    },
  }
}
