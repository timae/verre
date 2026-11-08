import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { validateDisplayName } from '@verre/core'
import { disambiguateAgainst } from '@/lib/displayName.server'
import { withSessionMutation, admitted } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
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
  const session = await resolveUser(req)

  // Participant gate first — must be in the identities map. Banned /
  // kicked / unknown identity all reject before we touch the name.
  const op = await openAsParticipant(c, req, session)
  if (op instanceof NextResponse) return op
  const { identity } = op

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
  // A full contract (G1, r1-10): the identities hash is shared state, and a
  // rename that waited behind a kick must not restore the removed identity —
  // under the locks the caller must still be registered, not banned, not
  // kicked, and the incarnation must be the one it opened; then the fenced HSET.
  let resolvedName: string
  try {
    resolvedName = await withSessionMutation(c, { label: 'anon-rename', redisLock: { waitMs: 1000 }, caller: identity, expectedCreatedAt: op.meta.createdAt },
      async (_tx, ctx) => {
        admitted(ctx)
        const identities = await redis.hGetAll(k.identities(c))
        if (identities[identity.id] === name) return name
        // Collision check against the OTHER participants only.
        const resolved = disambiguateAgainst(name, Object.entries(identities).filter(([id]) => id !== identity.id).map(([, n]) => n))
        await ctx.fence!.exec(m => { m.hSet(k.identities(c), identity.id, resolved) })
        return resolved
      })
  } catch (err) {
    return contractFailure(err, c, { label: 'anon-rename' })
  }

  return NextResponse.json({ name: resolvedName }, { headers: noStore })
}
