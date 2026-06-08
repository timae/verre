import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveIdentity } from '@/lib/identity'
import { acquireBanLock, releaseBanLock } from '@/lib/sessionBan'
import { sessionWipe } from '@/lib/sessionWipe'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// POST /api/session/<code>/leave?cleanup={keep|full}
//
// Endpoint the kicked-user-side bounce screen calls when the user picks
// "Delete my ratings". `cleanup=keep` is the default no-op (data stays;
// session remains in /me/sessions). `cleanup=full` wipes ratings +
// hall_of_fame + bookmarks + session_members for the (user, session)
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
  const session = await auth()
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

  // Authorization: the caller must NOT be a currently-active participant.
  // Either the bans Set contains their id (kicked or banned, banned
  // explicitly), or the identities hash doesn't (kicked + then a
  // subsequent participant-list refresh dropped them). Active
  // participants use the normal session flows.
  const isBannedNow = await redis.sIsMember(k.bans(c), identity.id)
  const stillRegistered = await redis.hExists(k.identities(c), identity.id)
  if (!isBannedNow && stillRegistered) {
    return NextResponse.json({ error: 'still a participant' }, { status: 403, headers: noStore })
  }

  const url = new URL(req.url)
  const cleanup = url.searchParams.get('cleanup')
  if (cleanup !== 'full') {
    // Default no-op. "Keep" is the inaction state — nothing to do.
    return NextResponse.json({ ok: true, cleaned: false }, { headers: noStore })
  }

  // Full cleanup. Reuse the kick-delete scope. The wine-orphan toggle
  // is forced false here — wines are the host's decision, not the
  // kicked user's. If the host already orphaned them at ban time, that
  // ran in a separate call.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json({ error: 'another moderation action is in progress' }, { status: 409, headers: noStore })
  }
  try {
    await sessionWipe({
      code: c,
      identityId: identity.id,
      scope: 'kick-delete',
      deleteAddedWines: false,
    })
    // Kicked marker no longer needed — the user has chosen + acted.
    await redis.sRem(k.kicked(c), identity.id)
  } finally {
    await releaseBanLock(c)
  }

  return NextResponse.json({ ok: true, cleaned: true }, { headers: noStore })
}
