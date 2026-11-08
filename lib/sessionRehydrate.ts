import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { redis, k, scanKeys, lifespanTTL } from '@/lib/redis'
import {
  withSessionMutation, mutationHooks, ContractBusy, ContractGone, ContractCold, ContractConflict, ContractRefused, LockLost, type Fence,
} from '@/lib/sessionMutation'
import { readLiveRow, readRecordRoles, metaFromRecord, type SessionRow } from '@/lib/sessionRecord'
import { disambiguateAgainst } from '@/lib/displayName.server'
import type { AuthorizedIdentity } from '@/lib/sessionGrant'
import type { SessionMeta, WineMeta, RatingMeta } from '@/lib/session'

// Rebuild and heal (docs/dev/proposals/redis-rehydration.md § 5; release-B plan
// § 4). For a Postgres-backed session the record is the truth and Redis a
// rebuildable cache: a miss is a rebuild, not an error; the rebuild is
// serialized per session (the contract), idempotent (content fills holes with
// NX; authorization-shaped state — identities, bans, kicked, role lists — is
// RECONCILED both ways against the record), and never writes Postgres.
//
// 🔒 'restoring' is a 503 + Retry-After, never a 404: mobile maps 404 to the
// terminal "This moment has ended". A live Postgres row never produces a 404.
// 🔒 List and enrichment reads (/api/me/sessions, lib/sessionFeedWines.ts) never
// rebuild — only opening one moment does.

export type Liveness = 'live' | 'absent' | 'restoring'

// Field coverage, checked by the compiler (§ 5.2, R1-13): `Record<keyof T, …>`
// is exhaustive, so a field added to SessionMeta / WineMeta / RatingMeta fails
// `tsc` here until someone decides whether the rebuild restores it. The cutover
// suite checks that every 'rebuilt' field round-trips.
export const SESSION_META_FIELDS: Record<keyof SessionMeta, 'rebuilt' | 'ephemeral'> = {
  host: 'rebuilt', name: 'rebuilt', createdAt: 'rebuilt', hostUserId: 'rebuilt', hostIdentityId: 'rebuilt',
  blind: 'rebuilt', blindForEveryone: 'rebuilt', lifespan: 'rebuilt', coHostIds: 'rebuilt', providerIds: 'rebuilt',
  address: 'rebuilt', dateFrom: 'rebuilt', dateTo: 'rebuilt', timezone: 'rebuilt', description: 'rebuilt',
  link: 'rebuilt', hideLineup: 'rebuilt', hideLineupMinutesBefore: 'rebuilt', showProvenance: 'rebuilt',
  coverPhotoUrl: 'rebuilt', category: 'rebuilt', promotedAt: 'rebuilt',
}
export const WINE_META_FIELDS: Record<keyof WineMeta, 'rebuilt' | 'ephemeral'> = {
  id: 'rebuilt', name: 'rebuilt', producer: 'rebuilt', vintage: 'rebuilt', grape: 'rebuilt', type: 'rebuilt',
  // A transient base64 upload, empty at rest — rebuilt as ''.
  image: 'ephemeral',
  imageUrl: 'rebuilt', description: 'rebuilt', region: 'rebuilt', country: 'rebuilt', vinification: 'rebuilt',
  purchaseUrl: 'rebuilt', revealedAt: 'rebuilt', addedByIdentityId: 'rebuilt', addedByDisplayName: 'rebuilt',
  productId: 'rebuilt', vintageId: 'rebuilt',
}
export const RATING_META_FIELDS: Record<keyof RatingMeta, 'rebuilt' | 'ephemeral'> = {
  score: 'rebuilt', flavors: 'rebuilt', aromas: 'rebuilt', notes: 'rebuilt', at: 'rebuilt',
}

type Db = Prisma.TransactionClient | typeof prisma

// ── The eligibility rule (B2) — ONE definition ───────────────────────────────
//
//   eligible(u) ⇔ u ∈ (members ∪ rating authors ∪ {strict host}) ∧ users row exists
//                 ∧ ¬kicked (the strict host is never kicked) ∧ 'u:<u>' ∉ session_bans
//   tombstone groups (d:<key>) are always eligible; anonymous entries are never
//   touched (ruling 3).
// Shared by the rebuild, `force`, the precheck; its single-user form is the
// grant read (lib/sessionGrant.ts grantStatus).
export type Roster = {
  eligible: { userId: number; name: string }[]
  kicked: number[]
  bans: string[]
  tombstones: string[]
}

