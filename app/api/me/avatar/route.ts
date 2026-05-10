import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'

// Inlined S3 reclaim — same workaround as app/api/checkins/[id]/route.ts.
// Adding a third export to lib/s3.ts silently drops it during Next/webpack
// bundling, so each route that needs delete-by-URL keeps its own copy.
const ENDPOINT = process.env.S3_ENDPOINT
const BUCKET = process.env.S3_BUCKET
const s3 = ENDPOINT
  ? new S3Client({
      endpoint: ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!s3 || !BUCKET || !url || !ENDPOINT) return
  const prefix = `${ENDPOINT}/${BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] avatar reclaim failed:', { key, err })
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:avatar:${userId}:1h`, 10, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many uploads. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { imageData } = body as { imageData?: unknown }
  if (typeof imageData !== 'string' || imageData.length > MAX_IMAGE_DATA_URL_BYTES) {
    return NextResponse.json({ error: 'image too large' }, { status: 400 })
  }

  // Resolve the prior URL up-front so we can reclaim it after the
  // replacement upload succeeds. Keep it in scope through the catch.
  const prior = await prisma.user.findUnique({ where: { id: userId }, select: { imageUrl: true } })
  const priorUrl = prior?.imageUrl ?? null

  const keyBase = `avatars/u_${userId}_${Date.now()}`
  const newUrl = await uploadImage(keyBase, imageData).catch(() => null)
  if (!newUrl) return NextResponse.json({ error: 'upload failed' }, { status: 500 })

  await prisma.user.update({ where: { id: userId }, data: { imageUrl: newUrl } })

  // Replace successful — reclaim the old object if it was different.
  // Fire-and-forget so a transient S3 error doesn't fail the response.
  if (priorUrl && priorUrl !== newUrl) reclaimImage(priorUrl).catch(() => {})

  return NextResponse.json({ imageUrl: newUrl })
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const prior = await prisma.user.findUnique({ where: { id: userId }, select: { imageUrl: true } })
  const priorUrl = prior?.imageUrl ?? null
  if (!priorUrl) return NextResponse.json({ ok: true })

  await prisma.user.update({ where: { id: userId }, data: { imageUrl: null } })
  reclaimImage(priorUrl).catch(() => {})
  return NextResponse.json({ ok: true })
}
