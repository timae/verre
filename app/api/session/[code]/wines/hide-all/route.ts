import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@/lib/sessionCode'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can hide all wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const updated = wines.map(w => {
    const copy = { ...w }
    delete (copy as Partial<typeof copy>).revealedAt
    return copy
  })
  await redis.set(k.wines(c), JSON.stringify(updated), { KEEPTTL: true })
  await touchWithMeta(c)

  // Mirror to Postgres — restricted to rows that need flipping
  // (revealed_at IS NOT NULL). No-ops for anon-host wines whose
  // Postgres row doesn't exist.
  try {
    const sessionRow = await prisma.session.findUnique({ where: { code: c }, select: { id: true } })
    if (sessionRow) {
      await prisma.wine.updateMany({
        where: { sessionId: sessionRow.id, revealedAt: { not: null } },
        data: { revealedAt: null },
      })
    }
  } catch (err) {
    console.error('hide-all pg update error:', err)
  }

  return NextResponse.json({ ok: true })
}