export async function eligibleRoster(db: Db, row: Pick<SessionRow, 'id' | 'code' | 'hostUserId' | 'createdAt'>): Promise<Roster> {
  const people = await db.$queryRaw<{ user_id: number; name: string; kicked: boolean; banned: boolean }[]>`
    WITH cand AS (
      SELECT m.user_id, m.joined_at AS t, m.removed_state = 'kicked' AS kicked FROM session_members m WHERE m.session_code = ${row.code}
      UNION ALL
      SELECT r.user_id, min(r.rated_at), false FROM ratings r WHERE r.session_id = ${row.id} AND r.user_id IS NOT NULL GROUP BY r.user_id
      UNION ALL
      SELECT s.host_user_id, s.created_at, false FROM sessions s WHERE s.id = ${row.id} AND s.host_user_id IS NOT NULL
    )
    SELECT c.user_id, u.name, bool_or(c.kicked) AS kicked,
           EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = ${row.code} AND b.identity_id = 'u:' || c.user_id) AS banned
      FROM cand c JOIN users u ON u.id = c.user_id
     GROUP BY c.user_id, u.name
     ORDER BY min(c.t), c.user_id`
  const bans = await db.$queryRaw<{ identity_id: string }[]>`
    SELECT identity_id FROM session_bans WHERE session_code = ${row.code} ORDER BY banned_at, identity_id`
  const tombstones = await db.$queryRaw<{ k: string }[]>`
    SELECT DISTINCT tombstone_key AS k FROM ratings
     WHERE session_id = ${row.id} AND user_id IS NULL AND tombstone_key IS NOT NULL ORDER BY 1`
  const isHost = (id: number) => row.hostUserId !== null && Number(id) === row.hostUserId
  return {
    eligible: people.filter(p => !p.banned && (!p.kicked || isHost(p.user_id))).map(p => ({ userId: Number(p.user_id), name: p.name })),
    kicked: people.filter(p => p.kicked && !p.banned && !isHost(p.user_id)).map(p => Number(p.user_id)),
    bans: bans.map(b => b.identity_id),
    tombstones: tombstones.map(t => t.k),
  }
}

// ── Record → Redis values (§ 5.2) ────────────────────────────────────────────

type WineRow = {
  id: string; name: string; producer: string | null; vintage: string | null; grape: string | null; style: string | null
  image_url: string | null; description: string | null; region: string | null; country: string | null
  vinification: string | null; purchase_url: string | null; revealed_at: Date | null
  added_by_identity_id: string | null; added_by_display_name: string | null; product_id: string | null; vintage_id: string | null
}

export async function recordLineup(db: Db, sessionId: number): Promise<WineMeta[]> {
  const rows = await db.$queryRaw<WineRow[]>`
    SELECT id, name, producer, vintage, grape, style, image_url, description, region, country, vinification,
           purchase_url, revealed_at, added_by_identity_id, added_by_display_name, product_id, vintage_id
      FROM wines WHERE session_id = ${sessionId}
     ORDER BY position NULLS LAST, created_at, id`
  return rows.map((w) => {
    const out: WineMeta = {
      id: w.id, name: w.name, producer: w.producer ?? '', vintage: (w.vintage ?? '').trim(), grape: w.grape ?? '',
      type: w.style ?? '', image: '', imageUrl: w.image_url ?? '',
      revealedAt: w.revealed_at ? w.revealed_at.toISOString() : null,
      productId: w.product_id, vintageId: w.vintage_id,
    }
    if (w.description) out.description = w.description
    if (w.region) out.region = w.region
    if (w.country) out.country = w.country
    if (w.vinification) out.vinification = w.vinification
    if (w.purchase_url) out.purchaseUrl = w.purchase_url
    if (w.added_by_identity_id) out.addedByIdentityId = w.added_by_identity_id
    if (w.added_by_display_name) out.addedByDisplayName = w.added_by_display_name
    return out
  })
}

type RatingRow = {
  wine_id: string; user_id: number | null; tombstone_key: string | null; score: unknown
  flavors: unknown; aromas: unknown; notes: string | null; mirror_at: Date | null; rated_at: Date | null
}

