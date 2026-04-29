import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touch } from '@/lib/redis'
import { isHost, getSessionMeta, getWines, addWineToSession, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import type { WineMeta, SessionMeta } from '@/lib/session'

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

function shouldRedact(meta: SessionMeta & { blind?: boolean; coHosts?: string[] }, userName: string | null, userId: string | null): boolean {
  if (!meta.blind) return false
  return !isHost(meta, userId ?? undefined, userName ?? undefined)
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const userName = req.nextUrl.searchParams.get('name')

  const wines = await getWines(c)
  const meta = await getSessionMeta(c) as (SessionMeta & { blind?: boolean }) | null

  if (meta?.blind && shouldRedact(meta as SessionMeta & { blind?: boolean }, userName, session?.user?.id ?? null)) {
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
  if (!isHost(meta, session?.user?.id, body.userName)) {
    return NextResponse.json({ error: 'only the host can add wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const result = await addWineToSession(c, body)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

  wines.push(result)
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL })
  await touch(c)

  if (session?.user) {
    try {
      await pgUpsertSession(c, meta)
      await pgUpsertWine(c, result)
    } catch {}
  }

  return NextResponse.json(result)
}
