import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { formatWait } from '@/lib/rateLimit'
import { applyDefault, SECTION, type DefaultField } from '@/lib/momentDefaults'

// POST /api/me/moment-defaults/apply { field } (the alert's "All N …"): your
// STORED default for that one field, applied to every one of your moments /
// check-ins that differs NOW (K7: not bound to the preview; ruled). → 200
// { changed }, or 429 (the limiter's message) when a widening part was
// refused, AFTER the narrowing part was applied; 404 when the field's flag is
// off and the apply could only widen (§ 2.5). Hiding is never charged or
// refused (R10). Budgets, the two passes, the Redis deadlines:
// lib/momentDefaults.ts applyDefault.

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: 'forbidden' }, 403)
  const session = await resolveUser(req)
  if (!session?.user) return json({ error: 'auth required' }, 401)
  const userId = Number(session.user.id)
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const field = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 ? body.field : undefined
  if (typeof field !== 'string' || !Object.hasOwn(SECTION, field)) return json({ error: 'invalid body' }, 400)
  try {
    const out = await applyDefault(userId, field as DefaultField)
    if (out.status === 'not-found') return json({ error: 'not found' }, 404)
    if (out.status === 'limited') {
      return json({ error: `Too many changes. Try again in ${formatWait(out.retryAfter)}.`, retryAfter: out.retryAfter, changed: out.changed }, 429, { 'Retry-After': String(out.retryAfter) })
    }
    return json({ changed: out.changed })
  } catch (err) {
    console.error('[moment-defaults] apply failed', { err })
    return json({ error: 'Could not apply the setting. Try again.' }, 500)
  }
}
