import { NextResponse, type NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { isHostByIdentity, mutateWines, isMutateReject, mirrorLineup, type SessionMeta, type WineMeta, type MutateReject } from '@/lib/session'
import { withSessionMutation, admitted, refuse, bestEffortMirror } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'
import type { AuthorizedIdentity } from '@/lib/sessionGrant'

// The preamble of a participant-gated session route (redis-rehydration § 5.3):
// open the session (a cold Postgres-backed moment is rebuilt; 404 only when it
// is really gone, 503 while restoring), then the admission (the record for a
// `u:` caller of a Postgres-backed session). Returns the response to send on
// any refusal.
export async function openAsParticipant(
  code: string, req: NextRequest, session: Session | null, invalid?: string,
): Promise<{ meta: SessionMeta; wines: WineMeta[]; identity: AuthorizedIdentity } | NextResponse> {
  const opened = await openSession(code)
  if (opened.status !== 'live') return unavailable(opened.status)
  const p = await participantOrBanned(code, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid(invalid)
  return { meta: opened.meta, wines: opened.wines, identity: p.identity }
}

// A host-tier lineup write (reveal/hide, reveal-all/hide-all, reorder) inside
// the session mutation contract: the power re-decided from the caller's fresh
// grant, the fenced mutateWines (content, Redis-first), the whole-array mirror
// with positions (§ 4.6) — best-effort, repaired by the next list write.
export async function hostLineupWrite(
  code: string,
  caller: AuthorizedIdentity,
  { label, forbidden, rejectStatus = 404 }: { label: string; forbidden: string; rejectStatus?: number },
  transform: (wines: WineMeta[]) => WineMeta[] | MutateReject,
): Promise<WineMeta[] | NextResponse> {
  try {
    return await withSessionMutation(code, { label, redisLock: { waitMs: 3000 }, caller }, async (tx, ctx) => {
      if (!isHostByIdentity(ctx.meta!, admitted(ctx))) throw refuse(403, forbidden)
      const out = await mutateWines(ctx.fence!, transform)
      if (isMutateReject(out)) throw refuse(rejectStatus, out.reject)
      await bestEffortMirror(tx, code, 'wine-list', () => mirrorLineup(tx, ctx.row?.id ?? null, out))
      return out
    })
  } catch (err) {
    return contractFailure(err, code, { label })
  }
}
