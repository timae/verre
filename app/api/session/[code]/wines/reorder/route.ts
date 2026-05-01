import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, getSessionMeta, getWines } from '@/lib/session'
import { resolveIdentity } from '@/lib/identity'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const body = await req.json()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const identity = await resolveIdentity(c, req, session, body.userName ?? null)
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can reorder wines' }, { status: 403 })
  }

  const wines = await getWines(c)
  const orderedIds: string[] = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : []
  if (orderedIds.length !== wines.length) {
    return NextResponse.json({ error: 'orderedIds length mismatch' }, { status: 400 })
  }

  const byId = new Map(wines.map(w => [w.id, w]))
  if (orderedIds.some(id => !byId.has(id)) || new Set(orderedIds).size !== wines.length) {
    return NextResponse.json({ error: 'invalid orderedIds' }, { status: 400 })
  }

  const reordered = orderedIds.map(id => byId.get(id)!)
  await redis.set(k.wines(c), JSON.stringify(reordered), { EX: TTL })
  await touchWithMeta(c)
  return NextResponse.json(reordered)
}
