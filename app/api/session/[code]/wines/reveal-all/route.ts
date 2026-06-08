import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, mutateWines, isMutateReject } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { normalizeCode } from '@verre/core'
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
    return NextResponse.json({ error: 'only the host can reveal all wines' }, { status: 403 })
  }

  const nowDate = new Date()
  const now = nowDate.toISOString()
  const updated = await mutateWines(c, (wines) => wines.map(w => w.revealedAt ? w : { ...w, revealedAt: now }))
  await touchWithMeta(c)

  // Mirror to Postgres so the post-rewire feed-read path renders
  // correctly after Redis eviction. UPDATE is restricted to rows
  // that need flipping; no-ops for anon-host sessions whose
  // wines row doesn't exist in Postgres.
  try {
    const sessionRow = await prisma.session.findFirst({ where: { code: c, deletedAt: null }, select: { id: true } })
    if (sessionRow) {
      await prisma.wine.updateMany({
        where: { sessionId: sessionRow.id, revealedAt: null },
        data: { revealedAt: nowDate },
      })
    }
  } catch (err) {
    console.error('reveal-all pg update error:', err)
  }

  const revealedCount = isMutateReject(updated) ? 0 : updated.filter(w => w.revealedAt).length
  return NextResponse.json({ ok: true, revealed: revealedCount })
}
