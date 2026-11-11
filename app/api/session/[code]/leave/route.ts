import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { participantOrBanned, resolveIdentity, authUnavailable } from '@/lib/identity'
import { sessionWipe } from '@/lib/sessionWipe'
import { refuse } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// POST /api/session/<code>/leave?cleanup={keep|full}
//
// Endpoint the kicked-user-side bounce screen calls when the user picks
// "Delete my ratings". `cleanup=keep` is the default no-op (data stays;
// session remains in /me/sessions). `cleanup=full` wipes ratings +
// bookmarks + session_members for the (user, session)
// pair — same scope as the host-side kick-with-delete branch.
//
// Caller must resolve to an identity that is currently banned OR no
// longer a registered participant. Active participants are rejected so
// no one can blow away their own session data via this path while
// staying in the session.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const session = await resolveUser(req)
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })

  // Rate limit keyed on the caller's identity-id. Without this, a non-
  // participant holding any valid token could spam `cleanup=full` and
  // force a per-session lock + Postgres txn per call. 20/10min is
  // generous for legitimate Keep/Delete flows (one or two calls per
  // session) but bounds the abuse.
  const rl = await checkRate(`rl:sessleave:${identity.id}:10m`, 20, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many leave attempts. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Authorization: the caller must NOT be a currently-admitted participant —
  // banned, kicked, or no longer registered. For a `u:` caller of a
  // Postgres-backed session that is the RECORD's answer (a participant whose
  // roster entry was merely evicted is still a participant and must not be able
  // to blow away their own data here). Re-decided under the locks below.
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'ok') {
    return NextResponse.json({ error: 'still a participant' }, { status: 403, headers: noStore })
  }

  const url = new URL(req.url)
  const cleanup = url.searchParams.get('cleanup')
  if (cleanup !== 'full') {
    // Default no-op. "Keep" is the inaction state — nothing to do.
    return NextResponse.json({ ok: true, cleaned: false }, { headers: noStore })
  }

  // Full cleanup. Reuse the kick-delete scope. The wine-orphan toggle is forced
  // false here — wines are the host's decision, not the kicked user's.
  try {
    await sessionWipe({
      code: c,
      identityId: identity.id,
      scope: 'kick-delete',
      deleteAddedWines: false,
      caller: identity,
      expectedCreatedAt: opened.meta.createdAt,
      label: 'leave',
      authorize: (ctx) => { if (ctx.callerStatus === 'ok') throw refuse(403, 'still a participant') },
      // Kicked marker no longer needed — the user has chosen + acted.
      afterCommit: async (ctx) => { await ctx.fence!.exec(m => { m.sRem(k.kicked(c), identity.id) }) },
    })
  } catch (err) {
    return contractFailure(err, c, { busy: 409, label: 'leave' })
  }

  return NextResponse.json({ ok: true, cleaned: true }, { headers: noStore })
}