// Ratings on the lineup, keyed by their Redis identity: `u:<id>` for a live
// (not banned) rater, `d:<key>` for a tombstone group (§ 4.3).
export async function recordRatings(db: Db, sessionId: number, code: string): Promise<Map<string, RatingMeta>> {
  const rows = await db.$queryRaw<RatingRow[]>`
    SELECT r.wine_id, r.user_id, r.tombstone_key, r.score, r.flavors, r.aromas, r.notes, r.mirror_at, r.rated_at
      FROM ratings r
      JOIN wines w ON w.id = r.wine_id AND w.session_id = r.session_id
     WHERE r.session_id = ${sessionId}
       AND (r.user_id IS NOT NULL OR r.tombstone_key IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = ${code} AND b.identity_id = 'u:' || r.user_id)
     ORDER BY r.rated_at ASC NULLS FIRST, r.mirror_at ASC NULLS FIRST, r.id ASC`
  // Oldest first: when several rows share one key (legacy deleted raters
  // folded into one tombstone group), the LATEST rating is set last and wins
  // (r2 N6), deterministically.
  const out = new Map<string, RatingMeta>()
  for (const r of rows) {
    const identity = r.user_id !== null ? `u:${r.user_id}` : r.tombstone_key!
    const at = r.mirror_at ?? r.rated_at
    out.set(k.rating(code, identity, r.wine_id), {
      score: Number(r.score ?? 0),
      flavors: (r.flavors && typeof r.flavors === 'object' ? r.flavors : {}) as Record<string, number>,
      aromas: Array.isArray(r.aromas) ? r.aromas as RatingMeta['aromas'] : [],
      notes: r.notes ?? '',
      at: at ? at.getTime() : 0,
    })
  }
  return out
}

// Identity of a rating key `s:{C}:r:<identity>:<wineId>` (identities carry one colon).
function ratingKeyIdentity(code: string, key: string): string | null {
  const rest = key.slice(`s:${code}:r:`.length)
  const i = rest.lastIndexOf(':')
  return i > 0 ? rest.slice(0, i) : null
}

// ── ensureSessionLive (§ 5.1) ────────────────────────────────────────────────

export async function ensureSessionLive(code: string, { force = false }: { force?: boolean } = {}): Promise<Liveness> {
  if (!force && (await redis.exists([k.meta(code), k.wines(code)])) === 2) return 'live'
  const row = await readLiveRow(prisma, code)
  if (!row && !(await redis.exists(k.meta(code)))) return 'absent'
  try {
    return await withSessionMutation(code, { label: force ? 'rebuild:force' : 'rebuild', redisLock: { waitMs: 3000 }, readMeta: 'optional' },
      async (tx, ctx) => {
        const fence = ctx.fence!
        const [metaRaw, winesRaw] = await redis.mGet([k.meta(code), k.wines(code)])
        if (!ctx.row) {
          // A Redis-only session whose wines key was evicted (D5): re-seed `[]`
          // (its content is accepted as lost, ruling 3) — otherwise reject-on-
          // absent would freeze the lineup forever.
          if (metaRaw && !winesRaw) {
            const pttl = Number(await redis.pTTL(k.meta(code)))
            await fence.exec(m => { m.set(k.wines(code), '[]', pttl > 0 ? { NX: true, PX: pttl } : { NX: true }) })
          }
          return metaRaw ? 'live' : 'absent'
        }
        if (!force && metaRaw && winesRaw) return 'live'
        await publishFromRecord(tx, ctx.row, fence, force ? ctx.meta : null)
        return 'live'
      })
  } catch (err) {
    if (err instanceof ContractBusy || err instanceof LockLost) return 'restoring'
    // The cache holds another incarnation than the record (never expected):
    // never repaint it — the request proceeds and the grant belt fails closed.
    if (err instanceof ContractConflict) return 'live'
    throw err
  }
}

