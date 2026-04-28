import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const ratings = await prisma.rating.findMany({
    where: { userId: Number(session.user.id) },
    include: { wine: { include: { session: { select: { code: true, createdAt: true } } } } },
    orderBy: { ratedAt: 'desc' },
    take: 200,
  })

  return NextResponse.json(ratings.map(r => ({
    id: r.id, score: r.score, flavors: r.flavors, notes: r.notes, rated_at: r.ratedAt,
    wine_name: r.wine.name, producer: r.wine.producer, vintage: r.wine.vintage,
    style: r.wine.style, category: r.wine.category, image_url: r.wine.imageUrl,
    session_code: r.wine.session.code, session_date: r.wine.session.createdAt,
  })))
}
