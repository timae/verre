import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'
import { getWines } from '@/lib/session'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid()
  const identity = p.identity

  await redis.del(k.rating(c, identity.id, wineId))
  await touchWithMeta(c)

  // Remove the Postgres archive too. Anon raters never had a row, so
  // skip them. The Hall of Fame entry (if any) keys on (wineName,
  // userId), so we look up the wine name from Redis to target the
  // exact row — wineName + userId + sessionCode triple.
  //
  // Scope the rating delete to (wineId, userId, sessionId). Pre-rewire
  // the same (wineId, userId) couldn't appear across multiple sessions
  // because @@unique([wineId, userId]) global-blocked it. Phase 1.5 swapped
  // that for a partial unique on (user_id, wine_id, session_id), so the
  // same (wine, user) pair CAN now appear with sessionId=NULL (a standalone
  // rating) or in another session. Unscoped deleteMany would wipe those
  // unrelated rows. Resolve sessionId from the live (deletedAt IS NULL)
  // session row and filter explicitly.
  //
  // Engagement-deletion auto-cascade (rating empty → drop, last in session
  // → also drop the feed_item) is deferred to phase 3 alongside the undo
  // affordance. This handler keeps today's "delete on explicit DELETE only"
  // semantics; feed_items survive the rating delete.
  if (identity.kind === 'user') {
    const userId = Number(identity.id.slice(2))
    if (Number.isInteger(userId) && userId > 0) {
      const sessionRow = await prisma.session.findFirst({
        where: { code: c, deletedAt: null },
        select: { id: true },
      })
      if (sessionRow) {
        await prisma.rating.deleteMany({
          where: { wineId, userId, sessionId: sessionRow.id },
        })
      }
      const wines = await getWines(c)
      const wine = wines.find(w => w.id === wineId)
      if (wine) {
        await prisma.hallOfFame.deleteMany({
          where: { wineName: wine.name, userId, sessionCode: c },
        })
      }
    }
  }

  return NextResponse.json({ ok: true })
}
