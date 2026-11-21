import { NextRequest, NextResponse } from 'next/server'
import { normalizeCode } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { isHostByIdentity } from '@/lib/session'
import { refuse } from '@/lib/sessionMutation'
import { openAsParticipant } from '@/lib/sessionRoute'
import { authUnavailable } from '@/lib/identity'
import { readGrant, grantStatus } from '@/lib/sessionGrant'
import { checkRate, formatWait, getClientIp } from '@/lib/rateLimit'
import { momentLookInEnabled } from '@/lib/momentGate'
import { readMomentSettingsByCode, momentVisibilityView, parseVisibilityPatch, widens, frozen, writeVisibility } from '@/lib/momentSettings'
import { momentSettingsWrite, momentSettingsSeams, featureOff, noStore } from '@/lib/momentSettingsRoute'

type Ctx = { params: Promise<{ code: string }> }

// Moment Visibility, read from the RECORD on every call (never the cached
// meta: step-1 plan T7). Any participant reads the four settings; `canEdit`
// and the link part only for a signed-in host or cohost (the grant). A moment
// with no record (guest-only) reads as closed and frozen.
//
// 🔒 The flag check sits AFTER the entrance gate, so the route sweep covers
// this route with no exemption; its 404 is the app's "feature off" signal.
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)
  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  if (!momentLookInEnabled()) return featureOff()
  // Per user when signed in; per address for a guest, whose identity can be re-minted.
  const who = op.identity.kind === 'user' ? `u:${op.identity.id.slice(2)}` : `ip:${getClientIp(req)}`
  const rl = await checkRate(`rl:moment-visibility-read:${who}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }
  await momentSettingsSeams.afterGate(c)
  const settings = await readMomentSettingsByCode(prisma, c)
  // The code was deleted and reused since this request opened the moment. (A
  // row without a created_at cannot be compared and passes, as everywhere.)
  if (settings && settings.createdAt !== null && settings.createdAt !== op.meta.createdAt) return authUnavailable()
  // 🔒 The link is shown on a grant read AFTER the link state, never on the
  // gate's earlier one: a cohost demoted (or kicked) and THEN the link reset,
  // both between the gate and this read, would otherwise be handed the
  // replacement link, which is exactly what the reset was for. Read in this
  // order, any link state this request saw was committed before the grant
  // read, and so was every removal that preceded it.
  let canEdit = false
  if (settings && op.identity.kind === 'user' && op.identity.grant && isHostByIdentity(op.meta, op.identity)) {
    const fresh = await readGrant(prisma, c, Number(op.identity.id.slice(2)))
    canEdit = !!fresh && fresh.sessionId === settings.sessionId && grantStatus(fresh) === 'ok' && (fresh.strictHost || fresh.role === 'co_host')
  }
  return NextResponse.json(momentVisibilityView(settings, canEdit), { headers: noStore })
}

// Body: any of `visibility`, `includeGuestCircles`, `showPlace`, `showDetails`.
// Host and cohosts; not pro-gated. 🔒 The freeze: a moment with no signed-in
// host can be narrowed, never widened (decided under the locks, from the
// locked row; sending the current value is never a change).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  return momentSettingsWrite(req, code, 'moment-visibility', parseVisibilityPatch, async (tx, current, patch) => {
    if (frozen(current) && widens(current, patch)) throw refuse(403, 'This moment\'s visibility can\'t be widened')
    return writeVisibility(tx, current, patch)
  })
}
