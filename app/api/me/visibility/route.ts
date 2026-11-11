import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, formatWait } from '@/lib/rateLimit'
import {
  loadVisibility,
  setProfileVisibility,
  isProfileVisibility,
  isCheckinVisibility,
  VISIBILITY_FIELDS,
  type VisibilitySettings,
  type VisibilityChanges,
} from '@/lib/profileVisibility'

// Logged-in user's own visibility settings — read + write. Authorization
// is implicit: the calling user can only ever modify their own row, the
// userId is taken from the cookie not the request body.
//
// PATCH is a compare-and-set (lib/profileVisibility.ts setProfileVisibility):
//   { expected: { …the six as last read }, …changes }
// 200 { ok: true, current } (also a no-op / an already-committed retry),
// 409 { error, current } when the stored settings differ from `expected`.
// There is no legacy shape: a body without `expected` is a 400.

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return json({ error: 'auth required' }, 401)
  const userId = Number(session.user.id)
  const rl = await checkRate(`rl:visibility-read:${userId}:1m`, 60, 60)
  if (!rl.allowed) return json({ error: 'Too many requests' }, 429)
  const settings = await loadVisibility(userId)
  if (!settings) return json({ error: 'not found' }, 404)
  return json(settings)
}

type Field = (typeof VISIBILITY_FIELDS)[number]
const FIELD_SET = new Set<string>(VISIBILITY_FIELDS)
const validValue: Record<Field, (v: unknown) => boolean> = {
  visibility: isProfileVisibility,
  fofEnabled: v => typeof v === 'boolean',
  checkinVisibility: v => v === null || isCheckinVisibility(v),
  showCravings: v => typeof v === 'boolean',
  showMoments: v => typeof v === 'boolean',
  showLocations: v => typeof v === 'boolean',
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// Pure body parse: `expected` must carry all six; `changes` = the other
// top-level keys, a non-empty subset of the six. Unknown keys and ill-typed
// values are refused. ⚠️ A seventh setting must be OPTIONAL in `expected`
// (compared only when sent), else every older client 400s on every save.
function parsePatch(body: unknown):
  | { ok: true; expected: VisibilitySettings; changes: VisibilityChanges }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'invalid body' }
  // Readable copy for every `expected` problem: the web form shows `error`
  // raw, and a body without a valid `expected` is a page (or app build) from
  // before this shape, or a snapshot read from the previous release mid-deploy.
  const STALE = 'Reload the page and try again.'
  if (!isRecord(body.expected)) return { ok: false, error: STALE }
  const expected = body.expected
  if (Object.keys(expected).some(k => !FIELD_SET.has(k))) return { ok: false, error: STALE }
  if (VISIBILITY_FIELDS.some(f => !(f in expected) || !validValue[f](expected[f]))) return { ok: false, error: STALE }
  const changes: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'expected') continue
    if (!FIELD_SET.has(k)) return { ok: false, error: `unknown field ${k}` }
    if (!validValue[k as Field](v)) return { ok: false, error: `invalid ${k}` }
    changes[k] = v
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: 'nothing to change' }
  return { ok: true, expected: expected as unknown as VisibilitySettings, changes: changes as VisibilityChanges }
}

export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: 'forbidden' }, 403)
  const session = await resolveUser(req)
  if (!session?.user) return json({ error: 'auth required' }, 401)
  const userId = Number(session.user.id)

  // Route-level cap separate from setProfileVisibility's per-change
  // limiter. setProfileVisibility only counts actual changes (via
  // peek-then-check); this 60/min/user bound covers no-op submits a
  // stolen cookie could spam to thrash DB roundtrips.
  const rl = await checkRate(`rl:visibility-write:${userId}:1m`, 60, 60)
  if (!rl.allowed) {
    return json({ error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.` }, 429, { 'Retry-After': String(rl.retryAfter) })
  }

  const parsed = parsePatch(await req.json().catch(() => null))
  if (!parsed.ok) return json({ error: parsed.error }, 400)

  const result = await setProfileVisibility(userId, { expected: parsed.expected, changes: parsed.changes })
  if (result.ok) return json({ ok: true, current: result.current })
  if (result.reason === 'conflict') {
    return json({ error: 'Your privacy settings changed while saving.', current: result.current }, 409)
  }
  if (result.reason === 'rate-limited') {
    return json({ error: `Too many changes. Try again in ${formatWait(result.retryAfter)}.` }, 429, { 'Retry-After': String(result.retryAfter) })
  }
  return json({ error: 'not found' }, 404)
}
