import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'

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

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const bookmarks = await prisma.bookmark.findMany({
    where: { userId },
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

  return NextResponse.json(bookmarks.map(b => {
    const latestRating = b.wine.ratings[0]
    const session = latestRating?.session ?? null
    const sessionDeleted = !!session?.deletedAt
    return {
      saved_at: b.savedAt,
      wine_id: b.wineId,
      name: b.wine.name,
      producer: b.wine.producer,
      vintage: b.wine.vintage,
      grape: b.wine.grape,
      style: b.wine.style,
      category: b.wine.category,
      image_url: b.wine.imageUrl,
      purchase_url: b.wine.purchaseUrl,
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
