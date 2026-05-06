import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

type Ctx = { params: Promise<{ wineId: string }> }

// DELETE /api/me/bookmarks/<wineId> — remove a bookmark from the saved list.
// Session-agnostic: works on orphaned wines (session_id = NULL) where the
// existing /api/session/<code>/wines/<id>/bookmark endpoint would need a
// session code that no longer exists.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const { wineId } = await params
  await prisma.bookmark.deleteMany({
    where: { userId: Number(session.user.id), wineId },
  })
  return NextResponse.json({ ok: true })
}
