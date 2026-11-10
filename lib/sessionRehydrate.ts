import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { redis, k, scanKeys, lifespanTTL } from '@/lib/redis'
import {
  withSessionMutation, mutationHooks, ContractBusy, ContractGone, ContractCold, ContractConflict, ContractRefused, LockLost, type Fence, type MutationCtx,
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
// terminal "This moment isn't available". A live Postgres row never produces a 404.
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

// ── rehydrateSession / ensureSessionLive (§ 5.1; release-C plan § 1.2) ─────
//
// ONE rebuild path for the app (ensureSessionLive) and the operator script
// (scripts/rehydrate-sessions.mts). `dryRun` runs the same contract entry minus
// the Redis lease — advisory lock, live row FOR UPDATE, meta + incarnation —
// and plans the publish without writing anything (no lock key, no generation
// baseline, no re-seed). A dry run is an observational estimate, never carried
// into an apply: the apply re-plans under its own locks.
// `reseedRedisOnly: false` (the script): a code without a live row is reported,
// never touched — the D5 re-seed is app behaviour on open.

export type RebuildOutcome = 'warm' | 'absent' | 'redisOnly' | 'planned' | 'applied' | 'busy' | 'refused' | 'conflict'
export type RehydrateResult = {
  // What ensureSessionLive answers (a dry run changes nothing: a cold cache stays 'restoring').
  status: Liveness
  outcome: RebuildOutcome
  state?: 'warm' | 'cold'
  plan?: RebuildPlan
  published?: Published
}
type RehydrateOpts = { force?: boolean; dryRun?: boolean; reseedRedisOnly?: boolean }

export async function rehydrateSession(code: string, { force = false, dryRun = false, reseedRedisOnly = true }: RehydrateOpts = {}): Promise<RehydrateResult> {
  if (!force && (await redis.exists([k.meta(code), k.wines(code)])) === 2) return { status: 'live', outcome: 'warm', state: 'warm' }
  const row = await readLiveRow(prisma, code)
  if (!row) {
    if (!(await redis.exists(k.meta(code)))) return { status: 'absent', outcome: 'absent' }
    if (!reseedRedisOnly) return { status: 'live', outcome: 'redisOnly' }
  }
  try {
    const r = await withSessionMutation(code, {
      label: dryRun ? 'rebuild:plan' : force ? 'rebuild:force' : 'rebuild',
      redisLock: dryRun ? false : { waitMs: 3000 },
      readMeta: 'optional',
    }, (tx, ctx) => rebuildWork(tx, ctx, code, { force, publish: !dryRun, reseedRedisOnly }))
    const status: Liveness = r.outcome === 'absent' ? 'absent' : r.outcome === 'planned' && r.state === 'cold' ? 'restoring' : 'live'
    return { status, ...r }
  } catch (err) {
    if (err instanceof ContractBusy) return { status: 'restoring', outcome: 'busy' }
    if (err instanceof LockLost) return { status: 'restoring', outcome: 'refused' }
    // The cache holds another incarnation than the record (never expected):
    // never repaint it — the request proceeds and the grant belt fails closed.
    if (err instanceof ContractConflict) return { status: 'live', outcome: 'conflict' }
    throw err
  }
}

export async function ensureSessionLive(code: string, { force = false }: { force?: boolean } = {}): Promise<Liveness> {
  return (await rehydrateSession(code, { force })).status
}

// The rebuild's work callback, shared by both modes. Its result is the return
// value — nothing is captured outside the callback, so a contract attempt can
// never leak a previous attempt's plan.
async function rebuildWork(
  tx: Prisma.TransactionClient, ctx: MutationCtx, code: string,
  { force, publish, reseedRedisOnly }: { force: boolean; publish: boolean; reseedRedisOnly: boolean },
): Promise<Omit<RehydrateResult, 'status'>> {
  const [metaRaw, winesRaw] = await redis.mGet([k.meta(code), k.wines(code)])
  if (!ctx.row) {
    // A Redis-only session whose wines key was evicted (D5): re-seed `[]`
    // (its content is accepted as lost, ruling 3) — otherwise reject-on-
    // absent would freeze the lineup forever.
    if (publish && reseedRedisOnly && metaRaw && !winesRaw) {
      const pttl = Number(await redis.pTTL(k.meta(code)))
      await ctx.fence!.exec(m => { m.set(k.wines(code), '[]', pttl > 0 ? { NX: true, PX: pttl } : { NX: true }) })
    }
    return { outcome: metaRaw ? 'redisOnly' : 'absent' }
  }
  const state = metaRaw && winesRaw ? 'warm' : 'cold'
  if (!force && state === 'warm') return { outcome: 'warm', state }
  const liveMeta = force ? ctx.meta : null
  if (!publish) return { outcome: 'planned', state, plan: await planPublish(tx, ctx.row, liveMeta, !!metaRaw, 'rebuild:plan') }
  const { plan, published } = await publishFromRecord(tx, ctx.row, ctx.fence!, liveMeta, !!metaRaw)
  return { outcome: 'applied', state, plan, published }
}

// ── The plan and the publish (§ 5.1 steps 7–8; release-C plan § 1.2) ───────
//
// The fenced publish runs INSIDE the transaction while the advisory lock is
// held (r2-2). One MULTI: wines NX; identities reconciled (HSETNX eligible, HDEL
// ineligible u:/absent d:); rating keys NX; orphan / banned / absent-tombstone
// rating keys deleted; bans + kicked reconciled (u:/d: only); every key EXPIREd
// to the lifespan; meta NX LAST (XX from the record under `force` with meta
// present). WATCHes the publication generation recorded BEFORE the record was
// read: any durable change made since by a writer without the lease refuses the
// publish (plan § 3, r4-1).
const GEN_BASELINE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]`

// What the publish writes (actionable) — planned from the plan's pre-reads,
// confirmed from the EXEC replies. Converged ⇔ every count 0, every flag false,
// metaFields [].
export type RebuildCounts = {
  rebuilt: { meta: boolean; lineup: boolean; wines: number; members: number; tombstones: number; ratings: number; bans: number; kicked: number }
  reconciled: { metaFields: string[]; identities: number; ratingKeys: number; bans: number; kicked: number; provenance: number }
}
export type RebuildPlan = {
  code: string
  ttl: number
  wines: WineMeta[]
  cachedWinesRaw: string | null
  patchedWines: WineMeta[] | null
  hset: [string, string][]
  hdel: string[]
  ratings: Map<string, RatingMeta>
  delRatings: string[]
  bans: string[]
  sremBans: string[]
  kickedIds: string[]
  sremKicked: string[]
  expireKeys: string[]
  meta: SessionMeta
  liveMeta: SessionMeta | null
  // NX with meta absent → create; NX with meta present → noop; XX → rewrite.
  metaWrite: { write: 'nx' | 'xx'; expect: 'create' | 'noop' | 'rewrite' }
  counts: RebuildCounts
  // Informational — stays nonzero on a converged moment.
  info: { tombstoneGroups: number; orphans: number }
}

// Reads only — no Redis write. The baseline (publishFromRecord) precedes it.
export async function planPublish(
  tx: Prisma.TransactionClient,
  row: SessionRow,
  liveMeta: SessionMeta | null,
  metaPresent: boolean,
  label: string,
): Promise<RebuildPlan> {
  const code = row.code
  const ttl = lifespanTTL(row.lifespan ?? undefined)
  const [roster, roles, wines, ratings] = [
    await eligibleRoster(tx, row), await readRecordRoles(tx, code), await recordLineup(tx, row.id), await recordRatings(tx, row.id, code),
  ]
  await mutationHooks.at('recordRead', code, label)
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
  let provenance = 0
  if (cachedWinesRaw) {
    const byId = new Map(wines.map(w => [w.id, w]))
    const cached = JSON.parse(cachedWinesRaw) as WineMeta[]
    const next = cached.map((w) => {
      const r = byId.get(w.id)
      if (!r?.addedByIdentityId || (r.addedByIdentityId === w.addedByIdentityId && r.addedByDisplayName === w.addedByDisplayName)) return w
      provenance++
      return { ...w, addedByIdentityId: r.addedByIdentityId, addedByDisplayName: r.addedByDisplayName }
    })
    if (provenance) patchedWines = next
  }
  const keySet = new Set(keys)
  const cachedBans = new Set(bans), cachedKicked = new Set(kicked)
  const metaWrite = liveMeta ? { write: 'xx' as const, expect: 'rewrite' as const } : { write: 'nx' as const, expect: metaPresent ? 'noop' as const : 'create' as const }
  return {
    code, ttl, wines, cachedWinesRaw, patchedWines, hset, hdel, ratings, delRatings,
    bans: roster.bans, sremBans, kickedIds: [...kickedIds], sremKicked,
    // EVERY key of the session, the readiness pair included (r1 P2-5): an
    // existing meta near its expiry must not die before its rebuilt siblings.
    expireKeys: [...new Set([...keys, k.meta(code), k.wines(code), k.identities(code), k.bans(code), k.kicked(code), k.gen(code), ...ratings.keys()])],
    meta, liveMeta, metaWrite,
    counts: {
      rebuilt: {
        meta: metaWrite.expect === 'create',
        lineup: cachedWinesRaw === null,
        wines: cachedWinesRaw === null ? wines.length : 0,
        members: hset.filter(([id]) => id.startsWith('u:')).length,
        tombstones: hset.filter(([id]) => id.startsWith('d:')).length,
        ratings: [...ratings.keys()].filter(key => !keySet.has(key)).length,
        bans: roster.bans.filter(id => !cachedBans.has(id)).length,
        kicked: [...kickedIds].filter(id => !cachedKicked.has(id)).length,
      },
      reconciled: {
        metaFields: liveMeta ? metaFieldChanges(liveMeta, meta) : [],
        identities: hdel.length, ratingKeys: delRatings.length, bans: sremBans.length, kicked: sremKicked.length, provenance,
      },
    },
    info: { tombstoneGroups: roster.tombstones.length, orphans: userIdsIn.filter(id => !liveUsers.has(`u:${id}`)).length },
  }
}

// The names of the meta fields a forced XX rewrite changes, normalized like
// scripts/rehydration-precheck.mts (absent ≡ null ≡ '' ≡ the documented
// default, dates by instant, role lists as sets) so a format-only difference is
// not reported. Fields the record never produces (legacy `coHosts`) count: the
// rewrite drops them.
const META_DEFAULTS: Record<string, unknown> = {
  blind: false, blindForEveryone: false, category: 'wine', address: '', timezone: '', description: '', link: '',
  coverPhotoUrl: '', dateTo: null, dateFrom: null, coHostIds: [], providerIds: [],
}
function metaNorm(key: string, v: unknown): unknown {
  if (v === undefined || v === null || v === '') v = META_DEFAULTS[key] ?? null
  if ((key === 'dateFrom' || key === 'dateTo') && typeof v === 'string') return Date.parse(v)
  if ((key === 'coHostIds' || key === 'providerIds') && Array.isArray(v)) return [...v].sort().join(',')
  return v
}
export function metaFieldChanges(cached: SessionMeta, next: SessionMeta): string[] {
  const a = cached as Record<string, unknown>, b = next as Record<string, unknown>
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()
    .filter(f => JSON.stringify(metaNorm(f, a[f])) !== JSON.stringify(metaNorm(f, b[f])))
}

// The MULTI as a list, built ONCE from the plan; applyPublish queues it and the
// EXEC replies are read back by the same list (they cannot drift).
type Multi = Parameters<Parameters<Fence['exec']>[0]>[0]
type PublishTag = 'lineup' | 'provenance' | 'member' | 'tombstone' | 'hdel' | 'rating' | 'delRatings'
  | 'sAddBans' | 'sRemBans' | 'sAddKicked' | 'sRemKicked' | 'expire' | 'meta'
export type Published = { tags: PublishTag[]; replies: unknown[] }

function publishCommands(plan: RebuildPlan): { tag: PublishTag; queue: (m: Multi) => void }[] {
  const { code, ttl } = plan
  const out: { tag: PublishTag; queue: (m: Multi) => void }[] = []
  const q = (tag: PublishTag, queue: (m: Multi) => void) => { out.push({ tag, queue }) }
  q('lineup', m => { m.set(k.wines(code), JSON.stringify(plan.wines), { NX: true, EX: ttl }) })
  if (plan.patchedWines) { const patched = plan.patchedWines; q('provenance', m => { m.set(k.wines(code), JSON.stringify(patched), { XX: true, KEEPTTL: true }) }) }
  for (const [id, name] of plan.hset) q(id.startsWith('d:') ? 'tombstone' : 'member', m => { m.hSetNX(k.identities(code), id, name) })
  if (plan.hdel.length) q('hdel', m => { m.hDel(k.identities(code), plan.hdel) })
  for (const [key, value] of plan.ratings) q('rating', m => { m.set(key, JSON.stringify(value), { NX: true, EX: ttl }) })
  if (plan.delRatings.length) q('delRatings', m => { m.del(plan.delRatings) })
  if (plan.bans.length) q('sAddBans', m => { m.sAdd(k.bans(code), plan.bans) })
  if (plan.sremBans.length) q('sRemBans', m => { m.sRem(k.bans(code), plan.sremBans) })
  if (plan.kickedIds.length) q('sAddKicked', m => { m.sAdd(k.kicked(code), plan.kickedIds) })
  if (plan.sremKicked.length) q('sRemKicked', m => { m.sRem(k.kicked(code), plan.sremKicked) })
  for (const key of plan.expireKeys) q('expire', m => { m.expire(key, ttl) })
  if (plan.liveMeta) q('meta', m => { m.set(k.meta(code), JSON.stringify(plan.meta), { XX: true, KEEPTTL: true }) })
  else q('meta', m => { m.set(k.meta(code), JSON.stringify(plan.meta), { NX: true, EX: ttl }) })
  return out
}

async function applyPublish(fence: Fence, plan: RebuildPlan, gen: string): Promise<Published> {
  const { code } = plan
  const cmds = publishCommands(plan)
  const replies = await fence.exec((m) => { for (const c of cmds) c.queue(m) },
    // the patch requires the lineup it was computed from (r3 P2-4): an eviction
    // in between would otherwise let XX overwrite the NX record lineup with it
    { watch: [k.gen(code), k.wines(code)], expect: { [k.gen(code)]: gen, ...(plan.patchedWines ? { [k.wines(code)]: plan.cachedWinesRaw } : {}) } })
  return { tags: cmds.map(c => c.tag), replies }
}

// The confirmed effects of a publish, read off its EXEC replies as node-redis
// v4 returns them after its per-command transformers (which run inside MULTI
// too): SET → 'OK' | null, HSETNX / EXPIRE → boolean, HDEL / DEL / SADD / SREM →
// a count. Any other shape throws — never a silent zero. Not on the app path.
export function confirmedEffects(plan: RebuildPlan, { tags, replies }: Published): { counts: RebuildCounts; metaAcked: boolean } {
  if (tags.length !== replies.length) throw new Error(`publish: ${replies.length} EXEC replies for ${tags.length} commands`)
  const set = (v: unknown) => { if (v === 'OK') return true; if (v === null) return false; throw new Error('publish: unexpected SET reply shape') }
  const bool = (v: unknown) => { if (typeof v === 'boolean') return v; throw new Error('publish: unexpected boolean reply shape') }
  const num = (v: unknown) => { if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v; throw new Error('publish: unexpected count reply shape') }
  const c: RebuildCounts = {
    rebuilt: { meta: false, lineup: false, wines: 0, members: 0, tombstones: 0, ratings: 0, bans: 0, kicked: 0 },
    reconciled: { metaFields: [], identities: 0, ratingKeys: 0, bans: 0, kicked: 0, provenance: 0 },
  }
  let metaAcked = false
  tags.forEach((tag, i) => {
    const v = replies[i]
    switch (tag) {
      case 'lineup': if (set(v)) { c.rebuilt.lineup = true; c.rebuilt.wines = plan.wines.length } break
      case 'provenance': if (set(v)) c.reconciled.provenance = plan.counts.reconciled.provenance; break
      case 'member': if (bool(v)) c.rebuilt.members++; break
      case 'tombstone': if (bool(v)) c.rebuilt.tombstones++; break
      case 'hdel': c.reconciled.identities += num(v); break
      case 'rating': if (set(v)) c.rebuilt.ratings++; break
      case 'delRatings': c.reconciled.ratingKeys += num(v); break
      case 'sAddBans': c.rebuilt.bans += num(v); break
      case 'sRemBans': c.reconciled.bans += num(v); break
      case 'sAddKicked': c.rebuilt.kicked += num(v); break
      case 'sRemKicked': c.reconciled.kicked += num(v); break
      case 'expire': bool(v); break
      case 'meta': metaAcked = set(v); break
    }
  })
  c.rebuilt.meta = plan.metaWrite.write === 'nx' && metaAcked
  if (plan.metaWrite.write === 'xx' && metaAcked) c.reconciled.metaFields = plan.counts.reconciled.metaFields
  return { counts: c, metaAcked }
}

// The app's publish: baseline → plan → hook → apply → log. The baseline in ONE
// step (code review r1 P2-4): an eviction between a SET NX and a GET would
// record null, and a later eviction of a writer's bump would then match it.
// It precedes the record reads (r4-1): a durable write between the reads and
// the publish refuses the publish.
async function publishFromRecord(
  tx: Prisma.TransactionClient,
  row: SessionRow,
  fence: Fence,
  liveMeta: SessionMeta | null,
  metaPresent: boolean,
): Promise<{ plan: RebuildPlan; published: Published }> {
  const code = row.code
  const ttl = lifespanTTL(row.lifespan ?? undefined)
  const gen = String(await redis.eval(GEN_BASELINE_SCRIPT, { keys: [k.gen(code)], arguments: [randomUUID(), String(ttl)] }))
  const label = liveMeta ? 'rebuild:force' : 'rebuild'
  const plan = await planPublish(tx, row, liveMeta, metaPresent, label)
  await mutationHooks.at('beforePublish', code, label)
  const published = await applyPublish(fence, plan, gen)
  console.log('[rehydrate]', JSON.stringify({
    code, force: !!liveMeta, wines: plan.wines.length, ratings: plan.ratings.size, identitiesAdded: plan.hset.length, identitiesRemoved: plan.hdel.length,
    ratingKeysRemoved: plan.delRatings.length, bans: plan.bans.length, bansRemoved: plan.sremBans.length, kicked: plan.kickedIds.length,
    kickedRemoved: plan.sremKicked.length, tombstones: plan.info.tombstoneGroups, provenanceRepaired: !!plan.patchedWines,
  }))
  return { plan, published }
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
