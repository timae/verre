// Profile images (avatar + profile cover): the ONE replace protocol, so a
// replace can never orphan an upload or reclaim bytes a row still points at.
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

import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'

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

const COLUMN: Record<ProfileImageKind, { sql: Prisma.Sql; field: 'imageUrl' | 'coverPhotoUrl' }> = {
  avatar: { sql: Prisma.raw('image_url'), field: 'imageUrl' },
  cover: { sql: Prisma.raw('cover_photo_url'), field: 'coverPhotoUrl' },
}

// Both under the proven public-read `avatars/` prefix.
function keyBase(kind: ProfileImageKind, userId: number): string {
  const unique = `${Date.now()}_${randomBytes(4).toString('hex')}`
  return kind === 'avatar' ? `avatars/u_${userId}_${unique}` : `avatars/cover_u_${userId}_${unique}`
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
  const col = COLUMN[kind]
  let fresh: string | null = null
  if (dataUrl !== null) {
    fresh = (await uploadImage(keyBase(kind, userId), dataUrl).catch(() => '')) || null
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
  if (prior && prior !== fresh) await reclaimImage(prior)
  return { ok: true, url: fresh }
}
