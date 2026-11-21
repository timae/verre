// Bulk loader for the per-wine ratings inside a SessionFeedCard.
//
// Why bulk: a feed page can carry N session feed_items from N authors;
// the naive shape (one query per item) would N+1. This collects every
// (authorId, sessionId) pair on the page and runs ONE prisma.rating
// query against the union, then groups the results.
//
// Server-side redaction is applied here — never ship unrevealed wine
// identity over the wire. 🔒 What a bottle may show outside its moment is
// decided by ONE SQL rule (lib/outsideView.ts, lists plan D4), read for the
// page's ratings in one raw query: `redacted` → a blind row, `hidden` (the
// line-up is hidden from this viewer) → left out. No TypeScript twin of the
// rule lives here (two rules on two clocks drift).

import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@verre/core'
import { outsideViewSql } from '@/lib/outsideView'
import { entryKey, loadEntriesSoft, type CatalogEntry } from '@/lib/catalogEntries'
import { entryYear } from '@/lib/wineDisplay'
import { savedFlags } from '@/lib/cravings'
import type { SessionFeedWine } from '@/lib/feedTypes'

// One session feed_item: its author and its moment. Everything the rule needs
// is read from the record by the SQL, never passed in.
export type SessionFeedPair = {
  authorId: number
  sessionId: number
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
      id: true,
      userId: true,
      sessionId: true,
      score: true,
      flavors: true,
      aromas: true,
      notes: true,
      wine: {
        select: {
          id: true, name: true, producer: true, vintage: true, productId: true, vintageId: true,
          grape: true, style: true, colour: true, sparkling: true, abv: true, imageUrl: true,
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

  const flags = new Map<number, { redacted: boolean; hidden: boolean }>()
  if (ratings.length > 0) {
    const { redacted, hidden } = outsideViewSql(viewerUserId, { s: 's', w: 'w' })
    const rows = await prisma.$queryRaw<{ id: number; redacted: boolean; hidden: boolean }[]>`
      SELECT r.id, ${redacted} AS redacted, ${hidden} AS hidden
        FROM ratings r
        JOIN wines w ON w.id = r.wine_id
        LEFT JOIN sessions s ON s.id = r.session_id
       WHERE r.id = ANY(${ratings.map(r => r.id)}::int[])`
    for (const f of rows) flags.set(f.id, { redacted: f.redacted, hidden: f.hidden })
  }

  // What a visible bottle shows: its catalogue entry (merges followed), else
  // its snapshot. Never read for a redacted one.
  const entries = await loadEntriesSoft(ratings.filter(r => flags.get(r.id)?.redacted === false).map(r => ({ productId: r.wine.productId, vintageId: r.wine.vintageId })))
  const entryOf = (w: { productId: string | null; vintageId: string | null }): CatalogEntry | undefined => (w.productId ? entries.get(entryKey(w.productId, w.vintageId)) : undefined)
  // The viewer's save state per bottle (one statement; a redacted row reads
  // only the viewer's save of that bottle). Fail-soft: no flag on a failure.
  let saved: Map<string, boolean> | null = null
  if (viewerUserId !== null) {
    const seen = new Map<string, { id: string; hidden: boolean; effective: { productId: string; vintageId: string | null } | null }>()
    for (const r of ratings) {
      const f = flags.get(r.id)
      if (!f || f.hidden !== false || seen.has(r.wine.id)) continue
      const e = f.redacted === false ? entryOf(r.wine) : undefined
      seen.set(r.wine.id, { id: r.wine.id, hidden: f.redacted !== false, effective: e ? { productId: e.productId, vintageId: e.vintageId } : null })
    }
    try { saved = await savedFlags(viewerUserId, [...seen.values()]) }
    catch (err) { console.error('[feed] saved flags unavailable:', err) }
  }

  for (const r of ratings) {
    if (r.userId == null || r.sessionId == null) continue  // standalone tastings can't reach this loop (no matching pair)
    const key = pairKey(r.userId, r.sessionId)
    const w = r.wine
    // 🔒 A missing flag row (the rating went between the two reads) is left
    // out, never shown in full.
    // A NULL flag (never by construction) reads as the closed side.
    const f = flags.get(r.id)
    if (!f || f.hidden !== false) continue
    const redacted = f.redacted !== false
    const ratingImage = r.images[0]?.imageUrl ?? null
    const wireWine: SessionFeedWine = redacted
      ? {
          ratingId: r.id,
          // 🔒 No wine id on a blind row, except for the rating's own author.
          ...(viewerUserId !== null && viewerUserId === r.userId ? { id: w.id } : {}),
          name: '',     // UI renders "Wine N" via index — see SessionFeedCard
          producer: null,
          vintage: null,
          grape: null,
          // Style (red/white/spark/rose) is NOT identity — a taster knows it's
          // sparkling from the glass. Expose it so the structure wheel offers the
          // right axes (e.g. Bubbles on a blind sparkling wine); the mystery slot
          // keys on `_blind`, not type. Consistent with lib/wineRedaction.ts.
          // A legacy alcohol-free token is the alcohol-free mark: hidden on a
          // blind row (ruled 2026-11-20), like the abv.
          type: w.style === 'nonalc' ? null : w.style,
          colour: w.colour,
          sparkling: w.sparkling,
          abv: null,
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
          ratingId: r.id,
          id: w.id,
          name: entryOf(w)?.name ?? w.name,
          producer: entryOf(w)?.producer ?? w.producer,
          vintage: (() => { const e = entryOf(w); return e ? (entryYear(e) || null) : w.vintage })(),
          grape: (() => { const e = entryOf(w); return e ? (e.grapes.join(', ') || null) : w.grape })(),
          type: w.style,
          colour: w.colour,
          sparkling: w.sparkling,
          abv: w.abv === null ? null : Number(w.abv),
          imageUrl: ratingImage ?? w.imageUrl,
          score: decimalToNumber(r.score),
          flavors: (r.flavors as Record<string, number>) ?? {},
          aromas: (r.aromas as SessionFeedWine['aromas']) ?? [],
          notes: r.notes,
          region: entryOf(w)?.region ?? w.region,
          country: entryOf(w)?.country ?? w.country,
          vinification: w.vinification,
          description: w.description,
          purchaseUrl: w.purchaseUrl,
        }
    if (saved) wireWine.saved = saved.get(w.id) ?? false
    const arr = out.get(key)
    if (arr) arr.push(wireWine)
    else out.set(key, [wireWine])
  }

  return out
}
