import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors, fillFlavourZeros } from '@/lib/flavours'
import { gateAromas, type AromaSelection } from '@/lib/aromas'
import { validateScore, decimalToNumber, normalizeCode } from '@verre/core'
import { redis, k, TTL, existsKey, touchWithMeta } from '@/lib/redis'
import { engagementDeletionCascade } from '@/lib/engagementCascade'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'
import { scrub, cleanCountry, cleanUrl } from '@/lib/textSafe'

// Inlined S3 reclaim — the equivalent helper exported from lib/s3.ts gets
// silently dropped by Next 15.5 / webpack 5.98 when more than two named
// exports live alongside the existing uploadImage/deleteImage. Until that
// bundling bug is understood, keep this local copy so the route survives.
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
    console.warn('[s3] reclaimImage failed:', { key, err })
  }
}

type Ctx = { params: Promise<{ id: string }> }

// Post-rewire, PATCH/DELETE /api/checkins/[id] operate on the new model:
// `id` is a feed_items.id (kind='standalone'), the rating + wine + rating_image
// hang off it. The legacy `checkins` table is read-only after slice 3 (no
// new POSTs write to it); existing rows get migrated to the new model by
// the data migration script (task #12). The migration preserves
// feed_items.id = source.checkins.id, so cached client URLs continue to
// resolve.

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Share the create budget — edits and creates count toward the same hourly cap.
  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-in writes. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const feedItemId = parsePathId((await params).id)
  if (feedItemId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  // Walk the new model: feed_item → rating → wine → optional rating_image.
  // We need ALL of these to apply edits: the wine carries name/producer/etc.,
  // the rating carries score/flavors/notes, the rating_image carries the
  // photo URL. kind='standalone' edits everything below; kind='session'
  // (feed-side rating edit, 2026-07-17) branches to the rating-only handler —
  // the wine belongs to the MOMENT, not the poster, so identity fields are
  // not editable from the feed.
  const feedItem = await prisma.feedItem.findUnique({
    where: { id: feedItemId },
    include: {
      rating: {
        include: {
          wine: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        },
      },
    },
  })
  if (!feedItem) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (feedItem.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (feedItem.kind === 'session') return patchSessionRating(req, feedItem.id, feedItem.sessionId, userId)
  if (feedItem.kind !== 'standalone' || !feedItem.rating) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const rating = feedItem.rating
  const wine = rating.wine
  const currentImage = rating.images[0] ?? null

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineName, producer, vintage, grape, type, score, flavors, aromas, notes,
    imageData, venueName, city, country, lat, lng, taggedUserIds,
    wineRegion, wineCountry, vinification, description, purchaseUrl } = body
  // Mirror the per-field length caps from POST so over-sized PATCH input
  // returns 400 instead of letting Prisma raise P2000 (→ 500).
  const lenCheck: Array<[string, unknown, number]> = [
    ['wineName', wineName, 200], ['producer', producer, 200], ['vintage', vintage, 8],
    ['grape', grape, 200], ['type', type, 32],
    ['venueName', venueName, 200], ['city', city, 100], ['country', country, 8],
    ['notes', notes, 4000],
    // Wine-origin metadata (feed-edit round, 2026-07-17) — same caps as POST.
    ['wineRegion', wineRegion, 255], ['wineCountry', wineCountry, 8],
    ['vinification', vinification, 1000], ['description', description, 1000],
    ['purchaseUrl', purchaseUrl, 1000],
  ]
  for (const [k, v, max] of lenCheck) {
    if (typeof v === 'string' && v.length > max) return NextResponse.json({ error: `${k} too long (max ${max})` }, { status: 400 })
  }
  // Run validators and capture the parsed values.
  let validScore: number | null | undefined = undefined
  let validFlavorsValue: Record<string, number> | undefined = undefined
  if (score !== undefined) {
    const c = validateScore(score)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validScore = c.value
  }
  // Effective style = the body type (if a valid style) else the EXISTING
  // wine.style — the same resolution the wine update below writes. Hoisted
  // because BOTH flavour paths key on it (sent-flavours gate + the
  // style-changed re-normalisation of stored flavours).
  const effStyle = type !== undefined
    ? (typeof type === 'string' && ['red','white','spark','rose','nonalc'].includes(type) ? type : null)
    : wine.style
  if (flavors !== undefined) {
    const c = validateFlavors(flavors)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    // Server-side flavour normalisation (§6g gate + §5 zero-fill — see
    // gateAndFillFlavors). category is 'wine'. Non-zero descriptor key → 400;
    // zero-valued off-style keys are stripped (stale-type fill artifacts);
    // the stored shape is filled-or-empty by construction.
    const norm = gateAndFillFlavors(c.value, 'wine', effStyle)
    if (norm.error) return NextResponse.json({ error: norm.error }, { status: 400 })
    validFlavorsValue = norm.value
  }
  // Aromas: same chokepoint + present-replaces / omitted-preserves contract
  // as the session rate route (aroma-layer.md §4/§5). A PRESENT field —
  // including [] — is the full new truth; an OMITTED field keeps the stored
  // selections (so a client that predates aromas can't wipe them). Explicit
  // null → 400 inside the gate, never a silent clear.
  const aromasProvided = aromas !== undefined
  let validAromas: AromaSelection[] = []
  if (aromasProvided) {
    const c = gateAromas(aromas)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validAromas = c.value ?? []
  }

  // Image handling: image lives in rating_images now (not on the wine row).
  // Three branches:
  //   - imageData is a fresh data URL → upload, create or replace the row,
  //     reclaim the prior S3 object if any.
  //   - imageData === null → caller wants to remove the image; delete the
  //     rating_images row and reclaim the S3 object.
  //   - imageData undefined (not sent) → leave existing rating_image alone.
  let nextImageUrl: string | null | undefined = undefined  // undefined = leave alone
  // Track whether we just uploaded a fresh S3 object so the catch below
  // can reclaim it if the txn rolls back.
  let freshUploadUrl: string | null = null
  if (imageData?.startsWith('data:image/')) {
    if (typeof imageData !== 'string' || imageData.length > MAX_IMAGE_DATA_URL_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 400 })
    }
    // Same key scheme as POST (wines/ci_<userId>_<timestamp>).
    const keyBase = `wines/ci_${userId}_${Date.now()}`
    const uploaded = await uploadImage(keyBase, imageData).catch(() => null)
    if (!uploaded) {
      // FAIL LOUDLY (2026-07-17): the caller explicitly sent a photo; a 200
      // that silently kept the old image reads as "saved" while the photo
      // vanished (device-observed with S3 down). 502 lets the client surface
      // a retryable error instead.
      return NextResponse.json({ error: 'photo upload failed — try again' }, { status: 502 })
    }
    nextImageUrl = uploaded
    freshUploadUrl = uploaded
  } else if (imageData === null) {
    nextImageUrl = null
  }

  // If the client sent taggedUserIds, verify each is a mutual follow before
  // we touch the tag rows. Same check as POST.
  let validTagIds: number[] | undefined
  if (Array.isArray(taggedUserIds)) {
    if (taggedUserIds.length === 0) {
      validTagIds = []
    } else {
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
      validTagIds = mutuals.map(m => m.id)
    }
  }

  // S3 reclaim: capture URLs to reclaim AFTER the txn commits.
  const urlsToReclaim: string[] = []
  if (nextImageUrl !== undefined && currentImage && currentImage.imageUrl !== nextImageUrl) {
    urlsToReclaim.push(currentImage.imageUrl)
  }

  let txResult: { updatedWine: Awaited<ReturnType<typeof prisma.wine.update>>; updatedRating: Awaited<ReturnType<typeof prisma.rating.update>>; updatedFeedItem: Awaited<ReturnType<typeof prisma.feedItem.update>>; updatedImageUrl: string | null }
  try {
    txResult = await prisma.$transaction(async (tx) => {
    // Wine-side fields (name, producer, vintage, grape, style).
    const updatedWine = await tx.wine.update({
      where: { id: wine.id },
      data: {
        name:     wineName !== undefined ? (scrub(wineName) || wine.name) : wine.name,
        producer: producer !== undefined ? scrub(producer)                 : wine.producer,
        vintage:  vintage  !== undefined ? (scrub(vintage)?.slice(0,4) || null) : wine.vintage,
        grape:    grape    !== undefined ? scrub(grape)                    : wine.grape,
        // Validate `type` against the seeded category_styles. Unknown
        // values coerce to NULL — see POST handler for the rationale.
        style:    effStyle,
        // Origin + metadata (POST parity: scrub, ISO-2 cleanCountry, cleanUrl
        // http(s)-only) — partial semantics like every other field here.
        region:       wineRegion   !== undefined ? (scrub(wineRegion) || null)          : wine.region,
        country:      wineCountry  !== undefined ? (cleanCountry(wineCountry) || null)  : wine.country,
        vinification: vinification !== undefined ? (scrub(vinification) || null)        : wine.vinification,
        description:  description  !== undefined ? (scrub(description) || null)         : wine.description,
        purchaseUrl:  purchaseUrl  !== undefined ? (cleanUrl(purchaseUrl).slice(0, 1000) || null) : wine.purchaseUrl,
        // wine.imageUrl is the catalog bottle shot, not the user's tasting
        // photo. Tasting photos live on rating_images. Don't touch wine
        // imageUrl from this surface — it stays whatever it was at create
        // time (null for standalone POSTs).
      },
    })

    // Rating-side fields (score, flavors, notes).
    const updatedRating = await tx.rating.update({
      where: { id: rating.id },
      data: {
        score:   score   !== undefined ? (validScore ?? null) : rating.score,
        // No flavours in the body but the style CHANGED → re-normalise the
        // STORED map against the new style (fillFlavourZeros drops off-set
        // keys — a spark row's bubbles doesn't survive a switch to red — and
        // re-fills; all-off-set collapses to {}). Otherwise a type-only PATCH
        // from a raw/partial client would leave rating.flavors keyed to the
        // OLD style, breaking the registry-keyed-for-effective-style invariant
        // the write boundary now guarantees.
        flavors: flavors !== undefined
          ? (validFlavorsValue ?? {})
          : effStyle !== wine.style
            ? fillFlavourZeros(rating.flavors as Record<string, number>, 'wine', effStyle)
            : (rating.flavors as object),
        aromas:  aromasProvided ? validAromas : (rating.aromas as object),
        notes:   notes   !== undefined ? scrub(notes)         : rating.notes,
      },
    })

    // Feed-item-side fields (venue + location, locationPublic).
    const updatedFeedItem = await tx.feedItem.update({
      where: { id: feedItem.id },
      data: {
        venueName: venueName !== undefined ? scrub(venueName) : feedItem.venueName,
        city:      city      !== undefined ? scrub(city)      : feedItem.city,
        country:   country   !== undefined ? (scrub(country)?.slice(0,2).toUpperCase() || null) : feedItem.country,
        lat:       lat       !== undefined ? (lat ?? null)    : feedItem.lat,
        lng:       lng       !== undefined ? (lng ?? null)    : feedItem.lng,
        // Recompute locationPublic only if a location-related field changed.
        // Match the POST default: true iff any location field is non-null.
        ...(venueName !== undefined || city !== undefined || country !== undefined ||
            lat !== undefined || lng !== undefined
          ? {
              locationPublic: !!(
                (venueName !== undefined ? scrub(venueName) : feedItem.venueName) ||
                (city !== undefined ? scrub(city) : feedItem.city) ||
                (country !== undefined ? scrub(country)?.slice(0,2).toUpperCase() : feedItem.country) ||
                (lat !== undefined ? lat : feedItem.lat) ||
                (lng !== undefined ? lng : feedItem.lng)
              ),
            }
          : {}),
      },
    })

    // Image: create / replace / delete the single rating_images row.
    let resolvedImageUrl: string | null = currentImage?.imageUrl ?? null
    if (nextImageUrl !== undefined) {
      // Wipe any existing rows for this rating (1 today; defensive).
      await tx.ratingImage.deleteMany({ where: { ratingId: rating.id } })
      if (nextImageUrl !== null) {
        await tx.ratingImage.create({
          data: { ratingId: rating.id, imageUrl: nextImageUrl, sortOrder: 0 },
        })
        resolvedImageUrl = nextImageUrl
      } else {
        resolvedImageUrl = null
      }
    }

    // Replace tags atomically if the client sent any list.
    if (validTagIds !== undefined) {
      await tx.feedItemTag.deleteMany({ where: { feedItemId } })
      if (validTagIds.length > 0) {
        await tx.feedItemTag.createMany({
          data: validTagIds.map(uid => ({ feedItemId, userId: uid })),
          skipDuplicates: true,
        })
      }
    }

    return { updatedWine, updatedRating, updatedFeedItem, updatedImageUrl: resolvedImageUrl }
    })
  } catch (err) {
    // If the txn failed AND we just uploaded a fresh S3 object, reclaim it
    // — otherwise the upload becomes orphan bytes with no recovery path.
    // Same capture-on-failure pattern as POST's USER_MISSING handler.
    //
    // P2025 (record not found) most likely means a concurrent account-delete
    // cascaded the rating between our findUnique and the tx.rating.update;
    // surface as 404. Other Prisma errors bubble as 500.
    if (freshUploadUrl) reclaimImage(freshUploadUrl)
    const errCode = (err as { code?: string })?.code
    if (errCode === 'P2025') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    throw err
  }
  const { updatedWine, updatedRating, updatedFeedItem, updatedImageUrl } = txResult

  // S3 reclaim AFTER commit (the prior rating_image's URL, replaced by the
  // upload we just did). Standard capture/commit/reclaim-after.
  for (const url of urlsToReclaim) reclaimImage(url)

  // Client-compatible legacy envelope, same shape as POST.
  return NextResponse.json({
    id: updatedFeedItem.id,
    userId,
    wineName: updatedWine.name,
    producer: updatedWine.producer,
    vintage: updatedWine.vintage,
    grape: updatedWine.grape,
    type: updatedWine.style,
    wineRegion: updatedWine.region,
    wineCountry: updatedWine.country,
    vinification: updatedWine.vinification,
    description: updatedWine.description,
    purchaseUrl: updatedWine.purchaseUrl,
    score: decimalToNumber(updatedRating.score),
    flavors: updatedRating.flavors,
    aromas: updatedRating.aromas,
    notes: updatedRating.notes,
    imageUrl: updatedImageUrl,
    venueName: updatedFeedItem.venueName,
    city: updatedFeedItem.city,
    country: updatedFeedItem.country,
    // feed_items.lat/lng are Decimal(9,6); Prisma surfaces them as Decimal
    // objects that JSON-serialize as strings. Coerce to number so the wire
    // shape matches POST's response (which echoes raw client numbers).
    // Same Decimal-as-string trap as `score` (handled by decimalToNumber).
    lat: decimalToNumber(updatedFeedItem.lat),
    lng: decimalToNumber(updatedFeedItem.lng),
    createdAt: updatedFeedItem.createdAt.toISOString(),
  })
}

