import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveIdentity, isValidIdentityId } from '@/lib/identity'
import { getSessionMeta, isHostByIdentity } from '@/lib/session'
import { removeBan } from '@/lib/sessionBan'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string; identityId: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// DELETE /api/session/<code>/bans/<identityId> — lift a ban. Idempotent.
// Authorization: host or cohost. Either can unban any target, including
// users banned by a different moderator (no per-row "banned by whom"
// attribution — once a ban is lifted, it's lifted).
//
// Lifts the bans-Set entry only. The user's data is already gone
// (deleted at ban time); unbanning doesn't restore it.
//
// Shares the 60/10min rate-limit budget with POST.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code, identityId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await auth()
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }
  // URL-decode the identity-id (path segment, may contain "%3A" for ":")
  const targetId = decodeURIComponent(identityId)
  if (!isValidIdentityId(targetId)) {
    return NextResponse.json({ error: 'invalid identityId' }, { status: 400, headers: noStore })
  }

  const rl = await checkRate(`rl:sessban:${identity.id}:10m`, 60, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many ban actions. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  await removeBan(c, targetId)
  return NextResponse.json({ ok: true }, { headers: noStore })
}
