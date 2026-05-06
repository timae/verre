import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, lifespanTTL } from '@/lib/redis'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { prisma } from '@/lib/prisma'
import { resolveIdentity, authInvalid } from '@/lib/identity'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()
  const body = await req.json()

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return authInvalid()
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can change session settings' }, { status: 403 })
  }

  const isPro = !!(session?.user as { pro?: boolean })?.pro

  if (body.name !== undefined)        meta.name        = String(body.name        || '').trim().slice(0, 80)
  if (body.address !== undefined)     meta.address     = String(body.address     || '').trim().slice(0, 255)
  if (body.dateFrom !== undefined)    meta.dateFrom    = body.dateFrom    || null
  if (body.dateTo !== undefined)      meta.dateTo      = body.dateTo      || null
  if (body.timezone !== undefined)    meta.timezone    = String(body.timezone    || '').trim().slice(0, 64)
  if (body.description !== undefined) meta.description = String(body.description || '').trim().slice(0, 1000)
  if (body.link !== undefined)               meta.link                    = String(body.link || '').trim().slice(0, 512)
  if (body.blind !== undefined) {
    // Enabling blind tasting requires a pro account. Disabling is always
    // allowed (lets a host turn it off without having to be pro).
    if (body.blind && !isPro) {
      return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
    }
    meta.blind = !!body.blind
  }
  if (body.hideLineup !== undefined)         meta.hideLineup              = !!body.hideLineup
  if (body.hideLineupMinutesBefore !== undefined) meta.hideLineupMinutesBefore = Number(body.hideLineupMinutesBefore) || 0

  if (body.lifespan !== undefined) {
    if (body.lifespan !== '48h' && !isPro) {
      return NextResponse.json({ error: 'extended lifespan requires a pro account' }, { status: 403 })
    }
    meta.lifespan = body.lifespan
  }

  const ttl = lifespanTTL(meta.lifespan)
  await redis.set(k.meta(c), JSON.stringify(meta), { EX: ttl })
  const keys = await redis.keys(`s:${c}:*`)
  for (const key of keys) await redis.expire(key, ttl)

  try {
    await prisma.session.update({
      where: { code: c },
      data: {
        name:        meta.name        || null,
        blind:       !!meta.blind,
        address:     meta.address     || null,
        dateFrom:    meta.dateFrom    ? new Date(meta.dateFrom) : null,
        dateTo:      meta.dateTo      ? new Date(meta.dateTo)   : null,
        timezone:    meta.timezone    || null,
        description: meta.description || null,
        link:        meta.link        || null,
      },
    })
  } catch {}

  return NextResponse.json({ ok: true, meta })
}
