import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, mutateWines, isMutateReject, pgMirrorWineList } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

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

  // The wine-list mirror projects revealed_at (and positions) for the whole
  // lineup from the committed array; a Redis-only session has no row → no-op.
  try { await pgMirrorWineList(c) }
  catch (err) { console.error('[wines] pg mirror failed', { code: c, kind: 'wine-list', err }) }

  const revealedCount = isMutateReject(updated) ? 0 : updated.filter(w => w.revealedAt).length
  return NextResponse.json({ ok: true, revealed: revealedCount })
}