// The fenced publish, INSIDE the transaction while the advisory lock is held
// (spec § 5.1 steps 7–8; r2-2). One MULTI: wines NX; identities reconciled
// (HSETNX eligible, HDEL ineligible u:/absent d:); rating keys NX; orphan /
// banned / absent-tombstone rating keys deleted; bans + kicked reconciled (u:/
// d: only); every key EXPIREd to the lifespan; meta NX LAST (XX from the
// record under `force` with meta present). WATCHes the publication generation
// recorded BEFORE the record was read: any durable change made since by a
// writer without the lease refuses the publish (plan § 3, r4-1).
const GEN_BASELINE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]`

async function publishFromRecord(
  tx: Prisma.TransactionClient,
  row: SessionRow,
  fence: Fence,
  liveMeta: SessionMeta | null,
): Promise<void> {
  const code = row.code
  const ttl = lifespanTTL(row.lifespan ?? undefined)
  // The baseline in ONE step (code review r1 P2-4): an eviction between a SET NX
  // and a GET would record null, and a later eviction of a writer's bump would
  // then match it.
  const gen = String(await redis.eval(GEN_BASELINE_SCRIPT, { keys: [k.gen(code)], arguments: [randomUUID(), String(ttl)] }))
  const [roster, roles, wines, ratings] = [
    await eligibleRoster(tx, row), await readRecordRoles(tx, code), await recordLineup(tx, row.id), await recordRatings(tx, row.id, code),
  ]
  const [identities, keys, bans, kicked] = await Promise.all([
    redis.hGetAll(k.identities(code)), scanKeys(`s:${code}:*`), redis.sMembers(k.bans(code)), redis.sMembers(k.kicked(code)),
  ])
  const eligibleIds = new Set(roster.eligible.map(e => `u:${e.userId}`))
  const tombstones = new Set(roster.tombstones)
  const kickedIds = new Set(roster.kicked.map(id => `u:${id}`))
  const banIds = new Set(roster.bans)
  const userIdsIn = [...new Set([...Object.keys(identities), ...keys.map(key => ratingKeyIdentity(code, key) ?? '')]
    .filter(id => /^u:\d{1,18}$/.test(id)).map(id => Number(id.slice(2))))]
  const liveUsers = new Set((userIdsIn.length ? await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${userIdsIn}::bigint[])` : [])
    .map(u => `u:${u.id}`))

  const names = new Set(Object.values(identities))
  const hset: [string, string][] = []
  for (const e of roster.eligible) {
    const id = `u:${e.userId}`
    if (id in identities) continue
    const name = disambiguateAgainst(e.name, names)
    names.add(name)
    hset.push([id, name])
  }
  for (const d of roster.tombstones) if (!(d in identities)) hset.push([d, '[deleted]'])
  const hdel = Object.keys(identities).filter(id => (id.startsWith('u:') && !eligibleIds.has(id)) || (id.startsWith('d:') && !tombstones.has(id)))
  const ratingKeys = keys.filter(key => key.startsWith(`s:${code}:r:`))
  const delRatings = ratingKeys.filter((key) => {
    const id = ratingKeyIdentity(code, key) ?? ''
    if (id.startsWith('u:')) return !liveUsers.has(id) || banIds.has(id)
    if (id.startsWith('d:')) return !tombstones.has(id)
    return false
  })
  // bans/kicked: the record's entries in, `u:`/`d:` entries the record lacks out
  // (anonymous entries untouched). A kicked marker is removed only for a user
  // the record ADMITS — for a kick-deleted user (no record trace) it is a
  // denial that only shapes the bounce screen, and the cache may deny.
  const sremBans = bans.filter(id => (id.startsWith('u:') || id.startsWith('d:')) && !banIds.has(id))
  const sremKicked = kicked.filter(id => id.startsWith('d:') || (id.startsWith('u:') && eligibleIds.has(id)))
  const meta = metaFromRecord(row, roles, liveMeta)
  // Provenance of an EXISTING lineup is reconciled from the record (r2 N4): a
  // reassign is record-first, so a refused projection leaves the cache naming
  // the old owner while the lineup itself (content, NX) is kept. Only a
  // non-null record owner overwrites (an add whose mirror failed has none).
  const cachedWinesRaw = await redis.get(k.wines(code))
  let patchedWines: WineMeta[] | null = null
  if (cachedWinesRaw) {
    const byId = new Map(wines.map(w => [w.id, w]))
    const cached = JSON.parse(cachedWinesRaw) as WineMeta[]
    let changed = false
    const next = cached.map((w) => {
      const r = byId.get(w.id)
      if (!r?.addedByIdentityId || (r.addedByIdentityId === w.addedByIdentityId && r.addedByDisplayName === w.addedByDisplayName)) return w
      changed = true
      return { ...w, addedByIdentityId: r.addedByIdentityId, addedByDisplayName: r.addedByDisplayName }
    })
    if (changed) patchedWines = next
  }
  await mutationHooks.at('beforePublish', code, liveMeta ? 'rebuild:force' : 'rebuild')

  await fence.exec((m) => {
    m.set(k.wines(code), JSON.stringify(wines), { NX: true, EX: ttl })
    if (patchedWines) m.set(k.wines(code), JSON.stringify(patchedWines), { XX: true, KEEPTTL: true })
    for (const [id, name] of hset) m.hSetNX(k.identities(code), id, name)
    if (hdel.length) m.hDel(k.identities(code), hdel)
    for (const [key, value] of ratings) m.set(key, JSON.stringify(value), { NX: true, EX: ttl })
    if (delRatings.length) m.del(delRatings)
    if (roster.bans.length) m.sAdd(k.bans(code), roster.bans)
    if (sremBans.length) m.sRem(k.bans(code), sremBans)
    if (kickedIds.size) m.sAdd(k.kicked(code), [...kickedIds])
    if (sremKicked.length) m.sRem(k.kicked(code), sremKicked)
    // EVERY key of the session, the readiness pair included (r1 P2-5): an
    // existing meta near its expiry must not die before its rebuilt siblings.
    for (const key of new Set([...keys, k.meta(code), k.wines(code), k.identities(code), k.bans(code), k.kicked(code), k.gen(code), ...ratings.keys()])) {
      m.expire(key, ttl)
    }
    if (liveMeta) m.set(k.meta(code), JSON.stringify(meta), { XX: true, KEEPTTL: true })
    else m.set(k.meta(code), JSON.stringify(meta), { NX: true, EX: ttl })
    // the patch requires the lineup it was computed from (r3 P2-4): an eviction
    // in between would otherwise let XX overwrite the NX record lineup with it
  }, { watch: [k.gen(code), k.wines(code)], expect: { [k.gen(code)]: gen, ...(patchedWines ? { [k.wines(code)]: cachedWinesRaw } : {}) } })
  console.log('[rehydrate]', JSON.stringify({
    code, force: !!liveMeta, wines: wines.length, ratings: ratings.size, identitiesAdded: hset.length, identitiesRemoved: hdel.length,
    ratingKeysRemoved: delRatings.length, bans: roster.bans.length, bansRemoved: sremBans.length, kicked: kickedIds.size,
    kickedRemoved: sremKicked.length, tombstones: roster.tombstones.length, provenanceRepaired: !!patchedWines,
  }))
}

