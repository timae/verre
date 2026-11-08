// Release-B pre-merge precheck (redis-rehydration release-B plan § 7). READ-ONLY:
// no Redis or Postgres write of any kind. Imports release B's own lib (the
// record → cache mapping the rebuild uses), so what it reports is what a
// rebuild WOULD produce. Codes and counts only — never names.
//
//   DATABASE_URL=… [DATABASE_CA_CERT=…] REDIS_URL=… npx tsx scripts/rehydration-precheck.mts
//
// Sections:
//   (a) session ratings with no rater identity (user_id and tombstone_key NULL)
//       — expect 0; B's migration catches them up anyway
//   (b) per WARM Postgres-backed session: what a rebuild would produce vs live
//       Redis — meta fields, lineup (ids, order, every field incl. revealedAt),
//       roster ids, bans / kicked, rating keys + values
//   (c) COLD live sessions (no Redis meta), and those with a future date_from
//       (a hidden lineup or hidden provenance cannot be known for those)
//   (d) registered `u:` identities the grant read would answer 'invalid'
//       (no member row, no rating, not the strict host) — owner ruling Q2
//   (e) orphan session_members rows (code with no live sessions row) — what
//       B's migration deletes
//   (f) moments with activity in the last 30 minutes (ratings / lastseen) —
//       for choosing a quiet deploy window (Q4)
import { prisma } from '../lib/prisma.ts'
import { redis, k, scanKeys } from '../lib/redis.ts'
import { readLiveRow, readRecordRoles, metaFromRecord } from '../lib/sessionRecord.ts'
import { eligibleRoster, recordLineup, recordRatings } from '../lib/sessionRehydrate.ts'
import { readGrant, grantStatus } from '../lib/sessionGrant.ts'
import type { SessionMeta, WineMeta, RatingMeta } from '../lib/session.ts'

const out: Record<string, unknown> = {}

// (a)
const [{ n: bothNull }] = await prisma.$queryRaw<[{ n: bigint }]>`
  SELECT count(*) AS n FROM ratings WHERE session_id IS NOT NULL AND user_id IS NULL AND tombstone_key IS NULL`
out.a_ratingsWithoutRater = Number(bothNull)

// Documented absent ≡ default normalizations (plan § 12 "round trip").
const DEFAULTS: Partial<Record<keyof SessionMeta, unknown>> = {
  blind: false, blindForEveryone: false, category: 'wine', address: '', timezone: '', description: '', link: '',
  coverPhotoUrl: '', dateTo: null, dateFrom: null, coHostIds: [], providerIds: [],
}
const norm = (key: string, v: unknown): unknown => {
  if (v === undefined || v === null || v === '') v = (DEFAULTS as Record<string, unknown>)[key] ?? null
  if ((key === 'dateFrom' || key === 'dateTo') && typeof v === 'string') return Date.parse(v)
  if ((key === 'coHostIds' || key === 'providerIds') && Array.isArray(v)) return [...v].sort().join(',')
  return v
}
const wineNorm = (w: WineMeta): Record<string, unknown> => {
  const o: Record<string, unknown> = {}
  for (const key of ['id', 'name', 'producer', 'vintage', 'grape', 'type', 'imageUrl', 'description', 'region', 'country',
    'vinification', 'purchaseUrl', 'revealedAt', 'addedByIdentityId', 'addedByDisplayName', 'productId', 'vintageId'] as const) {
    let v: unknown = w[key] ?? null
    if (v === '') v = null
    if (key === 'revealedAt' && typeof v === 'string') v = Date.parse(v)
    o[key] = v
  }
  return o
}
const ratingNorm = (r: Partial<RatingMeta>) => JSON.stringify({
  score: Number(r.score ?? 0), flavors: r.flavors ?? {}, aromas: r.aromas ?? [], notes: r.notes ?? '', at: Number(r.at ?? 0),
})

const live = await prisma.$queryRaw<{ code: string; date_from: Date | null }[]>`
  SELECT code, date_from FROM sessions WHERE deleted_at IS NULL AND code IS NOT NULL ORDER BY code`
