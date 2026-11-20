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
    return NextResponse.json({ error: 'only the host can reveal all wines' }, { status: 403 })
  }

  // A JS Date (millisecond precision), the same instant in the record and the
  // cache (the old mirror compares revealed_at exactly).
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const updated = await hostLineupWrite(c, identity, { label: 'reveal-all', forbidden: 'only the host can reveal all wines' }, {
    redisOnly: (wines) => wines.map(w => w.revealedAt ? w : { ...w, revealedAt: now }),
    record: async (tx, sessionId) => { await tx.$executeRaw`UPDATE wines SET revealed_at = ${nowDate} WHERE session_id = ${sessionId} AND revealed_at IS NULL` },
  })
  if (updated instanceof NextResponse) return updated
  await touchWithMeta(c)
  const revealedCount = updated.filter(w => w.revealedAt).length
  return NextResponse.json({ ok: true, revealed: revealedCount })
}
