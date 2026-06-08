import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, scanKeys } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'

// Returns ratings for this session, id-keyed. Shape:
//   { "u:42": { displayName: "Sam 🍅", ratings: { "<wineId>": {...} } }, ... }
//
// Caller must be a registered participant of this session (auth cookie or
// valid anon token, plus an entry in the identities map). Non-participants
// who happen to know the session code are rejected.
//
// Block filter is COSMETIC (client-side only) for ratings. The locked
// design treats in-session participation like participant-list rendering:
// the data is shared session-context, the block filter is render-style.
// Compare client-side hides block-pair rater chips from the UI; the raw
// wire payload still contains them (visible in DevTools). This is the
// accepted asymmetry — Verre's block primitive is a UI filter, not a
// secrecy mechanism inside a shared tasting.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  // Every return path carries `private, no-store` — the payload contains
  // session-scoped display names and the participant gate varies by viewer.
  const noStore = { 'Cache-Control': 'private, no-store' }
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  const session = await resolveUser(req)

  // Session-existence check before participant check. 404 on a deleted /
  // never-existed session lets the client distinguish "go home" from
  // "your token is bad, retry join" (401 + x-vr-auth: invalid).
  if (!(await redis.exists(k.meta(c)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })
  }

  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const caller = p.identity

  const prefix = `s:${c}:r:`
  const keys = await scanKeys(`${prefix}*`)
  const identities = await redis.hGetAll(k.identities(c))

  // Each rating key is `s:{C}:r:{identityId}:{wineId}` where identityId is
  // either `u:<n>` (one colon) or `a:<uuid>` (one colon). Strip the known
  // prefix, then split off the trailing `:<wineId>` from the right so the
  // identity id retains its embedded colon.
  type Bucket = { displayName: string; ratings: Record<string, unknown> }
  const result: Record<string, Bucket> = {}

  if (keys.length === 0) return NextResponse.json(result, { headers: noStore })
  const values = await redis.mGet(keys)

  keys.forEach((key, i) => {
    const val = values[i]
    if (!val) return
    const rest = key.slice(prefix.length)               // "<identityId>:<wineId>"
    const lastColon = rest.lastIndexOf(':')
    if (lastColon === -1) return                         // malformed — skip
    const identityId = rest.slice(0, lastColon)
    const wineId = rest.slice(lastColon + 1)
    if (!result[identityId]) {
      result[identityId] = {
        displayName: identities[identityId] || identityId,
        ratings: {},
      }
    }
    result[identityId].ratings[wineId] = JSON.parse(val)
  })

  return NextResponse.json(result, { headers: noStore })
}
