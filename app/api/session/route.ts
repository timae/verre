import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, lifespanTTL, LIFESPAN } from '@/lib/redis'
import { genCode, pgUpsertSession } from '@/lib/session'
import { prisma } from '@/lib/prisma'
import { validateDisplayName } from '@/lib/displayName'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
} from '@/lib/identity'

export async function POST(req: NextRequest) {
  const session = await auth()
  const { hostName: rawHostName, sessionName, blind, lifespan } = await req.json()

  let hostName: string
  try { hostName = validateDisplayName(rawHostName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  // blind tasting requires a pro account
  if (blind && (!session?.user || !(session.user as { pro?: boolean }).pro)) {
    return NextResponse.json({ error: 'blind tastings require a pro account' }, { status: 403 })
  }

  let code: string
  for (let i = 0; i < 10; i++) {
    code = genCode()
    if (!(await redis.exists(k.meta(code!)))) break
  }
  code = code!

  // lifespan beyond 48h requires pro
  const isPro = !!(session?.user as { pro?: boolean } | undefined)?.pro
  const resolvedLifespan = (lifespan && lifespan !== '48h' && !isPro) ? '48h' : (lifespan || '48h')
  const sessionTTL = lifespanTTL(resolvedLifespan)

  const meta = {
    host: hostName,
    name: sessionName ? String(sessionName).trim().slice(0, 80) : '',
    createdAt: Date.now(),
    hostUserId: session?.user?.id ? Number(session.user.id) : null,
    blind: !!blind,
    lifespan: resolvedLifespan,
    coHosts: [] as string[],
  }

  await redis.set(k.meta(code), JSON.stringify(meta), { EX: sessionTTL })
  await redis.set(k.wines(code), '[]', { EX: sessionTTL })
  await redis.sAdd(k.users(code), hostName)
  await redis.expire(k.users(code), sessionTTL)

  // Identity model. Anonymous host gets a per-session identity + token so
  // subsequent requests can prove who they are without putting userName in
  // the body. Logged-in users don't need an entry — the auth cookie is the
  // trust anchor; their displayName comes from session.user.name.
  let anonToken: string | null = null
  if (!session?.user?.id) {
    const anonId = newAnonIdentityId()
    anonToken = newAnonToken()
    await recordIdentity(code, { id: anonId, displayName: hostName, kind: 'anon' })
    await recordAnonToken(code, anonToken, anonId)
    await redis.expire(k.identities(code), sessionTTL)
    await redis.expire(k.tokens(code), sessionTTL)
  }

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
    } catch {}
  }

  return NextResponse.json({
    code,
    name: meta.name,
    host: hostName,
    blind: !!blind,
    lifespan: resolvedLifespan,
    ...(anonToken ? { anonToken } : {}),
  })
}
