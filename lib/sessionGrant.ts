import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import type { Identity } from '@/lib/identity'

// The grant read (redis-rehydration § 4.7): for a logged-in identity in a
// Postgres-backed session, every authorization decision derives from COMMITTED
// Postgres state — one indexed round trip, carried on the identity as `grant`.
// The Redis copy of roles / bans / kicks / the roster is presentation for `u:`
// once the record exists: the cache can deny (a Redis ban still bounces first),
// never grant. Anonymous identities and Redis-only sessions have no record and
// keep today's Redis authority (ruling 3).
//
// 🔒 A grant applies only to the incarnation it was read for (`createdAt`):
// codes recycle after a soft-delete, and a grant read for one incarnation must
// never authorize a request against another's cache.

export type MemberRole = 'host' | 'co_host' | 'provider' | 'taster'

export type Grant = {
  sessionId: number
  createdAt: number | null
  strictHost: boolean
  // No host identity at all in the record (an anonymous or tombstoned host).
  hostless: boolean
  role: MemberRole | null
  member: boolean
  kicked: boolean
  banned: boolean
  // Has a committed rating in this session (a historical rater with no member row).
  author: boolean
  // sessions.lineup_revision, read in the same statement (model change § 8a,
  // step 1 ruling: the poll's line-up check costs a signed-in caller nothing).
  // Not an authorization input.
  lineupRevision: number | null
}

export type GrantStatus = 'ok' | 'banned' | 'kicked' | 'invalid'

type Db = Prisma.TransactionClient | typeof prisma

// The grant read's columns and member join (alias `s` = sessions), ONE
// definition for readGrant and its twins keyed by public id and by session ids
// (Moment Visibility: the look-in's `member: true`, the by-moment read and the
// feed's `momentId`), so none of them can disagree with the moment's own rule.
// A NULL user (a signed-out reader) matches nothing: never a member.
export type GrantRow = {
  id: number; created_at: Date | null; host_user_id: number | null; role: string | null
  member: boolean; removed_state: string | null; banned: boolean; author: boolean; lineup_revision: number | null
}
export function grantColumnsSql(userId: number | null): Prisma.Sql {
  return Prisma.sql`s.id, s.created_at, s.host_user_id, m.role, (m.user_id IS NOT NULL) AS member, m.removed_state, s.lineup_revision,
    EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = s.code AND b.identity_id = ${userId === null ? null : `u:${userId}`}::text) AS banned,
    EXISTS (SELECT 1 FROM ratings r WHERE r.user_id = ${userId}::int AND r.session_id = s.id) AS author`
}
export const grantMemberJoinSql = (userId: number | null): Prisma.Sql =>
  Prisma.sql`LEFT JOIN session_members m ON m.session_code = s.code AND m.user_id = ${userId}::int`
export function grantFromRow(r: GrantRow, userId: number | null): Grant {
  return {
    sessionId: r.id,
    createdAt: r.created_at ? r.created_at.getTime() : null,
    strictHost: userId !== null && r.host_user_id !== null && Number(r.host_user_id) === userId,
    hostless: r.host_user_id === null,
    role: (r.role as MemberRole | null) ?? null,
    member: r.member,
    kicked: r.removed_state === 'kicked',
    banned: r.banned,
    author: r.author,
    lineupRevision: r.lineup_revision,
  }
}

