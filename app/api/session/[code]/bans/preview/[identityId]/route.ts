import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, scanKeys } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { resolveIdentity, isValidIdentityId } from '@/lib/identity'
import { getSessionMeta, getWines, isHostByIdentity } from '@/lib/session'
import { prisma } from '@/lib/prisma'

type Ctx = { params: Promise<{ code: string; identityId: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// GET /api/session/<code>/bans/preview/<identityId> — preview the
// effects of kicking or banning a participant before the host commits.
// Used by the host-side modal to show "they added these wines" and
// "they wrote N ratings" so the host can make an informed decision.
//
// Authorization: host or cohost. Cohosts get the same preview — they
// can ban regular participants, so they need the same context.
//
// 404 when the target isn't actually part of this session (identities,
// bans, or kicked Sets) so a cohost can't probe arbitrary `u:<n>` ids
// for existence via the displayName lookup.
//
// Payload deliberately omits per-target bookmarks (hosts shouldn't see
// per-user bookmark state outside of moderation). Returns:
//   - ratingCount: number of rating rows the target has in this session
//     (informational on kick — the user gets to choose later — and
//     actionable on ban where they get wiped).
//   - addedWines: [{id, name, vintage, producer}] of wines the target
//     added, used by the modal toggle "delete their wines?".
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code, identityId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)
  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  }
  const targetId = decodeURIComponent(identityId)
  if (!isValidIdentityId(targetId)) {
    return NextResponse.json({ error: 'invalid identityId' }, { status: 400, headers: noStore })
  }
  // Scope the lookup to session-scoped state. A target who isn't in any
  // session Set (identities / bans / kicked) is treated as "not part of
  // this session" — 404. Otherwise a cohost could probe `u:<n>` ids and
  // get back the live Postgres `name` for an arbitrary user.
  const [inIdentities, inBans, inKicked] = await Promise.all([
    redis.hExists(k.identities(c), targetId),
    redis.sIsMember(k.bans(c), targetId),
    redis.sIsMember(k.kicked(c), targetId),
  ])
  if (!inIdentities && !inBans && !inKicked) {
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  }

  // Rating count, wines, and displayName all fire in parallel — none of
  // them depend on each other.
  //
  // Rating count via SCAN over `s:<C>:r:<identityId>:*` — Redis is
  // authoritative for live-session rating state (Postgres rows exist
  // only for logged-in users and only after the rate POST, so it's not
  // a complete source). On a quiet Redis the SCAN is sub-10ms; on a
  // very busy instance the iteration cost grows with total keyspace,
  // but the cost is mitigated here by issuing it in parallel with the
  // other reads.
  const ratingCountP = scanKeys(`s:${c}:r:${targetId}:*`).then(keys => keys.length)

  // Wines the target added — read from Redis (live state); the Postgres
  // row may not exist yet for sessions still in their first 48h.
  const winesP = getWines(c)

  // Display name for the modal header. Pull from identities hash if
  // still present; fall back to the Postgres users row for logged-in
  // identities (post-ban kick-keep already cleared the hash entry).
  const displayNameP: Promise<string | null> = (async () => {
    const fromHash = await redis.hGet(k.identities(c), targetId)
    if (fromHash) return fromHash
    if (targetId.startsWith('u:')) {
      const u = await prisma.user.findUnique({
        where: { id: Number(targetId.slice(2)) },
        select: { name: true },
      })
      return u?.name ?? null
    }
    return null
  })()

  const [ratingCount, wines, displayName] = await Promise.all([
    ratingCountP, winesP, displayNameP,
  ])
  const addedWines = wines
    .filter(w => w.addedByIdentityId === targetId)
    .map(w => ({ id: w.id, name: w.name, vintage: w.vintage, producer: w.producer }))

  return NextResponse.json(
    { identityId: targetId, displayName, ratingCount, addedWines },
    { headers: noStore },
  )
}
