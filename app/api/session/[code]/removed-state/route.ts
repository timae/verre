import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, hasKey } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { resolveIdentity } from '@/lib/identity'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// GET /api/session/<code>/removed-state
//
// Used by the /join/<code>?removed=1 bounce screen to determine whether
// the caller was kicked, banned, or is just a stranger. Returns one of:
//   { state: 'banned' }   — in bans Set
//   { state: 'kicked' }   — in kicked Set (kicked-keep variant; ratings
//                           may still exist in their history)
//   { state: 'none' }     — not removed; the bounce was incidental, the
//                           caller should see the normal join form
//
// Authorization: caller must resolve to an identity (auth cookie OR a
// known anon token via x-vr-anon-token). No-identity returns 'none' —
// they're just a visitor who landed here without context.
//
// Rate-limited per-identity so a banned attacker holding their token
// can't poll cheaply. Cheap-enough budget for the legitimate bounce
// flow (one fetch on mount).
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ state: 'none' }, { headers: noStore })
  if (!(await redis.exists(k.meta(c)))) {
    return NextResponse.json({ state: 'none' }, { headers: noStore })
  }
  const session = await resolveUser(req)
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ state: 'none' }, { headers: noStore })

  const rl = await checkRate(`rl:removed-state:${identity.id}:1m`, 10, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  if (await redis.sIsMember(k.bans(c), identity.id)) {
    return NextResponse.json({ state: 'banned', identityId: identity.id }, { headers: noStore })
  }
  if (await redis.sIsMember(k.kicked(c), identity.id)) {
    // Did they have any ratings to keep/delete? Surface as a hint so
    // the bounce can skip the prompt when there's nothing actionable.
    // hasKey uses SCAN under the hood — non-blocking, stops on first
    // match.
    const hasRatings = await hasKey(`s:${c}:r:${identity.id}:*`)
    return NextResponse.json(
      { state: 'kicked', identityId: identity.id, hasRatings },
      { headers: noStore },
    )
  }
  return NextResponse.json({ state: 'none' }, { headers: noStore })
}
