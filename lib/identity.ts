import crypto from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { redis, k } from '@/lib/redis'

// Stable identity for a session participant. id is the trust anchor — never
// derived from a request body. displayName is cosmetic, can change, can collide.
export type Identity = {
  id: string          // "u:<userId>" for logged-in, "a:<uuid>" for anonymous
  displayName: string
  kind: 'user' | 'anon'
}

const ANON_TOKEN_HEADER = 'x-vr-anon-token'

export function userIdentityId(userId: string | number): string {
  return `u:${userId}`
}

// Identity-ids are `u:<integer>` for logged-in or `a:<uuid>` for anon.
// Used at request boundaries to reject malformed input before it hits
// Redis SADD / Postgres queries — without this check a bad client could
// bloat the bans Set with junk or burn a wipe txn on a no-op.
const USER_ID_PATTERN = /^u:\d+$/
const ANON_ID_PATTERN = /^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isValidIdentityId(id: unknown): id is string {
  return typeof id === 'string' && (USER_ID_PATTERN.test(id) || ANON_ID_PATTERN.test(id))
}

export function newAnonIdentityId(): string {
  return `a:${crypto.randomUUID()}`
}

export function newAnonToken(): string {
  return crypto.randomUUID()
}

// Resolve the caller's identity for a session.
//
// Priority:
//   1. NextAuth session (logged-in users)
//   2. x-vr-anon-token header → Redis lookup in s:{CODE}:tokens
//
// Returns null when nothing identifies the caller. There is no body-name
// fallback — that would let any caller claim any name and have the server
// treat them as that participant for the duration of a request.
export async function resolveIdentity(
  code: string,
  req: NextRequest,
  authSession: Session | null,
): Promise<Identity | null> {
  if (authSession?.user?.id) {
    // Prefer the per-session displayName from the identities map (set by the
    // visit/join endpoints, possibly with a disambiguation suffix). Falls back
    // to the bare account name for users who have a session cookie but no
    // identities entry yet (sessions created before the visit endpoint started
    // writing identity records, or a tight race between visit and the first
    // state-changing call).
    const id = userIdentityId(authSession.user.id)
    const registered = await redis.hGet(k.identities(code), id)
    return {
      id,
      displayName: registered || authSession.user.name || '',
      kind: 'user',
    }
  }

  const headerToken = req.headers.get(ANON_TOKEN_HEADER)
  if (headerToken) {
    const id = await redis.hGet(k.tokens(code), headerToken)
    if (id) {
      const displayName = (await redis.hGet(k.identities(code), id)) || ''
      return { id, displayName, kind: 'anon' }
    }
    // Token presented but unknown for this session — refuse silently with null.
    // Endpoints translate this to a generic 403 so attackers can't probe which
    // tokens exist.
    return null
  }

  // No auth, no token → no identity. The legacy body-name fallback was
  // removed: it allowed unauthenticated callers to claim any name and have
  // the server treat them as that participant for the duration of a request.
  // After Packet 5 every real client carries either an auth cookie or an
  // anon token; anything without either is an unauthenticated probe.
  return null
}

// Authorization check for session-scoped reads. A caller is a "participant"
// if their resolved identity is registered in this session's identities map
// AND not in the session's bans Set. Returns the identity on success.
// Returns null when the caller should be rejected. Callers that need to
// distinguish "banned" from "invalid identity" (to render a different
// bounce) should use `participantOrBanned` below — it returns the tri-state.
//
// Most existing callers use this thin shape and emit `authInvalid()`,
// which clears the client's local state on bounce. For banned callers
// that's wrong — we want to PRESERVE local state so the /join page can
// identify them and show "You were removed." Use `participantOrBanned`
// in any endpoint that polls (the session GET, ratings, wines) so the
// banned user gets the right bounce header.
export async function requireParticipant(
  code: string,
  req: NextRequest,
  authSession: Session | null,
): Promise<Identity | null> {
  const result = await participantOrBanned(code, req, authSession)
  return result.status === 'ok' ? result.identity : null
}

// Quad-state variant. Endpoints that poll the session use this to
// distinguish:
//   - 'ok'      — active participant, proceed.
//   - 'banned'  — in bans Set; emit authRemoved (preserves token).
//   - 'kicked'  — removed from identities but not banned; also emit
//                 authRemoved so the bounce-screen can offer Keep/Delete.
//   - 'invalid' — no identity / never joined; emit authInvalid.
export type ParticipantResult =
  | { status: 'ok'; identity: Identity }
  | { status: 'banned'; identity: Identity }
  | { status: 'kicked'; identity: Identity }
  | { status: 'invalid' }

export async function participantOrBanned(
  code: string,
  req: NextRequest,
  authSession: Session | null,
): Promise<ParticipantResult> {
  const identity = await resolveIdentity(code, req, authSession)
  if (!identity) return { status: 'invalid' }
  // Banned check first — ban is the hard gate.
  if (await redis.sIsMember(k.bans(code), identity.id)) {
    return { status: 'banned', identity }
  }
  const registered = await redis.hGet(k.identities(code), identity.id)
  if (registered === null || registered === undefined) {
    // Identity isn't in the participants list. Check kicked Set so the
    // recently-kicked user gets a "removed" bounce instead of a stale-
    // token "invalid" bounce.
    if (await redis.sIsMember(k.kicked(code), identity.id)) {
      return { status: 'kicked', identity }
    }
    return { status: 'invalid' }
  }
  return { status: 'ok', identity }
}

export async function recordIdentity(code: string, identity: Identity): Promise<void> {
  await redis.hSet(k.identities(code), identity.id, identity.displayName)
}

export async function recordAnonToken(code: string, token: string, id: string): Promise<void> {
  await redis.hSet(k.tokens(code), token, id)
}

// Standardized rejection for "you have no valid identity for this session"
// (resolver returned null, or you're not a participant). The X-Vr-Auth header
// signals the client to drop its stored token and bounce to /join, which is
// distinct from a permission-denied 403 (e.g. "only the host can do this") —
// those should NOT clear the token.
export function authInvalid(error = 'identity required', status = 401): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { 'X-Vr-Auth': 'invalid', 'Cache-Control': 'private, no-store' },
  })
}

// Variant for callers who were a participant but got removed (kicked or
// banned). The 'removed' sentinel tells the client to PRESERVE the local
// token + name + id keys (vs 'invalid' which wipes them), bounce to
// /join/<code>, and let that page identify them via the preserved token
// and render the right "You were removed" copy.
export function authRemoved(error = 'removed from session', status = 401): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { 'X-Vr-Auth': 'removed', 'Cache-Control': 'private, no-store' },
  })
}
