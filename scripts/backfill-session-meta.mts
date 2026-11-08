// One-shot backfill: Redis meta → the session columns release A added
// (docs/dev/proposals/redis-rehydration.md § 4.2, R1-11).
//
// Release A added sessions.lifespan / hide_lineup / hide_lineup_minutes_before /
// show_provenance. For every session that was LIVE when it deployed, those
// columns are NULL while Redis still holds the real values — and a later
// rebuild (release B) would read NULL as "shown", exposing a lineup the host
// hid. Run this ONCE right after release A deploys, while Redis is still warm,
// and again (dry-run) to re-validate immediately before release B.
//
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-session-meta.mts          # dry run
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-session-meta.mts --apply  # write
//
// Same runner as the planned operator script (§ 7): a checkout + tsx against the
// target database and Redis, importing lib/ directly (one mapping —
// sessionSettingsColumns — not a second implementation).
//
// Per live Postgres-backed session: lock the row FOR UPDATE, read its Redis meta
// UNDER that lock, write the four columns only where they differ. Reading under
// the lock is what makes a concurrent settings save safe: that save writes Redis
// first and its Postgres mirror waits on the same row lock, so whichever
// Postgres write lands last carries the newer Redis value. Idempotent: a re-run
// changes nothing and says so.
import { prisma } from '../lib/prisma.ts'
import { redis, k } from '../lib/redis.ts'
import { sessionSettingsColumns, type SessionMeta } from '../lib/session.ts'

const apply = process.argv.includes('--apply')

type Row = { code: string }
const live = await prisma.$queryRaw<Row[]>`
  SELECT code FROM sessions WHERE deleted_at IS NULL AND code IS NOT NULL ORDER BY code`

const counts = { live: live.length, changed: 0, unchanged: 0, cold: 0, otherIncarnation: 0, gone: 0 }
for (const { code } of live) {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: number; created_at: Date | null }[]>`
      SELECT id, created_at FROM sessions WHERE code = ${code} AND deleted_at IS NULL FOR UPDATE`
    const row = rows[0]
    if (!row) return 'gone' as const
    const raw = await redis.get(k.meta(code))
    if (!raw) return 'cold' as const
    const meta = JSON.parse(raw) as SessionMeta
    if (!row.created_at || meta.createdAt !== row.created_at.getTime()) return 'otherIncarnation' as const
    const { lifespan, hideLineup, hideLineupMinutesBefore, showProvenance } = sessionSettingsColumns(meta)
    const differs = await tx.$queryRaw<{ x: number }[]>`
      SELECT 1 AS x FROM sessions
       WHERE id = ${row.id}
         AND (lifespan, hide_lineup, hide_lineup_minutes_before, show_provenance)
             IS DISTINCT FROM (${lifespan}::varchar, ${hideLineup}::boolean, ${hideLineupMinutesBefore}::int, ${showProvenance}::boolean)`
    if (!differs[0]) return 'unchanged' as const
    if (apply) {
      await tx.$executeRaw`
        UPDATE sessions
           SET lifespan = ${lifespan}, hide_lineup = ${hideLineup},
               hide_lineup_minutes_before = ${hideLineupMinutesBefore}, show_provenance = ${showProvenance}
         WHERE id = ${row.id}`
    }
    return 'changed' as const
  })
  counts[outcome]++
  if (outcome === 'changed') console.log(`${apply ? 'updated' : 'would update'} ${code}`)
  if (outcome === 'otherIncarnation') console.warn(`skipped ${code}: Redis meta belongs to another incarnation`)
}

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts }))
console.log(counts.cold > 0
  ? `${counts.cold} live session(s) had no Redis meta — their columns stay NULL (defaults); nothing to recover from Redis.`
  : 'every live session had Redis meta.')
await redis.quit()
await prisma.$disconnect()
