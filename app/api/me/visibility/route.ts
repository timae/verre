import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, formatWait } from '@/lib/rateLimit'
import {
  loadVisibility,
  setProfileVisibility,
  isProfileVisibility,
} from '@/lib/profileVisibility'

// Logged-in user's own visibility settings — read + write. Authorization
// is implicit: the calling user can only ever modify their own row, the
// userId is taken from the cookie not the request body.

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)
  const rl = await checkRate(`rl:visibility-read:${userId}:1m`, 60, 60)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const settings = await loadVisibility(userId)
  if (!settings) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(settings)
}

export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Route-level cap separate from setProfileVisibility's per-change
  // limiter. setProfileVisibility only counts actual changes (via
  // peek-then-check); this 60/min/user bound covers no-op submits a
  // stolen cookie could spam to thrash DB roundtrips.
  const rl = await checkRate(`rl:visibility-write:${userId}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null) as { visibility?: unknown; fofEnabled?: unknown } | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  if (!isProfileVisibility(body.visibility)) {
    return NextResponse.json({ error: 'invalid visibility' }, { status: 400 })
  }
  const fofEnabled = body.fofEnabled === true

  const result = await setProfileVisibility(userId, body.visibility, fofEnabled)
  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      return NextResponse.json(
        { error: `Too many changes. Try again in ${formatWait(result.retryAfter)}.` },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      )
    }
    if (result.reason === 'not-found') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ error: 'invalid visibility' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
