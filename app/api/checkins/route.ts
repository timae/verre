import { NextRequest, NextResponse } from 'next/server'
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { validateScore, validateFlavors } from '@/lib/checkinValidation'
import { isSameOrigin } from '@/lib/csrf'
import { scrub } from '@/lib/textSafe'
import { decimalToNumber } from '@/lib/decimal'
import { viewerCanSeeAuthor } from '@/lib/profileVisibility'

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
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-ins. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineName: rawWineName, producer, vintage, grape, type, score, flavors, notes, imageData, copyFromCheckinId, venueName, city, country, lat, lng, taggedUserIds = [] } = body
  // Scrub control chars first so a payload of pure NULL bytes doesn't
  // pass the non-empty check below.
  const wineName = scrub(rawWineName)
  if (!wineName) return NextResponse.json({ error: 'wine name required' }, { status: 400 })
  // Per-field length caps mirror the column widths in `prisma/schema.prisma`
  // for the Checkin model. Reject oversize input here so we return a
  // clean 400 instead of letting Prisma raise P2000 (which we'd surface
  // as 500). Free-text `notes` has no DB cap; bound it conservatively.
  // Caps mirror the Prisma column widths to reject oversize input
  // here as 400 instead of letting Prisma raise P2000 (→ 500).
  // city: VarChar(100), country: Char(2) (sliced to 2 below).
  const lenCheck: Array<[string, unknown, number]> = [
    ['wineName', rawWineName, 200], ['producer', producer, 200], ['vintage', vintage, 8],
    ['grape', grape, 200], ['type', type, 32],
    ['venueName', venueName, 200], ['city', city, 100], ['country', country, 8],
    ['notes', notes, 4000],
  ]
  for (const [k, v, max] of lenCheck) {
    if (typeof v === 'string' && v.length > max) return NextResponse.json({ error: `${k} too long (max ${max})` }, { status: 400 })
  }
  const scoreCheck = validateScore(score); if (scoreCheck.error) return NextResponse.json({ error: scoreCheck.error }, { status: 400 })
  const flavorsCheck = validateFlavors(flavors); if (flavorsCheck.error) return NextResponse.json({ error: flavorsCheck.error }, { status: 400 })

  let imageUrl: string | null = null
  if (imageData?.startsWith('data:image/')) {
    // Reject the data URL up front if it's bigger than ~3MB encoded
    // (~2MB decoded, which uploadImage caps to). Avoids spending bcrypt-
    // grade CPU base64-decoding a 50MB blob just to throw it away.
    if (typeof imageData !== 'string' || imageData.length > MAX_IMAGE_DATA_URL_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 400 })
    }
    const keyBase = `wines/ci_${userId}_${Date.now()}`
    imageUrl = await uploadImage(keyBase, imageData).catch(() => null)
  } else if (Number.isInteger(copyFromCheckinId) && copyFromCheckinId > 0 && copyFromCheckinId <= 2_147_483_647) {
    // "had a sip" flow: resolve the source row server-side, verify the
    // caller is allowed to copy it, then clone the bytes. The client never
    // gets to point at an arbitrary S3 URL.
    //
    // Two gates, both required: (a) viewer can see the author's content
    // per their profile-visibility tier — copying content the viewer
    // shouldn't see at all is the obvious leak. (b) viewer follows the
    // author — the explicit consent gate, beyond visibility, since
    // copying a bottle photo is a stronger relationship than just
    // browsing.
    //
    // All negative branches collapse to a single generic 400 message so
    // the endpoint can't be used to enumerate per-id existence /
    // ownership / follow-state. Distinct messages would let any authed
    // user probe ids and learn which ones exist, who owns them, and who
    // they follow.
    const COPY_ERROR = 'This check-in cannot be copied right now.'
    const source = await prisma.checkin.findUnique({
      where: { id: copyFromCheckinId },
      select: { imageUrl: true, userId: true },
    })
    if (!source) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    if (source.userId === userId) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    if (!(await viewerCanSeeAuthor(userId, source.userId))) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    const follows = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: source.userId } },
      select: { followerId: true },
    })
    if (!follows) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    if (source.imageUrl) {
      imageUrl = await copyImageFromCheckin(source.imageUrl, userId)
      if (!imageUrl) return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
  }

  const checkin = await prisma.checkin.create({
    data: {
      userId,
      // wineName scrubbed earlier; remaining free-text run through
      // scrub() so NULL bytes don't cause P22021 from Postgres TEXT.
      wineName,
      producer: scrub(producer),
      vintage: scrub(vintage)?.slice(0, 4) || null,
      grape: scrub(grape),
      type: type || null,
      score: scoreCheck.value,
      flavors: flavorsCheck.value,
      notes: scrub(notes),
      imageUrl,
      venueName: scrub(venueName),
      city: scrub(city),
      country: scrub(country)?.slice(0, 2).toUpperCase() || null,
      lat: lat ?? null,
      lng: lng ?? null,
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

  return NextResponse.json({ ...checkin, score: decimalToNumber(checkin.score) }, { status: 201 })
}
