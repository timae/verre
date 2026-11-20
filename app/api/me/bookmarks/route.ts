import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { outsideViewSql, cravingSessionIdSql } from '@/lib/outsideView'

// Per-bookmark session context resolves via the wine's RATINGS, not via
// wines.session_id. The latter is NULL whenever the source session has
// been soft-deleted (the §8 rewire contract preserves the rating's
// session_id but orphans the wine). Reading session context from the
// user's own rating gives:
//   - live session: code + tombstone state (deletedAt null)
//   - deleted session: deletedAt set, code/name scrubbed — renderer
//     shows "[deleted session]" without a link
//   - no rating at all: no session context (bookmarked wine the user
//     never rated)
//
// This is the future-direction read path. When `wines.session_id` is
// eventually dropped entirely (it becomes deprecated once dedup ships
// and a wine is decoupled from any one session), this query keeps
// working unchanged.
//
// 🔒 Outside a moment (lib/outsideView.ts, lists plan D4), on the craving's
// moment (the bottle's own, else a session rating's of it): a hidden line-up
// is LEFT OUT, an unrevealed blind bottle you have no bypass on is a blind
// row (`_blind`: no name / producer / vintage / grape / photo / purchase link).

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const { redacted, hidden } = outsideViewSql(userId, { s: 's', w: 'w' })
  // 🔒 ONE snapshot for the flags and the content (Codex review): see
  // /api/me/ratings. REPEATABLE READ.
  const { flagRows, bookmarks } = await prisma.$transaction(async (tx) => {
    const flagRows = await tx.$queryRaw<{ id: number; redacted: boolean }[]>`
      SELECT b.id, ${redacted} AS redacted
        FROM bookmarks b
        JOIN wines w ON w.id = b.wine_id
        LEFT JOIN sessions s ON s.id = ${cravingSessionIdSql('w')}
       WHERE b.user_id = ${userId} AND NOT ${hidden}`
    const bookmarks = await tx.bookmark.findMany({
      where: { userId, id: { in: flagRows.map(f => f.id) } },
      include: {
        wine: {
          include: {
            // Most-recent rating BY THIS VIEWER on this wine, with the
            // session it was rated in. take:1 + ratedAt desc — if the
            // user re-tasted the same wine across multiple sessions
            // (aging bottle), use the freshest rating's session.
            ratings: {
              where: { userId },
              orderBy: { ratedAt: 'desc' },
              take: 1,
              select: {
                sessionId: true,
                session: { select: { code: true, name: true, deletedAt: true } },
              },
            },
          },
        },
      },
      orderBy: { savedAt: 'desc' },
    })
    return { flagRows, bookmarks }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  const blind = new Set(flagRows.filter(f => f.redacted !== false).map(f => f.id))

  // Every id came through the inner join on wines above, so each row has its
  // bottle; the narrowing only satisfies the nullable source pointer (catalogue
  // model change step 2). Step 5 rewrites this list onto the craving itself.
  const withWine = bookmarks.flatMap(b => b.wine ? [{ ...b, wine: b.wine }] : [])
  return NextResponse.json(withWine.map(b => {
    const latestRating = b.wine.ratings[0]
    const session = latestRating?.session ?? null
    const sessionDeleted = !!session?.deletedAt
    const isBlind = blind.has(b.id)
    return {
      saved_at: b.savedAt,
      wine_id: b.wineId,
      name: isBlind ? '' : b.wine.name,
      producer: isBlind ? null : b.wine.producer,
      vintage: isBlind ? null : b.wine.vintage,
      grape: isBlind ? null : b.wine.grape,
      // A legacy alcohol-free token is hidden on a blind row (the mark, ruled
      // 2026-11-20), like the abv.
      style: isBlind && b.wine.style === 'nonalc' ? null : b.wine.style,
      // The bottle's kind (the axes read `sparkling`); alcohol hidden on a
      // blind row (catalogue model change step 4).
      colour: b.wine.colour,
      sparkling: b.wine.sparkling,
      abv: isBlind || b.wine.abv === null ? null : Number(b.wine.abv),
      category: b.wine.category,
      image_url: isBlind ? null : b.wine.imageUrl,
      purchase_url: isBlind ? null : b.wine.purchaseUrl,
      ...(isBlind ? { _blind: true } : {}),
      // For tombstoned sessions: code is NULL after the §8 scrub, so
      // we surface deleted=true + a NULL session_code. The renderer
      // shows "[deleted session]" without a link.
      session_code: sessionDeleted ? null : (session?.code ?? null),
      session_deleted: sessionDeleted,
      // session_id surfaces even for tombstones (the integer id survives
      // per §8); useful for the client's bookmark→rating cross-match
      // (replaces the legacy session_code/wine_name name-based join).
      session_id: latestRating?.sessionId ?? null,
    }
  }), {
    // Viewer-private content (only this user's bookmarks). Per
    // app/api/CLAUDE.md, viewer-dependent responses MUST set
    // Cache-Control: private, no-store so a shared cache can't serve
    // one viewer's payload to another.
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
