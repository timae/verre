import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { redis, k } from '@/lib/redis'
import { normalizeCode } from '@/lib/sessionCode'
import { requireParticipant, authInvalid } from '@/lib/identity'

// Returns ratings for this session, id-keyed. Shape:
//   { "u:42": { displayName: "Sam 🍅", ratings: { "<wineId>": {...} } }, ... }
//
// Caller must be a registered participant of this session (auth cookie or
// valid anon token, plus an entry in the identities map). Non-participants
// who happen to know the session code are rejected.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await auth()

  // Session-existence check before participant check. 404 on a deleted /
  // never-existed session lets the client distinguish "go home" from
  // "your token is bad, retry join" (401 + x-vr-auth: invalid).
  if (!(await redis.exists(k.meta(c)))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const caller = await requireParticipant(c, req, session)
  if (!caller) return authInvalid('not a participant')

  const prefix = `s:${c}:r:`
  const keys = await redis.keys(`${prefix}*`)
  const identities = await redis.hGetAll(k.identities(c))

  // Each rating key is `s:{C}:r:{identityId}:{wineId}` where identityId is
  // either `u:<n>` (one colon) or `a:<uuid>` (one colon). Strip the known
  // prefix, then split off the trailing `:<wineId>` from the right so the
  // identity id retains its embedded colon.
  type Bucket = { displayName: string; ratings: Record<string, unknown> }
  const result: Record<string, Bucket> = {}

  for (const key of keys) {
    const rest = key.slice(prefix.length)               // "<identityId>:<wineId>"
    const lastColon = rest.lastIndexOf(':')
    if (lastColon === -1) continue                      // malformed — skip
    const identityId = rest.slice(0, lastColon)
    const wineId = rest.slice(lastColon + 1)
    const val = await redis.get(key)
    if (!val) continue
    if (!result[identityId]) {
      result[identityId] = {
        displayName: identities[identityId] || identityId,
        ratings: {},
      }
    }
    result[identityId].ratings[wineId] = JSON.parse(val)
  }

  return NextResponse.json(result)
}
