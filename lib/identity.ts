import crypto from 'crypto'
import type { NextRequest } from 'next/server'
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
//   3. Legacy fallback: body.userName matched against the session's identities
//      map or, if the session predates Phase 2, just trusted as the displayName
//      (closes Packet 5 once the frontend wires the token everywhere).
//
// Returns null when nothing identifies the caller (anonymous request to an
// endpoint that requires identity).
export async function resolveIdentity(
  code: string,
  req: NextRequest,
  authSession: Session | null,
  bodyUserName: string | null,
): Promise<Identity | null> {
  if (authSession?.user?.id) {
    return {
      id: userIdentityId(authSession.user.id),
      displayName: authSession.user.name || '',
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

  // Legacy path: anonymous client without a token, identifying via body name.
  // Used during the Packet 4 → Packet 5 transition window. Anchored to the
  // identities map when the name is known there; otherwise a synthetic anon
  // identity (id = a:legacy:<name>) so isHost name-paths keep working.
  if (bodyUserName) {
    const idsByName = await redis.hGetAll(k.identities(code))
    for (const [id, name] of Object.entries(idsByName)) {
      if (name === bodyUserName) return { id, displayName: name, kind: id.startsWith('u:') ? 'user' : 'anon' }
    }
    return { id: `a:legacy:${bodyUserName}`, displayName: bodyUserName, kind: 'anon' }
  }

  return null
}

export async function recordIdentity(code: string, identity: Identity): Promise<void> {
  await redis.hSet(k.identities(code), identity.id, identity.displayName)
}

export async function recordAnonToken(code: string, token: string, id: string): Promise<void> {
  await redis.hSet(k.tokens(code), token, id)
}
