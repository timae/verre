import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines, addWineToSession, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import type { WineMeta, SessionMeta } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { resolveIdentity, requireParticipant, participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'

type Ctx = { params: Promise<{ code: string }> }

function redactWine(wine: WineMeta, index: number): WineMeta {
  return {
    ...wine,
    name: `Wine ${index + 1}`,
    producer: '',
    vintage: '',
    grape: '',
    type: 'red',   // keep as red for FL purposes but will show mystery icon
    image: '',
    imageUrl: '',
    _blind: true,  // flag for client
  } as WineMeta & { _blind: boolean }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  // Session-existence check first. If the session was deleted or never
  // existed, return 404 — distinct from 401 ("session exists but you're
  // not a participant"). The client uses this to decide whether to bounce
  // the participant home (404 = session gone, leave) vs to /join/<code>
  // (401 = token bad / not in session, try to join).
  if (!(await redis.exists(k.meta(c)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const identity = p.identity

  const wines = await getWines(c)
  const meta = await getSessionMeta(c) as (SessionMeta & { blind?: boolean; hideLineup?: boolean; hideLineupMinutesBefore?: number }) | null
  const isUserHost = isHostByIdentity(meta as SessionMeta, identity)

  // Lineup hidden until X minutes before start
  if (meta?.hideLineup && meta.dateFrom && !isUserHost) {
    const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60 * 1000
    if (Date.now() < revealAt) return NextResponse.json([])
  }

  // Wire payload strips `addedByIdentityId` — it's host-internal
  // provenance (used by ban-with-delete-wines to identify which wines to
  // orphan) and shouldn't leak to participants. Anon ids would correlate
  // across multiple wines from the same author, which the ban UI does
  // server-side and clients have no need for.
  const onWire = (w: typeof wines[number]) => {
    const { addedByIdentityId: _unused, ...rest } = w
    void _unused
    return rest
  }

  if (meta?.blind && !isUserHost) {
    return NextResponse.json(wines.map((w, i) =>
      onWire(w.revealedAt ? w : redactWine(w, i))
    ))
  }

  return NextResponse.json(wines.map(onWire))
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await auth()
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  // Banned cohosts must not be able to write wines until they next poll
  // and bounce. participantOrBanned does the same check that GET uses.
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can add wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  // Pass the adder's identity so the wine record carries provenance
  // (used by ban-with-delete-wines to identify which wines to orphan).
  const result = await addWineToSession(c, body, undefined, identity.id)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines.push(result)
  // Optional one-shot insert position (1-indexed). Out-of-range silently
  // falls through to "append at end" — frontend validates the range.
  const pos = Number(body.position)
  if (Number.isInteger(pos) && pos >= 1 && pos < wines.length) {
    const inserted = wines.pop()!
    wines.splice(pos - 1, 0, inserted)
  }
  await redis.set(k.wines(c), JSON.stringify(wines), { KEEPTTL: true })
  await touchWithMeta(c)

  if (session?.user) {
    try {
      await pgUpsertSession(c, meta)
      await pgUpsertWine(c, result)
    } catch {}
  }

  return NextResponse.json(result)
}
