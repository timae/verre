import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'
import { getWines } from '@/lib/session'
import { engagementDeletionCascade } from '@/lib/engagementCascade'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

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
  // Engagement-deletion auto-cascade (rewire.md §3): force-delete the
  // rating, then drop the session feed_item if this was the user's
  // last rating in the session. Rating photos S3-reclaim AFTER commit.
  // The DELETE endpoint is the explicit "Reset" path — the rating
  // gate (origin check, participant check, identity check) has
  // already authorised the wipe, so force-mode bypasses the empty-
  // payload predicate (the POST path uses empty-only mode).
  if (identity.kind === 'user') {
    const userId = Number(identity.id.slice(2))
    if (Number.isInteger(userId) && userId > 0) {
      const sessionRow = await prisma.session.findFirst({
        where: { code: c, deletedAt: null },
        select: { id: true },
      })
      if (sessionRow) {
        // Resolve the canonical rating_id. The path param is wineId; the
        // cascade keys on rating_id for the self-exclusion guard in
        // step 2. Scoped to (userId, sessionId) so a same-(user,wine)
        // standalone or other-session rating is never touched.
        const rating = await prisma.rating.findFirst({
          where: { wineId, userId, sessionId: sessionRow.id },
          select: { id: true },
        })
        if (rating) await engagementDeletionCascade(rating.id, 'force')
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
