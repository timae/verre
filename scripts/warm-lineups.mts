// The line-up warm-up (catalogue model change step 3; release runbook step 8
// item 6, after the rollout has finished and the step-2 backfills re-ran).
// The code does not depend on it: a NULL `sessions.lineup_revision` means "not
// reconciled" and the first contract or read that meets it reconciles
// (lib/occurrences.ts reconcileLineup). This only does that ahead of the first
// poll, and reports what a human has to look at.
//
//   DATABASE_URL=… REDIS_URL=… [DATABASE_CONNECTION_LIMIT=2] npx tsx scripts/warm-lineups.mts             # dry run
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/warm-lineups.mts --apply --expect-db <host>/<database>        # write
//
// Every live Postgres-backed moment with a cached line-up (meta + wines in
// Redis) is classified:
//   unreconciled  revision NULL: lists what the reconciliation does: the cached
//                 bottles the record lacks (copied in), the record's bottles the
//                 cache does not list (ORPHANED: session_id NULL, ratings kept;
//                 a DELETE whose old mirror failed left them, or a bottle a
//                 Redis failover lost: Simon reads each before the push, spec
//                 § 8a), and bottles whose content differs (the cache wins).
//                 --apply runs exactly that, under the session mutation
//                 contract, then stamps 1 and re-projects (the read's own path,
//                 refreshLineup).
//   stale         revision set, the cache not stamped with it: the next read
//                 replaces it from the record. Listed only.
//   residual      stamped equal, content differs: the rollout residual (an old
//                 instance's best-effort mirror failed after a new one stamped
//                 the moment). Listed for a human, never changed here.
//   ok            stamped equal, the same line-up.
// Cold moments (no cache) are counted: nothing to reconcile, the rebuild stamps
// them. Bottle names are listed (bottles, not people); never a person's name.
// Also reported: cached ids another row of the record holds (`toRemint`: they
// get fresh ids, their rating keys follow), cached bottles carrying an inline
// photo (`inlinePhotos`: a legacy upload that failed; never in the record, so
// every projection drops it, as the rebuild always did), and soft-deleted
// moments still carrying a revision (an OLD instance's scrub during the rollout
// did not know the column): --apply NULLs those.
import { prisma } from '../lib/prisma.ts'
import { redis, k } from '../lib/redis.ts'
import { recordLineup, parseLineup, foreignIds } from '../lib/occurrences.ts'
import { refreshLineup } from '../lib/sessionRehydrate.ts'
import type { WineMeta } from '../lib/session.ts'
import { argValue, checkApplyTarget, targetFromEnv } from './lib/operatorGuard.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectDb = argValue(args, '--expect-db')
const known = new Set(['--apply', '--expect-db', expectDb])
if (args.some(a => !known.has(a)) || (apply && !expectDb)) {
  console.error('usage: warm-lineups.mts [--apply --expect-db <host>/<database>]')
  process.exit(2)
}
const target = targetFromEnv('warm-lineups')
if (apply) {
  checkApplyTarget('warm-lineups', target, expectDb!)
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== target.db) { console.error(`warm-lineups: connected to ${db}, not ${target.db}`); process.exit(1) }
}

const CONTENT = ['name', 'producer', 'vintage', 'grape', 'type', 'imageUrl', 'description', 'region', 'country',
  'vinification', 'purchaseUrl', 'revealedAt', 'productId', 'vintageId'] as const
const norm = (w: WineMeta, f: typeof CONTENT[number]) => {
  const v = w[f] ?? null
  if (v === '') return null
  if (f === 'revealedAt' && typeof v === 'string') return Date.parse(v)
  return v
}
const differing = (rec: WineMeta[], cache: WineMeta[]) => {
  const out: { id: string; name: string; fields: string[] }[] = []
  for (const c of cache) {
    const r = rec.find(x => x.id === c.id)
    if (!r) continue
    const fields = CONTENT.filter(f => JSON.stringify(norm(r, f)) !== JSON.stringify(norm(c, f)))
    if (fields.length) out.push({ id: c.id, name: c.name, fields })
  }
  return out
}

