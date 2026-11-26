// scripts/moment-visibility-golive.mjs on a THROWAWAY migrated database (release 0.2.0 runbook 2.4).
// Fixtures: the two states an old instance can leave during the rolling switch (a tombstone its scrub left
// with the seven Moment Visibility values; a guest-hosted moment at the open default) beside rows that must not
// change (a live hosted moment, a live [deleted]-host one, a clean tombstone). Then: dry run reports them and
// writes nothing; --apply fixes exactly them; a second dry run reports 0; a wrong --expect-db and an edited
// migration file refuse.
//   DATABASE_URL=postgres://…/<throwaway> npx tsx scripts/tests/moment-visibility-golive.mts
import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const URL_ = process.env.DATABASE_URL
if (!URL_ || !/127\.0\.0\.1|localhost/.test(URL_)) { console.error('needs DATABASE_URL of a THROWAWAY local database'); process.exit(2) }
const target = new globalThis.URL(URL_), expect = `${target.hostname}/${target.pathname.slice(1)}`
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`); if (!ok) failed++ }
const run = (...a: string[]) => {
  const r = spawnSync('node', ['scripts/moment-visibility-golive.mjs', ...a], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: URL_ } })
  let out: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any -- the script's JSON
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') } catch { /* below */ }
  return { status: r.status, out, stderr: r.stderr }
}
const db = new pg.Client({ connectionString: URL_ }); await db.connect()
const SEVEN = ['visibility', 'include_guest_circles', 'show_place', 'show_details', 'link_version', 'link_active', 'link_since']
const ins = async (hostUserId: number | null, hostName: string) => (await db.query(
  `INSERT INTO sessions (code, host_name, name, host_user_id, created_at) VALUES ($1, $2, 'golive fixture', $3, now()) RETURNING id`,
  [`GL${Math.random().toString(36).slice(2, 10).toUpperCase()}`, hostName, hostUserId])).rows[0].id as number
const u = (await db.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0]?.id
if (!u) { console.error('the database needs one users row'); process.exit(2) }
const hosted = await ins(u, 'Host'), guest = await ins(null, 'Guest Host'), deletedHost = await ins(null, '[deleted]')
const leftTomb = await ins(u, 'Host'), cleanTomb = await ins(u, 'Host')
// an old instance's scrub: deleted_at set, every OLD column NULL, the seven MV columns left as they were
await db.query(`UPDATE sessions SET deleted_at = now(), code = NULL, host_name = NULL, name = NULL, host_user_id = NULL WHERE id = $1`, [leftTomb])
await db.query(`UPDATE sessions SET deleted_at = now(), code = NULL, host_name = NULL, name = NULL, host_user_id = NULL, ${SEVEN.map(c => `${c} = NULL`).join(', ')} WHERE id = $1`, [cleanTomb])
// an old instance's promotion that wrote the open default (the trigger closes inserts; this is the belt)
await db.query(`UPDATE sessions SET visibility = 'friends' WHERE id = ANY($1::int[])`, [[guest, deletedHost]])
const row = async (id: number) => (await db.query(`SELECT * FROM sessions WHERE id = $1`, [id])).rows[0]
const rows = async (ids: number[]) => { const o = []; for (const id of ids) o.push(await row(id)); return o }
const before = await rows([hosted, guest, deletedHost, leftTomb, cleanTomb])
check('fixture: the left tombstone carries values, the guest-hosted row is open', before[3].visibility === 'friends' && before[1].visibility === 'friends')

const d1 = run()
check('dry run exits 0', d1.status === 0, d1.stderr)
check('dry run counts the guest-hosted row not at members (and not the [deleted] one)', d1.out.report?.hostlessOpen === 1, d1.out)
check('dry run counts the tombstone left with values (not the clean one)', d1.out.report?.tombstonesWithValues === 1, d1.out)
check('dry run counts the live [deleted]-host moments, codes on stderr only', d1.out.report?.deletedHostLive === 1 && !JSON.stringify(d1.out).includes('GL') && /GL[0-9A-Z]{8}/.test(d1.stderr), d1)
check('dry run writes nothing', JSON.stringify(await rows([hosted, guest, deletedHost, leftTomb, cleanTomb])) === JSON.stringify(before))
const w = run('--apply', '--expect-db', 'nope/nope')
check('--apply with a wrong --expect-db refuses', w.status === 1)
const a = run('--apply', '--expect-db', expect)
check('--apply exits 0', a.status === 0, a.stderr)
const after = await rows([hosted, guest, deletedHost, leftTomb, cleanTomb])
check('🔒 the left tombstone: the seven columns NULL', SEVEN.every(c => after[3][c] === null), after[3])
check('🔒 the guest-hosted moment: members', after[1].visibility === 'members', after[1])
check('🔒 the [deleted]-host moment keeps its value, the hosted one too', after[2].visibility === 'friends' && after[0].visibility === before[0].visibility)
check('the clean tombstone and the public ids untouched', JSON.stringify(after[4]) === JSON.stringify(before[4]) && after.every((r, i) => r.public_id === before[i].public_id))
const d2 = run()
check('a second dry run reports 0 to change', d2.out.report?.hostlessOpen === 0 && d2.out.report?.tombstonesWithValues === 0, d2.out)
// an edited migration file refuses (restored after)
const MIG = join(ROOT, 'prisma/migrations/20261115120000_moment_visibility/migration.sql'), BAK = `${MIG}.golive-test-bak`
copyFileSync(MIG, BAK)
try {
  writeFileSync(MIG, readFileSync(MIG, 'utf8') + '\n-- edited\n')
  const e = run()
  check('🔒 an edited migration file refuses (not the file the database applied)', e.status === 1 && /sha256/.test(e.stderr), e.stderr)
} finally { copyFileSync(BAK, MIG); spawnSync('rm', ['-f', BAK]) }
await db.end()
console.log(failed ? `\n${failed} FAILED` : '\nall passed'); process.exit(failed ? 1 : 0)
