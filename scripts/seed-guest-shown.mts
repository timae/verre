// Moment Visibility go-live: the guests already in a live moment are SHOWN to people looking in, like every
// guest who joins on the new code (docs/dev/proposals/moment-visibility.md § 5, ruled: the same default as
// everyone; release 0.2.0 runbook 4.18 c). A join on the new code adds its guest to s:{CODE}:shown when it mints
// the identity; guests who joined on the previous release are in no such set, so they would be counted, never
// named. This adds them, once.
//
//   DATABASE_URL=… REDIS_URL=… [DATABASE_CONNECTION_LIMIT=2] npx tsx scripts/seed-guest-shown.mts                       # dry run
//   DATABASE_URL=… REDIS_URL=… npx tsx scripts/seed-guest-shown.mts --apply --expect-db <host>/<database>              # write
//
// 🔒 RUN ONLY after no old instance is left (an old instance's join adds nobody) and while MOMENT_LOOKIN_ENABLED is
// still OFF (the guest's own switch is behind it, so nobody can have hidden yet: this never re-shows a guest who
// hid). The runbook checks the flag first (the visibility GET as a member answers 404).
//
// Every moment with a cached guest list (s:{CODE}:identities): under that moment's session mutation contract with
// its fenced Redis lock (lib/sessionMutation.ts; the lock a join and the guest's switch take), the guest (`a:`)
// identities minus the banned and the kicked, not yet in `shown`, are SADDed in one fenced step, with the guest
// list's TTL (the join's rule). Nothing in Postgres is written (the advisory lock and the row are only held).
// A moment whose lock is busy is left alone and counted (exit 1: run again). The dry run reads without locks.
// stdout: one JSON object (counts only: a code is a join credential). stderr: the targets.
// Exit 0 = ran, 1 = refused, error or a busy moment, 2 = usage.
import { redis, k, scanKeys } from '../lib/redis.ts'
import { withSessionMutation, ContractBusy, ContractGone } from '../lib/sessionMutation.ts'
import { argValue, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'

const SCRIPT = 'seed-guest-shown'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectDb = argValue(args, '--expect-db')
if (args.some(a => !new Set(['--apply', '--expect-db', expectDb]).has(a)) || expectDb === null || (apply && !expectDb)) {
  console.error(`usage: ${SCRIPT}.mts [--apply --expect-db <host>/<database>]`)
  process.exit(2)
}
if (!process.env.REDIS_URL) { console.error(`${SCRIPT}: REDIS_URL is not set in the environment`); process.exit(2) }
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb!)
console.error(`${SCRIPT}: redis ${new URL(process.env.REDIS_URL).host}`)

// The guests to add, read through `c` (the fence's client under the lock, or the shared client for the dry run).
async function plan(c: typeof redis, code: string): Promise<{ add: string[]; ttl: number }> {
  const [ids, bans, kicked, shown, ttl] = await Promise.all([
    c.hKeys(k.identities(code)), c.sMembers(k.bans(code)), c.sMembers(k.kicked(code)), c.sMembers(k.shown(code)), c.pTTL(k.identities(code))])
  const skip = new Set([...bans, ...kicked, ...shown])
  return { add: ids.filter(id => id.startsWith('a:') && !skip.has(id)).sort(), ttl: Number(ttl) }
}

const out = { mode: apply ? 'apply' : 'dry-run', moments: 0, withGuestsToAdd: 0, toAdd: 0, added: 0, busy: 0, gone: 0, errors: 0 }
let code = ''
try {
  if (apply) {
    const { prisma } = await import('../lib/prisma.ts')
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    if (db !== target.db) throw new Error(`connected to ${db}, not ${target.db}`)
  }
  const codes = (await scanKeys('s:*:identities')).map(key => key.slice(2, -':identities'.length)).sort()
  out.moments = codes.length
  for (code of codes) {
    if (!apply) {
      const p = await plan(redis, code)
      if (p.add.length) { out.withGuestsToAdd++; out.toAdd += p.add.length }
      continue
    }
    try {
      const n = await withSessionMutation(code, { label: SCRIPT, redisLock: { waitMs: 2000 }, readMeta: 'optional' }, async (_tx, ctx) => {
        const f = ctx.fence!
        const p = await plan(f.client as typeof redis, code)
        if (!p.add.length) return 0
        await f.exec(m => {
          m.sAdd(k.shown(code), p.add)
          if (p.ttl > 0) m.pExpire(k.shown(code), p.ttl)
        })
        return p.add.length
      })
      if (n) { out.withGuestsToAdd++; out.toAdd += n; out.added += n }
    } catch (e) {
      if (e instanceof ContractBusy) out.busy++
      else if (e instanceof ContractGone) out.gone++
      else { out.errors++; console.error(`${SCRIPT}: a moment failed: ${(e as Error)?.constructor?.name ?? 'Error'}`) } // the class only: messages carry the code
    }
  }
} catch (e) {
  out.errors++
  console.error(`${SCRIPT}: ${errText(e)}`)
} finally {
  const { prisma } = await import('../lib/prisma.ts')
  await prisma.$disconnect()
  await redis.quit().catch(() => {})
}
if (out.busy) console.error(`${SCRIPT}: ${out.busy} moment(s) busy (someone was joining or changing it): run again`)
if (out.busy || out.errors) process.exitCode = 1
console.log(JSON.stringify(out))
