import { NextRequest, NextResponse } from 'next/server'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveUser } from '@/lib/resolveUser'
import { isHostByIdentity } from '@/lib/session'
import { withSessionMutation, admitted, refuse } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { momentLookInEnabled } from '@/lib/momentGate'
import { readMomentSettings, momentVisibilityView, type MomentSettings } from '@/lib/momentSettings'
import type { Prisma } from '@prisma/client'

// The two writes of Moment Visibility (the visibility PATCH and the look-in
// link POST, step-1 plan § 4.2) share everything but the change itself:
// same-origin, the entrance gate, the flag (404), ONE limiter (30/h/user,
// `rl:moment-visibility`: a save and a link action can't stack N+N), and the
// decision under the session mutation contract.
//
// 🔒 Signed-in only, power from the RECORD: the caller must be a `u:` identity
// with a grant (so the moment has a row) that makes them host or cohost. A
// guest cohost's role lives only in the cache; it reads the four settings and
// gets a 403 here. Decided under the locks from `ctx.caller`; the check before
// them is only an early reject.

// Test seam (the you-profile suite § 23): a no-op unless a suite replaces it.
// `afterGate` fires in the visibility GET between the entrance gate and its
// record reads.
export const momentSettingsSeams: { afterGate: (code: string) => Promise<void> } = { afterGate: async () => {} }

export const noStore = { 'Cache-Control': 'private, no-store' }
export const featureOff = () => NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
const HOST_ONLY = 'only the host can change who can look in'
const hostOnly = () => NextResponse.json({ error: HOST_ONLY }, { status: 403, headers: noStore })

export async function momentSettingsWrite<B>(
  req: NextRequest, code: string, label: string,
  parse: (body: unknown) => B | null,
  change: (tx: Prisma.TransactionClient, current: MomentSettings, body: B) => Promise<MomentSettings>,
): Promise<NextResponse> {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)
  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  if (!momentLookInEnabled()) return featureOff()
  if (op.identity.kind !== 'user' || !op.identity.grant) return hostOnly()
  const rl = await checkRate(`rl:moment-visibility:u:${op.identity.id.slice(2)}:1h`, 30, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }
  if (!isHostByIdentity(op.meta, op.identity)) return hostOnly()
  const body = parse(await req.json().catch(() => null))
  if (body === null) return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  try {
    const next = await withSessionMutation(c, { label, redisLock: false, caller: op.identity }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!caller.grant || !ctx.row || !isHostByIdentity(ctx.meta!, caller)) throw refuse(403, HOST_ONLY)
      const current = await readMomentSettings(tx, ctx.row.id)
      if (!current) throw refuse(403, HOST_ONLY)
      return change(tx, current, body)
    })
    return NextResponse.json(momentVisibilityView(next, true), { headers: noStore })
  } catch (err) {
    return contractFailure(err, c, { label })
  }
}
