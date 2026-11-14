// Usernames, the web half (docs/dev/proposals/usernames.md § 5 + § 12): the
// `/@<name>` rewrite against the BUILT server, which no route-module test can
// see (next.config.ts rewrites run in the router, in front of every page).
//   § 1 `/@name`, `/@Name` and the encoded `/%40name` open the profile, exactly
//       like `/u/<publicId>`; no redirect either way
//   § 2 malformed, unknown, renamed away, held, a deeper path → 404
//   § 3 an operator-assigned RESERVED name opens through both forms
//   § 4 with the limiter spent neither web entry runs the target lookup
//
// Needs a production build (`npm run build`) and a throwaway Postgres + Redis:
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/usernames-web.mts [--next-start]
//
// Default: `node .next/standalone/server.js`, what the image runs
// (`output: 'standalone'`). `--next-start` runs `next start` instead.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureUsername, reservedFixtureUsername } from './lib/fixtureUsername.mjs'

const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const useNextStart = process.argv.includes('--next-start')
const standalone = join(ROOT, '.next', 'standalone', 'server.js')
if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no production build: run `npm run build` first')
if (!useNextStart && !existsSync(standalone)) throw new Error('no .next/standalone/server.js: run `npm run build` (output: standalone), or pass --next-start')

const { prisma } = await import('../../lib/prisma.ts')
const { redis } = await import('../../lib/redis.ts')
const { changeUsername, releaseUsernameHold } = await import('../../lib/username.ts')
const { isReservedUsername } = await import('../../packages/core/src/username.ts')
const { Client } = await import('pg')

let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})

const port = await freePort()
const BASE = `http://127.0.0.1:${port}`
const env = { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', AUTH_URL: BASE, AUTH_TRUST_HOST: 'true' }
let server: ChildProcess | null = null
let log = ''
const TAG = `unweb-${Date.now()}`
// Each request names its own address, so every check has its own budget (the
// limiter is per address) and § 4 can spend one without touching the rest.
let ipSeq = 0
const get = (path: string, ip = `203.0.113.${++ipSeq}`) => fetch(`${BASE}${path}`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } })
const page = async (path: string, ip?: string) => { const r = await get(path, ip); return { status: r.status, text: await r.text(), location: r.headers.get('location') } }

