import { NextRequest, NextResponse } from 'next/server'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { withSessionMutation, admitted, refuse } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
import { grantStatus } from '@/lib/sessionGrant'
import { checkRate, formatWait, getClientIp, refundRate } from '@/lib/rateLimit'
import { momentLookInEnabled, hideFromFeedEnabled } from '@/lib/momentGate'
import { featureOff, noStore } from '@/lib/momentSettingsRoute'
import { setMomentChoice, setGuestShown, readMomentChoices, guestOnlyInside, postPrivacyKey, showMomentChoice } from '@/lib/postPrivacy'

type Ctx = { params: Promise<{ code: string }> }

const NO_RECORD = 'This moment can\'t be seen from outside'
const noRecord = () => NextResponse.json({ error: NO_RECORD }, { status: 403, headers: noStore })

// PATCH /api/session/:code/me/privacy `{ "onlyInside": boolean }` |
// `{ "hiddenFromFeed": boolean }` (exactly one; Moment Visibility step 3,
// § 4.7, R11, R12): your own choices in this moment, for anyone in it (host,
// cohosts, tasters; a guest only `onlyInside`). `onlyInside` = "Incognito"
// (outsiders don't see you took part); `hiddenFromFeed` = "Hide from Feed" for
// your post of this moment (nobody but you sees it, people in it included; needs
// HIDE_FROM_FEED_ENABLED). The settings page and the web guest menu. Replies
// with the field echoed.
//
// Order: same origin → the entrance gate → the flag (404) → no record (403,
// the same for every request on that moment) → the body (400) → for SHOWING
// again only: the current choice (already shown: answered, no write, no
// charge), then the limiter (`rl:post-privacy`, shared with the post route; a
// guest per moment and address) → the contract. 🔒 Hiding is never charged or
// refused (R10, ruled 2026-11-24).
// 🔒 Signed in: one upsert of `moment_privacy` under the contract
// (`redisLock: false`: nothing mirrors it), admitted by the FRESH grant.
// 🔒 A guest: the contract with the Redis lock, the fenced SREM (hide) / SADD
// (show) of the caller's own id on `s:{CODE}:shown` (the second writer).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)
  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  if (!momentLookInEnabled()) return featureOff()
  const { identity } = op
  const signedIn = identity.kind === 'user'
  if (signedIn && !identity.grant) return noRecord()
  if (!signedIn) {
    const row = await prisma.session.findFirst({ where: { code: c, deletedAt: null }, select: { id: true } })
    if (!row) return noRecord()
  }
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  }
  // Exactly one choice: Incognito (`onlyInside`, R11) or, signed in and with
  // HIDE_FROM_FEED_ENABLED, Hide from Feed for your post of this moment
  // (`hiddenFromFeed`, R12; a field whose flag is off answers like a missing
  // route). A guest has no posts: Incognito only.
  const field = Object.keys(body)[0]
  if (field === 'hiddenFromFeed' && !hideFromFeedEnabled()) return featureOff()
  if ((field !== 'onlyInside' && field !== 'hiddenFromFeed') || (field === 'hiddenFromFeed' && !signedIn) || typeof body[field] !== 'boolean') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  }
  const on = body[field] as boolean
  // 🔒 R10 (ruled 2026-11-24): HIDING is never refused or counted (a
  // protective path, like Unblock); showing again counts, and only when it is
  // a change (already shown: answered, nothing written, nothing charged).
  // A slot is RESERVED here (atomic, so a burst can't overshoot); the write
  // inside the contract changes only a choice still on and says so; the slot
  // is given back when it changed nothing or the contract failed, and a
  // refused request whose choice is already shown is answered, not refused
  // (Codex recheck 2026-11-25).
  let key: { key: string; max: number } | null = null
  if (!on) {
    const hiddenNow = async () => signedIn
      ? (await readMomentChoices(prisma, identity.grant!.sessionId, Number(identity.id.slice(2))))[field]
      : await guestOnlyInside(c, identity.id)
    if (!(await hiddenNow())) return NextResponse.json({ [field]: false }, { headers: noStore })
    key = signedIn ? postPrivacyKey.user(identity.id.slice(2)) : postPrivacyKey.guest(c, getClientIp(req))
    const rl = await checkRate(key.key, key.max, 3600)
    if (!rl.allowed) {
      await refundRate(key.key) // a refusal takes no slot (Codex recheck 2)
      if (!(await hiddenNow())) return NextResponse.json({ [field]: false }, { headers: noStore })
      return NextResponse.json(
        { error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
        { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
      )
    }
  }
  let changed = false
  try {
    if (signedIn) {
      changed = await withSessionMutation(c, { label: 'moment-privacy', redisLock: false, caller: identity }, async (tx, ctx) => {
        const caller = admitted(ctx)
        if (!caller.grant || !ctx.row || grantStatus(caller.grant) !== 'ok') throw refuse(403, NO_RECORD)
        const uid = Number(caller.id.slice(2))
        if (!on) return showMomentChoice(tx, ctx.row.id, uid, field)
        await setMomentChoice(tx, ctx.row.id, uid, field, true)
        return false
      })
    } else {
      changed = await withSessionMutation(c, { label: 'moment-privacy-guest', redisLock: { waitMs: 1000 }, caller: identity, expectedCreatedAt: op.meta.createdAt },
        async (_tx, ctx) => {
          admitted(ctx)
          if (!ctx.row) throw refuse(403, NO_RECORD)
          return setGuestShown(ctx.fence!, c, identity.id, on)
        })
    }
  } catch (err) {
    if (key) await refundRate(key.key)
    return contractFailure(err, c, { label: 'moment-privacy' })
  }
  if (key && !changed) await refundRate(key.key)
  return NextResponse.json({ [field]: on }, { headers: noStore })
}
