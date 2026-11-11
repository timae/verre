import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { replaceProfileImage } from '@/lib/profileImage'

// Upload / replace / remove go through the shared replace protocol
// (lib/profileImage.ts): prior URL read under the row lock, reclaimed after
// commit; a failed update reclaims its own upload.
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
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

  const r = await replaceProfileImage(userId, 'avatar', imageData)
  if (!r.ok) return r.reason === 'gone'
    ? NextResponse.json({ error: 'user not found' }, { status: 404 })
    : NextResponse.json({ error: 'upload failed' }, { status: 500 })
  return NextResponse.json({ imageUrl: r.url })
}

// Uncapped: it reclaims S3 rather than consuming it.
export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  await replaceProfileImage(Number(session.user.id), 'avatar', null)
  return NextResponse.json({ ok: true })
}
