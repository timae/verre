import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@verre/core'
import { outsideViewSql } from '@/lib/outsideView'
import { entryKey, loadEntriesSoft } from '@/lib/catalogEntries'
import { entryYear } from '@/lib/wineDisplay'

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
//
// 🔒 Outside a moment (lib/outsideView.ts, lists plan D4): a rating whose
// moment's line-up is hidden from you is LEFT OUT (a host can edit a bottle
// while the line-up is hidden), and an unrevealed blind bottle you have no
// bypass on comes back as a blind row (`_blind`, no name / producer / vintage
// / photo). Score, date and style stay.

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)
  const { redacted, hidden } = outsideViewSql(userId, { s: 's', w: 'w' })
  // 🔒 ONE snapshot for the flags and the content (Codex review): two reads
  // let a host hide the line-up and edit the bottle in between, and the label
  // read second would go out under the flag read first. REPEATABLE READ (read
  // committed would give each statement its own snapshot).
  const { flagRows, ratings } = await prisma.$transaction(async (tx) => {
    const flagRows = await tx.$queryRaw<{ id: number; redacted: boolean }[]>`
      SELECT r.id, ${redacted} AS redacted
        FROM ratings r
        JOIN wines w ON w.id = r.wine_id
        LEFT JOIN sessions s ON s.id = r.session_id
       WHERE r.user_id = ${userId} AND NOT ${hidden}
       ORDER BY r.rated_at DESC, r.id DESC
       LIMIT 200`
    const ratings = await tx.rating.findMany({
      where: { userId, id: { in: flagRows.map(f => f.id) } },
      include: {
        wine: { select: { name: true, producer: true, vintage: true, style: true, category: true, imageUrl: true, productId: true, vintageId: true } },
        session: { select: { id: true, code: true, deletedAt: true, createdAt: true } },
        images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { imageUrl: true } },
      },
      orderBy: [{ ratedAt: 'desc' }, { id: 'desc' }],
    })
    return { flagRows, ratings }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  const blind = new Set(flagRows.filter(f => f.redacted !== false).map(f => f.id))
  // A visible bottle shows its catalogue entry (merges followed), else its
  // snapshot; a blind one never reads it.
  const entries = await loadEntriesSoft(ratings.filter(r => !blind.has(r.id)).map(r => ({ productId: r.wine.productId, vintageId: r.wine.vintageId })))

  return NextResponse.json(ratings.map(r => {
    const sessionDeleted = !!r.session?.deletedAt
    // Image priority: rating's own photo first (the user's tasting photo
    // captured at write time), falling back to the wine's bottle shot.
    const ratingImage = r.images[0]?.imageUrl ?? null
    const isBlind = blind.has(r.id)
    const e = !isBlind && r.wine.productId ? entries.get(entryKey(r.wine.productId, r.wine.vintageId)) : undefined
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
      wine_name: isBlind ? '' : e?.name ?? r.wine.name,
      producer: isBlind ? null : e?.producer ?? r.wine.producer,
      vintage: isBlind ? null : e ? (entryYear(e) || null) : r.wine.vintage,
      style: r.wine.style,
      category: r.wine.category,
      image_url: isBlind ? null : (ratingImage ?? r.wine.imageUrl),
      ...(isBlind ? { _blind: true } : {}),
      session_id: r.session?.id ?? null,
      session_code: sessionDeleted ? null : (r.session?.code ?? null),
      session_deleted: sessionDeleted,
      session_date: r.session?.createdAt ?? null,
    }
  }), {
    // Viewer-private content (only this user's ratings). Per
    // app/api/CLAUDE.md, viewer-dependent responses MUST set
    // Cache-Control: private, no-store.
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
