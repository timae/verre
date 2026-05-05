import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage } from '@/lib/s3'
import { validateScore, validateFlavors } from '@/lib/checkinValidation'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-ins. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const body = await req.json()
  const { wineName, producer, vintage, grape, type, score, flavors, notes, imageData, venueName, city, country, lat, lng, isPublic, taggedUserIds = [] } = body
  if (!wineName?.trim()) return NextResponse.json({ error: 'wine name required' }, { status: 400 })
  const scoreCheck = validateScore(score); if (scoreCheck.error) return NextResponse.json({ error: scoreCheck.error }, { status: 400 })
  const flavorsCheck = validateFlavors(flavors); if (flavorsCheck.error) return NextResponse.json({ error: flavorsCheck.error }, { status: 400 })

  let imageUrl: string | null = null
  if (imageData?.startsWith('data:image/')) {
    const tempId = `ci_${userId}_${Date.now()}`
    imageUrl = await uploadImage(tempId, imageData).catch(() => null)
  }

  const checkin = await prisma.checkin.create({
    data: {
      userId,
      wineName: wineName.trim(),
      producer: producer?.trim() || null,
      vintage: vintage?.trim().slice(0, 4) || null,
      grape: grape?.trim() || null,
      type: type || null,
      score: scoreCheck.value,
      flavors: flavorsCheck.value,
      notes: notes?.trim() || null,
      imageUrl,
      venueName: venueName?.trim() || null,
      city: city?.trim() || null,
      country: country?.trim().slice(0, 2).toUpperCase() || null,
      lat: lat ?? null,
      lng: lng ?? null,
      isPublic: isPublic !== false,
    },
  })

  // Save tags — only mutual follows (verify server-side)
  if (Array.isArray(taggedUserIds) && taggedUserIds.length > 0) {
    const mutuals = await prisma.$queryRaw<{ id: number }[]>`
      SELECT f1.following_id AS id
      FROM follows f1
      JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
      WHERE f1.follower_id = ${userId} AND f1.following_id = ANY(${taggedUserIds}::integer[])
    `
    const validIds = mutuals.map(m => m.id)
    if (validIds.length > 0) {
      await prisma.checkinTag.createMany({
        data: validIds.map(uid => ({ checkinId: checkin.id, userId: uid })),
        skipDuplicates: true,
      })
    }
  }

  return NextResponse.json(checkin, { status: 201 })
}
