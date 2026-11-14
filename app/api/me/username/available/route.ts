import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkUsername } from '@verre/core'
import { checkRates, formatWait, getClientIp } from '@/lib/rateLimit'
import { usernameTaken } from '@/lib/username'

// GET /api/me/username/available?username= → { available, reason?: 'invalid' |
// 'reserved' | 'taken' }. ADVISORY: the PUT's answer from the database is the
// authority. One answer for a taken and a held name; your own name and your
// own held name are available. Per user, plus a per-address backstop (free
// accounts multiply a per-user budget), both charged after the 401.
const noStore = { 'Cache-Control': 'private, no-store' }

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)
  const rl = await checkRates([
    { key: `rl:username-check:user:${userId}:1m`, max: 60, windowSeconds: 60 },
    { key: `rl:username-check:ip:${getClientIp(req)}:1m`, max: 300, windowSeconds: 60 },
  ])
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }
  const checked = checkUsername(req.nextUrl.searchParams.get('username') ?? '')
  if (!checked.ok) return NextResponse.json({ available: false, reason: checked.reason }, { headers: noStore })
  if (await usernameTaken(checked.username, userId)) return NextResponse.json({ available: false, reason: 'taken' }, { headers: noStore })
  return NextResponse.json({ available: true }, { headers: noStore })
}
