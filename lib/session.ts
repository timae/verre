import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import type { Identity } from '@/lib/identity'
import { userIdentityId } from '@/lib/identity'

// Inlined S3 reclaim — see app/api/checkins/[id]/route.ts for the same
// helper and the bundler-bug rationale.
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

export type WineMeta = {
  id: string
  name: string
  producer: string
  vintage: string
  grape: string
  type: string
  image: string
  imageUrl: string
  revealedAt?: string | null
}

export type RatingMeta = {
  score: number
  flavors: Record<string, number>
  notes: string
  at: number
}

export type SessionMeta = {
  host: string
  name: string
  createdAt: number
  hostUserId: number | null
  // Identity id of the host. `u:<userId>` for logged-in hosts (redundant with
  // hostUserId), `a:<uuid>` for anonymous hosts (the only stable handle).
  hostIdentityId?: string
  blind?: boolean
  lifespan?: string
  coHostIds?: string[]
  address?: string
  dateFrom?: string | null
  dateTo?: string | null
  timezone?: string
  description?: string
  link?: string
  hideLineup?: boolean
  hideLineupMinutesBefore?: number
}

export { genCode } from '@/lib/sessionCode'

export async function getSessionMeta(code: string): Promise<SessionMeta | null> {
  const raw = await redis.get(k.meta(code))
  return raw ? JSON.parse(raw) : null
}

export async function getWines(code: string): Promise<WineMeta[]> {
  const raw = await redis.get(k.wines(code))
  return raw ? JSON.parse(raw) : []
}

// Host check by stable identity id. Returns true for the strict host AND
// for any cohost — both are allowed to do host-equivalent actions like
// editing wines and settings. Strict-host-only actions (cohost role
// assignment, session delete) check hostIdentityId / hostUserId directly.
export function isHostByIdentity(meta: SessionMeta, identity: Identity | null): boolean {
  if (!identity) return false
  if (meta.hostIdentityId && identity.id === meta.hostIdentityId) return true
  if (meta.hostUserId && identity.id === userIdentityId(meta.hostUserId)) return true
  if (meta.coHostIds?.includes(identity.id)) return true
  return false
}


export function sanitizeImage(value: unknown): string {
  if (!value || typeof value !== 'string') return ''
  if (!value.startsWith('data:image/')) return ''
  if (value.length > 1_500_000) return ''
  return value
}

export async function addWineToSession(
  code: string,
  body: Partial<WineMeta>,
  existing?: WineMeta,
): Promise<WineMeta | { error: string }> {
  const name = String(body.name || '').trim()
  const type = String(body.type || '').trim()
  if (!name) return { error: 'name required' }
  if (!['red', 'white', 'spark', 'rose', 'nonalc'].includes(type)) return { error: 'valid type required' }

  let imageUrl = existing?.imageUrl || ''
  let image = body.image === undefined
    ? (existing?.image || '')
    : sanitizeImage(body.image)

  // Upload to S3 if new base64 image provided. uploadImage keys by wine id,
  // so a same-extension replace overwrites in place. If the new image has
  // a different extension the old key would be orphaned — handle that by
  // deleting the previous URL only after the new upload succeeds. This
  // upload-first-then-cleanup ordering is failure-safe: if the new upload
  // throws or returns empty, the old image stays referenced and accessible.
  if (image && image.startsWith('data:image/')) {
    try {
      const id = existing?.id || Date.now().toString()
      const url = await uploadImage(id, image)
      if (url) {
        if (existing?.imageUrl && existing.imageUrl !== url) {
          reclaimImage(existing.imageUrl)
        }
        imageUrl = url
        image = ''
      }
    } catch {}
  }

  return {
    id: existing?.id || Date.now().toString(),
    name,
    producer: String(body.producer || '').trim(),
    vintage: String(body.vintage || '').trim().slice(0, 4),
    grape: String(body.grape || '').trim(),
    type,
    image,
    imageUrl,
  }
}

export async function pgUpsertSession(code: string, meta: SessionMeta) {
  await prisma.session.upsert({
    where: { code },
    create: {
      code,
      hostName: meta.host,
      hostUserId: meta.hostUserId,
      name: meta.name || null,
      createdAt: new Date(meta.createdAt),
    },
    update: { name: meta.name || undefined },
  })
}

export async function pgUpsertWine(sessionCode: string, wine: WineMeta) {
  const session = await prisma.session.findUnique({ where: { code: sessionCode } })
  if (!session) return
  await prisma.wine.upsert({
    where: { id: wine.id },
    create: {
      id: wine.id,
      sessionId: session.id,
      name: wine.name,
      producer: wine.producer || null,
      vintage: wine.vintage || null,
      grape: wine.grape || null,
      style: wine.type || null,
      imageUrl: wine.imageUrl || null,
    },
    update: {
      name: wine.name,
      producer: wine.producer || null,
      vintage: wine.vintage || null,
      grape: wine.grape || null,
      style: wine.type || null,
      imageUrl: wine.imageUrl || undefined,
    },
  })
}
