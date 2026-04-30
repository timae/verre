import crypto from 'crypto'
import { redis, k, TTL, touch } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'

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
  blind?: boolean
  lifespan?: string
  coHosts?: string[]
  address?: string
  dateFrom?: string | null
  dateTo?: string | null
  timezone?: string
  description?: string
  link?: string
  hideLineup?: boolean
  hideLineupMinutesBefore?: number
}

export function genCode(): string {
  return crypto.randomBytes(2).toString('hex').toUpperCase()
}

export async function getSessionMeta(code: string): Promise<SessionMeta | null> {
  const raw = await redis.get(k.meta(code))
  return raw ? JSON.parse(raw) : null
}

export async function getWines(code: string): Promise<WineMeta[]> {
  const raw = await redis.get(k.wines(code))
  return raw ? JSON.parse(raw) : []
}

export function isHost(meta: SessionMeta & { coHosts?: string[] }, userId?: string, userName?: string): boolean {
  // Host slot: when the session was created by a logged-in user, require a
  // matching userId from the auth session — do not fall back to userName,
  // since clients can put any name in the request body.
  if (meta.hostUserId) {
    if (userId && String(meta.hostUserId) === userId) return true
  } else {
    // Anonymous-hosted session: userName is the only identity available.
    if (userName && userName === meta.host) return true
  }
  // Co-hosts are still tracked as display-name strings (Phase 2 will move
  // them to ids). Treated as a soft check until then.
  if (userName && meta.coHosts?.includes(userName)) return true
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

  // Upload to S3 if new base64 image provided
  if (image && image.startsWith('data:image/')) {
    try {
      const id = existing?.id || Date.now().toString()
      const url = await uploadImage(id, image)
      if (url) { imageUrl = url; image = '' }
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

export { touch, TTL, k, redis }
