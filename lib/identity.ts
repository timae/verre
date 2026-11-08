import crypto from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { readGrant, grantStatus, authorized, type AuthorizedIdentity, type Grant, cacheAdmission } from '@/lib/sessionGrant'
import { healRegistration, reseedRemoval } from '@/lib/sessionRehydrate'

export type { AuthorizedIdentity } from '@/lib/sessionGrant'

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
//
// `d:<uuid>` is the TOMBSTONE identity of a deleted account's ratings in one
// session (ratings.tombstone_key, redis-rehydration § 4.3). It is valid for
// TARGETING (a host may kick-delete it) and never for authenticating — no
// cookie or token resolves to one. Sites that must not accept it as a target
// (ban, kick-keep, brought-by reassignment) reject it with isTombstoneIdentityId.
const USER_ID_PATTERN = /^u:\d+$/
const ANON_ID_PATTERN = /^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOMBSTONE_ID_PATTERN = /^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isValidIdentityId(id: unknown): id is string {
  return typeof id === 'string' && (USER_ID_PATTERN.test(id) || ANON_ID_PATTERN.test(id) || TOMBSTONE_ID_PATTERN.test(id))
}
export function isTombstoneIdentityId(id: unknown): boolean {
  return typeof id === 'string' && TOMBSTONE_ID_PATTERN.test(id)
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

// Authorization check for session-scoped reads: the caller is an admitted
// participant (participantOrBanned 'ok'). Returns the AuthorizedIdentity on
// success, null when the caller should be rejected. Endpoints that poll should
// use participantOrBanned so a removed caller gets the right bounce header.
export async function requireParticipant(
  code: string,
  req: NextRequest,
  authSession: Session | null,
  opened: Opened,
): Promise<AuthorizedIdentity | null> {
  const result = await participantOrBanned(code, req, authSession, opened)
  return result.status === 'ok' ? result.identity : null
}

// Quad-state admission, plus 'unavailable':
//   - 'ok'          — admitted participant, proceed.
//   - 'banned'      — emit authRemoved (preserves token).
//   - 'kicked'      — removed but not banned; also authRemoved.
//   - 'invalid'     — no identity / never joined; emit authInvalid.
//   - 'unavailable' — the record and the cache disagree on the incarnation
//                     (never expected — fail closed with a 503).
//
// 🔒 redis-rehydration § 4.7 — THE RECORD GRANTS, THE CACHE ONLY DENIES. For a
// `u:` caller of a Postgres-backed session the answer comes from one indexed
// read of COMMITTED Postgres state (lib/sessionGrant.ts), carried on the
// identity as `grant`; the Redis bans set is still checked FIRST (a cached ban
// denies), but a cached roster entry, role or a missing kick never admits or
// grants. When the record answers banned/kicked and Redis lacks the entry, it is
// re-seeded (fenced, no wait); when it answers ok and the identities hash lacks
// the user, the per-user heal registers them (fenced, bounded wait) — mobile
// treats `invalid` as fatal, so the heal must be server-side. Anonymous callers
// and Redis-only sessions keep Redis as their authority (ruling 3).
export type ParticipantResult =
  | { status: 'ok'; identity: AuthorizedIdentity }
  | { status: 'banned'; identity: AuthorizedIdentity }
  | { status: 'kicked'; identity: AuthorizedIdentity }
  | { status: 'invalid' }
  | { status: 'unavailable' }

export async function participantOrBanned(
  code: string,
  req: NextRequest,
  authSession: Session | null,
  opened: Opened,
): Promise<ParticipantResult> {
  const identity = await resolveIdentity(code, req, authSession)
  if (!identity) return { status: 'invalid' }
  const resolved = await resolveGrant(code, identity, opened)
  if (resolved === 'unavailable') return { status: 'unavailable' }
  const { grant: grantRes, incarnation } = resolved
  if (!grantRes) {
    // Cache authority (anonymous caller, Redis-only session): the incarnation
    // check and the admission read in ONE step (r3 R1-1) — a code reused
    // between two commands could otherwise admit through the successor's roster.
    const r = await cacheAdmission(code, identity.id, incarnation)
    if (r === 'mismatch') return { status: 'unavailable' }
    // 'host' (a meta-proven strict host missing from the roster) is not a
    // participant here — unchanged; the privilege helpers still grant it.
    if (r === 'banned') return { status: 'banned', identity: authorized(identity, null, incarnation, true) }
    if (r === 'kicked') return { status: 'kicked', identity: authorized(identity, null, incarnation) }
    if (r !== 'ok') return { status: 'invalid' }
    return { status: 'ok', identity: authorized(identity, null, incarnation) }
  }
  if (await redis.sIsMember(k.bans(code), identity.id)) return { status: 'banned', identity: authorized(identity, grantRes, incarnation, true) }
  const auth = authorized(identity, grantRes, incarnation)
  {
    const status = grantStatus(grantRes)
    if (status === 'banned' || status === 'kicked') {
      await reseedRemoval(code, identity.id, status)
      return { status, identity: auth }
    }
    // Not in the record (e.g. kick-deleted: no member row, no ratings left): a
    // cached kicked marker still shapes the bounce ("You were removed") — a
    // denial, which the cache may give.
    if (status === 'invalid') {
      return (await redis.sIsMember(k.kicked(code), identity.id)) ? { status: 'kicked', identity: auth } : { status: 'invalid' }
    }
    if ((await redis.hGet(k.identities(code), identity.id)) == null) {
      const name = await healRegistration(code, auth)
      if (name) return { status: 'ok', identity: authorized({ ...identity, displayName: name }, grantRes, incarnation) }
    }
    return { status: 'ok', identity: auth }
  }
}


// The caller's authorization WITHOUT the participant gate — for routes a
// removed caller may still reach (bans list, ban preview, removed-state, leave):
// the same grant read, so host checks answer from the record.
export async function resolveAuthorized(
  code: string,
  req: NextRequest,
  authSession: Session | null,
  opened: Opened,
): Promise<AuthorizedIdentity | null | 'unavailable'> {
  const identity = await resolveIdentity(code, req, authSession)
  if (!identity) return null
  const resolved = await resolveGrant(code, identity, opened)
  if (resolved === 'unavailable') return 'unavailable'
  // No participant gate here, so the cache's denials are carried as `denied` —
  // every privilege helper refuses it: a cached ban for anyone (r2/r3 N1); for
  // a cache-authority caller also a kick or an off-roster identity, whatever
  // stale role entry meta still holds (r4 N1). Same atomic read as admission.
  if (!resolved.grant) {
    const r = await cacheAdmission(code, identity.id, resolved.incarnation)
    if (r === 'mismatch') return 'unavailable'
    return authorized(identity, null, resolved.incarnation, r !== 'ok' && r !== 'host')
  }
  return authorized(identity, resolved.grant, resolved.incarnation, await redis.sIsMember(k.bans(code), identity.id))
}


// The snapshot the route opened (openSession's meta) — the incarnation the
// whole request is bound to. null only where nothing was opened.
type Opened = { createdAt: number } | null

// The grant for a `u:` identity (null for anon / Redis-only), with the
// incarnation belt (r2-1): the grant must belong to the SAME incarnation as
// the snapshot the route opened (and will build its response from) — never a
// fresh read, which a code recycled between the open and the grant read would
// pass (code review r1 P1-1). The incarnation is then carried on the
// AuthorizedIdentity into every contract the request enters.
async function resolveGrant(code: string, identity: Identity, opened: Opened): Promise<{ grant: Grant | null; incarnation: number | undefined } | 'unavailable'> {
  let seen = opened?.createdAt
  const grant = identity.kind === 'user' ? await readGrant(prisma, code, Number(identity.id.slice(2))) : null
  // Without a grant (cache authority) the callers check the cache's
  // incarnation atomically with their admission read (cacheAdmission).
  if (!grant) return { grant: null, incarnation: seen }
  if (seen === undefined) {
    const raw = await redis.get(k.meta(code))
    if (raw) seen = (JSON.parse(raw) as { createdAt?: number }).createdAt
  }
  if (seen !== undefined && grant.createdAt !== null && seen !== grant.createdAt) {
    console.error('[grant] incarnation mismatch', { code })
    return 'unavailable'
  }
  return { grant, incarnation: seen ?? grant.createdAt ?? undefined }
}

// 503 for the 'unavailable' admission (and the resolveAuthorized form).
export function authUnavailable(): NextResponse {
  return NextResponse.json({ error: 'session is being restored' }, {
    status: 503,
    headers: { 'Retry-After': '1', 'Cache-Control': 'private, no-store' },
  })
}

export { authInvalid, authRemoved } from '@/lib/authResponses'
