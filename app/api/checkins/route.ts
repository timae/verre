import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { uploadImage } from '@/lib/s3'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:checkin:${userId}:1h`, 20, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-ins. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const body = await req.json()
  const { wineName, producer, vintage, grape, type, score, flavors, notes, imageData, venueName, city, country, lat, lng, isPublic } = body
  if (!wineName?.trim()) return NextResponse.json({ error: 'wine name required' }, { status: 400 })

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
      score: score ?? null,
      flavors: flavors ?? {},
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

  return NextResponse.json(checkin, { status: 201 })
}
