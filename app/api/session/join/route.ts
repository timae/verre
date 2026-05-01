import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k, TTL, touchWithMeta } from '@/lib/redis'
import { touch } from '@/lib/session'
import { validateDisplayName } from '@/lib/displayName'
import {
  newAnonIdentityId,
  newAnonToken,
  recordAnonToken,
  recordIdentity,
} from '@/lib/identity'

export async function POST(req: NextRequest) {
  const session = await auth()
  const { code, userName: rawUserName } = await req.json()
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  let userName: string
  try { userName = validateDisplayName(rawUserName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const c = code.toUpperCase()
  const raw = await redis.get(k.meta(c))
  if (!raw) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  await redis.sAdd(k.users(c), userName)

  // Identity model. Anonymous joiner: mint a per-session token tied to a
  // fresh anon identity. The client persists the token in sessionStorage and
  // replays it on every subsequent request via the x-vr-anon-token header
  // (Packet 5 wires the persistence). Logged-in joiners don't need a token
  // or an identities entry — auth() is the trust anchor.
  let anonToken: string | null = null
  if (!session?.user?.id) {
    const anonId = newAnonIdentityId()
    anonToken = newAnonToken()
    await recordIdentity(c, { id: anonId, displayName: userName, kind: 'anon' })
    await recordAnonToken(c, anonToken, anonId)
  }

  await touchWithMeta(c)

  return NextResponse.json({
    ...JSON.parse(raw),
    code: c,
    ...(anonToken ? { anonToken } : {}),
  })
}
