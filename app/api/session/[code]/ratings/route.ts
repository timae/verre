import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { buildRatingsView } from '@/lib/sessionState'

// Returns ratings for this session, id-keyed. Shape (and the cosmetic-block
// design note): see lib/sessionState.ts buildRatingsView — shared with
// /api/session/:code/state.
//
// Caller must be a registered participant of this session (auth cookie or
// valid anon token, plus an entry in the identities map). Non-participants
// who happen to know the session code are rejected.
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

  const identities = await redis.hGetAll(k.identities(c))
  const result = await buildRatingsView(c, identities)
  return NextResponse.json(result, { headers: noStore })
}
