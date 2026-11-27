import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { parsePathId } from '@/lib/parsePathId'
import { checkRate, formatWait, refundRate } from '@/lib/rateLimit'
import { momentLookInEnabled, hideFromFeedEnabled } from '@/lib/momentGate'
import { setHiddenFromFeed, setMomentChoiceByPost, ownPostPrivacy, postPrivacyKey, showHiddenCheckin, showMomentChoiceByPost } from '@/lib/postPrivacy'

type Ctx = { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }
const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })

// PATCH /api/feed-items/:id/privacy (Moment Visibility step 3, § 4.7): the
// post's ⋯ rows on YOUR OWN post. Exactly one field:
//   `{ "onlyInside": boolean }`     a moment post: Incognito in its moment
//                                   (R11; MOMENT_LOOKIN_ENABLED)
//   `{ "hiddenFromFeed": boolean }` a check-in or a moment post: Hide from
//                                   Feed (R12; HIDE_FROM_FEED_ENABLED)
// Replies with the field echoed. By authorship alone, so it works after the
// moment is deleted and for a kicked author; no session contract (there is no
// session lock to take after a deletion).
//
// Order: same origin → signed in (401) → both flags off (404, BEFORE the body:
// a switched-off route answers like a missing one) → the body: exactly one
// known field whose flag is on (a field whose flag is off is an unknown
// field: the same 404), a boolean, else 400 → the id (404) → for SHOWING
// again only: the caller's post of the field's kind (else the same 404) and its
// current value (already shown: answered, no write, no charge), then the
// limiter (`rl:post-privacy`, shared with the moment route) → the write, whose
// statement matches the caller's post of that kind again (else the same 404).
// 🔒 Hiding is never charged or refused (R10, ruled 2026-11-24).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const userId = Number(session.user.id)
  const onlyInsideOn = momentLookInEnabled()
  const hideOn = hideFromFeedEnabled()
  if (!onlyInsideOn && !hideOn) return notFound()
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: NO_STORE })
  }
  const field = Object.keys(body)[0]
  if (!(field === 'onlyInside' && onlyInsideOn) && !(field === 'hiddenFromFeed' && hideOn)) return notFound()
  const on = body[field]
  if (typeof on !== 'boolean') return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: NO_STORE })
  const postId = parsePathId((await params).id)
  if (postId === null) return notFound()
  // 🔒 R10 (ruled 2026-11-24): hiding is never refused or counted; showing
  // again counts, and only on a change (already shown: answered, no write).
  // A slot is RESERVED before the write (atomic, so a burst can't overshoot)
  // and given back when the write changed nothing (a concurrent twin got
  // there first); a refused request whose choice is already shown is answered,
  // not refused (Codex recheck 2026-11-25).
  if (!on) {
    const now = await ownPostPrivacy(postId, userId, field)
    if (now === null) return notFound()
    if (!now) return NextResponse.json({ [field]: false }, { headers: NO_STORE })
    const key = postPrivacyKey.user(userId)
    const rl = await checkRate(key.key, key.max, 3600)
    if (!rl.allowed) {
      await refundRate(key.key) // a refusal takes no slot (Codex recheck 2)
      if ((await ownPostPrivacy(postId, userId, field)) === false) return NextResponse.json({ [field]: false }, { headers: NO_STORE })
      return NextResponse.json(
        { error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } },
      )
    }
    let changed: boolean
    try {
      changed = field === 'hiddenFromFeed'
        ? (await showHiddenCheckin(postId, userId)) || (await showMomentChoiceByPost(postId, userId, 'hiddenFromFeed'))
        : await showMomentChoiceByPost(postId, userId, 'onlyInside')
    } catch (err) {
      await refundRate(key.key) // a write that failed changed nothing
      throw err
    }
    if (!changed) await refundRate(key.key)
    return NextResponse.json({ [field]: false }, { headers: NO_STORE })
  }
  // Hide from Feed: a check-in's own column, else a moment post's per-moment
  // choice (R12). Incognito: moment posts only.
  const done = field === 'hiddenFromFeed'
    ? (await setHiddenFromFeed(postId, userId, on)) || (await setMomentChoiceByPost(postId, userId, 'hiddenFromFeed', on))
    : await setMomentChoiceByPost(postId, userId, 'onlyInside', on)
  if (!done) return notFound()
  return NextResponse.json({ [field]: on }, { headers: NO_STORE })
}
