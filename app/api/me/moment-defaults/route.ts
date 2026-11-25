import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { readDefaults, writeDefault, parseDefaultPatch, previewDefault, narrowsDefault, type Preview } from '@/lib/momentDefaults'
import { prisma } from '@/lib/prisma'

// Your Moment Defaults (docs/dev/proposals/moment-defaults.md; the app's
// Privacy → Moment Defaults page). Your own row only: the user id comes from
// the cookie, never the body. 🔒 COPIED, never live: saving a default changes
// nothing that exists (lib/momentDefaults.ts); `existing` tells the app how
// many of your moments / check-ins differ, for the "Apply to Existing" alert.

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })

// GET → the seven resolved values (a field never set = the system default).
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return json({ error: 'auth required' }, 401)
  const userId = Number(session.user.id)
  const rl = await checkRate(`rl:moment-defaults-read:u:${userId}:1m`, 60, 60)
  if (!rl.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rl.retryAfter) })
  return json(await readDefaults(prisma, userId))
}

// PATCH { <exactly one field>: value } (the page saves on change) →
// { defaults, existing }. `existing` = the preview for THAT field (counts by
// direction, D2), or null when nothing differs or the count failed (the save
// still stands); a no-op save (the value it already has) counts nothing and
// answers null (review r1 P3: else an uncharged loop of the preview's scan;
// the app never sends one). 60/h/user, charged only on an actual change that
// WIDENS: 🔒 a change that makes a default more private is never charged or
// refused (R10), so the alert's Cancel, undoing a widening, always lands
// (Codex build r9).
export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: 'forbidden' }, 403)
  const session = await resolveUser(req)
  if (!session?.user) return json({ error: 'auth required' }, 401)
  const userId = Number(session.user.id)
  const patch = parseDefaultPatch(await req.json().catch(() => null))
  if (!patch) return json({ error: 'invalid body' }, 400)
  const before = await readDefaults(prisma, userId)
  if (before[patch.field] === patch.value) return json({ defaults: before, existing: null })
  if (!narrowsDefault(patch.field, before[patch.field], patch.value)) {
    const rl = await checkRate(`rl:moment-defaults:u:${userId}:1h`, 60, 3600)
    if (!rl.allowed) {
      return json({ error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter) })
    }
  }
  await writeDefault(userId, patch.field, patch.value)
  const defaults = await readDefaults(prisma, userId)
  let existing: Preview | null = null
  try { existing = await previewDefault(prisma, userId, patch.field, defaults[patch.field]) }
  catch (err) { console.error('[moment-defaults] preview failed (the save stands)', { err }) }
  return json({ defaults, existing })
}
