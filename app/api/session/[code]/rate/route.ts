import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { getSessionMeta, getWines, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { resolveIdentity } from '@/lib/identity'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  const { userName, wineId, score, flavors, notes } = await req.json()

  if (!wineId) return NextResponse.json({ error: 'wineId required' }, { status: 400 })

  // Identity comes from auth() or x-vr-anon-token, NEVER from the request body.
  // Falls back to bodyUserName during the Packet 4→5 transition window for
  // anonymous clients that haven't been wired to send the token yet.
  const identity = await resolveIdentity(c, req, session, userName ?? null)
  if (!identity) return NextResponse.json({ error: 'identity required' }, { status: 401 })

  const ratingScore = score || 0
  // Redis rating key still uses displayName for compatibility with the
  // existing ratings GET endpoint and frontend lookup. Identity-keyed Redis
  // ratings are deferred (would require a separate migration of the ratings
  // GET shape and the frontend ratingsData[displayName] lookup).
  await redis.set(
    k.rating(c, identity.displayName, wineId),
    JSON.stringify({ score: ratingScore, flavors: flavors || {}, notes: notes || '', at: Date.now() }),
    { EX: TTL },
  )

  const wines = await getWines(c)
  const wine = wines.find(w => w.id === wineId)

  if (identity.kind === 'user' && wine) {
    const userId = Number(identity.id.slice(2))  // strip "u:" prefix
    try {
      const meta = await getSessionMeta(c)
      if (meta) {
        await pgUpsertSession(c, meta)
        await pgUpsertWine(c, wine)
        await prisma.rating.upsert({
          where: { wineId_userId: { wineId, userId } },
          create: {
            wineId, userId, raterName: identity.displayName,
            score: ratingScore, flavors: flavors || {}, notes: notes || null, ratedAt: new Date(),
          },
          update: {
            raterName: identity.displayName,
            score: ratingScore, flavors: flavors || {}, notes: notes || null, ratedAt: new Date(),
          },
        })
      }
    } catch {}

    if (ratingScore === 5) {
      try {
        await prisma.hallOfFame.upsert({
          where: { wineName_userId: { wineName: wine.name, userId } },
          create: {
            wineName: wine.name, producer: wine.producer || null, vintage: wine.vintage || null,
            style: wine.type || null, score: 5, raterName: identity.displayName,
            userId, sessionCode: c, ratedAt: new Date(),
          },
          update: { raterName: identity.displayName, score: 5, ratedAt: new Date() },
        })
      } catch {}
    }
  }

  await touchWithMeta(c)

  // Award badges + XP directly (no HTTP round-trip). Logged-in users only.
  if (identity.kind === 'user') {
    const userId = Number(identity.id.slice(2))
    const hasNote = (notes || '').length > 5
    const action = ratingScore === 5
      ? (hasNote ? 'rate_5star_note' : 'rate_5star')
      : (hasNote ? 'rate_with_note' : 'rate')
    import('@/lib/badgeService').then(({ checkAndAwardBadges }) =>
      checkAndAwardBadges(userId, action)
    ).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
