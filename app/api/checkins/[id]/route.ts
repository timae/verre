import { NextRequest, NextResponse } from 'next/server'
import { imageKey } from '@/lib/imageKeys'
import { parseTagList, resolveTagList, publicIdFor } from '@/lib/publicIds'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors, fillFlavourZeros } from '@/lib/flavours'
import { gateAromas, type AromaSelection } from '@/lib/aromas'
import { validateScore, decimalToNumber, normalizeCode } from '@verre/core'
import { redis, k, existsKey, touchWithMeta } from '@/lib/redis'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, ContractRefused, ContractBusy, ContractNeedsLease, LockLost, ratingKeyWrite, type MutationCtx } from '@/lib/sessionMutation'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'
import { scrub } from '@/lib/textSafe'
import { CatalogValidationError, publishSearchWords } from '@/lib/catalogWrite'
import { relinkOccurrence, editOccurrenceNotes } from '@/lib/occurrences'
import { afterRelink } from '@/lib/cravings'
import { prepareLink, applyRelink, type AppliedLink } from '@/lib/catalogLink'
import { loadEntries, entryKey } from '@/lib/catalogEntries'
import { cleanBottleNotes } from '@/lib/session'
import { bumpRatingVersion } from '@/lib/ratingVersions'

// Inlined S3 reclaim — the equivalent helper exported from lib/s3.ts gets
// silently dropped by Next 15.5 / webpack 5.98 when more than two named
// exports live alongside uploadImage (and the since-removed id-keyed delete). Until that
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

