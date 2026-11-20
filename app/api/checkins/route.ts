import { NextRequest, NextResponse } from 'next/server'
import { imageKey } from '@/lib/imageKeys'
import { parseTagList, resolveTagList, publicIdFor } from '@/lib/publicIds'
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors } from '@/lib/flavours'
import { gateAromas } from '@/lib/aromas'
// From textSafe, NOT lib/session — importing session here would connect
// Redis at module load just to use two pure sanitizers (codex finding).
import { cleanUrl } from '@/lib/textSafe'
import { validateScore, decimalToNumber } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { scrub } from '@/lib/textSafe'
import { viewerCanSeePosts } from '@/lib/profileVisibility'
import { CatalogValidationError } from '@/lib/catalogWrite'
import { isClientOccurrenceId } from '@/lib/occurrences'
import { prepareLink, applyLink, linkRequired, type AppliedLink } from '@/lib/catalogLink'
import { linkableLink, loadEntries, entryKey } from '@/lib/catalogEntries'

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
async function copyImageFromCheckin(sourceUrl: string): Promise<string | null> {
  if (!_s3 || !_S3_BUCKET || !_S3_ENDPOINT) return null
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!sourceUrl.startsWith(prefix)) return null
  const sourceKey = sourceUrl.slice(prefix.length)
  // Whitelist key shape — legitimate keys never contain reserved chars, so
  // anything unusual is rejected before we hand it to S3.
  if (!/^wines\/[A-Za-z0-9_.\-]+$/.test(sourceKey)) return null
  const ext = sourceKey.split('.').pop() || 'jpg'
  // 🔒 A random key with nothing that points to the person (D2,
  // lib/imageKeys.ts): the bucket is public, so a key must not be guessable.
  const newKey = `${imageKey('checkin')}.${ext}`
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
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-ins. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  // `wineRegion`/`wineCountry` are the WINE's origin — named to stay distinct
  // from `country`, which is the VENUE country (same split the feed payload
  // makes). vinification/description/purchaseUrl land on the minted wine row,
  // giving a standalone check-in the same About-block metadata as a session
  // wine (the feed read path already surfaces them from the wine columns).
  // 🔒 The wine itself is a catalogue link (catalogue model change step 4,
  // lib/catalogLink.ts): `productId` (+ `vintageId`) picks an entry, `create`
  // mints one (the add-flow body); "had a sip" takes its SOURCE's link. Typed
  // identity text (wineName, producer, vintage, grape, type, wineRegion,
  // wineCountry) is ignored: the bottle's snapshot is the entry's.
  const { occurrenceId, score, flavors, aromas, notes, imageData, copyFromCheckinId, copyPhoto, venueName, city, country, lat, lng, taggedUserIds: rawTags, vinification, description, purchaseUrl } = body
  // 🔒 The client mints the occurrence id (model change § 8a): a check-in
  // retried after a lost response replays the WHOLE check-in (occurrence,
  // rating, feed item) instead of adding a second one. The photo is not part of
  // a create: it attaches through PATCH /api/checkins/<id> with `imageData`.
  if (!isClientOccurrenceId(occurrenceId)) return NextResponse.json({ error: 'occurrenceId required' }, { status: 400 })
  if (imageData !== undefined && imageData !== null && imageData !== '') {
    return NextResponse.json({ error: 'add the photo with its own call, after the check-in' }, { status: 400 })
  }
  // 🔒 Public ids, resolved BEFORE the transaction (lib/publicIds.ts parseTagList).
  const tagPublicIds = parseTagList(rawTags)
  if (tagPublicIds === null) return NextResponse.json({ error: 'invalid taggedUserIds' }, { status: 400 })
  const taggedUserIds = await resolveTagList(tagPublicIds)
  // Per-field length caps mirror the column widths in `prisma/schema.prisma`
  // for the Checkin model. Reject oversize input here so we return a
  // clean 400 instead of letting Prisma raise P2000 (which we'd surface
  // as 500). Free-text `notes` has no DB cap; bound it conservatively.
  // Caps mirror the Prisma column widths to reject oversize input
  // here as 400 instead of letting Prisma raise P2000 (→ 500).
  // city: VarChar(100), country: Char(2) (sliced to 2 below).
  const lenCheck: Array<[string, unknown, number]> = [
    ['venueName', venueName, 200], ['city', city, 100], ['country', country, 8],
    ['notes', notes, 4000],
    // The bottle's own fields mirror the wines columns (VarChar(1000)).
    ['vinification', vinification, 1000], ['description', description, 1000],
    ['purchaseUrl', purchaseUrl, 1000],
  ]
  for (const [k, v, max] of lenCheck) {
    if (typeof v === 'string' && v.length > max) return NextResponse.json({ error: `${k} too long (max ${max})` }, { status: 400 })
  }
  const scoreCheck = validateScore(score); if (scoreCheck.error) return NextResponse.json({ error: scoreCheck.error }, { status: 400 })
  const flavorsCheck = validateFlavors(flavors); if (flavorsCheck.error) return NextResponse.json({ error: flavorsCheck.error }, { status: 400 })
  // Aromas through the same chokepoint as the session rate route (aroma-
  // layer.md §5): unknown node / disallowed modifier / explicit null → 400,
  // loudly. On CREATE there is no stored prior, so present-replaces /
  // omitted-preserves collapses to "omitted = []" (the column default).
  const aromasCheck = gateAromas(aromas); if (aromasCheck.error) return NextResponse.json({ error: aromasCheck.error }, { status: 400 })
  const ratingAromas = aromasCheck.value ?? []

  // A retry of a check-in that already committed is answered BEFORE any
  // source-dependent work (Codex r1: a "had a sip" retry whose source was
  // deleted meanwhile would otherwise fail its copy check); the conflict path
  // in the transaction still decides a concurrent fresh create.
  if ((await prisma.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM wines WHERE id = ${occurrenceId}`)[0]) {
    const replay = await existingCheckin(occurrenceId, userId)
    if (!replay) return NextResponse.json({ error: 'that id belongs to another check-in' }, { status: 409 })
    return NextResponse.json(replay.body, { status: 200 })
  }

  let imageUrl: string | null = null
  let sourceLink: { productId: string; vintageId: string | null } | null = null
  if (Number.isInteger(copyFromCheckinId) && copyFromCheckinId > 0 && copyFromCheckinId <= 2_147_483_647) {
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
            wine: { select: { imageUrl: true, productId: true, vintageId: true } },
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
    // The POST gate (profile tier + Check-Ins Visible To), like the like POST.
    if (!(await viewerCanSeePosts(userId, source.userId))) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    const follows = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: source.userId } },
      select: { followerId: true },
    })
    if (!follows) {
      return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
    // 🔒 The copy is the SAME wine: it takes the source's link server-side
    // (merges followed, a vintage moved to the survivor's year), never the
    // body's. A source with nothing linkable left (purged, rejected) needs a
    // link in the body like any check-in.
    sourceLink = await linkableLink(source.rating.wine)
    // Nothing linkable left on the source and no link in the body: refused
    // BEFORE the photo is copied (review r1: a copy then a reclaim per try).
    if (!sourceLink && body.productId === undefined && body.vintageId === undefined && body.create === undefined) {
      return linkRequired()
    }
    // Source image priority: the rating's first attached image if present
    // (the user's tasting photo), else the wine's canonical bottle shot.
    const sourceImageUrl = source.rating.images[0]?.imageUrl || source.rating.wine.imageUrl
    // `copyPhoto: false`: the sipper replaced or removed the photo (theirs
    // follows through the PATCH); the wine is still the source's.
    if (sourceImageUrl && copyPhoto !== false) {
      imageUrl = await copyImageFromCheckin(sourceImageUrl)
      if (!imageUrl) return NextResponse.json({ error: COPY_ERROR }, { status: 400 })
    }
  }

  // Build the new-model writes. Path B per rewire.md §5: fresh wine +
  // rating + feed_item + rating_images, the wine row (the occurrence) linked
  // to its catalogue entry.
  //
  // Identifiers:
  //   - wines.id: the client's occurrence id (replay, model change § 8a).
  //   - feed_items.id: autoincrement; the migration preserves
  //     `feed_items.id = source.checkins.id` for backfilled rows, so the
  //     "had a sip" copyFromCheckinId id-equality story is preserved.
  //   - ratings.id: autoincrement.
  const wineId = occurrenceId
  const linkReq = sourceLink
    ? { kind: 'pick' as const, ...sourceLink }
    : await prepareLink(req, body, { userId, identityId: `u:${userId}`, pickRate: false, required: true })
  if (linkReq instanceof NextResponse) {
    if (imageUrl) reclaimImage(imageUrl)
    return linkReq
  }
  if (linkReq.kind === 'none') return linkRequired()
  const scrubNotes = scrub(notes) || null
  const scrubVenue = scrub(venueName) || null
  const scrubCity = scrub(city) || null
  const scrubCountry = scrub(country)?.slice(0, 2).toUpperCase() || null
  // The bottle's own fields (ruled 2026-11-20: About and vinification stay on
  // the bottle): cleanUrl defangs to http(s)-only and can EXPAND its input via
  // the https:// auto-prefix, so re-bound to the column width after.
  const scrubVinification = scrub(vinification) || null
  const scrubDescription = scrub(description) || null
  const cleanPurchaseUrl = cleanUrl(purchaseUrl).slice(0, 1000) || null
  const ratingScore = scoreCheck.value

  // locationPublic = true iff any location field is non-null (per
  // rewire.md §5: "true if any location field is non-NULL else false").
  // Public/private session location toggle UI is post-rewire; this is the
  // default for standalone check-ins, where the user supplied the venue.
  const hasLocation = !!(scrubVenue || scrubCity || scrubCountry || lat != null || lng != null)

  // Sentinel error used by the txn to surface "user disappeared" without
  // bubbling as a generic 500. Caught by the awaiting code below.
  const USER_MISSING = Symbol('user-missing')

  // The existing check-in behind this occurrence id: the caller's → replayed
  // (its stored envelope, 200); anyone else's, or a session bottle → 409.
  const EXISTS = Symbol('exists')
  const BAD_LINK = 'BAD_LINK'
  let ratingFlavors: Record<string, number> = {}
  try {
    await prisma.$transaction(async (tx) => {
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
    // 1. The catalogue link: a create mints here (its review items with it;
    //    rolled back if anything below fails, so a retried or refused check-in
    //    leaves no stray entry), then the entry is read for the snapshot.
    let applied: AppliedLink
    try { applied = await applyLink(tx, linkReq, userId) }
    catch (err) { if (err instanceof CatalogValidationError) throw Object.assign(new Error(err.message), { code: BAD_LINK }); throw err }
    // Server-side flavour normalisation (§6g gate + §5 zero-fill —
    // gateAndFillFlavors): only structure keys for this bottle's KIND may land
    // (Bubbles from the entry's `sparkling`), filled-or-empty by construction.
    const norm = gateAndFillFlavors(flavorsCheck.value, 'wine', { sparkling: applied.snapshot.sparkling })
    if (norm.error) throw Object.assign(new Error(norm.error), { code: BAD_LINK })
    ratingFlavors = norm.value ?? {}
    // 2. Mint the wine row (the occurrence): sessionId NULL, origin
    //    'standalone', the snapshot from the entry. `wines.imageUrl` stays NULL
    //    (the user's photo lives in rating_images). INSERT-only on the client
    //    id: a concurrent duplicate waits on the unique index for this one's
    //    COMMIT, then finds the row and rolls this transaction (and its mint)
    //    back (below).
    const snap = applied.snapshot
    const minted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO wines (id, session_id, origin, name, producer, vintage, grape, style, colour, sparkling, abv, category, image_url,
                         region, country, vinification, description, purchase_url, product_id, vintage_id)
      VALUES (${wineId}, NULL, 'standalone', ${snap.name.slice(0, 255)}, ${snap.producer.slice(0, 255) || null}, ${snap.vintage || null},
              ${snap.grape || null}, ${snap.type || null}, ${snap.colour}, ${snap.sparkling}, ${snap.abv}::numeric, 'wine', NULL,
              ${snap.region || null}, ${snap.country || null}, ${scrubVinification}, ${scrubDescription}, ${cleanPurchaseUrl},
              ${applied.productId}, ${applied.vintageId})
      ON CONFLICT (id) DO NOTHING
      RETURNING id`
    if (!minted[0]) throw EXISTS
    // 3. Mint the rating. origin='standalone', sessionId=NULL. One rating
    //    per standalone occurrence (the raw partial unique
    //    ratings_standalone_wine_id_key, catalogue model change step 2):
    //    tasting the same wine again is a new check-in, so a new wine row
    //    (step 1) with its own rating — the aging-bottle case.
    const r = await tx.rating.create({
      data: {
        wineId,
        userId,
        sessionId: null,
        origin: 'standalone',
        raterName: userRow.name,
        score: ratingScore,
        flavors: ratingFlavors,
        aromas: ratingAromas,
        notes: scrubNotes,
        ratedAt: new Date(),
      },
    })
    // 4. Mint the feed_item. kind='standalone'; ratingId points at the new
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
    // 5. Attach the rating_image if we have one. sortOrder=0 (single
    //    image today; the column exists for future multi-photo support).
    if (imageUrl) {
      await tx.ratingImage.create({
        data: { ratingId: r.id, imageUrl, sortOrder: 0 },
      })
    }
    // 6. The tags, in the same transaction: a replayed check-in answers what
    //    was stored and never writes them again (review r1: a late duplicate
    //    would re-add tags the owner removed since).
    await writeTags(tx, fi.id, userId, taggedUserIds)
    })
  } catch (err) {
    if (err === EXISTS) {
      if (imageUrl) reclaimImage(imageUrl)
      const replay = await existingCheckin(wineId, userId)
      if (!replay) return NextResponse.json({ error: 'that id belongs to another check-in' }, { status: 409 })
      return NextResponse.json(replay.body, { status: 200 })
    }
    // Reclaim the orphan S3 copy that landed before the txn opened
    // (the upload is the only "external" side-effect; everything inside
    // the txn rolls back). Fire on every catch path — not just
    // USER_MISSING — because any txn failure (FK violation on
    // category_styles, Prisma connection blip, etc.) leaves the same
    // orphan bytes with no recovery if we don't reclaim here.
    if (imageUrl) reclaimImage(imageUrl)
    if (err === USER_MISSING) {
      return NextResponse.json({ error: 'user not found' }, { status: 401 })
    }
    if ((err as { code?: string })?.code === BAD_LINK) return NextResponse.json({ error: (err as Error).message }, { status: 400 })
    throw err
  }
  // The answer is the stored check-in's envelope, the same one a replay gets.
  const stored = await existingCheckin(wineId, userId)
  // Committed, but its envelope could not be read: a 500 (the outcome is
  // uncertain for the client, which then keeps its choice frozen), never a 404.
  if (!stored) return NextResponse.json({ error: 'Posted, but the answer could not be read. Reload.' }, { status: 500 })
  return NextResponse.json(stored.body, { status: 201 })
}

