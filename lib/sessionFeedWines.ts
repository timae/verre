// Bulk loader for the per-wine ratings inside a SessionFeedCard.
//
// Why bulk: a feed page can carry N session feed_items from N authors;
// the naive shape (one query per item) would N+1. This collects every
// (authorId, sessionId) pair on the page and runs ONE prisma.rating
// query against the union, then groups the results.
//
// Server-side redaction is applied here — never ship unrevealed wine
// identity over the wire. The redaction predicate mirrors the live
// session view (lib/wineRedaction.ts):
//   redacted = session.blind && wine.revealedAt is NULL
//              && viewer is not the host && viewer doesn't own the wine
// Host bypass + own-wine bypass match the live route's contract so the
// host's profile / feed shows their own session post un-redacted.

import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@/lib/decimal'
import type { SessionFeedWine } from '@/lib/feedTypes'

// Input record per session feed_item. `blind`, `hostUserId`, and
// `deleted` come from the included `session` row on the feed_item;
// pass them in so the helper doesn't need to re-read them.
//
// Tombstoned sessions (`deleted: true`) always render their wines fully
// — the live blind invariant only matters while the session is active.
// A host who deletes a blind session pre-reveal accepts that the
// preserved post records reveal the wine identity to participants.
// (Trade-off: deletes are rare and host-initiated; the alternative
// "treat scrubbed-blind as blind" over-redacts non-blind sessions
// forever because non-blind wines never have `revealedAt` set.)
export type SessionFeedPair = {
  authorId: number
  sessionId: number
  blind: boolean
  deleted: boolean
  hostUserId: number | null
}

// Map key shape: `${authorId}:${sessionId}` so the caller can look up
// each feed_item's wines without reconstructing the join.
export function pairKey(authorId: number, sessionId: number): string {
  return `${authorId}:${sessionId}`
}

export async function loadSessionFeedWines(
  pairs: SessionFeedPair[],
  viewerUserId: number | null,
): Promise<Map<string, SessionFeedWine[]>> {
  const out = new Map<string, SessionFeedWine[]>()
  if (pairs.length === 0) return out

  // Single OR-of-AND query covering every pair on the page. Backed
  // by the (user_id, session_id) composite index on `ratings`.
  const ratings = await prisma.rating.findMany({
    where: {
      OR: pairs.map(p => ({ userId: p.authorId, sessionId: p.sessionId })),
    },
    select: {
      userId: true,
      sessionId: true,
      score: true,
      flavors: true,
      notes: true,
      wine: {
        select: {
          id: true, name: true, producer: true, vintage: true,
          grape: true, style: true, imageUrl: true, revealedAt: true,
          addedByIdentityId: true,
        },
      },
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { imageUrl: true } },
    },
    orderBy: { ratedAt: 'asc' },
  })

  // Index pairs by key for O(1) lookup of blind / hostUserId per group.
  const pairMeta = new Map<string, SessionFeedPair>()
  for (const p of pairs) pairMeta.set(pairKey(p.authorId, p.sessionId), p)

  // Null viewer = unauthenticated path (no host bypass, no own-wine
  // bypass). Sentinel string can't match a real identity-id.
  const viewerIdentity = viewerUserId == null ? null : `u:${viewerUserId}`

  for (const r of ratings) {
    if (r.userId == null || r.sessionId == null) continue  // standalone tastings can't reach this loop (no matching pair)
    const key = pairKey(r.userId, r.sessionId)
    const meta = pairMeta.get(key)
    if (!meta) continue
    const w = r.wine
    const revealed = w.revealedAt != null
    const isHost = viewerUserId != null && meta.hostUserId === viewerUserId
    const ownsWine = viewerIdentity != null
      && !!w.addedByIdentityId
      && w.addedByIdentityId === viewerIdentity
    // Redaction predicate identical to lib/wineRedaction.ts: any
    // bypass wins. If non-blind session, redaction never fires.
    // Tombstoned sessions short-circuit to "always show" — see the
    // SessionFeedPair comment for the trade-off.
    const redacted = !meta.deleted && meta.blind && !revealed && !isHost && !ownsWine
    const ratingImage = r.images[0]?.imageUrl ?? null
    const wireWine: SessionFeedWine = redacted
      ? {
          id: w.id,
          name: '',     // UI renders "Wine N" via index — see SessionFeedCard
          producer: null,
          vintage: null,
          grape: null,
          type: null,
          // Hide rating photo on a redacted wine — a label-bearing pour
          // photo would leak the identity. Per rewire.md §3 line 429.
          imageUrl: null,
          score: decimalToNumber(r.score),
          flavors: (r.flavors as Record<string, number>) ?? {},
          notes: r.notes,
          _blind: true,
        }
      : {
          id: w.id,
          name: w.name,
          producer: w.producer,
          vintage: w.vintage,
          grape: w.grape,
          type: w.style,
          imageUrl: ratingImage ?? w.imageUrl,
          score: decimalToNumber(r.score),
          flavors: (r.flavors as Record<string, number>) ?? {},
          notes: r.notes,
        }
    const arr = out.get(key)
    if (arr) arr.push(wireWine)
    else out.set(key, [wireWine])
  }

  return out
}