// ── The read-path entry points (§ 5.3, plan § 4.2) ───────────────────────────

export type OpenedSession = { status: 'live'; meta: SessionMeta; wines: WineMeta[] } | { status: 'absent' | 'restoring' }

// ensureSessionLive + the readiness-pair read. Replaces every meta/existence
// read in the session routes (r1-9: an ensure followed by a raw GET meta still
// 404s when the key is evicted in between). A miss after 'live' re-ensures
// once, then answers 'restoring' for a live row and 'absent' only without one.
export async function openSession(code: string): Promise<OpenedSession> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [m, w] = await redis.mGet([k.meta(code), k.wines(code)])
    if (m && w) return { status: 'live', meta: JSON.parse(m) as SessionMeta, wines: JSON.parse(w) as WineMeta[] }
    const r = await ensureSessionLive(code)
    if (r !== 'live') return { status: r }
  }
  return { status: (await readLiveRow(prisma, code)) ? 'restoring' : 'absent' }
}

// The lineup read for a route that already opened the session: an absent key is
// a miss (re-ensure once → 503 / 404-only-if-absent), never `[]`.
export async function loadLiveWines(code: string): Promise<WineMeta[] | 'absent' | 'restoring'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await redis.get(k.wines(code))
    if (raw) return JSON.parse(raw) as WineMeta[]
    const r = await ensureSessionLive(code)
    if (r !== 'live') return r
  }
  return (await readLiveRow(prisma, code)) ? 'restoring' : 'absent'
}

export function sessionRestoring(): NextResponse {
  return NextResponse.json({ error: 'session is being restored' }, {
    status: 503, headers: { 'Retry-After': '1', 'Cache-Control': 'private, no-store' },
  })
}

