import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touch } from '@/lib/redis'
import { getSessionMeta, getWines, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName, wineId, score, flavors, notes } = await req.json()

  if (!userName || !wineId) {
    return NextResponse.json({ error: 'userName and wineId required' }, { status: 400 })
  }

  const ratingScore = score || 0
  await redis.set(
    k.rating(c, userName, wineId),
    JSON.stringify({ score: ratingScore, flavors: flavors || {}, notes: notes || '', at: Date.now() }),
    { EX: TTL },
  )

  const wines = await getWines(c)
  const wine = wines.find(w => w.id === wineId)

  if (session?.user && wine) {
    try {
      const meta = await getSessionMeta(c)
      if (meta) {
        await pgUpsertSession(c, meta)
        await pgUpsertWine(c, wine)
        await prisma.rating.upsert({
          where: { wineId_raterName: { wineId, raterName: userName } },
          create: {
            wineId, userId: Number(session.user.id), raterName: userName,
            score: ratingScore, flavors: flavors || {}, notes: notes || null, ratedAt: new Date(),
          },
          update: {
            score: ratingScore, flavors: flavors || {}, notes: notes || null, ratedAt: new Date(),
          },
        })
      }
    } catch {}

    if (ratingScore === 5 && wine) {
      try {
        await prisma.hallOfFame.upsert({
          where: { wineName_raterName: { wineName: wine.name, raterName: userName } },
          create: {
            wineName: wine.name, producer: wine.producer || null, vintage: wine.vintage || null,
            style: wine.type || null, score: 5, raterName: userName,
            userId: Number(session.user.id), sessionCode: c, ratedAt: new Date(),
          },
          update: { score: 5, ratedAt: new Date() },
        })
      } catch {}
    }
  }

  await touch(c)

  // Trigger badge check asynchronously for logged-in users
  if (session?.user) {
    const hasNote = (notes || '').length > 5
    const action = ratingScore === 5
      ? (hasNote ? 'rate_5star_note' : 'rate_5star')
      : (hasNote ? 'rate_with_note' : 'rate')
    const baseUrl = req.nextUrl.origin
    fetch(`${baseUrl}/api/me/badges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.get('Authorization') || '' },
      body: JSON.stringify({ action }),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
