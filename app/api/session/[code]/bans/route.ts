import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveAuthorized, authUnavailable, isValidIdentityId, isTombstoneIdentityId } from '@/lib/identity'
import { isHostByIdentity, isStrictHost } from '@/lib/session'
import { listBans } from '@/lib/sessionBan'
import { sessionWipe } from '@/lib/sessionWipe'
import { refuse } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }

// Every response on this route is viewer-dependent (auth gate + per-
// session state). Cache-Control: private, no-store on every return so a
// shared cache can't serve one viewer's response to another.
const noStore = { 'Cache-Control': 'private, no-store' }

// GET /api/session/<code>/bans — list banned identities for this session.
// Host + cohost can read (cohosts can ban, so cohosts see the list).
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const session = await resolveUser(req)
  const identity = await resolveAuthorized(c, req, session, opened.meta)
  if (identity === 'unavailable') return authUnavailable()
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(opened.meta, identity)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }
  const bans = await listBans(c)
  return NextResponse.json({ bans }, { headers: noStore })
}

// POST /api/session/<code>/bans — kick or ban a participant.
// Body: { identityId: string, mode: 'kick' | 'ban', deleteAddedWines?: boolean }
// Authorization:
//   - Host + cohost can target a regular participant.
//   - Banning/kicking a cohost requires strict-host.
//   - Self-target rejected.
// Rate limit: 60 / 10 min / user, shared between POST and DELETE.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  const session = await resolveUser(req)
  const identity = await resolveAuthorized(c, req, session, opened.meta)
  if (identity === 'unavailable') return authUnavailable()
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  // Early reject only — every gating decision is re-made under the locks.
  if (!isHostByIdentity(opened.meta, identity)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }

  // Validate body BEFORE incrementing the rate-limit budget — a cohost
  // with malformed input or invalid targets shouldn't burn through their
  // 60/10min allotment on bad attempts.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  }
  const { identityId, mode, deleteAddedWines } = body as Record<string, unknown>
  // isValidIdentityId rejects malformed shapes — without it, a bad
  // client could accumulate junk in the bans Set or burn a Postgres txn
  // on a no-op wipe.
  // A `d:` tombstone (a deleted account's ratings, redis-rehydration § 4.3)
  // cannot rejoin, so ban and kick-keep are meaningless for it: `mode: 'kick'`
  // on a d: runs kick-DELETE (G4 — its ratings by tombstone_key go, wine
  // provenance stays), `mode: 'ban'` is the same 400 as a malformed id.
  if (!isValidIdentityId(identityId) || (isTombstoneIdentityId(identityId) && mode === 'ban')) {
    return NextResponse.json({ error: 'invalid identityId' }, { status: 400, headers: noStore })
  }
  if (mode !== 'kick' && mode !== 'ban') {
    return NextResponse.json({ error: 'mode must be kick or ban' }, { status: 400, headers: noStore })
  }
  if (identityId === identity.id) {
    return NextResponse.json({ error: 'cannot remove yourself' }, { status: 400, headers: noStore })
  }

  // Rate limit AFTER permission gates: validated cohost actions still
  // consume the budget, but invalid attempts don't.
  const rl = await checkRate(`rl:sessban:${identity.id}:10m`, 60, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many ban actions. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // The whole wipe runs inside the session mutation contract; the caller's
  // power and the target's role/host status are decided there, fresh (§ 4.7):
  // the host can never be targeted; removing a cohost requires the strict host.
  try {
    await sessionWipe({
      code: c,
      identityId,
      scope: isTombstoneIdentityId(identityId) ? 'kick-delete' : mode === 'kick' ? 'kick-keep' : 'ban',
      // Host's wine-delete toggle applies to both kick and ban — the wines
      // belong to the session, not the participant.
      deleteAddedWines: deleteAddedWines === true,
      caller: identity,
      label: 'ban',
      authorize: (ctx, target) => {
        if (ctx.callerStatus !== 'ok' || !isHostByIdentity(ctx.meta!, ctx.caller)) throw refuse(403, 'forbidden')
        if (target.strictHost) throw refuse(400, 'cannot remove the host')
        if (target.cohost && !isStrictHost(ctx.meta!, ctx.caller)) throw refuse(403, 'only the host can remove a co-host')
      },
    })
  } catch (err) {
    return contractFailure(err, c, { busy: 409, label: 'ban' })
  }

  return NextResponse.json({ ok: true }, { headers: noStore })
}
