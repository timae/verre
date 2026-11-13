// Public user ids at the wire edge (docs/dev/proposals/public-user-ids.md § 4).
//
// 🔒 The integer `users.id` is the internal id EVERYWHERE (Postgres keys,
// Redis keys, the `u:<int>` session identity, `auth()`, `resolveUser`,
// rate-limit keys, the stored identity strings); it never leaves the server.
// Every user id a client sees, sends, scans or links is the public id, and
// this module is the one translation point.
//
// Outbound: `publicIdsFor` / `wireIdentityMap`. 🔒 A MISS IS DROPPED, never
// passed through: integers without a users row reach the outbound paths (a
// deleted account lingers in Redis identities, rating keys, bans, roles and
// wine provenance until the `d:` migration; a host can ban any `u:<int>`), and
// such an entry leaves the payload instead of emitting the integer.
//
// Inbound: `parsePublicIdParam` / `parseWireIdentity` are FORMAT ONLY (an
// integer is malformed, 400). Resolution (`userIdForPublicId`,
// `internalIdentity`) runs where today's code meets a nonexistent integer:
// after the limiter and the role gates, so a null takes exactly that path and
// an unknown id is indistinguishable from a blocked or deleted one.

import { isPublicUserId, normalizePublicUserId } from '@verre/core'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export { isPublicUserId }

// ── Forward cache: int → public id ─────────────────────────────────────────
// The mapping never changes (immutability trigger), but an entry would
// otherwise outlive the account's deletion and the miss rule would differ by
// instance: entries live 10 minutes. Misses are never cached.
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 50_000
const forward = new Map<number, { pid: string; at: number }>()

function remember(id: number, pid: string, now: number) {
  forward.delete(id)
  forward.set(id, { pid, at: now })
  if (forward.size > MAX_ENTRIES) forward.delete(forward.keys().next().value as number)
}

export async function publicIdsFor(userIds: Iterable<number | null | undefined>): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const want: number[] = []
  const now = Date.now()
  for (const id of userIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || out.has(id) || want.includes(id)) continue
    const hit = forward.get(id)
    if (hit && now - hit.at < TTL_MS) { out.set(id, hit.pid); continue }
    if (hit) forward.delete(id)
    want.push(id)
  }
  if (want.length === 0) return out
  const rows = await prisma.$queryRaw<{ id: number; public_id: string }[]>`
    SELECT id, public_id FROM users WHERE id = ANY(${want}::int[])`
  for (const r of rows) { out.set(r.id, r.public_id); remember(r.id, r.public_id, now) }
  return out
}

export async function publicIdFor(userId: number | null | undefined): Promise<string | null> {
  if (userId == null) return null
  return (await publicIdsFor([userId])).get(userId) ?? null
}

// For tests: the cache window is part of the miss rule (§ 9 deleted-participant walk).
export function _resetPublicIdCache() { forward.clear() }

