// scripts/seed-guest-shown.mts on THROWAWAY stores (release 0.2.0 runbook 2.3 / 4.18 c).
// A guest-only moment (no record) and a Postgres-backed one, each with a cached guest list: a guest from before
// the release (not in `shown`) is added; a guest who joined on the new code (already in `shown`) stays; banned,
// kicked and signed-in identities are never added; the TTL follows the guest list's; a second run adds nothing;
// a moment whose lock is held is reported busy and left alone (exit 1, re-run).
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://127.0.0.1:<throwaway> npx tsx scripts/tests/seed-guest-shown.mts
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from 'redis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DB = process.env.DATABASE_URL, RURL = process.env.REDIS_URL
if (!DB || !RURL || !/127\.0\.0\.1|localhost/.test(DB + RURL)) { console.error('needs DATABASE_URL and REDIS_URL of THROWAWAY local stores'); process.exit(2) }
const t = new globalThis.URL(DB), expect = `${t.hostname}/${t.pathname.slice(1)}`
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`); if (!ok) failed++ }
const run = (...a: string[]) => {
  const r = spawnSync('npx', ['tsx', 'scripts/seed-guest-shown.mts', ...a], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_CONNECTION_LIMIT: '2' } })
  let out: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any -- the script's JSON
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') } catch { /* below */ }
  return { status: r.status, out, stderr: r.stderr }
}
const redis = createClient({ url: RURL }); await redis.connect()
if ((await redis.dbSize()) !== 0) { console.error('the Redis must be EMPTY (throwaway)'); process.exit(2) }
const db = new pg.Client({ connectionString: DB }); await db.connect()
const TTL = 3_600_000
async function moment(code: string, createdAt: number, ids: Record<string, string>, extra: { shown?: string[]; bans?: string[]; kicked?: string[] } = {}) {
  await redis.set(`s:${code}:meta`, JSON.stringify({ name: 'seed fixture', createdAt, host: 'Host' }), { PX: TTL })
  await redis.hSet(`s:${code}:identities`, ids); await redis.pExpire(`s:${code}:identities`, TTL)
  if (extra.shown?.length) { await redis.sAdd(`s:${code}:shown`, extra.shown); await redis.pExpire(`s:${code}:shown`, TTL) }
  if (extra.bans?.length) await redis.sAdd(`s:${code}:bans`, extra.bans)
  if (extra.kicked?.length) await redis.sAdd(`s:${code}:kicked`, extra.kicked)
}
const A = 'SEEDAAAA', B = 'SEEDBBBB', C = 'SEEDCCCC'
await moment(A, Date.now(), { 'a:old': 'Olga', 'a:new': 'Nina', 'a:ban': 'Ben', 'a:kick': 'Kim', 'u:9': 'Ursula' },
  { shown: ['a:new'], bans: ['a:ban'], kicked: ['a:kick'] })
const u = (await db.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id
const created = new Date(Date.now() - 60_000)
await db.query(`INSERT INTO sessions (code, host_name, name, host_user_id, created_at) VALUES ($1, 'Host', 'seed fixture', $2, $3)`, [B, u, created])
await moment(B, created.getTime(), { 'a:b1': 'Bea', [`u:${u}`]: 'Host' })
const members = async (c: string) => (await redis.sMembers(`s:${c}:shown`)).sort()

const d1 = run()
check('dry run exits 0', d1.status === 0, d1.stderr)
check('dry run: 2 moments, 2 guests to add (the old guest of each)', d1.out.moments === 2 && d1.out.toAdd === 2, d1.out)
check('dry run writes nothing', JSON.stringify(await members(A)) === '["a:new"]' && (await members(B)).length === 0)
check('codes never in the JSON', !JSON.stringify(d1.out).includes('SEED'), d1.out)
check('--apply without --expect-db refuses (usage)', run('--apply').status === 2)
const a = run('--apply', '--expect-db', expect)
check('--apply exits 0', a.status === 0, a.stderr)
check('🔒 the old guest is shown, the new one stays, banned / kicked / signed-in are not added', JSON.stringify(await members(A)) === '["a:new","a:old"]', await members(A))
check('🔒 the moment with a record: its guest shown, its host not', JSON.stringify(await members(B)) === '["a:b1"]', await members(B))
const st = Number(await redis.pTTL(`s:${B}:shown`)), it = Number(await redis.pTTL(`s:${B}:identities`))
check('the shown set carries the guest list\'s TTL', st > 0 && Math.abs(st - it) < 5000, { st, it })
check('--apply reports what it added', a.out.added === 2, a.out)
const d2 = run()
check('a second run has nothing to add', d2.out.toAdd === 0, d2.out)
// a moment busy (a join holds its lock): left alone, reported, exit 1
await moment(C, Date.now(), { 'a:c1': 'Cleo' })
await redis.set(`lock:session:${C}`, 'someone-else', { PX: 60_000 })
const b = run('--apply', '--expect-db', expect)
check('🔒 a busy moment is left alone and reported (exit 1, re-run)', b.status === 1 && b.out.busy === 1 && (await members(C)).length === 0, b)
await redis.del(`lock:session:${C}`)
const c = run('--apply', '--expect-db', expect)
check('the re-run seeds it', c.status === 0 && JSON.stringify(await members(C)) === '["a:c1"]', c)
await redis.flushDb(); await redis.quit(); await db.end()
console.log(failed ? `\n${failed} FAILED` : '\nall passed'); process.exit(failed ? 1 : 0)
