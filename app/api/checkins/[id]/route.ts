import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { uploadImage, MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors, fillFlavourZeros } from '@/lib/flavours'
import { gateAromas, type AromaSelection } from '@/lib/aromas'
import { validateScore, decimalToNumber, normalizeCode, normalizeVintageText } from '@verre/core'
import { redis, k, existsKey, touchWithMeta } from '@/lib/redis'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, ContractRefused, ContractBusy, ContractNeedsLease, LockLost, ratingKeyWrite, type MutationCtx } from '@/lib/sessionMutation'
import { parsePathId } from '@/lib/parsePathId'
import { isSameOrigin } from '@/lib/csrf'
import type { WineMeta } from '@/lib/session'
import { scrub, cleanCountry, cleanUrl } from '@/lib/textSafe'
import { resolveCatalogLink, applyIdentityEditRule, CatalogValidationError } from '@/lib/catalogWrite'

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
    if (feedItem.userId !== userId) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return patchSessionRating(req, feedItem.id, feedItem.sessionId, userId)
  }
  if (feedItem.kind !== 'standalone' || !feedItem.rating) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (feedItem.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const rating = feedItem.rating
  const wine = rating.wine
  const currentImage = rating.images[0] ?? null

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineName, producer, vintage, grape, type, score, flavors, aromas, notes,
    imageData, venueName, city, country, lat, lng, taggedUserIds,
    wineRegion, wineCountry, vinification, description, purchaseUrl,
    productId, vintageId } = body
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

  // Catalog link on edit — same two composed rules as the session wine PATCH
  // (explicit re-link wins; otherwise an identity-changing edit CLEARS the
  // link rather than keeping an incompatible one). Resolved before the txn:
  // the lookups can't affect its outcome and shouldn't hold it open.
  //
  // `wine` here is the full row (`wine: true` in the include above), so its
  // stored link is what the rule compares against.
  let catalogLink: { productId: string | null; vintageId: string | null }
  // Whether this request DECIDED the link (explicit re-link/clear, or the
  // identity-changing-edit rule firing) versus merely resolving to "unchanged".
  // Only a deliberate decision may overwrite what is live at write time.
  let catalogLinkIsDeliberate = false
  try {
    // Stored link passed so a partial link edit keeps the untouched grain —
    // see the session wine PATCH for the same rule.
    const explicit = (productId !== undefined || vintageId !== undefined)
      ? await resolveCatalogLink(productId, vintageId, wine)
      : null
    catalogLink = applyIdentityEditRule(
      {
        name: wine.name,
        producer: wine.producer ?? '',
        vintage: wine.vintage ?? '',
        productId: wine.productId,
        vintageId: wine.vintageId,
      },
      { name: wineName, producer, vintage },
      explicit,
    )
    catalogLinkIsDeliberate = explicit !== null
      || catalogLink.productId !== (wine.productId ?? null)
      || catalogLink.vintageId !== (wine.vintageId ?? null)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
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
        // Canonicalize, don't truncate — see lib/session.ts.
        vintage:  vintage  !== undefined ? (normalizeVintageText(scrub(vintage) ?? '') || null) : wine.vintage,
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
        //
        // 🔒 The catalog link is written ONLY when this request made a
        // DELIBERATE decision about it — an explicit re-link/clear, or the
        // identity-changing-edit rule firing. Writing it unconditionally looked
        // safe (with no explicit link and no identity change, `catalogLink`
        // resolves to the wine's CURRENT values, so the write is a no-op) but
        // those values come from a snapshot read BEFORE the transaction: a
        // concurrent re-link landing in between would be silently reverted by
        // this "no-op". Skipping the write entirely lets the concurrent value
        // stand, which is the correct outcome for an edit that never mentioned
        // the link. The condition must NOT be `productId !== undefined` — that
        // would skip the identity-changing CLEAR, which is the whole point of
        // the rule.
        ...(catalogLinkIsDeliberate
          ? { productId: catalogLink.productId, vintageId: catalogLink.vintageId }
          : {}),
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
// PG-only once expired or soft-deleted. Deliberately NOT touched: lifetime
// counters + HoF (an edit is not new activity), rater_name (frozen snapshot),
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
    const rows = await tx.$queryRaw<{ id: number; score: unknown; flavors: unknown; aromas: unknown; notes: string | null; style: string | null }[]>`
      SELECT r.id, r.score, r.flavors, r.aromas, r.notes, w.style FROM ratings r JOIN wines w ON w.id = r.wine_id
       WHERE r.user_id = ${userId} AND r.session_id = ${sessionId} AND r.wine_id = ${wineId} FOR UPDATE OF r`
    const rating = rows[0]
    if (!rating) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Liveness and the wine's CURRENT style, decided under the lock. Redis
    // trouble degrades to a PG-only edit — it must never fail the edit.
    let live = false
    let liveStyle: string | null = null
    if (liveCode) {
      try {
        live = await existsKey(k.meta(liveCode))
        if (live) liveStyle = (JSON.parse((await redis.get(k.wines(liveCode))) ?? '[]') as WineMeta[]).find(w => w.id === wineId)?.type ?? null
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
      const norm = gateAndFillFlavors(checkedFlavors, 'wine', liveStyle ?? rating.style)
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
      const urls = await engagementCascadeIn(tx, rating.id, 'empty-only')
      if (urls) { o.reaped = true; o.reclaim = urls }
    }
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
        const key = k.rating(liveCode, `u:${userId}`, wineId)
        if (o.reaped) await ratingKeyWrite(ctx, key, null)
        else {
          const pttl = Number(await redis.pTTL(k.meta(liveCode)))
          o.mirrored = await ratingKeyWrite(ctx, key, JSON.stringify({ score: o.nextScore ?? 0, flavors: o.nextFlavors, aromas: o.nextAromas, notes: o.nextNotes ?? '', at: versionTs }), { pxMs: pttl, onlyIfExists: true })
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
