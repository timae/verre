// Profile images (avatar, profile cover, a tile's own photo): the ONE replace
// protocol, so a replace can never orphan an upload or reclaim bytes a row
// still points at.
//
//   upload (fresh, unique key) → txn { SELECT the current URL FOR UPDATE,
//   UPDATE } → COMMIT → reclaim the captured prior.
//   Zero rows (account deleted) or a failed update → reclaim the fresh upload.
//
// The prior URL is read UNDER the row lock, never before the upload: two
// concurrent replaces serialize on the lock and each reclaims exactly what it
// overwrote. Account deletion captures both columns under the same lock
// (lib/accountDelete.ts), so a replace blocked on it finds no row and reclaims
// its own upload. Keys carry a random suffix: `Date.now()` alone collides.
//
// A TILE column holds either the tile's own upload or a REFERENCE to a photo
// your content shows (lib/profileTiles.ts): only an own upload is ever
// reclaimed, whether a replace, a profile PATCH (another pin or null) or the
// account deletion takes it off the row.

import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import { isOwnTileUpload, tileUploadKeyPrefix, type TileKey } from '@/lib/profileTiles'

// Inlined S3 reclaim, the house workaround (see lib/accountDelete.ts).
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
    console.warn('[s3] profile image reclaim failed:', { key, err })
  }
}

export type ProfileImageKind = 'avatar' | 'cover'

type Field = 'imageUrl' | 'coverPhotoUrl' | 'tileImpressionsUrl' | 'tileMomentsUrl' | 'tileCravingsUrl'
type Column = { sql: Prisma.Sql; field: Field }

const COLUMN: Record<ProfileImageKind, Column> = {
  avatar: { sql: Prisma.raw('image_url'), field: 'imageUrl' },
  cover: { sql: Prisma.raw('cover_photo_url'), field: 'coverPhotoUrl' },
}
export const TILE_COLUMN: Record<TileKey, Column> = {
  impressions: { sql: Prisma.raw('tile_impressions_url'), field: 'tileImpressionsUrl' },
  moments: { sql: Prisma.raw('tile_moments_url'), field: 'tileMomentsUrl' },
  cravings: { sql: Prisma.raw('tile_cravings_url'), field: 'tileCravingsUrl' },
}

const unique = () => `${Date.now()}_${randomBytes(4).toString('hex')}`
// All under the proven public-read `avatars/` prefix.
function keyBase(kind: ProfileImageKind, userId: number): string {
  return kind === 'avatar' ? `avatars/u_${userId}_${unique()}` : `avatars/cover_u_${userId}_${unique()}`
}

export type ReplaceResult =
  | { ok: true; url: string | null }
  | { ok: false; reason: 'upload' | 'gone' }

// dataUrl null = remove. Throws only on an unexpected DB error (its fresh
// upload is reclaimed first).
export async function replaceProfileImage(
  userId: number,
  kind: ProfileImageKind,
  dataUrl: string | null,
): Promise<ReplaceResult> {
  return replaceColumn(userId, COLUMN[kind], dataUrl === null ? null : { key: keyBase(kind, userId), dataUrl }, () => true)
}

// A tile's own photo (POST /api/me/profile/tiles/<tile>): pinned as it
// uploads. The prior is reclaimed only when it was the tile's own upload too.
export async function replaceTilePhoto(userId: number, tile: TileKey, dataUrl: string): Promise<ReplaceResult> {
  return replaceColumn(userId, TILE_COLUMN[tile], { key: `${tileUploadKeyPrefix(tile, userId)}${unique()}`, dataUrl }, prior => isOwnTileUpload(prior, tile, userId))
}

async function replaceColumn(
  userId: number,
  col: Column,
  upload: { key: string; dataUrl: string } | null,
  owns: (prior: string) => boolean,
): Promise<ReplaceResult> {
  let fresh: string | null = null
  if (upload !== null) {
    fresh = (await uploadImage(upload.key, upload.dataUrl).catch(() => '')) || null
    if (!fresh) return { ok: false, reason: 'upload' }
  }
  let prior: string | null = null
  let updated: boolean
  try {
    updated = await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ url: string | null }[]>`
        SELECT ${col.sql} AS url FROM users WHERE id = ${userId} FOR UPDATE`
      if (rows.length === 0) return false
      prior = rows[0].url
      if (prior === fresh) return true
      await tx.user.update({ where: { id: userId }, data: { [col.field]: fresh } })
      return true
    })
  } catch (err) {
    await reclaimImage(fresh)
    throw err
  }
  if (!updated) {
    await reclaimImage(fresh)
    return { ok: false, reason: 'gone' }
  }
  if (prior && prior !== fresh && owns(prior)) await reclaimImage(prior)
  return { ok: true, url: fresh }
}

export type ProfileFields = { name?: string; bio?: string | null } & Partial<Record<'tileImpressionsUrl' | 'tileMomentsUrl' | 'tileCravingsUrl', string | null>>

// The profile PATCH's write: name / bio / tile pins in ONE update. A changed
// tile whose prior value was its own upload has that upload reclaimed after
// COMMIT (the prior read under the row lock, like a replace). The pin is still
// written unconditionally: a re-pick that waited on a dead-pin clear's row
// lock lands after it (lib/profileTiles.ts). false = no such user.
export async function writeProfileFields(userId: number, data: ProfileFields, tiles: readonly TileKey[]): Promise<boolean> {
  const owned: string[] = []
  const found = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Record<TileKey, string | null>[]>`
      SELECT tile_impressions_url AS impressions, tile_moments_url AS moments, tile_cravings_url AS cravings
      FROM users WHERE id = ${userId} FOR UPDATE`
    if (rows.length === 0) return false
    for (const t of tiles) {
      const prior = rows[0][t]
      if (isOwnTileUpload(prior, t, userId) && prior !== data[TILE_COLUMN[t].field as keyof ProfileFields]) owned.push(prior)
    }
    await tx.user.update({ where: { id: userId }, data })
    return true
  })
  for (const u of owned) await reclaimImage(u)
  return found
}
