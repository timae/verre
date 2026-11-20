import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { touchWithMeta } from '@/lib/redis'
import { isHostByIdentity } from '@/lib/session'
import { buildWinesEcho } from '@/lib/sessionState'
import { normalizeCode } from '@verre/core'
import { openAsParticipant, hostLineupWrite } from '@/lib/sessionRoute'
import { isSameOrigin } from '@/lib/csrf'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { meta, identity } = op
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can reorder wines' }, { status: 403 })
  }

  const orderedIds: string[] = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : []

  // Reorder is a pure permutation of the CURRENT list, so the validity
  // checks (length + id-set match) run inside the transform against the
  // watched value — a wine added/removed by a concurrent request would
  // otherwise pass a stale check and then clobber that change.
  const invalid = (ids: string[]) => orderedIds.length !== ids.length ? { reject: 'orderedIds length mismatch' }
    : orderedIds.some(id => !ids.includes(id)) || new Set(orderedIds).size !== ids.length ? { reject: 'invalid orderedIds' } : null
  const out = await hostLineupWrite(c, identity, { label: 'reorder', forbidden: 'only the host can reorder wines', rejectStatus: 400 }, {
    redisOnly: (wines) => {
      const bad = invalid(wines.map(w => w.id))
      if (bad) return bad
      const byId = new Map(wines.map(w => [w.id, w]))
      return orderedIds.map(id => byId.get(id)!)
    },
    // The permutation decided on the locked rows; only the moved rows written.
    record: async (tx, sessionId) => {
      const ids = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wines WHERE session_id = ${sessionId} FOR UPDATE`).map(r => r.id)
      const bad = invalid(ids)
      if (bad) return bad
      await tx.$executeRaw`
        UPDATE wines AS w SET position = (v.ord - 1)::int
          FROM unnest(${orderedIds}::text[]) WITH ORDINALITY AS v(id, ord)
         WHERE w.id = v.id AND w.session_id = ${sessionId} AND w.position IS DISTINCT FROM (v.ord - 1)::int`
    },
  })
  if (out instanceof NextResponse) return out
  await touchWithMeta(c)
  // The same per-viewer view as the line-up read (lib/sessionState.ts
  // buildWinesEcho): provenance kept server-internal, isMine synthesized, and
  // Blind for All masking the host's own echo too.
  return NextResponse.json(
    await buildWinesEcho(c, meta, identity, out),
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
