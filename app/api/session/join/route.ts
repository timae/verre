import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@/lib/sessionCode'
import { validateDisplayName, disambiguateDisplayName } from '@/lib/displayName'
import { checkRate, resetRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
  userIdentityId,
} from '@/lib/identity'

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()

  // Rate limit invalid session-code attempts: 30 per minute per IP.
  // Counter is cleared on a successful join (real users with a typo
  // streak shouldn't slowly accumulate toward a block once they get
  // the right code). Counts everything until a successful match — so
  // both "session not found" and a malformed/empty code count.
  const ip = getClientIp(req)
  const rlKey = `rl:join:ip:${ip}:1m`
  const rl = await checkRate(rlKey, 30, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many join attempts. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Public field is `displayName` — see CLAUDE.md Auth section, names
  // are presentation-only and there is no concept of a username.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { code, displayName: rawDisplayName } = body as Record<string, unknown>
  if (!code || typeof code !== 'string') return NextResponse.json({ error: 'code required' }, { status: 400 })

  let displayName: string
  try { displayName = validateDisplayName(rawDisplayName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // Logged-in users have a stable identity-id (`u:<userId>`). If they're
  // already registered for this session, reuse their stored displayName so
  // repeated join calls (back/forward, refresh, etc.) don't accumulate
  // emoji suffixes. Anonymous joiners always get a fresh identity — each
  // browser session is a new participant from the server's point of view.
  //
  // Banned check: logged-in user's stable identity gets blocked here.
  // Anon users always mint a fresh id on join, so the bans Set can't
  // catch a determined re-joiner who cleared localStorage — documented
  // weakness, not a defect.
  //
  // resetRate happens AFTER the ban check and only on success — the ban
  // path keeps consuming the rate-limit budget so an attacker can't
  // fast-probe `u:<n>` ids for banned-status via response timing.
  let anonToken: string | null = null
  let identityId: string
  if (session?.user?.id) {
    identityId = userIdentityId(session.user.id)
    if (await redis.sIsMember(k.bans(c), identityId)) {
      // The literal error string 'banned' is part of the client contract:
      // components/session/JoinClient.tsx matches on `data.error ===
      // 'banned'` to redirect manual-rejoin attempts to the full
      // RemovedView (?removed=1) instead of showing a small inline error.
      // If you change this string, update JoinClient too.
      return NextResponse.json({ error: 'banned' }, { status: 403 })
    }
    const registered = await redis.hGet(k.identities(c), identityId)
    if (registered) {
      displayName = registered
    } else {
      displayName = await disambiguateDisplayName(c, displayName)
      await recordIdentity(c, { id: identityId, displayName, kind: 'user' })
    }
    // Clear any prior kicked-marker so this rejoin starts clean.
    await redis.sRem(k.kicked(c), identityId)
  } else {
    displayName = await disambiguateDisplayName(c, displayName)
    identityId = newAnonIdentityId()
    anonToken = newAnonToken()
    await recordIdentity(c, { id: identityId, displayName, kind: 'anon' })
    await recordAnonToken(c, anonToken, identityId)
  }

  await touchWithMeta(c)
  // Reset the join rate-limit only on a successful join — a typo streak
  // doesn't accumulate against legitimate users, but ban-rejections
  // continue to count so banned-id probing is rate-limited.
  await resetRate(rlKey)

  return NextResponse.json({
    ...JSON.parse(raw),
    code: c,
    id: identityId,
    displayName,
    ...(anonToken ? { anonToken } : {}),
  })
}
