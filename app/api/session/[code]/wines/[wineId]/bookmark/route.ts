import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSessionMeta, getWines, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import { normalizeCode } from '@/lib/sessionCode'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { requireParticipant } from '@/lib/identity'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  // Bookmarking requires session participation. Without this, any
  // logged-in user could enumerate session codes and bookmark wines
  // from sessions they were never part of.
  const identity = await requireParticipant(c, req, session)
  if (!identity) return NextResponse.json({ error: 'not a participant' }, { status: 403 })

  const wines = await getWines(c)
  const wine = wines.find(w => w.id === wineId)
  if (!wine) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  try {
    const meta = await getSessionMeta(c)
    if (meta) {
      await pgUpsertSession(c, meta)
      await pgUpsertWine(c, wine)
    }
    await prisma.bookmark.upsert({
      where: { userId_wineId: { userId: Number(session.user.id), wineId } },
      create: { userId: Number(session.user.id), wineId },
      update: {},
    })
  } catch (err) {
    console.error('bookmark error:', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, bookmarked: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code: _code, wineId } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  await prisma.bookmark.deleteMany({
    where: { userId: Number(session.user.id), wineId },
  })
  return NextResponse.json({ ok: true, bookmarked: false })
}
