import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { touchWithMeta } from '@/lib/redis'
import { isHostByIdentity } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { openAsParticipant, hostLineupWrite } from '@/lib/sessionRoute'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  const { meta, identity } = op
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can hide all wines' }, { status: 403 })
  }

  // The wine-list mirror projects revealed_at (and positions) for the whole
  // lineup from the committed array; a Redis-only session has no row → no-op.
  const out = await hostLineupWrite(c, identity, { label: 'hide-all', forbidden: 'only the host can hide all wines' }, (wines) => wines.map(w => {
    const copy = { ...w }
    delete (copy as Partial<typeof copy>).revealedAt
    return copy
  }))
  if (out instanceof NextResponse) return out
  await touchWithMeta(c)

  return NextResponse.json({ ok: true })
}
