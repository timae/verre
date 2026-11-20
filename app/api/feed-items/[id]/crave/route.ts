import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { isSameOrigin } from '@/lib/csrf'
import { parsePathId } from '@/lib/parsePathId'
import { viewerCanSeePosts } from '@/lib/profileVisibility'
import { outsideViewSql } from '@/lib/outsideView'
import { saveBottle, unsaveBottle, NOT_IN_CATALOGUE, SAVE_LIMIT } from '@/lib/cravings'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }

// POST / DELETE /api/feed-items/<id>/crave { wineId }: save or unsave a bottle
// from someone's post (catalogue model change § 5; lib/cravings.ts has the
// rules). Answers `{ ok, saved }`, like the moment's own save.
//
// 🔒 Order: the post gate (`viewerCanSeePosts`: profile tier + Check-Ins
// Visible To) → 404, the bottle must be one of THIS post's (a check-in's own,
// or a session post's: the author rated it in that moment) → 404, a line-up
// hidden from the caller → 404 (the feed leaves it out), then the OUTSIDE rule
// for the caller (lib/outsideView.ts, the one the feed redacts by): on a
// redacted "Wine N" the save is a save of that bottle, answered the same
// whatever was stored, before any other refusal; only a visible unlinked
// bottle answers 409. Named: the decision reads committed state without the
// moment's lock (a reveal or a hide landing at the same instant decides it
// either way; neither answer names the wine).
async function run(req: NextRequest, { params }: Ctx, on: boolean): Promise<NextResponse> {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const itemId = parsePathId((await params).id)
  if (itemId === null) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const wineId = typeof body?.wineId === 'string' && body.wineId.length <= 21 ? body.wineId : null
  if (!wineId) return NextResponse.json({ error: 'wineId required' }, { status: 400, headers: NO_STORE })

  const item = await prisma.feedItem.findUnique({ where: { id: itemId }, select: { userId: true, kind: true, sessionId: true, ratingId: true } })
  if (!item || !(await viewerCanSeePosts(userId, item.userId))) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  const own = item.kind === 'session'
    ? item.sessionId !== null && Prisma.sql`EXISTS (SELECT 1 FROM ratings r WHERE r.wine_id = w.id AND r.user_id = ${item.userId} AND r.session_id = ${item.sessionId})`
    : item.ratingId !== null && Prisma.sql`EXISTS (SELECT 1 FROM ratings r WHERE r.id = ${item.ratingId} AND r.wine_id = w.id)`
  if (!own) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  const rl = await checkRate(SAVE_LIMIT.key(userId), SAVE_LIMIT.limit, SAVE_LIMIT.windowSec)
  if (!rl.allowed) return NextResponse.json({ error: `Too many saves. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429, headers: NO_STORE })
  const { redacted, hidden } = outsideViewSql(userId, { s: 's', w: 'w' })
  try {
    const out = await prisma.$transaction(async (tx) => {
      // 🔒 Lock order (review r2, r3): the moment's row FIRST, as every session
      // contract takes it (row, then bottle, then the saver's craving lock); a
      // key share on the bottle before it deadlocks against the host's edit,
      // delete or save of that bottle.
      if (item.sessionId !== null) await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${item.sessionId} FOR KEY SHARE`
      const f = (await tx.$queryRaw<{ redacted: boolean | null; hidden: boolean | null }[]>`
        SELECT ${redacted} AS redacted, ${hidden} AS hidden
          FROM wines w LEFT JOIN sessions s ON s.id = ${item.sessionId}
         WHERE w.id = ${wineId} AND ${own}
         FOR KEY SHARE OF w`)[0]
      // A NULL flag (never by construction) reads as the closed side.
      if (!f || f.hidden !== false) return 'gone' as const
      const isHidden = f.redacted !== false
      return on ? saveBottle(tx, userId, wineId, isHidden, itemId) : unsaveBottle(tx, userId, wineId, isHidden)
    })
    if (out === 'gone') return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
    if (out === 'not-in-catalogue') return NextResponse.json({ error: NOT_IN_CATALOGUE }, { status: 409, headers: NO_STORE })
  } catch (err) {
    // Belt: the bottle row is held FOR KEY SHARE for the transaction, so a
    // concurrent delete waits; should a key error still surface, it is a 404.
    if ((err as { code?: string })?.code === 'P2003') return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
    // A deadlock or serialisation failure is transient: try again (the raw
    // statement's code, as lib/username.ts reads it under Prisma 7).
    const e = err as { meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null
    const pg = e?.meta?.code ?? e?.meta?.driverAdapterError?.cause?.originalCode
    if (pg === '40P01' || pg === '40001') {
      return NextResponse.json({ error: 'try again' }, { status: 503, headers: { ...NO_STORE, 'Retry-After': '1' } })
    }
    throw err
  }
  return NextResponse.json({ ok: true, saved: on }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(req: NextRequest, ctx: Ctx) { return run(req, ctx, true) }
export async function DELETE(req: NextRequest, ctx: Ctx) { return run(req, ctx, false) }
