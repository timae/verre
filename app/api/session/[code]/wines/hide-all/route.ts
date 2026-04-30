import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHost, getSessionMeta, getWines } from '@/lib/session'

type Ctx = { params: Promise<{ code: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json().catch(() => ({}))

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!isHost(meta, session?.user?.id, body.userName)) {
    return NextResponse.json({ error: 'only the host can hide all wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const updated = wines.map(w => {
    const copy = { ...w }
    delete (copy as Partial<typeof copy>).revealedAt
    return copy
  })
  await redis.set(k.wines(c), JSON.stringify(updated), { EX: TTL })
  await touchWithMeta(c)

  return NextResponse.json({ ok: true })
}
