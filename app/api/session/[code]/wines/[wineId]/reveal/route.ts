import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHost, getSessionMeta, getWines } from '@/lib/session'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { code, wineId } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json().catch(() => ({}))

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!isHost(meta, session?.user?.id, body.userName)) {
    return NextResponse.json({ error: 'only the host can reveal wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const idx = wines.findIndex(w => w.id === wineId)
  if (idx === -1) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  wines[idx] = { ...wines[idx], revealedAt: new Date().toISOString() }
  await redis.set(k.wines(c), JSON.stringify(wines), { EX: TTL })
  await touchWithMeta(c)

  return NextResponse.json({ ok: true, wine: wines[idx] })
}
