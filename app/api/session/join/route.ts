import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { validateDisplayName, disambiguateDisplayName } from '@/lib/displayName'
import { checkRate, resetRate, getClientIp, formatWait } from '@/lib/rateLimit'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
  userIdentityId,
} from '@/lib/identity'

export async function POST(req: NextRequest) {
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

  const { code, userName: rawUserName } = await req.json()
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  let userName: string
  try { userName = validateDisplayName(rawUserName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // Valid code — reset the limiter so legitimate users with a typo streak
  // don't carry the count forward.
  await resetRate(rlKey)

  // Logged-in users have a stable identity-id (`u:<userId>`). If they're
  // already registered for this session, reuse their stored displayName so
  // repeated join calls (back/forward, refresh, etc.) don't accumulate
  // emoji suffixes. Anonymous joiners always get a fresh identity — each
  // browser session is a new participant from the server's point of view.
  let anonToken: string | null = null
  let identityId: string
  if (session?.user?.id) {
    identityId = userIdentityId(session.user.id)
    const registered = await redis.hGet(k.identities(c), identityId)
    if (registered) {
      userName = registered
    } else {
      userName = await disambiguateDisplayName(c, userName)
      await recordIdentity(c, { id: identityId, displayName: userName, kind: 'user' })
    }
  } else {
    userName = await disambiguateDisplayName(c, userName)
    identityId = newAnonIdentityId()
    anonToken = newAnonToken()
    await recordIdentity(c, { id: identityId, displayName: userName, kind: 'anon' })
    await recordAnonToken(c, anonToken, identityId)
  }

  await touchWithMeta(c)

  return NextResponse.json({
    ...JSON.parse(raw),
    code: c,
    id: identityId,
    userName,
    ...(anonToken ? { anonToken } : {}),
  })
}