// How long after posting a check-in's first photo is free of the shared budget.
const FIRST_PHOTO_WINDOW_MS = 10 * 60 * 1000

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Share the create budget — edits and creates count toward the same hourly
  // cap. Charged before every answer (a probe of someone else's id pays like an
  // edit), with ONE exception decided below: the first photo of the caller's
  // own check-in, sent alone right after posting (the photo has its own call
  // since the catalogue model change step 3; ruled 2026-11-20: it does not cost
  // a second slot).
  const limited = async () => {
    const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
    return rl.allowed ? null : NextResponse.json({ error: `Too many check-in writes. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })
  }

  const feedItemId = parsePathId((await params).id)
  if (feedItemId === null) return (await limited()) ?? NextResponse.json({ error: 'invalid id' }, { status: 400 })

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
  if (!feedItem) return (await limited()) ?? NextResponse.json({ error: 'not found' }, { status: 404 })
  // Kind branch BEFORE the owner check (mirrors DELETE below): a wrong-owner
  // 403 on every kind would let any logged-in user distinguish "exists" from
  // "doesn't" across the whole serial id space (app/api/CLAUDE.md status-code
  // rules). Session wrong-owner is 404 HERE, before any body validation —
  // (a) a 400-vs-404 split on a bad body would re-open the existence oracle,
  // and (b) a caller who rated the same session/wine could otherwise edit
  // THEIR OWN rating through someone else's feed-item id (the rating lookup
  // is caller-scoped), and the echoed foreign id would splice their values
  // into the other post in the client cache.
  if (feedItem.kind === 'session') {
    const l = await limited()
    if (l) return l
    if (feedItem.userId !== userId) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return patchSessionRating(req, feedItem.id, feedItem.sessionId, userId)
  }
  // Wrong owner = 404, like a missing id (no post-id existence oracle).
  if (feedItem.kind !== 'standalone' || !feedItem.rating || feedItem.userId !== userId) {
    return (await limited()) ?? NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const rating = feedItem.rating
  const wine = rating.wine
  const currentImage = rating.images[0] ?? null

  const body = await req.json().catch(() => null)
  // The uncharged case: ONLY `imageData` (a data URL), the check-in has no photo
  // yet, and it was posted in the last 10 minutes. Removing a photo, a second
  // photo or any other field is charged, so a remove-and-re-add loop still pays.
  const firstPhoto = !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && typeof (body as { imageData?: unknown }).imageData === 'string'
    && ((body as { imageData: string }).imageData).startsWith('data:image/')
    && !currentImage && feedItem.createdAt.getTime() > Date.now() - FIRST_PHOTO_WINDOW_MS
    // One free attempt per check-in, atomically (security review r1: a parallel
    // burst read "no photo yet" on every request).
    && (await redis.set(`rl:checkin-photo:${feedItem.id}`, '1', { NX: true, EX: Math.ceil(FIRST_PHOTO_WINDOW_MS / 1000) }).catch(() => null)) === 'OK'
  if (!firstPhoto) {
    const l = await limited()
    if (l) return l
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  // 🔒 The wine is its catalogue link (catalogue model change step 4): an
  // identity change is a RE-LINK (`productId` / `vintageId` pick, or `create`)
  // that writes the whole snapshot from the entry; typed identity text
  // (wineName, producer, vintage, grape, type, wineRegion, wineCountry) is
  // ignored. The bottle's own fields (About, vinification, the purchase link)
  // are written as sent.
  const { score, flavors, aromas, notes,
    imageData, venueName, city, country, lat, lng, taggedUserIds,
    vinification, description, purchaseUrl } = body
  // Mirror the per-field length caps from POST so over-sized PATCH input
  // returns 400 instead of letting Prisma raise P2000 (→ 500).
  const lenCheck: Array<[string, unknown, number]> = [
    ['venueName', venueName, 200], ['city', city, 100], ['country', country, 8],
    ['notes', notes, 4000],
    ['vinification', vinification, 1000], ['description', description, 1000],
    ['purchaseUrl', purchaseUrl, 1000],
  ]
  for (const [k, v, max] of lenCheck) {
    if (typeof v === 'string' && v.length > max) return NextResponse.json({ error: `${k} too long (max ${max})` }, { status: 400 })
  }  // 🔒 Tags are PUBLIC ids; any malformed element (an old tab's integer) is a
  // 400 for the whole request BEFORE any upload or write, so it can never
  // become `[]` and wipe the post's tags (lib/publicIds.ts parseTagList).
  const tagPublicIds = Array.isArray(taggedUserIds) ? parseTagList(taggedUserIds) : undefined
  if (tagPublicIds === null) return NextResponse.json({ error: 'invalid taggedUserIds' }, { status: 400 })

  // Run validators and capture the parsed values.
  let validScore: number | null | undefined = undefined
  let rawFlavors: Record<string, number> | undefined = undefined
  if (score !== undefined) {
    const c = validateScore(score)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validScore = c.value
  }
  // The link's shape, before any upload or write: a create is gated (signed in,
  // the kill switch, its budget); a pick is validated, and a create minted, in
  // the transaction below against the locked bottle (applyRelink). The
  // check-in's own `rl:checkin` budget is already charged.
  const linkReq = await prepareLink(req, body, { userId, identityId: `u:${userId}`, pickRate: false, required: false })
  if (linkReq instanceof NextResponse) return linkReq
  if (flavors !== undefined) {
    const c = validateFlavors(flavors)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    rawFlavors = c.value ?? {}
    // Gated against the bottle's kind under the lock (the transaction below):
    // a re-link in the same request, or a concurrent one, decides it.
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
    // Same key scheme as POST (lib/imageKeys.ts, nothing that points to the person): the
    // bucket is public, so a key must not be guessable.
    const uploaded = await uploadImage(imageKey('checkin'), imageData).catch(() => null)
    if (!uploaded) {
      // FAIL LOUDLY (2026-07-17): the caller explicitly sent a photo; a 200
      // that silently kept the old image reads as "saved" while the photo
      // vanished (device-observed with S3 down). 502 lets the client surface
      // a retryable error instead.
      return NextResponse.json({ error: 'photo upload failed, try again' }, { status: 502 })
    }
    nextImageUrl = uploaded
    freshUploadUrl = uploaded
  } else if (imageData === null) {
    nextImageUrl = null
  }

  // If the client sent taggedUserIds, verify each is a mutual follow before
  // we touch the tag rows. Same check as POST.
  let validTagIds: number[] | undefined
  if (tagPublicIds !== undefined) {
    const tagIds = await resolveTagList(tagPublicIds)
    if (tagIds.length === 0) {
      validTagIds = []
    } else {
      const mutuals = await prisma.$queryRaw<{ id: number }[]>`
        SELECT f1.following_id AS id
        FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
        WHERE f1.follower_id = ${userId} AND f1.following_id = ANY(${tagIds}::integer[])
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
  let mintTx: Prisma.TransactionClient | null = null
  try {
    txResult = await prisma.$transaction(async (tx) => {
    mintTx = tx
    // 🔒 The rating and its bottle as they stand NOW, locked (Codex r1, r2):
    // every value this edit derives (the flavour shape for the kind) comes
    // from these rows, never from the request's pre-read.
    const locked = (await tx.$queryRaw<{ sparkling: boolean; flavors: unknown; product_id: string | null; vintage_id: string | null }[]>`
      SELECT w.sparkling, r.flavors, w.product_id, w.vintage_id FROM ratings r JOIN wines w ON w.id = r.wine_id WHERE r.id = ${rating.id} FOR UPDATE OF r, w`)[0]
    if (!locked) throw Object.assign(new Error('gone'), { code: 'P2025' })
    // A re-link: mint (a create) and read the new entry; its snapshot replaces
    // the bottle's identity in one statement.
    // Resolved against the bottle AS LOCKED (a partial pick keeps the current
    // grain; a retried `create` on the same bottle mints nothing: applyRelink).
    let applied: AppliedLink | null = null
    try { applied = await applyRelink(tx, linkReq, userId, { productId: locked.product_id, vintageId: locked.vintage_id }) }
    catch (err) { if (err instanceof CatalogValidationError) throw Object.assign(new Error(err.message), { code: 'BAD_LINK' }); throw err }
    // A re-link carries the bottle's cravings to the new wine (R3).
    if (applied) { await relinkOccurrence(tx, null, wine.id, applied, applied.snapshot); await afterRelink(tx, wine.id) }
    const nextSparkling = applied ? applied.snapshot.sparkling : locked.sparkling
    // Sent flavours are gated against the kind the bottle has after this edit.
    let sentFlavors: Record<string, number> | undefined = undefined
    if (rawFlavors !== undefined) {
      const norm = gateAndFillFlavors(rawFlavors, 'wine', { sparkling: nextSparkling })
      if (norm.error) throw Object.assign(new Error(norm.error), { code: 'BAD_LINK' })
      sentFlavors = norm.value
    }
    await editOccurrenceNotes(tx, null, wine.id, cleanBottleNotes({ description, vinification, purchaseUrl }))
    const updatedWine = await tx.wine.findUniqueOrThrow({ where: { id: wine.id } })

    // Rating-side fields (score, flavors, notes).
    // Rating-side fields: only the ones sent (Codex r2: an omitted field keeps
    // what is stored NOW, never this request's pre-read).
    // rating-write: EXEMPT
    const updatedRating = await tx.rating.update({
      where: { id: rating.id },
      data: {
        ...(score !== undefined ? { score: validScore ?? null } : {}),
        // No flavours in the body but the style CHANGED → re-normalise the
        // STORED map (as locked) against the new style (fillFlavourZeros drops
        // off-set keys — a spark row's bubbles doesn't survive a switch to red
        // — and re-fills; all-off-set collapses to {}). Otherwise a type-only
        // PATCH from a raw/partial client would leave rating.flavors keyed to
        // the OLD style, breaking the registry-keyed-for-effective-style
        // invariant the write boundary guarantees.
        ...(flavors !== undefined
          ? { flavors: sentFlavors ?? {} }
          : nextSparkling !== locked.sparkling
            ? { flavors: fillFlavourZeros((locked.flavors ?? {}) as Record<string, number>, 'wine', { sparkling: nextSparkling }) }
            : {}),
        ...(aromasProvided ? { aromas: validAromas } : {}),
        ...(notes !== undefined ? { notes: scrub(notes) } : {}),
      },
    })

    // Feed-item-side fields (venue + location, locationPublic).
    // Only the fields sent; locationPublic recomputed from the row as stored
    // (the POST default: true iff any location field is set, a 0 coordinate
    // reading as unset like the JavaScript truthiness it replaced).
    const locationSent = venueName !== undefined || city !== undefined || country !== undefined || lat !== undefined || lng !== undefined
    let updatedFeedItem = await tx.feedItem.update({
      where: { id: feedItem.id },
      data: {
        ...(venueName !== undefined ? { venueName: scrub(venueName) } : {}),
        ...(city !== undefined ? { city: scrub(city) } : {}),
        ...(country !== undefined ? { country: scrub(country)?.slice(0,2).toUpperCase() || null } : {}),
        ...(lat !== undefined ? { lat: lat ?? null } : {}),
        ...(lng !== undefined ? { lng: lng ?? null } : {}),
      },
    })
    if (locationSent) {
      await tx.$executeRaw`
        UPDATE feed_items SET location_public = (COALESCE(venue_name, '') <> '' OR COALESCE(city, '') <> '' OR COALESCE(country, '') <> ''
                                                 OR COALESCE(lat, 0) <> 0 OR COALESCE(lng, 0) <> 0)
         WHERE id = ${feedItem.id}`
      updatedFeedItem = await tx.feedItem.findUniqueOrThrow({ where: { id: feedItem.id } })
    }

    // Image: create / replace / delete the single rating_images row.
    let resolvedImageUrl: string | null = currentImage?.imageUrl ?? null
    if (nextImageUrl !== undefined) {
      // Wipe any existing rows for this rating (1 today; defensive), and
      // reclaim exactly what this transaction removed (security review r1: a
      // concurrent edit's photo, committed after our pre-read, would otherwise
      // be left in the bucket with no row).
      const removed = await tx.$queryRaw<{ image_url: string }[]>`DELETE FROM rating_images WHERE rating_id = ${rating.id} RETURNING image_url`
      for (const r of removed) if (r.image_url && r.image_url !== nextImageUrl && !urlsToReclaim.includes(r.image_url)) urlsToReclaim.push(r.image_url)
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
    // A re-link `create`'s new search words, after the COMMIT (lib/catalogWrite.ts).
    void publishSearchWords(mintTx)
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
    if (errCode === 'BAD_LINK') {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 })
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
    userId: (await publicIdFor(userId)) ?? null,
    wineName: updatedWine.name,
    producer: updatedWine.producer,
    vintage: updatedWine.vintage,
    grape: updatedWine.grape,
    colour: updatedWine.colour,
    sparkling: updatedWine.sparkling,
    abv: updatedWine.abv === null ? null : Number(updatedWine.abv),
    entry: updatedWine.productId
      ? (await loadEntries([{ productId: updatedWine.productId, vintageId: updatedWine.vintageId }])).get(entryKey(updatedWine.productId, updatedWine.vintageId)) ?? null
      : null,
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
// PG-only once expired or soft-deleted. Deliberately NOT touched: lifetime
// counters (an edit is not new activity), rater_name (frozen snapshot),
// ratedAt (an edit must not reorder history/bookmark recency). Kick/ban posture
// (ruling, 2026-07-18): the rating is the user's own data, so a kick-keep'd
// user KEEPS editing it here — admission is OWNERSHIP of the row, not
// participation; kick-delete/ban delete the row → 404.
//
// 🔒 A session-rating writer of a LIVE code joins the session mutation contract
// (redis-rehydration release-B plan § 3, r2-3/r3-4): the advisory lock
// serializes it with the rate route, deletes and the rebuild (a cold rebuild
// that read v1 cannot publish over this v2); it bumps the publication
// generation (best-effort — without Redis the edit stays PG-only); an edit that
// may EMPTY the rating — and so delete its key — also holds the Redis lease
// (r3-3). Mirror liveness is decided after the lock. It never rebuilds
// (enrichment reads don't). A soft-deleted session (code NULL) is a plain
// transaction: no cache, no rebuild can exist.
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
  let validScore: number | null | undefined = undefined
  if (score !== undefined) {
    const c = validateScore(score)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validScore = c.value
  }
  let checkedFlavors: Record<string, number> | undefined = undefined
  if (flavors !== undefined) {
    const c = validateFlavors(flavors)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    checkedFlavors = c.value ?? {}
  }
  const aromasProvided = aromas !== undefined
  let validAromas: AromaSelection[] = []
  if (aromasProvided) {
    const c = gateAromas(aromas)
    if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
    validAromas = c.value ?? []
  }
  // Could this edit empty the rating (and so delete its key)? Only when it sets
  // nothing engaged — the committed result decides, this decides the lease.
  const mayReap = !((validScore ?? 0) > 0 || Object.values(checkedFlavors ?? {}).some(v => v) || validAromas.length > 0
    || (typeof notes === 'string' && (scrub(notes) ?? '').length > 0))

  const sess = await prisma.session.findUnique({ where: { id: sessionId }, select: { code: true } })
  const code = sess?.code ? normalizeCode(sess.code) : null
  type Out = { nextScore: number | null; nextFlavors: Record<string, number>; nextAromas: AromaSelection[]; nextNotes: string | null; reaped: boolean; reclaim: string[]; mirrored: boolean }
  const run = async (tx: Prisma.TransactionClient, liveCode: string | null, ctx: MutationCtx | null): Promise<Out | NextResponse> => {
    // 🔒 Lock order: the caller's users row BEFORE the rating (both branches).
    // In a soft-deleted moment this is a plain transaction with no shared
    // session lock, and account deletion takes the user row first and then
    // rewrites the rating: rating-then-user would deadlock. The take-back on an
    // emptied rating debits this row.
    const owner = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`
    if (!owner[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const rows = await tx.$queryRaw<{ id: number; score: unknown; flavors: unknown; aromas: unknown; notes: string | null; sparkling: boolean }[]>`
      SELECT r.id, r.score, r.flavors, r.aromas, r.notes, w.sparkling FROM ratings r JOIN wines w ON w.id = r.wine_id
       WHERE r.user_id = ${userId} AND r.session_id = ${sessionId} AND r.wine_id = ${wineId} FOR UPDATE OF r`
    const rating = rows[0]
    if (!rating) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Liveness under the lock (Redis trouble degrades to a PG-only edit — it
    // must never fail the edit). The bottle's style is the RECORD's (model
    // change § 8a: a session-kind feed item is a Postgres-backed moment's).
    let live = false
    if (liveCode) {
      try {
        live = await existsKey(k.meta(liveCode))
      } catch (err) {
        console.warn('[checkins] live-session lookup failed — PG-only edit:', err)
        live = false
      }
    }
    // FIELD-PRECISE update: only the provided fields are written, so two devices
    // editing DIFFERENT fields compose. mirror_at = clock_timestamp() is the
    // row's version token, durable (§ 4.3) and returned for the Redis `at`.
    const sets: Prisma.Sql[] = []
    if (score !== undefined) sets.push(Prisma.sql`score = ${validScore}::numeric`)
    if (checkedFlavors !== undefined) {
      const norm = gateAndFillFlavors(checkedFlavors, 'wine', { sparkling: rating.sparkling })
      if (norm.error) return NextResponse.json({ error: norm.error }, { status: 400 })
      sets.push(Prisma.sql`flavors = ${JSON.stringify(norm.value ?? {})}::jsonb`)
    }
    if (aromasProvided) sets.push(Prisma.sql`aromas = ${JSON.stringify(validAromas)}::jsonb`)
    if (notes !== undefined) sets.push(Prisma.sql`notes = ${scrub(notes)}`)
    let updated: { score: unknown; flavors: unknown; aromas: unknown; notes: string | null } = rating
    let versionTs = Date.now()
    const didUpdate = sets.length > 0
    if (didUpdate) {
      sets.push(Prisma.sql`mirror_at = clock_timestamp()`)
      // rating-write: BUMPS
      const out = await tx.$queryRaw<{ score: unknown; flavors: unknown; aromas: unknown; notes: string | null; ts: Date }[]>`
        UPDATE ratings SET ${Prisma.join(sets, ', ')} WHERE id = ${rating.id}
        RETURNING score, flavors, aromas, notes, mirror_at AS ts`
      const { ts, ...row } = out[0]
      updated = row
      versionTs = ts.getTime()
    }
    const o: Out = {
      nextScore: decimalToNumber(updated.score as never), nextFlavors: (updated.flavors as Record<string, number> | null) ?? {},
      nextAromas: (updated.aromas as AromaSelection[] | null) ?? [], nextNotes: updated.notes, reaped: false, reclaim: [], mirrored: false,
    }
    // Engagement cascade: an edit that EMPTIES the rating reaps it (and the post
    // iff it was the last engaged rating) — same rule as an empty rate POST.
    const engaged = (o.nextScore ?? 0) > 0 || Object.keys(o.nextFlavors).length > 0 || o.nextAromas.length > 0 || (o.nextNotes ?? '').length > 0
    if (!engaged) {
      // The owner's own clear: the row's action XP is taken back.
      // rating-write: BUMPS
      const urls = await engagementCascadeIn(tx, rating.id, 'empty-only', { ownClear: true })
      if (urls) { o.reaped = true; o.reclaim = urls }
    }
    // The rating's version (docs/dev/rating-saves.md), in this transaction, ONE
    // atomic statement (a soft-deleted moment has no session lock).
    const version = didUpdate || o.reaped ? await bumpRatingVersion(tx, userId, wineId, null) : null
    // The live mirror of the caller's OWN key, roster-independent (PR #81 P1 —
    // kick-keep retains the key and buildRatingsView hides it off-roster). An
    // absent key is skipped (a cold cache is filled by the next rebuild, which
    // reads the record this edit commits). The key's TTL is the session's
    // REMAINING lifespan (PTTL of meta), so an off-roster editor's save can
    // never extend anything or outlive the session onto a recycled code.
    // Fenced by this contract's generation bump (ratingKeyWrite); a DEL
    // without the lease re-runs the contract with it.
    if (live && liveCode && ctx && (o.reaped || didUpdate)) {
      try {
        // rating-write: BUMPS
        const key = k.rating(liveCode, `u:${userId}`, wineId)
        // rating-write: BUMPS
        if (o.reaped) await ratingKeyWrite(ctx, key, null)
        else {
          const pttl = Number(await redis.pTTL(k.meta(liveCode)))
          // rating-write: BUMPS
          o.mirrored = await ratingKeyWrite(ctx, key, JSON.stringify({ score: o.nextScore ?? 0, flavors: o.nextFlavors, aromas: o.nextAromas, notes: o.nextNotes ?? '', at: versionTs, ...(version !== null ? { v: version } : {}) }), { pxMs: pttl, onlyIfExists: true })
        }
      } catch (err) {
        if (err instanceof ContractNeedsLease || err instanceof LockLost || err instanceof ContractBusy) throw err
        console.warn('[checkins] live mirror failed (PG commits):', err)
      }
    }
    return o
  }
  let res: Out | NextResponse
  try {
    res = code
      ? await withSessionMutation(code, { label: 'checkin-patch', readMeta: false, redisLock: mayReap ? { waitMs: 3000 } : false, bumpGen: 'best-effort' },
          async (tx, ctx) => { const r = await run(tx, code, ctx); if (r instanceof NextResponse) throw new ContractRefused(r); return r })
      : await prisma.$transaction(tx => run(tx, null, null))
  } catch (err) {
    if (err instanceof ContractRefused) return err.response
    if (err instanceof ContractBusy || err instanceof LockLost) {
      return NextResponse.json({ error: 'busy, try again' }, { status: 503, headers: { 'Retry-After': '1' } })
    }
    throw err
  }
  if (res instanceof NextResponse) return res
  reclaimImages(res.reclaim)
  // A roster member's edit keeps the live session alive (rate-route pattern);
  // an off-roster (kicked) editor never refreshes the session-wide TTL.
  if (res.mirrored && code && await redis.hExists(k.identities(code), `u:${userId}`).catch(() => false)) {
    await touchWithMeta(code).catch(() => {})
  }
  const feedItemDeleted = res.reaped
    ? !(await prisma.feedItem.findUnique({ where: { id: feedItemId }, select: { id: true } }))
    : false
  return NextResponse.json({
    id: feedItemId,
    wineId,
    score: res.nextScore,
    flavors: res.nextFlavors,
    aromas: res.nextAromas,
    notes: res.nextNotes,
    reaped: res.reaped,
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
  // Wrong owner = 404, like a missing id (no post-id existence oracle).
  if (!feedItem || feedItem.kind !== 'standalone' || !feedItem.rating || feedItem.userId !== userId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Capture URLs BEFORE the cascade fires. Reclaim AFTER commit.
  const urlsToReclaim = feedItem.rating.images
    .map(i => i.imageUrl)
    .filter((u): u is string => !!u)

  // Deleting the rating cascades to its feed_item (1:1 via ratingId) and
  // its rating_images (FK on ratings.id). The wines row stays (it's
  // standalone with sessionId=NULL; if the user later bookmarks it from
  // somewhere else the row needs to survive). Orphaned wine rows are a
  // known acceptable cost of the no-dedup policy.
  // rating-write: EXEMPT
  await prisma.rating.delete({ where: { id: feedItem.rating.id } })

  for (const url of urlsToReclaim) reclaimImage(url)
  return NextResponse.json({ ok: true })
}
