// One-shot backfill: the live lineup ORDER (Redis) → wines.position, for live
// Postgres-backed sessions whose positions were never written
// (docs/dev/proposals/redis-rehydration.md § 4.6).
//
// Release A added wines.position and every wine-list mirror writes it for the
// whole lineup; a session with no list write since then still has every
// position NULL, so a rebuild (release B) orders its lineup by created_at
// instead of the order the host arranged — which in a blind moment renumbers
// "Wine N". Redis still holds the real order for a WARM session; for a cold
// one it is gone (reported, not recoverable).
//
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-lineup-positions.mts          # dry run
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/backfill-lineup-positions.mts --apply  # write
//
// Same discipline as scripts/backfill-session-meta.mts: per session, lock the
// row FOR UPDATE and read the Redis lineup UNDER that lock — every lineup
// mirror (release A's and B's) takes the same row lock, so a concurrent list
// write either lands first (its positions are set → skipped here) or after
// (and overwrites these with the newer order). Writes only when EVERY wine of
// the session has a NULL position and the record's wines are exactly the Redis
// lineup's (the all-set-or-all-NULL invariant); anything else is reported and
// skipped. Positions are 0-based, as mirrorLineup writes them. Idempotent.
import { prisma } from '../lib/prisma.ts'
import { redis, k } from '../lib/redis.ts'
import type { SessionMeta, WineMeta } from '../lib/session.ts'

const apply = process.argv.includes('--apply')
const live = await prisma.$queryRaw<{ code: string }[]>`
  SELECT code FROM sessions WHERE deleted_at IS NULL AND code IS NOT NULL ORDER BY code`

const counts = { live: live.length, filled: 0, winesFilled: 0, alreadyPositioned: 0, noWines: 0, cold: 0, mismatch: 0, otherIncarnation: 0, gone: 0 }
const coldUnpositioned: string[] = []
const mismatched: string[] = []
for (const { code } of live) {
  const r = await prisma.$transaction(async (tx) => {
    const row = (await tx.$queryRaw<{ id: number; created_at: Date | null }[]>`
      SELECT id, created_at FROM sessions WHERE code = ${code} AND deleted_at IS NULL FOR UPDATE`)[0]
    if (!row) return { o: 'gone' as const }
    const rec = await tx.$queryRaw<{ id: string; position: number | null }[]>`
      SELECT id, position FROM wines WHERE session_id = ${row.id}`
    if (!rec.length) return { o: 'noWines' as const }
    if (rec.some(w => w.position !== null)) return { o: 'alreadyPositioned' as const }
    const [metaRaw, winesRaw] = await Promise.all([redis.get(k.meta(code)), redis.get(k.wines(code))])
    if (!metaRaw || !winesRaw) return { o: 'cold' as const }
    if (!row.created_at || (JSON.parse(metaRaw) as SessionMeta).createdAt !== row.created_at.getTime()) return { o: 'otherIncarnation' as const }
    const lineup = (JSON.parse(winesRaw) as WineMeta[]).map(w => w.id)
    const recIds = new Set(rec.map(w => w.id))
    if (lineup.length !== recIds.size || new Set(lineup).size !== lineup.length || !lineup.every(id => recIds.has(id))) return { o: 'mismatch' as const }
    if (apply) {
      await tx.$executeRaw`
        UPDATE wines AS w SET position = (v.ord - 1)::int
          FROM unnest(${lineup}::text[]) WITH ORDINALITY AS v(id, ord)
         WHERE w.id = v.id AND w.session_id = ${row.id} AND w.position IS NULL`
    }
    return { o: 'filled' as const, n: lineup.length }
  })
  counts[r.o]++
  if (r.o === 'filled') { counts.winesFilled += r.n; console.log(`${apply ? 'positioned' : 'would position'} ${code} (${r.n} wines)`) }
  if (r.o === 'cold') coldUnpositioned.push(code)
  if (r.o === 'mismatch') { mismatched.push(code); console.warn(`skipped ${code}: the record's wines are not exactly the live lineup`) }
  if (r.o === 'otherIncarnation') console.warn(`skipped ${code}: Redis meta belongs to another incarnation`)
}

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts, mismatched }))
if (coldUnpositioned.length) {
  console.log(`${coldUnpositioned.length} cold session(s) have no position recorded and no Redis lineup left — a rebuild orders them by created_at: ${coldUnpositioned.join(' ')}`)
}
await redis.quit()
await prisma.$disconnect()