// Tags as feed_item_tags — only mutual follows (verify server-side). Block-pair
// members are excluded from the write: tagging a user the author block-pairs
// with shouldn't persist a row that the render-time filter would then hide
// globally anyway. Inside the create's transaction.
async function writeTags(tx: Prisma.TransactionClient, feedItemId: number, userId: number, taggedUserIds: number[]) {
  if (taggedUserIds.length === 0) return
  const mutuals = await tx.$queryRaw<{ id: number }[]>`
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
    await tx.feedItemTag.createMany({
      data: validIds.map(uid => ({ feedItemId, userId: uid })),
      skipDuplicates: true,
    })
  }
}

// The stored check-in of a standalone occurrence when it is the caller's: the
// same envelope as a create (replay, model change § 8a). null = not theirs, or
// not a check-in (a session bottle, an orphan).
async function existingCheckin(wineId: string, userId: number): Promise<{ feedItemId: number; body: Record<string, unknown> } | null> {
  const rows = await prisma.$queryRaw<{
    feed_id: number; created_at: Date; venue_name: string | null; city: string | null; country: string | null; lat: unknown; lng: unknown
    name: string; producer: string | null; vintage: string | null; grape: string | null; colour: string | null; sparkling: boolean; abv: unknown
    product_id: string | null; vintage_id: string | null
    region: string | null; wine_country: string | null; vinification: string | null; description: string | null; purchase_url: string | null
    score: unknown; flavors: unknown; aromas: unknown; notes: string | null; image_url: string | null
  }[]>`
    SELECT fi.id AS feed_id, fi.created_at, fi.venue_name, fi.city, fi.country, fi.lat, fi.lng,
           w.name, w.producer, w.vintage, w.grape, w.colour, w.sparkling, w.abv, w.product_id, w.vintage_id,
           w.region, w.country AS wine_country, w.vinification,
           w.description, w.purchase_url, r.score, r.flavors, r.aromas, r.notes,
           (SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = r.id ORDER BY ri.sort_order LIMIT 1) AS image_url
      FROM wines w
      JOIN ratings r ON r.wine_id = w.id AND r.session_id IS NULL AND r.user_id = ${userId}
      JOIN feed_items fi ON fi.rating_id = r.id AND fi.kind = 'standalone' AND fi.user_id = ${userId}
     WHERE w.id = ${wineId} AND w.session_id IS NULL AND w.origin = 'standalone'`
  const x = rows[0]
  if (!x) return null
  // The catalogue entry, merges followed (lib/catalogEntries.ts).
  const entry = x.product_id ? (await loadEntries([{ productId: x.product_id, vintageId: x.vintage_id }])).get(entryKey(x.product_id, x.vintage_id)) ?? null : null
  return {
    feedItemId: x.feed_id,
    body: {
      id: x.feed_id,
      userId: (await publicIdFor(userId)) ?? null,
      wineName: x.name,
      producer: x.producer,
      vintage: x.vintage?.trim() || null,
      grape: x.grape,
      // The bottle's kind (its snapshot) and alcohol; the catalogue identity
      // under `entry` (no legacy `type`, catalogue model change step 4).
      colour: x.colour,
      sparkling: x.sparkling,
      abv: x.abv === null ? null : Number(x.abv),
      entry,
      score: decimalToNumber(x.score as never),
      flavors: x.flavors ?? {},
      aromas: Array.isArray(x.aromas) ? x.aromas : [],
      notes: x.notes,
      imageUrl: x.image_url,
      venueName: x.venue_name,
      city: x.city,
      country: x.country,
      // Decimal(9,6) → a JSON string unless coerced (the Decimal trap).
      lat: x.lat === null ? null : Number(x.lat),
      lng: x.lng === null ? null : Number(x.lng),
      wineRegion: x.region,
      wineCountry: x.wine_country,
      vinification: x.vinification,
      description: x.description,
      purchaseUrl: x.purchase_url,
      createdAt: x.created_at.toISOString(),
    },
  }
}
