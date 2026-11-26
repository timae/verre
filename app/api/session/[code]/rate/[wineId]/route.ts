import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, admitted, refuse, ratingKeyWrite } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
import { bumpRatingVersion } from '@/lib/ratingVersions'
import { afterCommit } from '@/lib/afterCommit'

// DELETE /api/session/<code>/rate/<wineId> — the explicit "Reset" of the
// caller's rating of one wine: the rating key, and for a logged-in rater of a
// Postgres-backed session the archived row (force-mode engagement cascade:
// the rating, then the session feed item if it was their last rating there;
// photos reclaimed after COMMIT).
//
// 🔒 Inside the session mutation contract, holding the Redis lease (r3-3: a
// path that deletes a rating key must hold it — otherwise a rebuild whose
// backend died after its read could republish the deleted rating with its NX
// publish), with the publication generation bumped and the admission re-made
// under the locks.
//
// 🔒 A signed-in caller in a moment with NO record answers 503 + Retry-After
// and writes nothing (docs/dev/rating-saves.md: no signed-in rating is written
// to Redis only any more); no promotion attempt of its own (its only web
// caller, the Undo chip, follows a successful save). The Postgres branch, when
// it finds the rating in THIS moment, bumps its version (`rating_versions`) and
// is the owner's own clear: the row's rating-action XP is taken back
// (engagementCascadeIn `ownClear`). 🔒 A Reset that finds no rating row here is
// VERSION-NEUTRAL: the version row is per (user, bottle id), and an id from the
// path may name a bottle of another moment. Guests keep the Redis-only delete.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string; wineId: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const op = await openAsParticipant(c, req, session, 'identity required')
  if (op instanceof NextResponse) return op
  const { identity } = op

  let reclaim: string[] = []
  try {
    await withSessionMutation(c, {
      label: 'rate-delete', redisLock: { waitMs: 3000 }, caller: identity, bumpGen: true, expectedCreatedAt: op.meta.createdAt,
    }, async (tx, ctx) => {
      reclaim = []   // per attempt (r3 P1)
      const caller = admitted(ctx)
      if (caller.kind === 'user' && !ctx.row) throw refuse(503, 'This moment isn’t ready to save yet. Try again in a moment.', { 'Retry-After': '5' })
      if (caller.kind === 'user' && ctx.row) {
        const userId = Number(caller.id.slice(2))
        // Scoped to (user, session) so a same-(user, wine) standalone or
        // other-session rating is never touched.
        const rating = await tx.$queryRaw<{ id: number }[]>`
          SELECT id FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${ctx.row.id} LIMIT 1`
        // rating-write: BUMPS
        if (rating[0]) {
          reclaim = (await engagementCascadeIn(tx, rating[0].id, 'force', { ownClear: true })) ?? []
          await bumpRatingVersion(tx, userId, wineId, null)
        }
      }
      // rating-write: BUMPS
      await ratingKeyWrite(ctx, k.rating(c, caller.id, wineId), null)
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'rate-delete' })
  }
  reclaimImages(reclaim)
  // After COMMIT, in the background (like the rate POST): a failed or stalled
  // refresh must not turn a committed Reset into an error.
  afterCommit('rate-delete', 'touch', c, () => touchWithMeta(c))
  return NextResponse.json({ ok: true })
}
