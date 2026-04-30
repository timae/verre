import { NextRequest, NextResponse } from 'next/server'
import { redis, k } from '@/lib/redis'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const users = await redis.sMembers(k.users(c))
  const ttlSeconds = await redis.ttl(k.meta(c))
  return NextResponse.json({ ...JSON.parse(raw), code: c, users, ttlSeconds })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const { userName, targetUser, action } = await req.json()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const meta = JSON.parse(raw)
  if (userName !== meta.host) return NextResponse.json({ error: 'only the host can assign roles' }, { status: 403 })
  const coHosts: string[] = meta.coHosts || []
  if (action === 'add-cohost') {
    if (!coHosts.includes(targetUser)) coHosts.push(targetUser)
  } else if (action === 'remove-cohost') {
    const idx = coHosts.indexOf(targetUser)
    if (idx !== -1) coHosts.splice(idx, 1)
  } else if (action === 'transfer-host') {
    meta.host = targetUser
    meta.coHosts = [userName] // old host becomes co-host
  }
  if (action !== 'transfer-host') meta.coHosts = coHosts
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: 48 * 3600 })
  return NextResponse.json({ ok: true, meta })
}