const diffs: Record<string, Record<string, unknown>> = {}
const cold: string[] = []
const coldFuture: string[] = []
const invalidRegistered: Record<string, number> = {}
for (const { code, date_from } of live) {
  const metaRaw = await redis.get(k.meta(code))
  if (!metaRaw) {
    cold.push(code)
    if (date_from && date_from.getTime() > Date.now()) coldFuture.push(code)
    continue
  }
  const row = await readLiveRow(prisma, code)
  if (!row) continue
  const cached = JSON.parse(metaRaw) as SessionMeta
  const d: Record<string, unknown> = {}
  if (row.createdAt && cached.createdAt !== row.createdAt.getTime()) d.otherIncarnation = true
  // (b) meta
  const rebuilt = metaFromRecord(row, await readRecordRoles(prisma, code), cached)
  const metaFields = [...new Set([...Object.keys(rebuilt), ...Object.keys(cached)])]
    .filter(f => f !== 'promotedAt' && JSON.stringify(norm(f, (rebuilt as Record<string, unknown>)[f])) !== JSON.stringify(norm(f, (cached as Record<string, unknown>)[f])))
  if (metaFields.length) d.metaFields = metaFields
  // (b) lineup
  const winesRaw = await redis.get(k.wines(code))
  const recWines = await recordLineup(prisma, row.id)
  if (winesRaw === null) d.winesKeyMissing = true
  else {
    const cacheWines = JSON.parse(winesRaw) as WineMeta[]
    const recIds = recWines.map(w => w.id)
    const cacheIds = cacheWines.map(w => w.id)
    if (recIds.join() !== cacheIds.join()) {
      d.lineupOrderOrSet = { onlyInRecord: recIds.filter(id => !cacheIds.includes(id)), onlyInCache: cacheIds.filter(id => !recIds.includes(id)), sameSetDifferentOrder: recIds.length === cacheIds.length && recIds.every(id => cacheIds.includes(id)) }
    }
    const fieldDiffs: Record<string, string[]> = {}
    for (const cw of cacheWines) {
      const rw = recWines.find(w => w.id === cw.id)
      if (!rw) continue
      const a = wineNorm(rw), b = wineNorm(cw)
      const fields = Object.keys(a).filter(f => JSON.stringify(a[f]) !== JSON.stringify(b[f]))
      if (fields.length) fieldDiffs[cw.id] = fields
    }
    if (Object.keys(fieldDiffs).length) d.wineFields = fieldDiffs
  }
  // (b) roster, bans, kicked
  const roster = await eligibleRoster(prisma, row)
  const identities = await redis.hGetAll(k.identities(code))
  const recIds = new Set([...roster.eligible.map(e => `u:${e.userId}`), ...roster.tombstones])
  const cacheIds = Object.keys(identities).filter(id => id.startsWith('u:') || id.startsWith('d:'))
  const rosterAdd = [...recIds].filter(id => !(id in identities)).length
  const rosterRemove = cacheIds.filter(id => !recIds.has(id)).length
  if (rosterAdd || rosterRemove) d.roster = { wouldAdd: rosterAdd, wouldRemove: rosterRemove }
  const bans = new Set(await redis.sMembers(k.bans(code)))
  const recBans = new Set(roster.bans)
  const bansAdd = [...recBans].filter(id => !bans.has(id)).length
  const bansRemove = [...bans].filter(id => (id.startsWith('u:') || id.startsWith('d:')) && !recBans.has(id)).length
  if (bansAdd || bansRemove) d.bans = { wouldAdd: bansAdd, wouldRemove: bansRemove }
  const kicked = new Set(await redis.sMembers(k.kicked(code)))
  const recKicked = new Set(roster.kicked.map(id => `u:${id}`))
  const kickedAdd = [...recKicked].filter(id => !kicked.has(id)).length
  const kickedRemove = [...kicked].filter(id => id.startsWith('u:') && recIds.has(id)).length
  if (kickedAdd || kickedRemove) d.kicked = { wouldAdd: kickedAdd, wouldRemove: kickedRemove }
  // (b) rating keys: NX fill of missing ones + value differences on existing ones
  const recRatings = await recordRatings(prisma, row.id, code)
  const keys = new Set(await scanKeys(`s:${code}:r:*`))
  const missing = [...recRatings.keys()].filter(key => !keys.has(key)).length
  let differing = 0
  for (const [key, value] of recRatings) {
    if (!keys.has(key)) continue
    const raw = await redis.get(key)
    if (raw && ratingNorm(JSON.parse(raw)) !== ratingNorm(value)) differing++
  }
  if (missing || differing) d.ratings = { missingKeys: missing, differingValues: differing }
  if (Object.keys(d).length) diffs[code] = d
  // (d)
  let invalid = 0
  for (const id of Object.keys(identities).filter(i => /^u:\d{1,18}$/.test(i))) {
    const g = await readGrant(prisma, code, Number(id.slice(2)))
    if (g && grantStatus(g) === 'invalid') invalid++
  }
  if (invalid) invalidRegistered[code] = invalid
}
out.b_warmSessionsWithDiffs = diffs
out.c_cold = { count: cold.length, codes: cold, futureDateFrom: coldFuture }
out.d_registeredButInvalid = invalidRegistered

// (e)
const orphans = await prisma.$queryRaw<{ session_code: string; n: bigint }[]>`
  SELECT m.session_code, count(*) AS n FROM session_members m
   WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.code = m.session_code AND s.deleted_at IS NULL)
   GROUP BY 1 ORDER BY 1`
out.e_orphanMemberRows = { total: orphans.reduce((a, r) => a + Number(r.n), 0), codes: orphans.length }

// (f)
const since = new Date(Date.now() - 30 * 60 * 1000)
const recent = await prisma.$queryRaw<{ code: string; n: bigint }[]>`
  SELECT s.code, count(*) AS n FROM ratings r JOIN sessions s ON s.id = r.session_id
   WHERE s.deleted_at IS NULL AND coalesce(r.mirror_at, r.rated_at) > ${since} GROUP BY 1 ORDER BY 1`
const recentSeen: Record<string, number> = {}
for (const key of await scanKeys('s:*:lastseen')) {
  const n = Object.values(await redis.hGetAll(key)).filter(v => Number(v) > since.getTime()).length
  if (n) recentSeen[key.split(':')[1]] = n
}
out.f_activeLast30Min = { ratings: Object.fromEntries(recent.map(r => [r.code, Number(r.n)])), lastSeen: recentSeen }

console.log(JSON.stringify(out, null, 2))
await redis.quit()
await prisma.$disconnect()
