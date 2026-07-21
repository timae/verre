import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@verre/core'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'
import { mutedUserIds } from '@/lib/userMute'
import { blockPairIds } from '@/lib/userBlock'
import { loadSessionFeedWines, detectExpiredCodes, pairKey, type SessionFeedPair } from '@/lib/sessionFeedWines'
import type { SessionFeedPayload } from '@/lib/feedTypes'

const PAGE = 20

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  // Defense-in-depth: the SQL below uses prisma.$queryRaw's tagged template
  // form which parameterizes ${userId}, so this is already safe. But TypeScript
  // can't prevent a future caller from sneaking a non-integer through (e.g. via
  // a header or refactor that bypasses Number()). Reject anything that isn't a
  // positive integer up front so the SQL only ever sees a sane value.
  if (!Number.isInteger(userId) || userId < 1) {
    return NextResponse.json({ error: 'invalid session' }, { status: 401 })
  }

  // cursor must parse as a finite Date; bad input → 400 not 500.
  const cursorParam = req.nextUrl.searchParams.get('cursor')
  let cursor: Date
  if (cursorParam) {
    const d = new Date(cursorParam)
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: 'invalid cursor' }, { status: 400 })
    cursor = d
  } else {
    cursor = new Date()
  }

  // My network: explicit follows + tasting buddies (shared sessions). The
  // ${userId} interpolations below are parameterized by Prisma's tagged
  // template handling, not concatenated into the SQL string.
  const network = await prisma.$queryRaw<{ user_id: number }[]>`
    SELECT DISTINCT user_id FROM (
      SELECT ${userId}::integer AS user_id
      UNION
      SELECT following_id AS user_id FROM follows WHERE follower_id = ${userId}
      UNION
      SELECT sm2.user_id
      FROM session_members sm1
      JOIN session_members sm2 ON sm2.session_code = sm1.session_code
      WHERE sm1.user_id = ${userId} AND sm2.user_id <> ${userId}
    ) n
  `
  const networkIds = network.map(r => r.user_id)
  if (!networkIds.length) return NextResponse.json({ items: [], nextCursor: null })

  // Visibility pre-filter: trim networkIds down to authors the viewer can
  // actually see per their profile-visibility tier. Done up front so the
  // cursor reflects visible count, not raw count — otherwise a page of 20
  // could collapse to a handful of rows after post-filtering.
  // Batched: one query for visibilities, one for follows-out, one for
  // follows-in, optionally one for FoF reachability. Cost is O(networkSize)
  // not O(rowsPerPage), and constant in number of roundtrips.
  //
  // Mute filter: applied in the same pass. The viewer's mute set is
  // independent of tier — a `public-internet` user the viewer muted
  // gets filtered out the same as a `public-mutual` user they aren't
  // allowed to see. Composed multiplicatively: both checks must pass.
  //
  // Block filter: composed in the same pass. Block-pair authors (either
  // direction — viewer blocked author OR author blocked viewer) are
  // dropped before the visibility tier even runs. Block is the strictest
  // primitive.
  const [visMap, viewerMap, muteSet, blockPairs] = await Promise.all([
    batchLoadVisibilities(networkIds),
    resolveProfileViewerBulk(networkIds, userId),
    mutedUserIds(userId),
    blockPairIds(userId),
  ])
  const fofCandidates = networkIds.filter(id => visMap.get(id)?.fofEnabled === true)
  const fofSet = fofCandidates.length > 0
    ? await viewerFofAuthorSet(userId, fofCandidates)
    : new Set<number>()
  const allowedNetworkIds = networkIds.filter(authorId => {
    // Self-visibility: viewer always sees their own content. (Self-mute
    // and self-block are both rejected at the API + DB level, so the
    // viewer can't appear in their own mute/block sets.)
    if (authorId === userId) return true
    if (blockPairs.blockedByMe.has(authorId) || blockPairs.blockingMe.has(authorId)) return false
    if (muteSet.has(authorId)) return false
    const settings = visMap.get(authorId)
    if (!settings) return false
    const base = viewerMap.get(authorId) ?? { id: userId, followsProfile: false, profileFollowsViewer: false }
    // Clone so we never mutate the shared map values; isFofOfProfile is
    // a per-call hint, not state to carry on the underlying ProfileViewer.
    const viewer = {
      id: base.id ?? userId,
      followsProfile: base.followsProfile,
      profileFollowsViewer: base.profileFollowsViewer,
      isFofOfProfile: settings.fofEnabled ? fofSet.has(authorId) : undefined,
    }
    return canViewProfile(settings.visibility, viewer, settings.fofEnabled)
  })
  if (!allowedNetworkIds.length) return NextResponse.json({ items: [], nextCursor: null })

  // Feed items — both kind='standalone' and kind='session' in one query.
  // Standalone renders via the existing CheckinCard; session renders as a
  // stub card until phase 3 ships the aggregate SessionFeedCard.
  //
  // Single Prisma query with explicit `include` — batched IN clauses for
  // the relations. Naive per-row accessors would N+1; the include shape
  // avoids it (one round-trip plus one per included relation, all
  // resolved via Prisma's WHERE … IN under the hood).
  const feedItems = await prisma.feedItem.findMany({
    where: { userId: { in: allowedNetworkIds }, createdAt: { lt: cursor } },
    include: {
      user: { select: { id: true, name: true, xp: true, imageUrl: true } },
      _count: { select: { likes: true } },
      tags: { include: { user: { select: { id: true, name: true } } } },
      rating: {
        include: {
          wine: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        },
      },
      // Session is included for kind='session' rendering — we read
      // deletedAt (tombstone label), name, blind (phase 3 redaction),
      // hostName + hostUserId (header byline + own-host bypass for the
      // SessionFeedCard wine join). `code` drives the expired-blind
      // detection (Redis meta key gone → auto-reveal short-circuit).
      session: {
        select: {
          id: true, code: true, deletedAt: true, name: true, blind: true, blindForEveryone: true,
          hostName: true, hostUserId: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: PAGE,
  })

  // Which of these feed_items has the current user already liked?
  const myLikes = new Set(
    (await prisma.feedItemLike.findMany({
      where: { userId, feedItemId: { in: feedItems.map(f => f.id) } },
      select: { feedItemId: true },
    })).map(l => l.feedItemId)
  )

  // Like-count adjustment for block-pair likes. Locked design: a like
  // by user X on a feed_item by user Y is invisible to ALL viewers (not
  // just the block-pair members) once a block exists between X and Y.
  // Globally symmetric — every viewer sees the same adjusted count.
  //
  // One batched query fetches the like-rows on the page's feed_items
  // that involve a block-pair edge between liker and feed_item author;
  // we subtract those from each feed_item's _count.likes.
  //
  // COUNT(DISTINCT fl.user_id) protects against a mutual A↔B block
  // (two user_blocks rows for the same pair) double-counting the same
  // like row.
  const feedItemIds = feedItems.map(f => f.id)
  const blockAdjustedLikeCount = new Map<number, number>()
  if (feedItemIds.length > 0) {
    const blockHiddenLikes = await prisma.$queryRaw<{ feed_item_id: number; n: bigint }[]>`
      SELECT fl.feed_item_id AS feed_item_id, COUNT(DISTINCT fl.user_id)::bigint AS n
      FROM feed_item_likes fl
      JOIN feed_items fi ON fi.id = fl.feed_item_id
      JOIN user_blocks b
        ON (b.blocker_id = fl.user_id AND b.blocked_id = fi.user_id)
        OR (b.blocker_id = fi.user_id AND b.blocked_id = fl.user_id)
      WHERE fl.feed_item_id = ANY(${feedItemIds}::int[])
      GROUP BY fl.feed_item_id
    `
    for (const r of blockHiddenLikes) blockAdjustedLikeCount.set(r.feed_item_id, Number(r.n))
  }

  // Set of viewer-follows-author — gates the "had a sip" button per row.
  const myFollowing = new Set(
    (await prisma.follow.findMany({
      where: { followerId: userId, followingId: { in: feedItems.map(f => f.user.id) } },
      select: { followingId: true },
    })).map(f => f.followingId)
  )

  // Block-pair tag filter is GLOBAL: a tag of user X on a feed_item by
  // author Y is invisible to ALL viewers (not just the viewer's
  // block-pair set) once X↔Y has a block in either direction. Locked
  // design — match the like-count rule.
  //
  // One batched query collects every (author, tag-user) pair from the
  // page that has a block-pair edge; we filter tags per feed_item.
  const tagAuthorPairs = feedItems.flatMap(f => f.tags.map(t => ({ authorId: f.user.id, tagUserId: t.user.id })))
  // hiddenAuthorTag is a Set of "authorId:tagUserId" strings — fast O(1) lookup at render.
  const hiddenAuthorTag = new Set<string>()
  if (tagAuthorPairs.length > 0) {
    const authorIds = [...new Set(tagAuthorPairs.map(p => p.authorId))]
    const tagUserIds = [...new Set(tagAuthorPairs.map(p => p.tagUserId))]
    const rows = await prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: { in: authorIds }, blockedId: { in: tagUserIds } },
          { blockerId: { in: tagUserIds }, blockedId: { in: authorIds } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    for (const r of rows) {
      // Add both orderings — we'll look up by (author, tagUser) regardless
      // of which side of the user_blocks row the author was on.
      hiddenAuthorTag.add(`${r.blockerId}:${r.blockedId}`)
      hiddenAuthorTag.add(`${r.blockedId}:${r.blockerId}`)
    }
  }

  // Per-wine ratings for kind='session' feed_items, in one bulk query
  // (one query per page, not per session post). Server-side redaction
  // applied — never ship unrevealed blind-wine identity over the wire.
  // Tombstoned sessions short-circuit redaction (see SessionFeedPair
  // comment for the trade-off); the session-level identity (name + host)
  // is still scrubbed at the payload layer below.
  // Expired-blind detection — see SessionFeedPair `expired` comment for
  // the why. Tombstoned sessions (deletedAt set, code scrubbed) already
  // short-circuit via `deleted` so skip them here.
  const expiredCodes = await detectExpiredCodes(
    feedItems
      .filter(f => f.kind === 'session' && f.session && !f.session.deletedAt && f.session.code)
      .map(f => f.session!.code!)
  )

  const sessionPairs: SessionFeedPair[] = feedItems.flatMap(f => {
    if (f.kind !== 'session' || !f.session) return []
    return [{
      authorId: f.user.id,
      sessionId: f.session.id,
      blind: !!f.session.blind,
      blindForEveryone: !!f.session.blindForEveryone,
      deleted: !!f.session.deletedAt,
      expired: f.session.code != null && expiredCodes.has(f.session.code),
      hostUserId: f.session.hostUserId ?? null,
    }]
  })
  const sessionWines = await loadSessionFeedWines(sessionPairs, userId)

  // Badge unlocks used to merge in as standalone 'badge' feed items.
  // Removed: they cluttered the feed and didn't carry the context of
  // which post triggered them. The /me/badges surface remains the
  // canonical place to see what someone has earned. Inline badge
  // attribution on the triggering post is tracked as a follow-up.

  // Merge and sort. Two discriminated payload shapes:
  //   - 'checkin' — standalone feed_items (kind='standalone'). Renders
  //     via the existing CheckinCard. checkin.id is now the feed_item.id;
  //     the migration preserves id-equality with the legacy checkins.id
  //     so cached client URLs (PATCH/DELETE, like) keep working.
  //   - 'session' — session feed_items (kind='session'). Phase 3 carries
  //     a per-wine `wines: SessionFeedWine[]` array (server-side redacted
  //     for blind sessions). Tombstoned sessions collapse to deleted=true
  //     with wines=[] and the renderer shows "[deleted session]".
  type OutgoingItem =
    | { type: 'checkin'; createdAt: Date; author: { id: number; name: string; xp: number; imageUrl: string | null }; checkin: Record<string, unknown> }
    | { type: 'session'; createdAt: Date; author: { id: number; name: string; xp: number; imageUrl: string | null }; session: SessionFeedPayload }
  const items: OutgoingItem[] = [
    ...feedItems.flatMap((f): OutgoingItem[] => {
      if (f.kind === 'standalone') {
        if (!f.rating) return []  // defensive — schema invariant says standalone has ratingId set
        const wine = f.rating.wine
        const ratingImage = f.rating.images[0]?.imageUrl ?? null
        return [{
          type: 'checkin' as const,
          createdAt: f.createdAt,
          author: f.user,
          checkin: {
            id: f.id,
            wineName: wine.name,
            producer: wine.producer,
            vintage: wine.vintage,
            grape: wine.grape,
            type: wine.style,
            score: decimalToNumber(f.rating.score),
            notes: f.rating.notes,
            // Image priority: the rating's own photo first (the user's
            // tasting photo), falling back to the wine's canonical bottle
            // shot (host-curated; null for standalone wines today).
            imageUrl: ratingImage ?? wine.imageUrl,
            venueName: f.venueName,
            city: f.city,
            // `country` is the VENUE country (where they had it) — the location
            // line (venueName · city · country). Distinct from the WINE's
            // origin below.
            country: f.country,
            // Wine-catalog metadata for the detail page's "About this
            // impression" block (parity with SessionFeedWine). `wine: true`
            // already loads these columns; a standalone check-in is never blind,
            // so no redaction fork. `wineRegion`/`wineCountry` are the WINE's
            // ORIGIN (Origin row) — deliberately NOT `f.country` (the venue), a
            // conflation the old standalone card had.
            wineRegion: wine.region,
            wineCountry: wine.country,
            vinification: wine.vinification,
            description: wine.description,
            purchaseUrl: wine.purchaseUrl,
            // Canonical product link (standalone is never blind → no fork).
            productId: wine.productId,
            flavors: f.rating.flavors,
            // Wire format is plain {a, m, p?} objects (JSON column — no
            // Decimal trap). Never redacted: a standalone is never blind.
            aromas: f.rating.aromas ?? [],
            likeCount: Math.max(0, f._count.likes - (blockAdjustedLikeCount.get(f.id) ?? 0)),
            createdAt: f.createdAt,
            // Tag filter: drop GLOBALLY block-pair tags. Same rule as
            // the like-count subtraction. Render-time only — the tag row
            // stays in DB.
            tags: f.tags.filter(t => !hiddenAuthorTag.has(`${f.user.id}:${t.user.id}`)).map(t => t.user),
            liked: myLikes.has(f.id),
            viewerFollowsAuthor: myFollowing.has(f.user.id),
          },
        }]
      }
      if (f.kind === 'session') {
        const s = f.session
        const deleted = !!s?.deletedAt
        // Tombstoned sessions still ship their per-wine list (the post
        // is a preserved record); only the session-level identity
        // (name + host) is scrubbed. Per-wine identity is still gated
        // by the blind/revealed predicate inside loadSessionFeedWines.
        const wines = !s ? [] : (sessionWines.get(pairKey(f.user.id, s.id)) ?? [])
        // A LIVE session post with no wines has nothing to render (the
        // author's ratings were cascade-deleted — e.g. the host deleted the
        // only wine they'd rated; no app-level feed_items cleanup runs on that
        // path). Drop it rather than ship a contentless shell. Tombstoned
        // posts pass through regardless: their ratings survive the session
        // scrub and the "[deleted session]" render is deliberate.
        if (!deleted && wines.length === 0) return []
        return [{
          type: 'session' as const,
          createdAt: f.createdAt,
          author: f.user,
          session: {
            id: f.id,
            sessionId: s?.id ?? null,
            // §8 contract: when soft-deleted, name + hostName + code are
            // scrubbed. Renderer shows the "[deleted session]" header in
            // place of the live name; the wine list still renders.
            sessionName: deleted ? null : (s?.name ?? null),
            hostName: deleted ? null : (s?.hostName ?? null),
            deleted,
            blind: !!s?.blind,
            wines,
            likeCount: Math.max(0, f._count.likes - (blockAdjustedLikeCount.get(f.id) ?? 0)),
            liked: myLikes.has(f.id),
          },
        }]
      }
      return []  // unknown kind — drop defensively
    }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, PAGE)

  // "More rows may exist" keys on whether the RAW page filled — NOT on how
  // many items survived the render filters (the empty-live-session drop above,
  // the defensive kind/rating drops). Filtering must advance the cursor, never
  // terminate paging: keying on items.length would return nextCursor:null the
  // moment one row on a full page got dropped, hiding every older post. The
  // cursor is the last RAW row's createdAt so dropped trailing rows aren't
  // rescanned; a page may ship fewer than PAGE items with a non-null cursor —
  // clients just keep paging.
  const nextCursor = feedItems.length === PAGE
    ? feedItems[feedItems.length - 1].createdAt.toISOString()
    : null

  // Response varies by viewer (myLikes, viewerFollowsAuthor, tag filter,
  // like-count adjustment all depend on the calling user). Force
  // private no-store so a CDN can't serve one viewer's feed to another.
  return NextResponse.json(
    { items, nextCursor },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