// 🔒 "People in the moment" in SQL (Moment Visibility step 3, T2): the twin of
// `grantStatus(grant) === 'ok'` for the viewer in the moment `sid` (a column or
// a value): a LIVE row, no ban of `u:<viewer>`, and the strict host, or a
// member row not kicked, or no member row and a rating of the viewer's there.
// The SAME answer as the look-in's `member: true`, the feed's `momentId` and
// by-moment (pinned against grantStatus over every grant state, the suite's
// § 25 a). A deleted moment has no insiders; a NULL viewer is never one.
// Aliases are private (`gi*`) so a caller's `s` can't be shadowed.
export function insiderSql(viewerId: number | null, sid: Prisma.Sql): Prisma.Sql {
  if (viewerId === null) return Prisma.sql`FALSE`
  return Prisma.sql`EXISTS (
    SELECT 1 FROM sessions gis
     WHERE gis.id = ${sid} AND gis.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM session_bans gib WHERE gib.session_code = gis.code AND gib.identity_id = ${`u:${viewerId}`}::text)
       AND (COALESCE(gis.host_user_id = ${viewerId}::integer, false)
         OR EXISTS (SELECT 1 FROM session_members gim WHERE gim.session_code = gis.code AND gim.user_id = ${viewerId}::integer AND gim.removed_state IS DISTINCT FROM 'kicked')
         OR (NOT EXISTS (SELECT 1 FROM session_members gin WHERE gin.session_code = gis.code AND gin.user_id = ${viewerId}::integer)
             AND EXISTS (SELECT 1 FROM ratings gir WHERE gir.session_id = gis.id AND gir.user_id = ${viewerId}::integer))))`
}

// One statement. null = no live sessions row (a Redis-only session).
export async function readGrant(db: Db, code: string, userId: number): Promise<Grant | null> {
  const rows = await db.$queryRaw<GrantRow[]>`
    SELECT ${grantColumnsSql(userId)} FROM sessions s ${grantMemberJoinSql(userId)}
     WHERE s.code = ${code} AND s.deleted_at IS NULL`
  return rows[0] ? grantFromRow(rows[0], userId) : null
}

// The twin keyed by the moment's PUBLIC id (`GET /api/me/sessions/by-moment/:id`).
export async function readGrantByPublicId(db: Db, publicId: string, userId: number): Promise<{ grant: Grant; code: string } | null> {
  const rows = await db.$queryRaw<(GrantRow & { code: string })[]>`
    SELECT ${grantColumnsSql(userId)}, s.code FROM sessions s ${grantMemberJoinSql(userId)}
     WHERE s.public_id = ${publicId} AND s.deleted_at IS NULL`
  return rows[0] ? { grant: grantFromRow(rows[0], userId), code: rows[0].code } : null
}

// The entrance gate's record read (leak-fixes F2, lib/sessionRoute.ts): the
// same answer as readGrant, but shaped so a wrong code plans and costs like a
// right one: the code and the user enter as a one-row VALUES and everything
// else LEFT JOINs to it, so the statement always returns its one row and the
// plan is the same node tree whatever the code (pinned by EXPLAIN in the suite,
// with a parity test against readGrant). A NULL user (a guest or signed-out
// caller) runs the same statement and matches nothing. null = no live row.
export function gateGrantSql(code: string, userId: number | null): Prisma.Sql {
  return Prisma.sql`
    SELECT s.id, s.created_at, s.host_user_id, m.role, (m.user_id IS NOT NULL) AS member, m.removed_state, s.lineup_revision,
           EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = s.code AND b.identity_id = q.ident) AS banned,
           EXISTS (SELECT 1 FROM ratings r WHERE r.user_id = q.uid AND r.session_id = s.id) AS author
      FROM (VALUES (${code}::text, ${userId}::int, ${userId === null ? null : `u:${userId}`}::text)) AS q(code, uid, ident)
      LEFT JOIN sessions s ON s.code = q.code AND s.deleted_at IS NULL
      LEFT JOIN session_members m ON m.session_code = s.code AND m.user_id = q.uid`
}

export async function readGateGrant(db: Db, code: string, userId: number | null): Promise<Grant | null> {
  const rows = await db.$queryRaw<{
    id: number | null; created_at: Date | null; host_user_id: number | null; role: string | null
    member: boolean; removed_state: string | null; banned: boolean; author: boolean; lineup_revision: number | null
  }[]>(gateGrantSql(code, userId))
  const r = rows[0]
  if (!r || r.id === null) return null
  return {
    sessionId: r.id,
    createdAt: r.created_at ? r.created_at.getTime() : null,
    strictHost: userId !== null && r.host_user_id !== null && Number(r.host_user_id) === userId,
    hostless: r.host_user_id === null,
    role: (r.role as MemberRole | null) ?? null,
    member: r.member,
    kicked: r.removed_state === 'kicked',
    banned: r.banned,
    author: r.author,
    lineupRevision: r.lineup_revision,
  }
}