// ── Reverse: public id → int (indexed, not cached) ─────────────────────────
// `db`: pass the transaction's client when resolving inside a session
// mutation, so the lookup doesn't take a second pool connection while the
// transaction holds one.
export async function userIdForPublicId(publicId: string, db: Prisma.TransactionClient = prisma): Promise<number | null> {
  const rows = await db.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE public_id = ${publicId}`
  return rows[0]?.id ?? null
}

export async function userIdsForPublicIds(publicIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const uniq = [...new Set(publicIds)]
  if (uniq.length === 0) return out
  const rows = await prisma.$queryRaw<{ id: number; public_id: string }[]>`
    SELECT id, public_id FROM users WHERE public_id = ANY(${uniq}::text[])`
  for (const r of rows) out.set(r.public_id, r.id)
  return out
}

// An id no users row has (users.id is a serial from 1). Routing an unknown
// public id through it makes the null take EXACTLY today's nonexistent-integer
// path (limiter charged, FK-swallowed write, the same answer) in helpers that
// already handle a missing target (setBlock, setMute).
export const NO_SUCH_USER = 0

export async function userIdOrNoSuchUser(publicId: string): Promise<number> {
  return (await userIdForPublicId(publicId)) ?? NO_SUCH_USER
}

// ── Format-only parsers (no database read) ─────────────────────────────────
export function parsePublicIdParam(segment: string | null | undefined): string | null {
  return normalizePublicUserId(segment)
}

// The WIRE identity shape: `u:<publicId>` for a logged-in user, `a:` / `d:`
// uuids as they are. The internal shape (`u:<int>`) is lib/identity.ts
// isValidIdentityId and must never be accepted from a client.
const ANON_RE = /^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOMB_RE = /^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WireIdentity =
  | { kind: 'user'; publicId: string }
  | { kind: 'other'; id: string }

export function parseWireIdentity(raw: unknown): WireIdentity | null {
  if (typeof raw !== 'string') return null
  if (raw.startsWith('u:')) {
    const pid = normalizePublicUserId(raw.slice(2))
    return pid ? { kind: 'user', publicId: pid } : null
  }
  if (ANON_RE.test(raw) || TOMB_RE.test(raw)) return { kind: 'other', id: raw }
  return null
}

export function isWireIdentityId(raw: unknown): boolean {
  return parseWireIdentity(raw) !== null
}

// Wire → internal. `a:` / `d:` pass through; `u:<publicId>` resolves to
// `u:<int>`, or null when no such user exists (the caller follows the
// nonexistent-target path).
export async function internalIdentity(wire: WireIdentity, db: Prisma.TransactionClient = prisma): Promise<string | null> {
  if (wire.kind === 'other') return wire.id
  const id = await userIdForPublicId(wire.publicId, db)
  return id == null ? null : `u:${id}`
}

// ── Internal → wire ────────────────────────────────────────────────────────
// CANONICAL user ids only (no leading zero, within int4): before public ids a
// host could ban any `u:<digits>` in a Redis-only moment, and `u:0042` would
// translate to user 42 while never matching them, `u:99999999999` would fail
// the `::int[]` lookup for the whole view. Anything else is not a user: dropped.
const INTERNAL_USER_RE = /^u:([1-9]\d{0,9})$/
const INT4_MAX = 2147483647

export function userIdOfIdentity(identity: string | null | undefined): number | null {
  const m = identity ? INTERNAL_USER_RE.exec(identity) : null
  if (!m) return null
  const n = Number(m[1])
  return n <= INT4_MAX ? n : null
}

// Map every internal identity in `identities` to its wire form. `a:` / `d:`
// map to themselves; a `u:<int>` without a users row is ABSENT from the map,
// so callers drop it (🔒 never emit the integer).
export async function wireIdentityMap(identities: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...identities].filter((s): s is string => typeof s === 'string')
  const pids = await publicIdsFor(list.map(userIdOfIdentity))
  const out = new Map<string, string>()
  for (const id of list) {
    const uid = userIdOfIdentity(id)
    if (uid == null) { if (!id.startsWith('u:')) out.set(id, id); continue }
    const pid = pids.get(uid)
    if (pid) out.set(id, `u:${pid}`)
  }
  return out
}

export async function wireIdentity(identity: string): Promise<string | null> {
  return (await wireIdentityMap([identity])).get(identity) ?? null
}

// Helpers for the mappers: translate a list / a keyed object, dropping misses.
export function mapIdentityList(ids: readonly string[] | undefined, map: Map<string, string>): string[] {
  const out: string[] = []
  for (const id of ids ?? []) { const w = map.get(id); if (w) out.push(w) }
  return out
}

// ── Tag arrays (`taggedUserIds` on the check-in POST / PATCH) ──────────────
// 🔒 Any element that isn't a well-formed public id → 400 for the WHOLE
// request (`null`), so an old tab's integer list can never become `[]` and
// wipe a post's tags (the PATCH deletes and re-inserts). Well-formed unknown
// ids are dropped like a non-mutual tag. Capped before the lookup. Callers
// resolve BEFORE their transaction (tags are written after COMMIT, so a late
// 400 would leave the post created and a retry would duplicate it).
export const MAX_TAGS = 50

export function parseTagList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_TAGS) return null
  const out: string[] = []
  for (const v of raw) {
    const pid = normalizePublicUserId(v)
    if (!pid) return null
    out.push(pid)
  }
  return [...new Set(out)]
}

export async function resolveTagList(publicIds: readonly string[]): Promise<number[]> {
  if (publicIds.length === 0) return []
  return [...(await userIdsForPublicIds(publicIds)).values()]
}
