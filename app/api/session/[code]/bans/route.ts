import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveIdentity, isValidIdentityId } from '@/lib/identity'
import { getSessionMeta, isHostByIdentity, isStrictHost, isCohostId } from '@/lib/session'
import { listBans, acquireBanLock, releaseBanLock } from '@/lib/sessionBan'
import { sessionWipe } from '@/lib/sessionWipe'
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
  const session = await resolveUser(req)
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(meta, identity)) {
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
  const session = await resolveUser(req)
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(meta, identity)) {
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
  if (!isValidIdentityId(identityId)) {
    return NextResponse.json({ error: 'invalid identityId' }, { status: 400, headers: noStore })
  }
  if (mode !== 'kick' && mode !== 'ban') {
    return NextResponse.json({ error: 'mode must be kick or ban' }, { status: 400, headers: noStore })
  }
  if (identityId === identity.id) {
    return NextResponse.json({ error: 'cannot remove yourself' }, { status: 400, headers: noStore })
  }
  // Targeting the strict host is never allowed.
  if (isStrictHost(meta, { id: identityId, displayName: '', kind: 'user' })) {
    return NextResponse.json({ error: 'cannot remove the host' }, { status: 400, headers: noStore })
  }
  // Targeting a cohost requires strict-host. Cohosts can only ban
  // regular tasters.
  if (isCohostId(meta, identityId) && !isStrictHost(meta, identity)) {
    return NextResponse.json({ error: 'only the host can remove a co-host' }, { status: 403, headers: noStore })
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

  // Hold the per-session ban lock during the wipe so the wines JSON
  // write-back doesn't race a concurrent host action.
  if (!(await acquireBanLock(c))) {
    return NextResponse.json({ error: 'another moderation action is in progress' }, { status: 409, headers: noStore })
  }
  try {
    await sessionWipe({
      code: c,
      identityId,
      scope: mode === 'kick' ? 'kick-keep' : 'ban',
      // Host's wine-delete toggle applies to both kick and ban — the
      // wines belong to the session, not the participant, so it's the
      // host's call regardless of mode.
      deleteAddedWines: deleteAddedWines === true,
    })
  } finally {
    await releaseBanLock(c)
  }

  return NextResponse.json({ ok: true }, { headers: noStore })
}