// 404 for 'absent', 503 + Retry-After for 'restoring'.
export function unavailable(status: 'absent' | 'restoring', notFound = 'not found'): NextResponse {
  if (status === 'restoring') return sessionRestoring()
  return NextResponse.json({ error: notFound }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
}

// Maps a contract failure to the response (plan § 1.2): Busy/Lost → 503 +
// Retry-After (or the route's own busy status), Gone → 404, Cold → a rebuild
// and 503 (404 only when the session is really absent), a refusal → its own
// response. Anything else is a 500, logged.
export async function contractFailure(err: unknown, code: string, { busy = 503, label = 'contract' }: { busy?: number; label?: string } = {}): Promise<NextResponse> {
  if (err instanceof ContractRefused) return err.response
  if (err instanceof ContractBusy || err instanceof LockLost) {
    return NextResponse.json({ error: 'busy, try again' }, { status: busy, headers: { 'Retry-After': '1', 'Cache-Control': 'private, no-store' } })
  }
  if (err instanceof ContractGone) return unavailable('absent')
  if (err instanceof ContractConflict) return sessionRestoring()
  if (err instanceof ContractCold) {
    const r = await ensureSessionLive(code).catch(() => 'restoring' as const)
    return unavailable(r === 'absent' ? 'absent' : 'restoring')
  }
  console.error(`[${label}] failed`, { code, err })
  return NextResponse.json({ error: 'internal error' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } })
}

// ── The per-user heal and the entry-point re-seeds (§ 4.3) ───────────────────

// The record admitted a `u:` caller the identities hash lacks: register them.
// Bounded wait (500 ms) — on a busy lock the answer stays 'ok' without
// registering (the grant decided; the roster entry is presentation, the next
// poll retries). The contract re-reads the grant under the advisory lock and the
// fenced HSET (+ EXPIRE — the hash may have been evicted) is the projection, so
// a heal whose backend died cannot write after a kick took the lock (R5-2).
export async function healRegistration(code: string, caller: AuthorizedIdentity): Promise<string | null> {
  try {
    return await withSessionMutation(code, { label: 'heal', redisLock: { waitMs: 500 }, caller }, async (tx, ctx) => {
      if (ctx.callerStatus !== 'ok') return null
      const identities = await redis.hGetAll(k.identities(code))
      if (identities[caller.id] != null) return identities[caller.id]
      const users = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM users WHERE id = ${Number(caller.id.slice(2))}`
      if (!users[0]) return null
      return disambiguateAgainst(users[0].name, Object.values(identities))
    }, async (ctx, name) => {
      if (!name) return
      const ttl = lifespanTTL(ctx.row?.lifespan ?? undefined)
      await ctx.fence!.exec(m => { m.hSetNX(k.identities(code), caller.id, name); m.expire(k.identities(code), ttl) })
    })
  } catch (err) {
    if (!(err instanceof ContractBusy || err instanceof LockLost || err instanceof ContractGone || err instanceof ContractCold)) {
      console.error('[heal] failed', { code, err })
    }
    return null
  }
}

// The record answered banned/kicked and Redis lacks the entry: re-seed it so the
// cheap SISMEMBER is right again (R2-11). No wait on the lock — busy → skip (the
// record already decided). Re-read under the locks before the fenced SADD.
export async function reseedRemoval(code: string, identityId: string, kind: 'banned' | 'kicked'): Promise<void> {
  const key = kind === 'banned' ? k.bans(code) : k.kicked(code)
  try {
    if (await redis.sIsMember(key, identityId)) return
    await withSessionMutation(code, { label: `reseed:${kind}`, redisLock: { waitMs: 0 } }, async (tx, ctx) => {
      if (!ctx.row) return
      const still = kind === 'banned'
        ? await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM session_bans WHERE session_code = ${code} AND identity_id = ${identityId}`
        : await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM session_members WHERE session_code = ${code} AND user_id = ${Number(identityId.slice(2))} AND removed_state = 'kicked'`
      if (!still[0]) return
      const ttl = lifespanTTL(ctx.row.lifespan ?? undefined)
      await ctx.fence!.exec(m => { m.sAdd(key, identityId); m.expire(key, ttl) })
    })
  } catch (err) {
    if (!(err instanceof ContractBusy || err instanceof LockLost || err instanceof ContractGone || err instanceof ContractCold)) {
      console.error('[reseed] failed', { code, kind, err })
    }
  }
}

// The ratings-scan trigger (§ 5.1, ruling 5): an empty rating SCAN for a session
// with a live row and committed ratings → a reconciling rebuild.
export async function ratingsLost(code: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ x: number }[]>`
    SELECT 1 AS x FROM sessions s
     WHERE s.code = ${code} AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM ratings r WHERE r.session_id = s.id AND (r.user_id IS NOT NULL OR r.tombstone_key IS NOT NULL))`
  return !!rows[0]
}