try {
  server = useNextStart
    ? spawn('npx', ['next', 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('node', [standalone], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout?.on('data', d => { log += String(d) })
  server.stderr?.on('data', d => { log += String(d) })
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    if (server.exitCode !== null) throw new Error(`the server exited (${server.exitCode}):\n${log.slice(-2000)}`)
    up = await fetch(`${BASE}/login`, { redirect: 'manual' }).then(r => r.status < 500, () => false)
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`the server did not come up:\n${log.slice(-2000)}`)
  console.log(`\nserver: ${useNextStart ? 'next start' : 'node .next/standalone/server.js'} on ${BASE}`)

  // Display names no other page prints, so finding one proves WHICH profile rendered.
  const mk = async (name: string, username: string | null, data: Record<string, unknown> = {}) => {
    const row = await prisma.user.create({ data: { name, email: `${TAG}-${name.replace(/\W/g, '').toLowerCase()}@example.test`, profileVisibility: 'public-internet', ...data }, select: { id: true, publicId: true } })
    if (username) { const r = await changeUsername(row.id, username, { skipQuota: true }); if (r.status !== 'ok') throw new Error(`fixture username refused: ${r.status}`) }
    return { ...row, name, username }
  }
  const stamp = Date.now().toString(36)
  const P = await mk(`Pia Public ${stamp}`, fixtureUsername('web'))
  const S = await mk(`Sol Shell ${stamp}`, fixtureUsername('web'), { profileVisibility: 'public-mutual' })
  const brand = reservedFixtureUsername()
  await releaseUsernameHold(brand)   // a leftover hold from an earlier run on a persistent database
  const B = await mk(`Verre Brand ${stamp}`, brand)
  const R = await mk(`Ren Renamed ${stamp}`, fixtureUsername('web'))
  const renamedAway = R.username!
  await changeUsername(R.id, fixtureUsername('web'), { skipQuota: true })

  console.log('\n§ 1 /@name opens the profile')
  const byId = await page(`/u/${P.publicId.toLowerCase()}`)
  check('/u/<publicId> renders the profile (the baseline)', byId.status === 200 && byId.text.includes(P.name), byId.status)
  const at = await page(`/@${P.username}`)
  check('🔒 /@name renders the same profile, with no redirect', at.status === 200 && at.text.includes(P.name) && at.location === null, { status: at.status, location: at.location })
  const upper = await page(`/@${P.username!.toUpperCase()}`)
  check('/@Name (any case) opens it too', upper.status === 200 && upper.text.includes(P.name), upper.status)
  const encoded = await page(`/%40${P.username}`)
  check('🔒 the encoded form /%40name opens it too', encoded.status === 200 && encoded.text.includes(P.name), encoded.status)
  const shell = await page(`/@${S.username}`)
  check('a non-public profile, logged out: the name-only shell, as on /u/<id>', shell.status === 200 && shell.text.includes(S.name), shell.status)
  check('/u/<id> does not redirect to /@name', byId.location === null)
  const direct = await page(`/u/by-username/${P.username}`)
  check('the rewrite\'s target also answers directly (/u/by-username/<name>): the same page, a third spelling, left as is', direct.status === 200 && direct.text.includes(P.name), direct.status)

  console.log('\n§ 2 everything else is a 404')
  const expect404 = async (label: string, path: string) => { const r = await page(path); check(`${label} → 404`, r.status === 404 && !r.text.includes(P.name), { path, status: r.status }) }
  await expect404('a deeper path', `/@${P.username}/x`)
  await expect404('too short', '/@ab')
  await expect404('two dots', '/@a..b')
  await expect404('a second @', `/@@${P.username}`)
  await expect404('an unknown name', `/@${fixtureUsername('none')}`)
  await expect404('🔒 a renamed-away (held) name: no redirect to the new one', `/@${renamedAway}`)
  await expect404('a public id in the username slot', `/@${P.publicId.toLowerCase()}`)
  await expect404('a username in the id slot', `/u/${P.username}`)

  console.log('\n§ 3 a reserved name an operator assigned')
  const b1 = await page(`/@${brand}`), b2 = await page(`/%40${brand}`)
  check('🔒 opens through both web forms (reads are format-only)', isReservedUsername(brand) && b1.status === 200 && b1.text.includes(B.name) && b2.status === 200 && b2.text.includes(B.name), [b1.status, b2.status])

  console.log('\n§ 4 a spent limiter runs no lookup')
  // `users` is locked exclusively: any read of it would hang. Logged out, so
  // resolving the caller reads nothing; with the budget spent both entries
  // must answer (404) at once.
  const ip = '198.51.100.77'
  const locker = new Client({ connectionString: DB })
  await locker.connect()
  try {
    await redis.set(`rl:profile:${ip}:1m`, '60', { EX: 60 })
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')
    const answered = await Promise.race([Promise.all([page(`/@${P.username}`, ip), page(`/u/${P.publicId.toLowerCase()}`, ip)]), sleep(4000).then(() => null)])
    check('🔒 with the limiter spent both entries answer 404 without touching `users`', !!answered && answered.every(r => r.status === 404), answered?.map(r => r.status))
    check('…and both charged the SAME key (rl:profile:<ip>:1m)', Number(await redis.get(`rl:profile:${ip}:1m`)) === 62)
    // Control: a fresh address has budget, so the lookup runs and waits on the lock.
    const waiting = page(`/@${P.username}`, '198.51.100.78')
    const stuck = await Promise.race([waiting.then(() => false), sleep(1500).then(() => true)])
    check('…control: with budget left the lookup runs (it waits on the locked table)', stuck)
    await locker.query('ROLLBACK')
    check('…and renders once the lock is gone', (await waiting).status === 200)
  } finally { await locker.query('ROLLBACK').catch(() => {}); await locker.end() }

  await prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${`${TAG}-%`}`
} catch (err) {
  failed++
  console.log(`  ❌ the suite crashed: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  // By PID (never a pattern kill).
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(r => server!.once('exit', r)), sleep(5000)]) }
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
  process.exit(failed > 0 ? 1 : 0)
}
