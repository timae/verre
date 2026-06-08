import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { validateDisplayName } from '@verre/core'
import { disambiguateDisplayName } from '@/lib/displayName.server'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// PATCH /api/session/<code>/me/name
//
// Rename yourself within a session. Anonymous participants only —
// logged-in users carry their account name from `users.name` and change
// it via profile settings (which propagates to every session they're in
// at next read). In-session anons have no account, so per-session
// rename is the only knob they have.
//
// Body: { name: string }
// Returns: { name: <possibly-suffixed-with-emoji> }
//
// Disambiguation reuses `disambiguateDisplayName` — if the typed name
// collides with another participant's current display name, append a
// random food emoji. Renaming away from a previously-suffixed name to
// something unique drops the suffix naturally (it was stored as part
// of the name string; renaming overwrites it).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await auth()

  // Participant gate first — must be in the identities map. Banned /
  // kicked / unknown identity all reject before we touch the name.
  const pp = await participantOrBanned(c, req, session)
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  // Anon-only: identity.id is `u:<userId>` for logged-in, `a:<uuid>` for anon.
  if (identity.id.startsWith('u:')) {
    return NextResponse.json(
      { error: 'logged-in users rename via profile settings' },
      { status: 403, headers: noStore },
    )
  }
  // Belt-and-braces: auth() should be null for anons.
  if (session?.user) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }

  // Rate limit per anon identity-id. Each rename runs hGetAll on the
  // identities map (twice — once here, once inside disambiguate) plus
  // an hSet, AND pollutes the participants list visible to every
  // tasting participant via 5s polling. 10/min/identity is generous
  // for legitimate renames while bounding the abuse.
  const rl = await checkRate(`name:${c}:${identity.id}:1m`, 10, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many rename attempts. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  }

  let name: string
  try {
    name = validateDisplayName((body as { name?: unknown }).name)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400, headers: noStore })
  }

  // Disambiguate against current participants. The caller's own
  // identity entry holds their PREVIOUS name (we haven't written the
  // new name yet), so the typed name won't match their own row unless
  // they're "renaming" to their current name — in which case the
  // disambig adds an emoji to break the (self-)collision. That's a
  // no-op edit anyway; if you want to suppress it, early-return when
  // the typed name equals the current name.
  const identities = await redis.hGetAll(k.identities(c))
  const currentName = identities[identity.id]
  if (currentName === name) {
    return NextResponse.json({ name }, { headers: noStore })
  }
  const resolvedName = await disambiguateDisplayName(c, name)

  // hSet on an existing hash preserves the key's TTL (TTL is per-key,
  // not per-field). No KEEPTTL needed because we're not running SET.
  await redis.hSet(k.identities(c), identity.id, resolvedName)

  return NextResponse.json({ name: resolvedName }, { headers: noStore })
}
