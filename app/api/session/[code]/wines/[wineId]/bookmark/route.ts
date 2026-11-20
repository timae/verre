import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { ensurePromoted } from '@/lib/session'
import { reconcileLineup, lockOccurrence, readOccurrence } from '@/lib/occurrences'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { participantOrBanned, authUnavailable } from '@/lib/identity'
import { withSessionMutation, refuse } from '@/lib/sessionMutation'
import { lineupHiddenFor } from '@/lib/sessionState'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor } from '@/lib/sessionRoute'

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
  const opened = await openSessionFor(c, req, session, { notFound: 'session not found' })
  if (opened instanceof NextResponse) return opened
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status !== 'ok') return NextResponse.json({ error: 'not a participant' }, { status: 403 })
  // A line-up hidden from the caller is the same 404 (an early reject; decided
  // again under the locks).
  // (A cache behind the record must not 404 a bottle the record has.)
  if (lineupHiddenFor(opened.meta, p.identity) || (!opened.wines.some(w => w.id === wineId) && !(await readOccurrence(c, wineId)))) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Bookmarking is a logged-in act: promote first (before this route's own
  // contract), then — inside the contract (advisory lock + the publication
  // generation, plan § 3) — re-check admission, find the bottle in the RECORD
  // (model change § 8a; a NULL revision reconciled first), and write the
  // bookmark. Same transaction: no durable write outside the one that owns it.
  try { await ensurePromoted(c, opened.meta) }
  catch (err) { console.error('[bookmark] promotion failed', { code: c, err }) }
  const userId = Number(session.user.id)
  try {
    await withSessionMutation(c, { label: 'bookmark', caller: p.identity, bumpGen: true, expectedCreatedAt: opened.meta.createdAt }, async (tx, ctx) => {
      if (ctx.callerStatus !== 'ok') throw refuse(403, 'not a participant')
      if (!ctx.row) throw refuse(503, 'try again', { 'Retry-After': '1' })
      await reconcileLineup(tx, ctx)
      // 🔒 A hidden line-up (the live rule, decided here from the fresh grant +
      // meta) is the same 404: the read hides the bottle, so must the write.
      if (!(await lockOccurrence(tx, ctx.row.id, wineId)) || !ctx.meta || !ctx.caller || lineupHiddenFor(ctx.meta, ctx.caller)) throw refuse(404, 'wine not found')
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
