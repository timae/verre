import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { ensurePromoted, mirrorLineup, type WineMeta } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { participantOrBanned, authUnavailable } from '@/lib/identity'
import { withSessionMutation, refuse, ContractCold } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  // Bookmarking requires session participation. Without this, any
  // logged-in user could enumerate session codes and bookmark wines
  // from sessions they were never part of.
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status, 'session not found')
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status !== 'ok') return NextResponse.json({ error: 'not a participant' }, { status: 403 })
  if (!opened.wines.some(w => w.id === wineId)) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Bookmarking is a logged-in act: promote first (before this route's own
  // contract), then — inside the contract (advisory lock + the publication
  // generation, plan § 3) — re-check admission, mirror the lineup so the
  // wine's FK row exists, and write the bookmark. Same transaction: no durable
  // write outside the one that owns it.
  try { await ensurePromoted(c, opened.meta) }
  catch (err) { console.error('[bookmark] promotion failed', { code: c, err }) }
  const userId = Number(session.user.id)
  try {
    await withSessionMutation(c, { label: 'bookmark', caller: p.identity, bumpGen: true, expectedCreatedAt: opened.meta.createdAt }, async (tx, ctx) => {
      if (ctx.callerStatus !== 'ok') throw refuse(403, 'not a participant')
      if (!ctx.row) throw refuse(503, 'try again', { 'Retry-After': '1' })
      const raw = await redis.get(k.wines(c))
      if (raw === null) throw new ContractCold(c)
      const wines = JSON.parse(raw) as WineMeta[]
      if (!wines.some(w => w.id === wineId)) throw refuse(404, 'wine not found')
      await mirrorLineup(tx, ctx.row.id, wines)
      await tx.$executeRaw`INSERT INTO bookmarks (user_id, wine_id) VALUES (${userId}, ${wineId}) ON CONFLICT DO NOTHING`
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'bookmark' })
  }
  return NextResponse.json({ ok: true, bookmarked: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code: _code, wineId } = await params
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  await prisma.bookmark.deleteMany({
    where: { userId: Number(session.user.id), wineId },
  })
  return NextResponse.json({ ok: true, bookmarked: false })
}