const live = await prisma.$queryRaw<{ id: number; code: string; lineup_revision: number | null }[]>`
  SELECT id, code, lineup_revision FROM sessions WHERE deleted_at IS NULL AND code IS NOT NULL ORDER BY code`
const report: Record<string, unknown> = {}
const counts = { live: live.length, cold: 0, ok: 0, stale: 0, residual: 0, unreconciled: 0, reconciled: 0, busy: 0, failed: 0 }
for (const s of live) {
  const [meta, raw, wrev] = await redis.mGet([k.meta(s.code), k.wines(s.code), k.wrev(s.code)])
  if (!meta || !raw) { counts.cold++; continue }
  const cache = parseLineup(raw)
  if (cache === null) {
    // An unusable cached blob: nothing is orphaned or copied from it; the
    // reconciliation stamps 1 from the record and replaces the blob.
    const entry: Record<string, unknown> = { class: s.lineup_revision === null ? 'unreconciled' : 'stale', unusableCache: true }
    if (s.lineup_revision === null) {
      counts.unreconciled++
      if (apply) {
        try { const r = await refreshLineup(s.code); entry.applied = typeof r === 'object' ? 'reconciled' : r; if (typeof r === 'object') counts.reconciled++; else if (r === 'busy') counts.busy++ }
        catch (err) { counts.failed++; entry.applied = `failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    } else counts.stale++
    report[s.code] = entry
    continue
  }
  const rec = await recordLineup(prisma, s.id)
  const recIds = new Set(rec.map(w => w.id)), cacheIds = new Set(cache.map(w => w.id))
  if (s.lineup_revision === null) {
    counts.unreconciled++
    const foreign = await foreignIds(prisma as never, s.id, cache.map(w => w.id))
    const ratingCount = async (id: string) => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ratings WHERE wine_id = ${id}`)[0].n)
    const toOrphan = await Promise.all(rec.filter(w => !cacheIds.has(w.id)).map(async w => ({ id: w.id, name: w.name, ratings: await ratingCount(w.id) })))
    const entry: Record<string, unknown> = {
      class: 'unreconciled',
      toCopy: cache.filter(w => !recIds.has(w.id) && !foreign.has(w.id)).map(w => ({ id: w.id, name: w.name })),
      toRemint: cache.filter(w => foreign.has(w.id)).map(w => ({ id: w.id, name: w.name })),
      toOrphan,
      contentFromCache: differing(rec, cache),
      inlinePhotos: cache.filter(w => typeof w.image === 'string' && w.image.startsWith('data:')).length,
    }
    if (apply) {
      try {
        const r = await refreshLineup(s.code)
        entry.applied = typeof r === 'object' ? 'reconciled' : r
        if (typeof r === 'object') counts.reconciled++
        else if (r === 'busy') counts.busy++
      } catch (err) {
        counts.failed++
        entry.applied = `failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    report[s.code] = entry
    continue
  }
  if (wrev !== String(s.lineup_revision)) { counts.stale++; report[s.code] = { class: 'stale', revision: s.lineup_revision, stamp: wrev }; continue }
  const order = rec.map(w => w.id).join() !== cache.map(w => w.id).join()
  const fields = differing(rec, cache)
  if (order || fields.length) {
    counts.residual++
    report[s.code] = {
      class: 'residual', revision: s.lineup_revision,
      onlyInRecord: rec.filter(w => !cacheIds.has(w.id)).map(w => ({ id: w.id, name: w.name })),
      onlyInCache: cache.filter(w => !recIds.has(w.id)).map(w => ({ id: w.id, name: w.name })),
      orderDiffers: order, fields,
    }
    continue
  }
  counts.ok++
}
const [{ n: tomb }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM sessions WHERE deleted_at IS NOT NULL AND lineup_revision IS NOT NULL`
const tombstonesWithRevision = { found: Number(tomb), cleared: 0 }
if (apply && Number(tomb) > 0) {
  tombstonesWithRevision.cleared = await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE deleted_at IS NOT NULL AND lineup_revision IS NOT NULL`
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', counts, tombstonesWithRevision, moments: report }, null, 2))
await redis.quit()
await prisma.$disconnect()
