import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import type { WineMeta } from '@/lib/session'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, admitted, ratingKeyWrite } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'

// DELETE /api/session/<code>/rate/<wineId> — the explicit "Reset" of the
// caller's rating of one wine: the rating key, and for a logged-in rater of a
// Postgres-backed session the archived row (force-mode engagement cascade:
// the rating, then the session feed item if it was their last rating there;
// photos reclaimed after COMMIT) and the HoF entry (wineName + userId +
// sessionCode).
//
// 🔒 Inside the session mutation contract, holding the Redis lease (r3-3: a
// path that deletes a rating key must hold it — otherwise a rebuild whose
// backend died after its read could republish the deleted rating with its NX
// publish), with the publication generation bumped and the admission re-made
// under the locks.
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
      if (caller.kind === 'user' && ctx.row) {
        const userId = Number(caller.id.slice(2))
        // Scoped to (user, session) so a same-(user, wine) standalone or
        // other-session rating is never touched.
        const rating = await tx.$queryRaw<{ id: number }[]>`
          SELECT id FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${ctx.row.id} LIMIT 1`
        if (rating[0]) reclaim = (await engagementCascadeIn(tx, rating[0].id, 'force')) ?? []
        const wine = (JSON.parse((await redis.get(k.wines(c))) ?? '[]') as WineMeta[]).find(w => w.id === wineId)
        if (wine) await tx.hallOfFame.deleteMany({ where: { wineName: wine.name, userId, sessionCode: c } })
      }
      await ratingKeyWrite(ctx, k.rating(c, caller.id, wineId), null)
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'rate-delete' })
  }
  reclaimImages(reclaim)
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
