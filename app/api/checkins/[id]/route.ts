import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateScore, validateFlavors } from '@/lib/checkinValidation'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Share the create budget — edits and creates count toward the same hourly cap.
  const rl = await checkRate(`rl:checkin:${userId}:1h`, 20, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-in writes. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const { id } = await params
  const checkin = await prisma.checkin.findUnique({ where: { id: Number(id) } })
  if (!checkin) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (checkin.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json()
  const { wineName, producer, vintage, grape, type, score, flavors, notes,
    imageData, venueName, city, country, lat, lng, isPublic } = body
  if (score !== undefined) {
    const c = validateScore(score); if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
  }
  if (flavors !== undefined) {
    const c = validateFlavors(flavors); if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
  }

  let imageUrl = checkin.imageUrl
  if (imageData?.startsWith('data:image/')) {
    const tempId = `ci_${checkin.userId}_${checkin.id}`
    imageUrl = await uploadImage(tempId, imageData).catch(() => checkin.imageUrl)
  } else if (imageData === null) {
    imageUrl = null
  }

  const updated = await prisma.checkin.update({
    where: { id: Number(id) },
    data: {
      wineName:  wineName  !== undefined ? (wineName?.trim()  || checkin.wineName) : checkin.wineName,
      producer:  producer  !== undefined ? (producer?.trim()  || null) : checkin.producer,
      vintage:   vintage   !== undefined ? (vintage?.trim().slice(0,4) || null) : checkin.vintage,
      grape:     grape     !== undefined ? (grape?.trim()     || null) : checkin.grape,
      type:      type      !== undefined ? (type              || null) : checkin.type,
      score:     score     !== undefined ? (score             ?? null) : checkin.score,
      flavors:   flavors   !== undefined ? flavors            : checkin.flavors,
      notes:     notes     !== undefined ? (notes?.trim()     || null) : checkin.notes,
      imageUrl,
      venueName: venueName !== undefined ? (venueName?.trim() || null) : checkin.venueName,
      city:      city      !== undefined ? (city?.trim()      || null) : checkin.city,
      country:   country   !== undefined ? (country?.trim().slice(0,2).toUpperCase() || null) : checkin.country,
      lat:       lat       !== undefined ? (lat               ?? null) : checkin.lat,
      lng:       lng       !== undefined ? (lng               ?? null) : checkin.lng,
      isPublic:  isPublic  !== undefined ? isPublic           : checkin.isPublic,
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const { id } = await params
  const checkin = await prisma.checkin.findUnique({ where: { id: Number(id) } })
  if (!checkin) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (checkin.userId !== Number(session.user.id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  await prisma.checkin.delete({ where: { id: Number(id) } })
  return NextResponse.json({ ok: true })
}
