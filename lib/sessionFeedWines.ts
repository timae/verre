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
import { decimalToNumber } from '@verre/core'
import { existsKey, k } from '@/lib/redis'
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
//
// `expired: true` mirrors the `deleted` short-circuit for blind
// sessions whose Redis lifespan (48h/72h/1w/unlimited) ran out before
// the host revealed. Once the session's Redis state is gone there is
// no live URL to reveal in and no off-session reveal API — leaving
// the post permanently redacted as "Wine N" with no recovery path.
// Treating expired-blind as auto-reveal is the safer default (a host
// who let their session expire has effectively authorised reveal,
// same as one who deleted it). Detection uses `detectExpiredCodes`
// below — `EXISTS` on both `s:CODE:meta` AND `s:CODE:wines` so a
// single-key LRU eviction (where `meta` is gone but `wines` survives)
// won't falsely trigger reveal on a still-live session. See
// docs/dev/proposals/rewire.md "Auto-reveal for blind sessions".
export type SessionFeedPair = {
  authorId: number
  sessionId: number
  blind: boolean
  // "Blind for all" — disables the host/own-wine bypass for blind
  // sessions. Composes with reveal: a revealed wine still un-redacts.
  // See lib/wineRedaction.ts for the live-route mirror.
  blindForEveryone: boolean
  deleted: boolean
  expired: boolean
  hostUserId: number | null
}

// Map key shape: `${authorId}:${sessionId}` so the caller can look up
// each feed_item's wines without reconstructing the join.
export function pairKey(authorId: number, sessionId: number): string {
  return `${authorId}:${sessionId}`
}

// Detect which of the given session codes have expired (Redis lifespan
// ran out). Returns a Set of codes whose `s:CODE:meta` AND `s:CODE:wines`
// keys are both gone — the two-key gate defends against an LRU policy
// that could evict `meta` alone on a still-live session and force a
// premature reveal. Caller passes only LIVE codes (deletedAt IS NULL,
// non-null code); tombstoned sessions short-circuit via `deleted` and
// don't need this check.
export async function detectExpiredCodes(codes: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (codes.length === 0) return out
  const unique = [...new Set(codes)]
  const results = await Promise.all(unique.map(async c => {
    const [meta, wines] = await Promise.all([existsKey(k.meta(c)), existsKey(k.wines(c))])
    return { code: c, alive: meta || wines }
  }))
  for (const r of results) if (!r.alive) out.add(r.code)
  return out
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
      aromas: true,
      notes: true,
      wine: {
        select: {
          id: true, name: true, producer: true, vintage: true,
          grape: true, style: true, imageUrl: true, revealedAt: true,
          addedByIdentityId: true,
          // Catalog metadata for the feed's full impression detail page.
          // Blanked on a redacted wine (below) so blind identity can't leak.
          region: true, country: true, vinification: true,
          description: true, purchaseUrl: true,
        },
      },
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { imageUrl: true } },
    },
    // Author's rating order (their tasting journey) — NOT the session line-up
    // order, which lives only in the Redis wines array (mutated by
    // /wines/reorder) and has no PG mirror. KNOWN DEVIATION: a blind wine's
    // "Wine N" label (clients render it by array index) can therefore
    // disagree with the live session's line-up numbering, and the feed
    // carousel order can diverge from the line-up after a reorder. No leak —
    // both surfaces mask identity — just cross-surface numbering. Right fix =
    // a PG line-up-position mirror (durable-sessions work), NOT a Redis
    // lookup here (same ruling as the deferred cohost-bypass gap: this loader
    // stays PG-only).
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
    // Redaction predicate mirrors lib/wineRedaction.ts: revealed wines
    // always win; non-blind never redacts; tombstoned AND expired-blind
    // sessions short-circuit to "always show" (see SessionFeedPair
    // comment for the why); when blindForEveryone is on the host/own-
    // wine bypasses are disabled.
    const bypass = !meta.blindForEveryone && (isHost || ownsWine)
    const redacted = !meta.deleted && !meta.expired && meta.blind && !revealed && !bypass
    const ratingImage = r.images[0]?.imageUrl ?? null
    const wireWine: SessionFeedWine = redacted
      ? {
          id: w.id,
          name: '',     // UI renders "Wine N" via index — see SessionFeedCard
          producer: null,
          vintage: null,
          grape: null,
          // Style (red/white/spark/rose) is NOT identity — a taster knows it's
          // sparkling from the glass. Expose it so the structure wheel offers the
          // right axes (e.g. Bubbles on a blind sparkling wine); the mystery slot
          // keys on `_blind`, not type. Consistent with lib/wineRedaction.ts.
          type: w.style,
          // Hide rating photo on a redacted wine — a label-bearing pour
          // photo would leak the identity. Per rewire.md §3 line 429.
          imageUrl: null,
          score: decimalToNumber(r.score),
          flavors: (r.flavors as Record<string, number>) ?? {},
          // Aromas are the taster's own perception, not wine identity —
          // they survive redaction like score/flavors (aroma-layer.md §7).
          aromas: (r.aromas as SessionFeedWine['aromas']) ?? [],
          notes: r.notes,
          // Catalog metadata is identity-bearing (region/process/buy point
          // straight at the wine) — blank it, same as name/producer above.
          region: null,
          country: null,
          vinification: null,
          description: null,
          purchaseUrl: null,
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
          aromas: (r.aromas as SessionFeedWine['aromas']) ?? [],
          notes: r.notes,
          region: w.region,
          country: w.country,
          vinification: w.vinification,
          description: w.description,
          purchaseUrl: w.purchaseUrl,
        }
    const arr = out.get(key)
    if (arr) arr.push(wireWine)
    else out.set(key, [wireWine])
  }

  return out
}
