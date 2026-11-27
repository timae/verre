import { randomBytes } from 'node:crypto'

// 🔒 Public-read image KEYS carry nothing that points to a person (D2,
// public-user-ids § 8): a kind marker and a cryptographic random part, no
// user id (integer or public), no timestamp. lib/s3.ts uploadImage appends
// the extension. Ownership is never read from a key: a tile's own photo is
// `users.tile_*_own_url` (lib/profileTiles.ts isOwnTile).
export type ImageKind = 'avatar' | 'cover' | 'tile_impressions' | 'tile_moments' | 'tile_cravings' | 'checkin' | 'occurrence'

const PREFIX: Record<ImageKind, string> = {
  avatar: 'avatars/avatar_',
  cover: 'avatars/cover_',
  tile_impressions: 'avatars/tile_impressions_',
  tile_moments: 'avatars/tile_moments_',
  tile_cravings: 'avatars/tile_cravings_',
  checkin: 'wines/ci_',
  // A moment bottle's photo (the occurrence image call): a fresh key per upload,
  // so a refused write never overwrites bytes the bottle references.
  occurrence: 'wines/oc_',
}

export function imageKey(kind: ImageKind): string {
  return `${PREFIX[kind]}${randomBytes(16).toString('hex')}`
}
