// Pre-merge check for the public-user-ids migration (docs/dev/proposals/
// public-user-ids.md § 3; runbook docs/dev/deployment.md § Public user ids).
//
//   npx tsx scripts/public-ids-precheck.mts
//
// READ-ONLY. The migration adds CHECKs on `session_bans.identity_id` and
// `wines.added_by_identity_id` that accept only the internal identity shapes
// (`u:<digits>`, case-insensitive `a:` / `d:` uuids; lib/identity.ts
// isValidIdentityId). A nonconforming row fails the migration (and the deploy,
// P3009). Promotion copies the Redis bans sets and wine adders into those
// columns as-is (lib/session.ts), so the Redis values are counted too.
// Prints counts only, never a value. Exit 0 = all zero, 1 = something to fix
// (`nonCanonicalUserIdentities` is information only and never fails it).
import { createPrismaClient } from './lib/prismaClient.mjs'
import { createClient } from 'redis'

// Exactly the migration's CHECK: `u:` case-sensitive (`~`), `a:` / `d:` uuids
// case-insensitive (`~*`).
const VALID_U = /^u:\d+$/
const VALID_AD = /^[ad]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validU = (id: string) => VALID_U.test(id) || VALID_AD.test(id)
// Informational: a `u:` the CHECK accepts but that is not a canonical user id
// (a leading zero, or beyond int4). It fails nothing; after the deploy it is
// read as "not a user" and dropped from every list (lib/publicIds.ts).
const nonCanonicalU = (id: string) => VALID_U.test(id) && !(/^u:[1-9]\d{0,9}$/.test(id) && Number(id.slice(2)) <= 2147483647)
const NON_CANONICAL_SQL = (col: string) => `CASE WHEN ${col} ~ '^u:[1-9][0-9]{0,9}$' THEN substring(${col} from 3)::bigint > 2147483647 ELSE ${col} ~ '^u:[0-9]+$' END`

const prisma = createPrismaClient()
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()
try {
  const [bans] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM session_bans
    WHERE NOT (identity_id ~ '^u:[0-9]+$' OR identity_id ~* '^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR identity_id ~* '^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`
  const [wines] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM wines
    WHERE added_by_identity_id IS NOT NULL
      AND NOT (added_by_identity_id ~ '^u:[0-9]+$' OR added_by_identity_id ~* '^a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR added_by_identity_id ~* '^d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`
  const [nc] = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT (SELECT COUNT(*) FROM session_bans WHERE ${NON_CANONICAL_SQL('identity_id')})::int
         + (SELECT COUNT(*) FROM wines WHERE added_by_identity_id IS NOT NULL AND ${NON_CANONICAL_SQL('added_by_identity_id')})::int AS n`)
  let redisBans = 0, redisAdders = 0, scanned = 0, redisNonCanonical = 0
  for await (const keys of redis.scanIterator({ MATCH: 's:*:bans', COUNT: 500 })) {
    for (const key of ([] as string[]).concat(keys)) {
      scanned++
      for (const m of await redis.sMembers(key)) { if (!validU(m)) redisBans++; else if (nonCanonicalU(m)) redisNonCanonical++ }
    }
  }
  for await (const keys of redis.scanIterator({ MATCH: 's:*:wines', COUNT: 500 })) {
    for (const key of ([] as string[]).concat(keys)) {
      scanned++
      const raw = await redis.get(key)
      for (const w of (raw ? JSON.parse(raw) : []) as { addedByIdentityId?: string | null }[]) {
        if (w.addedByIdentityId && !validU(w.addedByIdentityId)) redisAdders++
        else if (w.addedByIdentityId && nonCanonicalU(w.addedByIdentityId)) redisNonCanonical++
      }
    }
  }
  const out = { sessionBansRows: bans?.n ?? 0, winesRows: wines?.n ?? 0, redisBanMembers: redisBans, redisWineAdders: redisAdders, redisKeysScanned: scanned, nonCanonicalUserIdentities: (nc?.n ?? 0) + redisNonCanonical }
  console.log(JSON.stringify(out))
  process.exitCode = out.sessionBansRows + out.winesRows + out.redisBanMembers + out.redisWineAdders === 0 ? 0 : 1
} finally {
  await prisma.$disconnect()
  await redis.quit()
}
