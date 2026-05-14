import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@/lib/decimal'

// History endpoint: every rating the viewer has written. Post-rewire,
// session context comes off the rating itself (rating.session) rather
// than via the wine — the wine may have been orphaned by a soft-delete
// (wines.session_id NULL) while the rating still points at the
// tombstoned session row.
//
// Surfaces:
//   - `session_code`: the join code, NULL when the session is soft-deleted
//     (the §8 scrub nulls it) or when the rating is standalone (sessionId
//     NULL).
//   - `session_deleted`: true for tombstoned sessions. Renderer uses this
//     to display "[deleted session]" instead of a link.
//   - `session_id`: integer id; surfaced for cross-match against bookmarks
//     (replaces the legacy session_code/wine_name name-based join).

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const ratings = await prisma.rating.findMany({
    where: { userId: Number(session.user.id) },
    include: {
      wine: { select: { name: true, producer: true, vintage: true, style: true, category: true, imageUrl: true } },
      session: { select: { id: true, code: true, deletedAt: true, createdAt: true } },
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { imageUrl: true } },
    },
    orderBy: { ratedAt: 'desc' },
    take: 200,
  })

  return NextResponse.json(ratings.map(r => {
    const sessionDeleted = !!r.session?.deletedAt
    // Image priority: rating's own photo first (the user's tasting photo
    // captured at write time), falling back to the wine's bottle shot.
    const ratingImage = r.images[0]?.imageUrl ?? null
    return {
      id: r.id,
      // wine_id surfaced for client-side cross-match against bookmarks
      // (replaces the legacy session_code/wine_name name-based join, which
      // collided across two deleted-session ratings of differently-spelled
      // same-name wines).
      wine_id: r.wineId,
      score: decimalToNumber(r.score),
      flavors: r.flavors,
      notes: r.notes,
      rated_at: r.ratedAt,
      wine_name: r.wine.name,
      producer: r.wine.producer,
      vintage: r.wine.vintage,
      style: r.wine.style,
      category: r.wine.category,
      image_url: ratingImage ?? r.wine.imageUrl,
      session_id: r.session?.id ?? null,
      session_code: sessionDeleted ? null : (r.session?.code ?? null),
      session_deleted: sessionDeleted,
      session_date: r.session?.createdAt ?? null,
    }
  }))
}
