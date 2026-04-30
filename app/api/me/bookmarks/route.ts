import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const bookmarks = await prisma.bookmark.findMany({
    where: { userId: Number(session.user.id) },
    include: { wine: { include: { session: { select: { code: true } } } } },
    orderBy: { savedAt: 'desc' },
  })

  return NextResponse.json(bookmarks.map(b => ({
    saved_at: b.savedAt, wine_id: b.wineId,
    name: b.wine.name, producer: b.wine.producer, vintage: b.wine.vintage,
    style: b.wine.style, category: b.wine.category, image_url: b.wine.imageUrl,
    purchase_url: b.wine.purchaseUrl, session_code: b.wine.session.code,
  })))
}
