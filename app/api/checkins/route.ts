import { NextRequest, NextResponse } from 'next/server'
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage } from '@/lib/s3'
import { validateScore, validateFlavors } from '@/lib/checkinValidation'

// Inlined S3 copy — adding a third named export to lib/s3.ts trips a Next
// 15.5 / webpack 5.98 bundling bug (see lib/accountDelete.ts for the same
// pattern). Keep this here until that's fixed upstream.
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

// Server-side S3 copy for the "had a sip" flow. Caller passes a source
// check-in id (already authorized to view that row), we resolve its stored
// imageUrl and clone the bytes into a fresh user-owned key. The image URL
// itself is never trusted from the client. Returns the new URL on success,
// null on any failure (missing source, gone object, S3 error).
async function copyImageFromCheckin(sourceUrl: string, userId: number): Promise<string | null> {
  if (!_s3 || !_S3_BUCKET || !_S3_ENDPOINT) return null
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!sourceUrl.startsWith(prefix)) return null
  const sourceKey = sourceUrl.slice(prefix.length)
  // Whitelist key shape — legitimate keys never contain reserved chars, so
  // anything unusual is rejected before we hand it to S3.
  if (!/^wines\/[A-Za-z0-9_.\-]+$/.test(sourceKey)) return null
  const ext = sourceKey.split('.').pop() || 'jpg'
  const newKey = `wines/ci_${userId}_${Date.now()}.${ext}`
  try {
    await _s3.send(new CopyObjectCommand({
      Bucket: _S3_BUCKET,
      CopySource: `/${_S3_BUCKET}/${sourceKey}`,
      Key: newKey,
    }))
    return `${_S3_ENDPOINT}/${_S3_BUCKET}/${newKey}`
  } catch (err) {
    console.warn('[s3] copyImageFromCheckin failed:', { sourceKey, newKey, err })
    return null
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-ins. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const body = await req.json()
  const { wineName, producer, vintage, grape, type, score, flavors, notes, imageData, copyFromCheckinId, venueName, city, country, lat, lng, isPublic, taggedUserIds = [] } = body
  if (!wineName?.trim()) return NextResponse.json({ error: 'wine name required' }, { status: 400 })
  const scoreCheck = validateScore(score); if (scoreCheck.error) return NextResponse.json({ error: scoreCheck.error }, { status: 400 })
  const flavorsCheck = validateFlavors(flavors); if (flavorsCheck.error) return NextResponse.json({ error: flavorsCheck.error }, { status: 400 })

  let imageUrl: string | null = null
  if (imageData?.startsWith('data:image/')) {
    const tempId = `ci_${userId}_${Date.now()}`
    imageUrl = await uploadImage(tempId, imageData).catch(() => null)
  } else if (Number.isInteger(copyFromCheckinId) && copyFromCheckinId > 0 && copyFromCheckinId <= 2_147_483_647) {
    // "had a sip" flow: resolve the source row server-side, verify the
    // caller is allowed to copy it, then clone the bytes. The client never
    // gets to point at an arbitrary S3 URL.
    const source = await prisma.checkin.findUnique({
      where: { id: copyFromCheckinId },
      select: { imageUrl: true, isPublic: true, userId: true },
    })
    if (!source || !source.isPublic) {
      return NextResponse.json({ error: 'Source check-in is no longer available.' }, { status: 400 })
    }
    if (source.userId === userId) {
      return NextResponse.json({ error: 'Cannot copy your own check-in.' }, { status: 400 })
    }
    const follows = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: source.userId } },
      select: { followerId: true },
    })
    if (!follows) {
      return NextResponse.json({ error: 'Follow this user to copy their check-ins.' }, { status: 403 })
    }
    if (source.imageUrl) {
      imageUrl = await copyImageFromCheckin(source.imageUrl, userId)
      if (!imageUrl) return NextResponse.json({ error: 'Source image is no longer available. Replace or remove it before posting.' }, { status: 400 })
    }
  }

  const checkin = await prisma.checkin.create({
    data: {
      userId,
      wineName: wineName.trim(),
      producer: producer?.trim() || null,
      vintage: vintage?.trim().slice(0, 4) || null,
      grape: grape?.trim() || null,
      type: type || null,
      score: scoreCheck.value,
      flavors: flavorsCheck.value,
      notes: notes?.trim() || null,
      imageUrl,
      venueName: venueName?.trim() || null,
      city: city?.trim() || null,
      country: country?.trim().slice(0, 2).toUpperCase() || null,
      lat: lat ?? null,
      lng: lng ?? null,
      isPublic: isPublic !== false,
    },
  })

  // Save tags — only mutual follows (verify server-side)
  if (Array.isArray(taggedUserIds) && taggedUserIds.length > 0) {
    const mutuals = await prisma.$queryRaw<{ id: number }[]>`
      SELECT f1.following_id AS id
      FROM follows f1
      JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
      WHERE f1.follower_id = ${userId} AND f1.following_id = ANY(${taggedUserIds}::integer[])
    `
    const validIds = mutuals.map(m => m.id)
    if (validIds.length > 0) {
      await prisma.checkinTag.createMany({
        data: validIds.map(uid => ({ checkinId: checkin.id, userId: uid })),
        skipDuplicates: true,
      })
    }
  }

  return NextResponse.json(checkin, { status: 201 })
}
