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
  if (identity.kind === 'user') {
    const userId = Number(identity.id.slice(2))
    if (Number.isInteger(userId) && userId > 0) {
      await prisma.rating.deleteMany({ where: { wineId, userId } })
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