// Feed-side edit of ONE session rating (kind='session' feed items, 2026-07-17).
// Rating-only — body { wineId, score?, flavors?, aromas?, notes? }; the wine's
// identity/venue belong to the moment. Owner + rate limit already checked by
// PATCH. Honors the session-rate invariants: score validation, flavour gate
// keyed to the wine's SERVER style, aroma present-replaces/omitted-preserves,
// engagement cascade when an edit empties the rating (post reaped only when it
// was the user's last engaged rating in that session), and a live-Redis mirror
// (same JSON shape as the rate route) when the session is still alive —
// PG-only once expired. Deliberately NOT touched: lifetime counters + HoF (an
// edit is not new activity), rater_name (frozen snapshot). Accepted edge: a
// banned-but-not-yet-wiped participant can still edit their own rating here —
// it is their own data, and a kick-wipe deletes the row (→ 404).
async function patchSessionRating(req: NextRequest, feedItemId: number, sessionId: number | null, userId: number) {
  if (sessionId == null) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineId, score, flavors, aromas, notes } = body
  if (!wineId || typeof wineId !== 'string' || wineId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(wineId)) {
    return NextResponse.json({ error: 'wineId required' }, { status: 400 })
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
  }
  if (typeof notes === 'string' && notes.length > 4000) return NextResponse.json({ error: 'notes too long (max 4000)' }, { status: 400 })

  const rating = await prisma.rating.findFirst({
    where: { userId, sessionId, wineId },
    include: { wine: { select: { style: true } } },
  })
  if (!rating) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let validScore: number | null | undefined = undefined
  if (score !== undefined) {
    const c = validateScore(score)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validScore = c.value
  }
  let validFlavorsValue: Record<string, number> | undefined = undefined
  if (flavors !== undefined) {
    const c = validateFlavors(flavors)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    const norm = gateAndFillFlavors(c.value, 'wine', rating.wine.style)
    if (norm.error) return NextResponse.json({ error: norm.error }, { status: 400 })
    validFlavorsValue = norm.value
  }
  const aromasProvided = aromas !== undefined
  let validAromas: AromaSelection[] = []
  if (aromasProvided) {
    const c = gateAromas(aromas)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validAromas = c.value ?? []
  }

  // Merged next values (partial-update semantics, mirroring the standalone
  // branch) — computed up front so the engagement check and the Redis mirror
  // see the SAME truth the UPDATE writes.
  const nextScore = score !== undefined ? validScore : decimalToNumber(rating.score)
  const nextFlavors = flavors !== undefined ? (validFlavorsValue ?? {}) : (rating.flavors as Record<string, number>)
  const nextAromas = aromasProvided ? validAromas : ((rating.aromas as AromaSelection[] | null) ?? [])
  const nextNotes = notes !== undefined ? scrub(notes) : rating.notes

  try {
    await prisma.rating.update({
      where: { id: rating.id },
      data: {
        score: nextScore,
        flavors: nextFlavors,
        aromas: nextAromas as object[],
        notes: nextNotes,
        ratedAt: new Date(),
      },
    })
  } catch (err) {
    // P2025 = concurrent delete (account cascade / kick wipe) — surface 404.
    if ((err as { code?: string })?.code === 'P2025') return NextResponse.json({ error: 'not found' }, { status: 404 })
    throw err
  }

  // Engagement cascade: an edit that EMPTIES the rating reaps it (and the
  // post, iff it was the last engaged rating) — same rule as an empty rate
  // POST. empty-only mode re-checks emptiness in SQL, so a concurrent engaged
  // write wins and nothing is deleted.
  const hasEngagement =
    (nextScore ?? 0) > 0 ||
    Object.keys(nextFlavors).length > 0 ||
    nextAromas.length > 0 ||
    (nextNotes ?? '').length > 0
  let reaped = false
  if (!hasEngagement) reaped = await engagementDeletionCascade(rating.id, 'empty-only')
  const feedItemDeleted = reaped
    ? !(await prisma.feedItem.findUnique({ where: { id: feedItemId }, select: { id: true } }))
    : false

  // Live-Redis mirror: while the session is alive, the compare/live screens
  // read s:{code}:r:{identityId}:{wineId} — an unmirrored PG edit would show
  // stale ratings in the live session until expiry. Session gone (or the
  // sessions row tombstoned, code NULL) → PG-only, nothing to sync.
  const sess = await prisma.session.findUnique({ where: { id: sessionId }, select: { code: true } })
  const code = sess?.code ? normalizeCode(sess.code) : null
  if (code && (await existsKey(k.meta(code)))) {
    const key = k.rating(code, `u:${userId}`, wineId)
    if (reaped) {
      await redis.del(key)
    } else {
      await redis.set(key, JSON.stringify({ score: nextScore ?? 0, flavors: nextFlavors, aromas: nextAromas, notes: nextNotes ?? '', at: Date.now() }), { EX: TTL })
    }
    // Re-stamp the keyspace to the session's real lifespan (the EX above is
    // the default TTL; touchWithMeta corrects pro lifespans — rate-route
    // pattern).
    await touchWithMeta(code)
  }

  return NextResponse.json({
    id: feedItemId,
    wineId,
    score: nextScore,
    flavors: nextFlavors,
    aromas: nextAromas,
    notes: nextNotes,
    reaped,
    feedItemDeleted,
  })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const feedItemId = parsePathId((await params).id)
  if (feedItemId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  // Walk to rating + image URLs for ownership check + S3 reclaim.
  const feedItem = await prisma.feedItem.findUnique({
    where: { id: feedItemId },
    include: {
      rating: {
        include: {
          images: { select: { imageUrl: true } },
        },
      },
    },
  })
  if (!feedItem || feedItem.kind !== 'standalone' || !feedItem.rating) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (feedItem.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Capture URLs BEFORE the cascade fires. Reclaim AFTER commit.
  const urlsToReclaim = feedItem.rating.images
    .map(i => i.imageUrl)
    .filter((u): u is string => !!u)

  // Deleting the rating cascades to its feed_item (1:1 via ratingId) and
  // its rating_images (FK on ratings.id). The wines row stays (it's
  // standalone with sessionId=NULL; if the user later bookmarks it from
  // somewhere else the row needs to survive). Orphaned wine rows are a
  // known acceptable cost of the no-dedup policy.
  await prisma.rating.delete({ where: { id: feedItem.rating.id } })

  for (const url of urlsToReclaim) reclaimImage(url)
  return NextResponse.json({ ok: true })
}
