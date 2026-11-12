// Native profile header extras (the app's "You" profile, step 1) — additive
// fields on the FULL (`ok`) GET /api/users/[id] payload. The web ignores them.
//
// Takes the `ok` gate (REQUIRED, no default — tsc fails a caller that
// forgets), exactly like loadProfile. 🔒 A tile hidden from the viewer is
// ABSENT: no count, no photo, no pin, and its queries never run (Impressions
// follows `sees.posts`, Moments / Cravings the owner's Show switches).

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { blockScrub } from '@/lib/peopleSql'
import { viewableProfiles } from '@/lib/profileVisibility'
import { resolveTilePhotos, TILE_KEYS, type TileKey } from '@/lib/profileTiles'
import type { CheckinVisibility, ProfileGateOk } from '@/lib/profileVisibility'

// `pinned` (own profile only): the photo is the owner's chosen tile cover.
export type ProfileTile = { count: number; imageUrl: string | null; pinned?: boolean }

export type ProfileFace = { id: number; name: string; imageUrl: string | null }

export type ProfileHeaderExtras = {
  // Mutual follows, block-pair scrubbed like the follower/following counts
  // (globally symmetric: the same number for every viewer).
  friendsCount: number
  // The profile's friends the viewer follows (D4; the Friends tab's
  // knownCount). Omitted on your own profile and for an anonymous viewer.
  // Scrubbed against block pairs with BOTH the viewer and the profile owner,
  // so nobody either side blocked can surface here; each face's photo follows
  // that person's own visibility (null when denied).
  inCommon?: { count: number; faces: ProfileFace[] }
  // Only the tiles this viewer may see (an absent key = hidden).
  tiles: Partial<Record<TileKey, ProfileTile>>
  // The owner's Check-Ins Visible To, present ONLY when it hides the posts
  // from this viewer (never on your own profile): the app's "Follow Lena to
  // see posts" line. The one sanctioned output of the gate's settings.
  checkinsAudience?: CheckinVisibility
}

const FACES = 3
// Faces are gated (each person's own visibility) and then sorted on the
// VISIBLE photo, from the newest FACE_POOL.
const FACE_POOL = 12

// `impressionsCount` is only read when the Impressions tile is shown.
export async function loadProfileHeaderExtras(
  profileId: number,
  gate: ProfileGateOk,
  impressionsCount: number,
): Promise<ProfileHeaderExtras> {
  const viewerId = gate.viewer.id
  const own = viewerId !== null && viewerId === profileId
  // The viewer, when in common applies (logged in, someone else's profile).
  const inCommonViewer = viewerId !== null && !own ? viewerId : null
  const shown = TILE_KEYS.filter(k => (k === 'impressions' ? gate.sees.posts : gate.sees[k]))
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
    // In common (D4): the profile's friends the VIEWER follows, block-scrubbed
    // like the People lists (lib/peopleSql.ts), so `count` == the Friends
    // tab's `knownCount`. Pick by id only: a photo-first ORDER BY on the raw
    // column would choose by photos the gate may hide.
    inCommonViewer !== null
      ? prisma.$queryRaw<{ id: number; name: string; image_url: string | null; total: number }[]>`
          SELECT u.id, u.name, u.image_url, COUNT(*) OVER ()::int AS total
          FROM follows f1
          JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
          JOIN follows fv ON fv.follower_id = ${inCommonViewer} AND fv.following_id = f1.following_id
          JOIN users u ON u.id = f1.following_id
          WHERE f1.follower_id = ${profileId}
            AND ${blockScrub(profileId, inCommonViewer, Prisma.raw('u.id'))}
          ORDER BY u.id DESC
          LIMIT ${FACE_POOL}
        `
      : Promise.resolve(null),
    // Current memberships (the Moments-tab predicate: live moment, not
    // kicked), NOT the monotonic lifetime counter.
    gate.sees.moments
      ? prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM session_members sm
          JOIN sessions s ON s.code = sm.session_code
          WHERE sm.user_id = ${profileId} AND s.deleted_at IS NULL
            AND sm.removed_state IS DISTINCT FROM 'kicked'
        `
      : Promise.resolve(null),
    gate.sees.cravings ? prisma.bookmark.count({ where: { userId: profileId } }) : Promise.resolve(null),
    // Photos only (pins + the automatic latest): lib/profileTiles.ts. The
    // counts above never depend on photo eligibility.
    resolveTilePhotos(profileId, shown),
  ])
  const count: Record<TileKey, number> = { impressions: impressionsCount, moments: moments?.[0]?.n ?? 0, cravings: cravings ?? 0 }
  const tiles: ProfileHeaderExtras['tiles'] = Object.fromEntries(shown.flatMap(k => {
    const p = photos[k]
    return p ? [[k, tile(count[k], p)]] : []
  }))

  let inCommon: ProfileHeaderExtras['inCommon']
  if (inCommonRows && inCommonViewer !== null) {
    const { admitted } = await viewableProfiles(inCommonViewer, inCommonRows.map(r => r.id))
    const faces = inCommonRows.map(r => ({ id: r.id, name: r.name, imageUrl: admitted.has(r.id) ? r.image_url : null }))
    faces.sort((a, b) => Number(a.imageUrl === null) - Number(b.imageUrl === null))
    inCommon = { count: inCommonRows[0]?.total ?? 0, faces: faces.slice(0, FACES) }
  }

  return {
    friendsCount: friends[0]?.n ?? 0,
    ...(inCommon ? { inCommon } : {}),
    tiles,
    ...(gate.sees.posts ? {} : { checkinsAudience: gate.settings.checkinVisibility ?? 'only-me' }),
  }
}
