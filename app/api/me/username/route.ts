import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkUsername } from '@verre/core'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { changeUsername, usernameState } from '@/lib/username'

// Your own username (docs/dev/proposals/usernames.md § 8). Its own route, not
// the profile PATCH: it has a quota, its own conflict answers and its own
// limiter. Viewer-dependent: private, no-store on every path.
const noStore = { 'Cache-Control': 'private, no-store' }
const limited = (what: string, retryAfter: number) => NextResponse.json(
  { error: `Too many ${what}. Try again in ${formatWait(retryAfter)}.`, retryAfter },
  { status: 429, headers: { ...noStore, 'Retry-After': String(retryAfter) } },
)

// GET → { username, changesLeft, nextChangeAt, previous: { username, heldUntil } | null }
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)
  const rl = await checkRate(`rl:username-read:user:${userId}:1m`, 60, 60)
  if (!rl.allowed) return limited('requests', rl.retryAfter)
  const state = await usernameState(userId)
  if (!state) return NextResponse.json({ error: 'user not found' }, { status: 404, headers: noStore })
  return NextResponse.json(state, { headers: noStore })
}

// PUT { username } → the GET's shape. 409 { code: 'taken' } for a taken AND a
// held name (one answer); 409 { code: 'quota', nextChangeAt }. A first choice
// is free, every later change counts toward 5 per rolling 90 days.
export async function PUT(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)

  const body = await req.json().catch(() => null)
  const checked = checkUsername(body && typeof body === 'object' ? (body as { username?: unknown }).username : undefined)
  if (!checked.ok) return NextResponse.json({ error: checked.message, code: checked.reason }, { status: 400, headers: noStore })

  // The same name again answers before the charge.
  const before = await usernameState(userId)
  if (!before) return NextResponse.json({ error: 'user not found' }, { status: 404, headers: noStore })
  if (before.username === checked.username) return NextResponse.json(before, { headers: noStore })

  const rl = await checkRate(`rl:username-set:user:${userId}:1h`, 20, 3600)
  if (!rl.allowed) return limited('username changes', rl.retryAfter)

  const result = await changeUsername(userId, checked.username)
  if (result.status === 'not-found') return NextResponse.json({ error: 'user not found' }, { status: 404, headers: noStore })
  if (result.status === 'taken') return NextResponse.json({ error: 'That username is taken.', code: 'taken' }, { status: 409, headers: noStore })
  if (result.status === 'quota') {
    return NextResponse.json(
      { error: 'You changed your username too often. Try again later.', code: 'quota', nextChangeAt: result.nextChangeAt },
      { status: 409, headers: noStore },
    )
  }
  return NextResponse.json(await usernameState(userId), { headers: noStore })
}
