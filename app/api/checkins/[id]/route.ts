import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { uploadImage, deleteImageByUrl } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { validateScore, validateFlavors } from '@/lib/checkinValidation'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Share the create budget — edits and creates count toward the same hourly cap.
  const rl = await checkRate(`rl:checkin:${userId}:1h`, 100, 3600)
  if (!rl.allowed) return NextResponse.json({ error: `Too many check-in writes. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  const { id } = await params
  const checkin = await prisma.checkin.findUnique({ where: { id: Number(id) } })
  if (!checkin) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (checkin.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json()
  const { wineName, producer, vintage, grape, type, score, flavors, notes,
    imageData, venueName, city, country, lat, lng, isPublic, taggedUserIds } = body
  if (score !== undefined) {
    const c = validateScore(score); if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
  }
  if (flavors !== undefined) {
    const c = validateFlavors(flavors); if (c.error) return NextResponse.json({ error: c.error }, { status: 400 })
  }

  let imageUrl = checkin.imageUrl
  if (imageData?.startsWith('data:image/')) {
    const tempId = `ci_${checkin.userId}_${checkin.id}`
    const newUrl = await uploadImage(tempId, imageData).catch(() => null)
    if (newUrl) {
      // Replace successful — reclaim the old object if it was different
      // (POST keys by timestamp, PATCH keys by checkin id, so the URL
      // almost always changes). If upload failed, keep the old URL and
      // don't touch S3.
      if (checkin.imageUrl && checkin.imageUrl !== newUrl) {
        deleteImageByUrl(checkin.imageUrl).catch(() => {})
      }
      imageUrl = newUrl
    }
  } else if (imageData === null) {
    if (checkin.imageUrl) deleteImageByUrl(checkin.imageUrl).catch(() => {})
    imageUrl = null
  }

  // If the client sent taggedUserIds, verify each is a mutual follow before
  // we touch the tag rows. Same check as POST — clients can ask to tag
  // anyone, but only mutuals actually get persisted.
  let validTagIds: number[] | undefined
  if (Array.isArray(taggedUserIds)) {
    if (taggedUserIds.length === 0) {
      validTagIds = []
    } else {
      const mutuals = await prisma.$queryRaw<{ id: number }[]>`
        SELECT f1.following_id AS id
        FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
        WHERE f1.follower_id = ${userId} AND f1.following_id = ANY(${taggedUserIds}::integer[])
      `
      validTagIds = mutuals.map(m => m.id)
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedCheckin = await tx.checkin.update({
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

    // Replace tags atomically if the client sent any list (including empty
    // — explicit empty means "remove all tags"). Skip when undefined so a
    // PATCH that only updates other fields doesn't drop existing tags.
    if (validTagIds !== undefined) {
      await tx.checkinTag.deleteMany({ where: { checkinId: Number(id) } })
      if (validTagIds.length > 0) {
        await tx.checkinTag.createMany({
          data: validTagIds.map(uid => ({ checkinId: Number(id), userId: uid })),
          skipDuplicates: true,
        })
      }
    }

    return updatedCheckin
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
  // Fire-and-forget: reclaim the S3 object after the DB row is gone. If
  // the S3 delete fails we still report success — the row is gone, the
  // object becomes a harmless orphan that a future cleanup can sweep.
  if (checkin.imageUrl) deleteImageByUrl(checkin.imageUrl).catch(() => {})
  return NextResponse.json({ ok: true })
}
