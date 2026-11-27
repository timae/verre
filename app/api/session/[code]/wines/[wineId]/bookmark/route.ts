import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { ensurePromoted, type SessionMeta } from '@/lib/session'
import { reconcileLineup, lockOccurrence, readOccurrence } from '@/lib/occurrences'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { participantOrBanned, authUnavailable } from '@/lib/identity'
import { authInvalid, authRemoved } from '@/lib/authResponses'
import { withSessionMutation, refuse, type MutationCtx } from '@/lib/sessionMutation'
import { bottleHiddenFor, lineupHiddenFor } from '@/lib/sessionState'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor } from '@/lib/sessionRoute'
import { saveBottle, unsaveBottle, NOT_IN_CATALOGUE, SAVE_LIMIT } from '@/lib/cravings'
import { checkRate, formatWait } from '@/lib/rateLimit'
import type { AuthorizedIdentity } from '@/lib/sessionGrant'
import type { WineMeta } from '@/lib/session'

type Ctx = { params: Promise<{ code: string; wineId: string }> }

// POST / DELETE /api/session/<code>/wines/<wineId>/bookmark: save or unsave ONE
// bottle of the moment (catalogue model change § 5; lib/cravings.ts has the
// rules). Answers `{ ok, saved }`.
//
// 🔒 Decided under the contract's locks, in this order: a hidden line-up → the
// same 404 as a missing bottle (the read has no bottle); then the LIVE blind
// rule for the caller (`bottleHiddenFor`, the line-up's own): on "Wine N" the
// save is a save of THAT bottle, answered the same whatever was stored, BEFORE
// any other refusal (so "not in the catalogue" never tells a hidden bottle's
// link); only a visible unlinked bottle answers 409.
//
// Saving needs a participant and a signed-in caller (it is a logged-in act:
// the moment is promoted first, before this route's own contract).
async function run(req: NextRequest, { params }: Ctx, on: boolean): Promise<NextResponse> {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  // Bookmarking requires session participation. Without this, any logged-in
  // user could enumerate session codes and bookmark wines from sessions they
  // were never part of.
  const opened = await openSessionFor(c, req, session, { notFound: 'session not found' })
  if (opened instanceof NextResponse) return opened
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status !== 'ok') return authInvalid()
  // An early reject only (decided again under the locks). A cache behind the
  // record must not 404 a bottle the record has.
  if (lineupHiddenFor(opened.meta, p.identity) || (!opened.wines.some(w => w.id === wineId) && !(await readOccurrence(c, wineId)))) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const userId = Number(session.user.id)
  const rl = await checkRate(SAVE_LIMIT.key(userId), SAVE_LIMIT.limit, SAVE_LIMIT.windowSec)
  if (!rl.allowed) return NextResponse.json({ error: `Too many saves. Try again in ${formatWait(rl.retryAfter)}.` }, { status: 429 })

  if (on) {
    try { await ensurePromoted(c, opened.meta) }
    catch (err) { console.error('[bookmark] promotion failed', { code: c, err }) }
  }
  try {
    await withSessionMutation(c, { label: 'bookmark', caller: p.identity, bumpGen: true, expectedCreatedAt: opened.meta.createdAt }, async (tx, ctx) => {
      if (ctx.callerStatus !== 'ok') throw refuse(403, 'not a participant')
      // A Redis-only moment has no cravings to remove; a save needs the record.
      if (!ctx.row) { if (on) throw refuse(503, 'try again', { 'Retry-After': '1' }); return }
      await reconcileLineup(tx, ctx)
      const wine = await lockOccurrence(tx, ctx.row.id, wineId)
      if (!wine || !ctx.meta || !ctx.caller || lineupHiddenFor(ctx.meta, ctx.caller)) throw refuse(404, 'wine not found')
      const hidden = hiddenNow(ctx, ctx.caller, wine)
      const out = on ? await saveBottle(tx, userId, wineId, hidden) : await unsaveBottle(tx, userId, wineId, hidden)
      if (out === 'gone') throw refuse(404, 'wine not found')
      if (out === 'not-in-catalogue') throw refuse(409, NOT_IN_CATALOGUE)
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'bookmark' })
  }
  return NextResponse.json({ ok: true, saved: on }, { headers: { 'Cache-Control': 'private, no-store' } })
}

// Hidden for the caller by the live rule, from the cached settings AND the
// record's, whichever is stricter (a tightening settings write lands in the
// cache before its COMMIT); ownership from the locked RECORD row.
function hiddenNow(ctx: MutationCtx, caller: AuthorizedIdentity, wine: WineMeta): boolean {
  const meta = ctx.meta as SessionMeta
  const strict: SessionMeta = { ...meta, blind: !!meta.blind || !!ctx.row?.blind, blindForEveryone: !!meta.blindForEveryone || !!ctx.row?.blindForEveryone }
  return bottleHiddenFor(strict, caller, wine, !!wine.addedByIdentityId && wine.addedByIdentityId === caller.id)
}

export async function POST(req: NextRequest, ctx: Ctx) { return run(req, ctx, true) }
export async function DELETE(req: NextRequest, ctx: Ctx) { return run(req, ctx, false) }
