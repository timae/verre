import { NextRequest, NextResponse } from 'next/server'
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { validateFlavors } from '@/lib/checkinValidation'
import { validateScore, decimalToNumber } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { scrub } from '@/lib/textSafe'
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

// Local S3 reclaim used when the txn fails after a successful upload.
// Duplicated across [id]/route.ts, accountDelete.ts, session.ts, avatar
// route — extraction to lib/s3reclaim.ts captured in .local/future-work.
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
    // "had a sip" flow: resolve the source server-side, verify the caller
    // is allowed to copy it, then clone the bytes. The client never gets
    // to point at an arbitrary S3 URL.
    //
    // Post-rewire, `copyFromCheckinId` resolves to a `feed_items.id` of
    // kind='standalone' (the field name is preserved for client/URL
    // compatibility; semantics shift per rewire.md §5). The migration
    // backfills feed_items.id = source.checkins.id, so cached client links
    // (e.g. notification deep-links into "had a sip") continue to resolve.
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
    // ownership / follow-state.
    const COPY_ERROR = 'This check-in cannot be copied right now.'
    const source = await prisma.feedItem.findUnique({
      where: { id: copyFromCheckinId },
      select: {
        userId: true,
        kind: true,
        rating: {
          select: {
            wine: { select: { imageUrl: true } },
            images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
          },
        },
      },
    })
    if (!source || source.kind !== 'standalone' || !source.rating) {
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
    // Source image priority: the rating's first attached image if present
    // (the user's tasting photo), else the wine's canonical bottle shot.
    const sourceImageUrl = source.rating.images[0]?.imageUrl || source.rating.wine.imageUrl
    if (sourceImageUrl) {
      imageUrl = await copyImageFromCheckin(sourceImageUrl, userId)
      if (!imageUrl) return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
  }

  // Build the new-model writes. Path B per rewire.md §5: fresh wine +
  // rating + feed_item + rating_images. No shared catalog identity (the
  // no-dedup non-goal applies to "had a sip" too). When real dedup ships
  // later, this becomes smarter — until then every standalone POST mints
  // its own wines row.
  //
  // Identifiers:
  //   - wines.id: standard 21-char nanoid (phase 1 widened the column).
  //   - feed_items.id: autoincrement; the migration preserves
  //     `feed_items.id = source.checkins.id` for backfilled rows, so the
  //     "had a sip" copyFromCheckinId id-equality story is preserved.
  //     New rows just get the next sequence value (no special handling).
  //   - ratings.id: autoincrement.
  const wineId = nanoid()
  const scrubVintage = scrub(vintage)?.slice(0, 4) || null
  const scrubProducer = scrub(producer) || null
  const scrubGrape = scrub(grape) || null
  // Validate `type` against the seeded category_styles values. The
  // composite FK wines (category, style) → category_styles rejects any
  // unrecognized value; coerce unknowns to NULL so a stale client (or
  // a hostile body) doesn't 500 the endpoint inside the txn. NULL
  // bypasses the FK (Postgres composite FK with any NULL component
  // skips validation), which is fine here — "unknown style" is a real
  // state for an old import or a beer/spirit that hasn't been seeded yet.
  const VALID_STYLES = new Set(['red', 'white', 'spark', 'rose', 'nonalc'])
  const wineStyle = typeof type === 'string' && VALID_STYLES.has(type) ? type : null
  const scrubNotes = scrub(notes) || null
  const scrubVenue = scrub(venueName) || null
  const scrubCity = scrub(city) || null
  const scrubCountry = scrub(country)?.slice(0, 2).toUpperCase() || null
  const ratingScore = scoreCheck.value
  const ratingFlavors = flavorsCheck.value ?? {}

  // locationPublic = true iff any location field is non-null (per
  // rewire.md §5: "true if any location field is non-NULL else false").
  // Public/private session location toggle UI is post-rewire; this is the
  // default for standalone check-ins, where the user supplied the venue.
  const hasLocation = !!(scrubVenue || scrubCity || scrubCountry || lat != null || lng != null)

  // Sentinel error used by the txn to surface "user disappeared" without
  // bubbling as a generic 500. Caught by the awaiting code below.
  const USER_MISSING = Symbol('user-missing')

  let txResult: { feedItem: Awaited<ReturnType<typeof prisma.feedItem.create>>; rating: Awaited<ReturnType<typeof prisma.rating.create>> }
  try {
    txResult = await prisma.$transaction(async (tx) => {
    // Pull the user's display name INSIDE the txn so a concurrent account-
    // deletion can't slip between the lookup and the rating insert (which
    // would leave a successful S3 upload orphan with no reclaim path).
    // raterName is a snapshot at write time; subsequent profile renames
    // don't propagate to existing rows.
    const userRow = await tx.user.findUnique({
      where: { id: userId },
      select: { name: true },
    })
    if (!userRow) throw USER_MISSING
    // 1. Mint the wine row. sessionId=NULL (standalone), category='wine'
    //    (only category seeded today; future categories add their own).
    //    `wines.imageUrl` is the canonical catalog bottle shot (per §2),
    //    not the user's tasting photo. Standalone POSTs don't curate the
    //    catalog — the user's photo lives in rating_images instead. Leave
    //    the wine's imageUrl null so a cascade-delete of the rating later
    //    doesn't leave a dangling S3 pointer on a surviving (bookmarked)
    //    wine row.
    await tx.wine.create({
      data: {
        id: wineId,
        sessionId: null,
        name: wineName,
        producer: scrubProducer,
        vintage: scrubVintage,
        grape: scrubGrape,
        style: wineStyle,
        category: 'wine',
        imageUrl: null,
      },
    })
    // 2. Mint the rating. origin='standalone', sessionId=NULL (per the
    //    partial-unique-on-(user,wine,session) contract: standalone
    //    ratings are unconstrained, multiple standalone tastings of the
    //    same wine are legal — the aging-bottle case).
    const r = await tx.rating.create({
      data: {
        wineId,
        userId,
        sessionId: null,
        origin: 'standalone',
        raterName: userRow.name,
        score: ratingScore,
        flavors: ratingFlavors,
        notes: scrubNotes,
        ratedAt: new Date(),
      },
    })
    // 3. Mint the feed_item. kind='standalone'; ratingId points at the new
    //    rating; locationPublic computed above. The feed_items.ratingId is
    //    @unique so this is 1:1 — re-saving a standalone is a new rating
    //    row + new feed_item, not an update.
    const fi = await tx.feedItem.create({
      data: {
        userId,
        kind: 'standalone',
        sessionId: null,
        ratingId: r.id,
        venueName: scrubVenue,
        city: scrubCity,
        country: scrubCountry,
        lat: lat ?? null,
        lng: lng ?? null,
        locationPublic: hasLocation,
      },
    })
    // 4. Attach the rating_image if we have one. sortOrder=0 (single
    //    image today; the column exists for future multi-photo support).
    if (imageUrl) {
      await tx.ratingImage.create({
        data: { ratingId: r.id, imageUrl, sortOrder: 0 },
      })
    }
    return { feedItem: fi, rating: r }
    })
  } catch (err) {
    // Reclaim the orphan S3 upload that landed before the txn opened
    // (the upload is the only "external" side-effect; everything inside
    // the txn rolls back). Fire on every catch path — not just
    // USER_MISSING — because any txn failure (FK violation on
    // category_styles, Prisma connection blip, etc.) leaves the same
    // orphan bytes with no recovery if we don't reclaim here.
    if (imageUrl) reclaimImage(imageUrl)
    if (err === USER_MISSING) {
      return NextResponse.json({ error: 'user not found' }, { status: 401 })
    }
    throw err
  }
  const { feedItem, rating } = txResult

  // Save tags as feed_item_tags — only mutual follows (verify server-side).
  // Block-pair members are excluded from the write: tagging a user the
  // author block-pairs with shouldn't persist a row that the render-time
  // filter would then hide globally anyway.
  if (Array.isArray(taggedUserIds) && taggedUserIds.length > 0) {
    const mutuals = await prisma.$queryRaw<{ id: number }[]>`
      SELECT f1.following_id AS id
      FROM follows f1
      JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
      WHERE f1.follower_id = ${userId} AND f1.following_id = ANY(${taggedUserIds}::integer[])
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${userId} AND b.blocked_id = f1.following_id)
             OR (b.blocker_id = f1.following_id AND b.blocked_id = ${userId})
        )
    `
    const validIds = mutuals.map(m => m.id)
    if (validIds.length > 0) {
      await prisma.feedItemTag.createMany({
        data: validIds.map(uid => ({ feedItemId: feedItem.id, userId: uid })),
        skipDuplicates: true,
      })
    }
  }

  // Client-compatible response shape: surface the new model in the legacy
  // `{...checkin, score}` envelope so existing consumers (mobile clients,
  // /me/feed surface, profile renders) don't have to change in lockstep.
  // Read paths transition in subsequent slices (task #13–#14); the response
  // adapter keeps writes ahead of reads safely.
  return NextResponse.json({
    id: feedItem.id,
    userId,
    wineName,
    producer: scrubProducer,
    vintage: scrubVintage,
    grape: scrubGrape,
    type: wineStyle,
    score: decimalToNumber(rating.score),
    flavors: ratingFlavors,
    notes: scrubNotes,
    imageUrl,
    venueName: scrubVenue,
    city: scrubCity,
    country: scrubCountry,
    lat: lat ?? null,
    lng: lng ?? null,
    createdAt: feedItem.createdAt.toISOString(),
  }, { status: 201 })
}
