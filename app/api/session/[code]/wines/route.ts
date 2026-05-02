import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines, addWineToSession, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import type { WineMeta, SessionMeta } from '@/lib/session'
import { resolveIdentity, requireParticipant } from '@/lib/identity'

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
  const c = code.toUpperCase()
  const session = await auth()

  const identity = await requireParticipant(c, req, session)
  if (!identity) return NextResponse.json({ error: 'not a participant' }, { status: 401 })

  const wines = await getWines(c)
  const meta = await getSessionMeta(c) as (SessionMeta & { blind?: boolean; hideLineup?: boolean; hideLineupMinutesBefore?: number }) | null
  const isUserHost = isHostByIdentity(meta as SessionMeta, identity)

  // Lineup hidden until X minutes before start
  if (meta?.hideLineup && meta.dateFrom && !isUserHost) {
    const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60 * 1000
    if (Date.now() < revealAt) return NextResponse.json([])
  }

  if (meta?.blind && !isUserHost) {
    return NextResponse.json(wines.map((w, i) =>
      w.revealedAt ? w : redactWine(w, i)
    ))
  }

  return NextResponse.json(wines)
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const identity = await resolveIdentity(c, req, session, body.userName ?? null)
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can add wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const result = await addWineToSession(c, body)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines.push(result)
  // Optional one-shot insert position (1-indexed). Out-of-range silently
  // falls through to "append at end" — frontend validates the range.
  const pos = Number(body.position)
  if (Number.isInteger(pos) && pos >= 1 && pos < wines.length) {
    const inserted = wines.pop()!
    wines.splice(pos - 1, 0, inserted)
  }
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL })
  await touchWithMeta(c)

  if (session?.user) {
    try {
      await pgUpsertSession(c, meta)
      await pgUpsertWine(c, result)
    } catch {}
  }

  return NextResponse.json(result)
}