// Admission from the record, the single-user form of eligibleRoster
// (lib/sessionRehydrate.ts): the strict host is always eligible (r1-8 — the
// logged-in create writes their member row, but a host who never got one must
// not be locked out of their own moment); otherwise a member or a rating
// author, minus kicked and banned.
export function grantStatus(g: Grant): GrantStatus {
  if (g.banned) return 'banned'
  if (g.strictHost) return 'ok'
  if (g.kicked) return 'kicked'
  if (!g.member && !g.author) return 'invalid'
  return 'ok'
}

// An identity whose authorization was RESOLVED for this request: `grant` is the
// record's answer for a `u:` caller of a Postgres-backed session, null for
// everyone else (anonymous callers, Redis-only sessions — Redis is their
// authority). Branded: the privilege helpers in lib/session.ts take only this
// type, so passing a raw resolveIdentity() result fails `tsc` — that is the
// § 4.7 audit, done by the compiler.
declare const AUTHORIZED: unique symbol
// `incarnation` — the createdAt of the session snapshot the request was
// admitted against. Every contract the caller enters re-checks it under the
// locks (withSessionMutation's expectedCreatedAt default), so a code deleted
// and reused mid-request refuses instead of writing into the successor.
// `denied` — a CACHED denial (a Redis ban) seen at admission: every privilege
// helper refuses it, for record-backed and cache-authority callers alike (the
// cache may deny, never grant — r3 N1: an anonymous cohost banned before its
// role strip landed).
export type AuthorizedIdentity = Identity & { readonly grant: Grant | null; readonly incarnation: number | undefined; readonly denied: boolean; readonly [AUTHORIZED]: true }

export function authorized(identity: Identity, grant: Grant | null, incarnation: number | undefined, denied = false): AuthorizedIdentity {
  return { ...identity, grant, incarnation, denied } as AuthorizedIdentity
}

// Cache-authority admission in ONE step (code review r3 R1-1): KEYS meta, bans,
// identities, kicked; ARGV the identity id and the opened incarnation ('' = none
// to check). A ban first; then the roster; the kicked set distinguishes a
// recently kicked user ("removed" bounce) from a stale token ("invalid");
// 'host' = not on the roster, no removal marker, but meta proves the strict
// host (an evicted identities hash must not demote it — r5).
const CACHE_ADMISSION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if ARGV[2] ~= '' then
  if not raw then return 'mismatch' end
  local ok, m = pcall(cjson.decode, raw)
  if not ok or type(m) ~= 'table' or string.format('%.0f', tonumber(m.createdAt) or -1) ~= ARGV[2] then return 'mismatch' end
end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 'banned' end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 'ok' end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then return 'kicked' end
if raw then
  local ok, m = pcall(cjson.decode, raw)
  if ok and type(m) == 'table' then
    if m.hostIdentityId == ARGV[1] then return 'host' end
    local hu = tonumber(m.hostUserId)
    if hu and ('u:' .. string.format('%.0f', hu)) == ARGV[1] then return 'host' end
  end
end
return 'invalid'`

export type CacheAdmission = 'ok' | 'host' | 'banned' | 'kicked' | 'invalid' | 'mismatch'

export async function cacheAdmission(code: string, id: string, incarnation: number | undefined): Promise<CacheAdmission> {
  const r = String(await redis.eval(CACHE_ADMISSION_SCRIPT, {
    keys: [k.meta(code), k.bans(code), k.identities(code), k.kicked(code)],
    arguments: [id, incarnation !== undefined ? String(incarnation) : ''],
  })) as CacheAdmission
  if (r === 'mismatch') console.error('[grant] incarnation mismatch (cache authority)', { code })
  return r
}
