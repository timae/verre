import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touch } from '@/lib/redis'
import { isHost, getSessionMeta, getWines, addWineToSession, pgUpsertSession, pgUpsertWine } from '@/lib/session'

type Ctx = { params: Promise<{ code: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const wines = await getWines(code.toUpperCase())
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
