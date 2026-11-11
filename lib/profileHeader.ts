// Native profile header extras (the app's "You" profile, step 1) — additive
// fields on the FULL (`ok`) GET /api/users/[id] payload. The web ignores them.
//
// Visibility gating is the caller's responsibility, exactly like loadProfile:
// only a `gate.status === 'ok'` viewer may reach this loader.

import { prisma } from '@/lib/prisma'
import { resolveTilePhotos } from '@/lib/profileTiles'

// `pinned` (own profile only): the photo is the owner's chosen tile cover.
export type ProfileTile = { count: number; imageUrl: string | null; pinned?: boolean }

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

export async function loadProfileHeaderExtras(
  profileId: number,
  viewerId: number | null,
  impressionsCount: number,
): Promise<ProfileHeaderExtras> {
  const withInCommon = viewerId !== null && viewerId !== profileId
  const own = viewerId !== null && viewerId === profileId
  const tile = (count: number, p: { imageUrl: string | null; pinned: boolean }): ProfileTile =>
    own ? { count, imageUrl: p.imageUrl, pinned: p.pinned } : { count, imageUrl: p.imageUrl }
  const [friends, inCommonRows, moments, cravings, photos] = await Promise.all([
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
    // Current memberships (the Moments-tab predicate: live moment, not
    // kicked), NOT the monotonic lifetime counter.
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM session_members sm
      JOIN sessions s ON s.code = sm.session_code
      WHERE sm.user_id = ${profileId} AND s.deleted_at IS NULL
        AND sm.removed_state IS DISTINCT FROM 'kicked'
    `,
    prisma.bookmark.count({ where: { userId: profileId } }),
    // Photos only (pins + the automatic latest): lib/profileTiles.ts. The
    // counts above never depend on photo eligibility.
    resolveTilePhotos(profileId),
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
      impressions: tile(impressionsCount, photos.impressions),
      moments: tile(moments[0]?.n ?? 0, photos.moments),
      cravings: tile(cravings, photos.cravings),
    },
  }
}
