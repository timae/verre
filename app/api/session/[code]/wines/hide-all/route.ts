import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines } from '@/lib/session'
import { resolveIdentity } from '@/lib/identity'

type Ctx = { params: Promise<{ code: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json().catch(() => ({}))

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const identity = await resolveIdentity(c, req, session, body.userName ?? null)
  if (!isHostByIdentity(meta, identity)) {
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
