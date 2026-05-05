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
// if their resolved identity is registered in this session's identities map.
// Returns the resolved identity on success, or null when the caller should
// be rejected (no identity, or an identity not present in this session).
export async function requireParticipant(
  code: string,
  req: NextRequest,
  authSession: Session | null,
): Promise<Identity | null> {
  const identity = await resolveIdentity(code, req, authSession)
  if (!identity) return null
  const registered = await redis.hGet(k.identities(code), identity.id)
  if (registered === null || registered === undefined) return null
  return identity
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
    headers: { 'X-Vr-Auth': 'invalid' },
  })
}
