import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, lifespanTTL } from '@/lib/redis'
import { genCode } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { validateDisplayName } from '@/lib/displayName'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
  userIdentityId,
} from '@/lib/identity'

export async function POST(req: NextRequest) {
  const session = await auth()

  // Rate limit session creation: 10 per 10 minutes per user (logged-in)
  // or per IP (anon). Generous enough for legitimate "hosting multiple
  // tastings tonight" use; tight enough to make session-code-space
  // exhaustion expensive.
  const rlKey = session?.user?.id
    ? `rl:create:user:${session.user.id}:10m`
    : `rl:create:ip:${getClientIp(req)}:10m`
  const rl = await checkRate(rlKey, 10, 600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many sessions created. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Public field is `hostDisplayName` — there's no concept of a "username"
  // in this codebase (see CLAUDE.md Auth section), only display names.
  const { hostDisplayName: rawHostName, sessionName, blind, lifespan } = await req.json()

  let hostName: string
  try { hostName = validateDisplayName(rawHostName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  // blind tasting requires a pro account
  const isPro = !!(session?.user as { pro?: boolean } | undefined)?.pro
  if (blind && !isPro) {
    return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
  }

  // lifespan beyond 48h requires pro. Reject loudly rather than silently
  // downgrading — a non-pro caller asking for 72h is making an explicit
  // choice we shouldn't honor and shouldn't quietly substitute.
  if (lifespan && lifespan !== '48h' && !isPro) {
    return NextResponse.json({ error: 'extended lifespan requires a pro account' }, { status: 403 })
  }
  const resolvedLifespan = lifespan || '48h'
  const sessionTTL = lifespanTTL(resolvedLifespan)

  // Collision check on BOTH Redis and Postgres. Anonymous sessions only
  // touch Redis, but a Postgres row can survive a Redis TTL expiry — re-using
  // such a code would clobber the unique constraint at create time. Log the
  // retry count so namespace-exhaustion shows up in logs before it bites.
  let code: string | null = null
  let attempts = 0
  for (let i = 0; i < 10; i++) {
    attempts++
    const candidate = genCode()
    const [redisHit, pgHit] = await Promise.all([
      redis.exists(k.meta(candidate)),
      prisma.session.findUnique({ where: { code: candidate }, select: { id: true } }),
    ])
    if (!redisHit && !pgHit) {
      code = candidate
      break
    }
  }
  if (!code) {
    console.error(`[session] code generation failed after ${attempts} attempts`)
    return NextResponse.json({ error: 'could not allocate session code' }, { status: 500 })
  }
  if (attempts > 1) {
    console.warn(`[session] code allocated after ${attempts} attempts`)
  }

  // Mint the host's identity id up front so it can be stamped into meta —
  // host checks then work purely by id, no display-name fallback needed.
  let anonToken: string | null = null
  let identityId: string
  if (session?.user?.id) {
    identityId = userIdentityId(session.user.id)
  } else {
    identityId = newAnonIdentityId()
    anonToken = newAnonToken()
  }

  const meta = {
    host: hostName,
    name: sessionName ? String(sessionName).trim().slice(0, 80) : '',
    createdAt: Date.now(),
    hostUserId: session?.user?.id ? Number(session.user.id) : null,
    hostIdentityId: identityId,
    blind: !!blind,
    lifespan: resolvedLifespan,
    coHostIds: [] as string[],
  }

  await redis.set(k.meta(code), JSON.stringify(meta), { EX: sessionTTL })
  await redis.set(k.wines(code), '[]', { EX: sessionTTL })

  // Register the host in the identities map so participant-gated reads
  // (wines, ratings, session meta) work right after create.
  await recordIdentity(code, {
    id: identityId,
    displayName: hostName,
    kind: session?.user?.id ? 'user' : 'anon',
  })
  if (anonToken) {
    await recordAnonToken(code, anonToken, identityId)
    await redis.expire(k.tokens(code), sessionTTL)
  }
  await redis.expire(k.identities(code), sessionTTL)

  if (session?.user) {
    try {
      await prisma.session.create({
        data: {
          code,
          hostUserId: Number(session.user.id),
          hostName,
          name: meta.name || null,
          blind: !!blind,
          createdAt: new Date(meta.createdAt),
        },
      })
    } catch (err) {
      // Pre-create collision check ran above, so a P2002 here means a race —
      // log loudly and surface it. Any other failure also surfaces; the
      // Redis state we just wrote is harmless and TTLs out.
      console.error('[session] postgres create failed', err)
      return NextResponse.json({ error: 'could not archive session' }, { status: 500 })
    }
    // Best-effort counter bump. A failure here doesn't undo the session.
    try {
      await prisma.$executeRaw`
        UPDATE users SET lifetime_sessions_hosted = lifetime_sessions_hosted + 1
        WHERE id = ${Number(session.user.id)}`
    } catch (err) {
      console.warn('[session] lifetime counter bump failed', err)
    }
  }

  return NextResponse.json({
    code,
    name: meta.name,
    host: hostName,
    id: identityId,
    displayName: hostName,
    blind: !!blind,
    lifespan: resolvedLifespan,
    ...(anonToken ? { anonToken } : {}),
  })
}
