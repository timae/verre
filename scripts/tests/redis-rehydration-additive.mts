// Redis rehydration — release A ("additive") integration suite.
// docs/dev/proposals/redis-rehydration.md § 9, the subset that holds without
// any rebuild: mirror completeness, the mirror token, tombstones, the
// one-transaction account deletion (incl. worker kill and Redis-unreachable
// schedules), the old-writer compatibility case and the delete registry.
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only: it deletes rate-limit keys and the
// keys of the sessions it creates, and refuses to run against the dev database.
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/redis-rehydration-additive.mts
//
// Orchestration rule for "A pauses, B proceeds" (§ 9): pause A at a hook while
// it holds its locks, start B, ASSERT B IS BLOCKED, release A, then await B.
// Worker-kill schedules run the deletion in a child process (this file with
// --worker) and SIGKILL it at a hook; assertions run here, in a separate
// process, so no cleanup of the dead worker can help it.
import { spawn } from 'node:child_process'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '../../lib/prisma.ts'
import { redis, k, scanKeys } from '../../lib/redis.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pjoin(HERE, '..', '..')
const SELF = fileURLToPath(import.meta.url)

// Route handlers run outside Next's request scope, where NextAuth's auth()
// (lib/resolveUser.ts's web branch) cannot read headers(). Logged-in actors
// here authenticate through the REAL Better Auth branch; only cookie-less
// callers reach auth(), which then returns null — the stub does exactly that.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: pathToFileURL(pjoin(HERE, 'stubs', 'nextauth-anonymous.mts')).href, shortCircuit: true }
    return next(specifier, context)
  },
})

// ── Worker mode (child process) ─────────────────────────────────────────────
if (process.argv[2] === '--worker') {
  const cfg = JSON.parse(process.argv[3]) as { userId: number; pauseAt?: string; native?: boolean }
  const { deleteAccountDurable, executeAccountDelete, AccountDeleteRetryableError } = await import('../../lib/accountDelete.ts')
  const signal = `test:worker:${cfg.userId}`
  const pause = async (label: string) => {
    if (cfg.pauseAt !== label) return
    // Signal through Postgres (the parent's Redis may be the one this child
    // cannot reach), then hang until SIGKILL.
    await prisma.$executeRawUnsafe(`NOTIFY test_worker, '${signal}:${label}'`)
    await new Promise(() => {})
  }
  try {
    const run = cfg.native ? executeAccountDelete : deleteAccountDurable
    await run(cfg.userId, { hooks: {
      afterLocks: () => pause('afterLocks'),
      afterSession: () => pause('afterSession'),
      beforeUserDelete: () => pause('beforeUserDelete'),
    } })
    console.log(JSON.stringify({ ok: true }))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ ok: false, retryable: err instanceof AccountDeleteRetryableError, message: (err as Error).message }))
    process.exit(3)
  }
}

// ── Guards ──────────────────────────────────────────────────────────────────
const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required (Better Auth)')

const { betterAuthServer } = await import('../../lib/betterAuth.ts')
const { syncCredential } = await import('../../lib/identityStore.ts')
const sessionRoute = await import('../../app/api/session/route.ts')
const codeRoute = await import('../../app/api/session/[code]/route.ts')
const joinRoute = await import('../../app/api/session/join/route.ts')
const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
const reorderRoute = await import('../../app/api/session/[code]/wines/reorder/route.ts')
const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const unbanRoute = await import('../../app/api/session/[code]/bans/[identityId]/route.ts')
const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const accountRoute = await import('../../app/api/me/account/route.ts')
const { deleteAccountDurable, migrateTombstonedSession, D_MIGRATION_SCRIPT, AccountDeleteTooManyWipesError, AccountDeleteRetryableError } = await import('../../lib/accountDelete.ts')
const { sessionWipe } = await import('../../lib/sessionWipe.ts')
const { reassignProvenance } = await import('../../lib/session.ts')
const { acquireSessionLock, releaseSessionLock } = await import('../../lib/sessionLock.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TAG = `rehyd-${Date.now()}`
const created: string[] = []
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }

type Actor = { cookie?: string; anon?: string }
type User = { id: number; cookie: string; email: string; password: string }
const BASE = 'http://localhost:3000'

function request(method: string, path: string, actor: Actor = {}, body?: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (actor.cookie) headers.cookie = actor.cookie
  if (actor.anon) headers['x-vr-anon-token'] = actor.anon
  return new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}) {
  const res = await (handler as Handler)(request(method, path, actor, body), { params: Promise.resolve(params) })
  let json: unknown = null
  try { json = await res.json() } catch {}
  return { status: res.status, json: json as Record<string, unknown> }
}

let userSeq = 0
async function mkUser(name: string, opts: { webPassword?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const password = `pw-${TAG}-${userSeq}`
  await betterAuthServer.api.signUpEmail({ body: { name, email, password } })
  const { headers } = await betterAuthServer.api.signInEmail({ body: { email, password }, returnHeaders: true })
  const cookie = (headers.get('set-cookie') ?? '').split(';')[0]
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  if (opts.webPassword) await syncCredential(row.id, await bcrypt.hash(password, 4))
  return { id: row.id, cookie, email, password }
}
const dateFrom = new Date(Date.now() + 3600_000).toISOString()

async function createSession(actor: Actor, extra: Record<string, unknown> = {}) {
  await resetLimits()
  const r = await call(sessionRoute.POST, 'POST', '/api/session', actor, { hostDisplayName: 'Hana Host', sessionName: `${TAG} moment`, dateFrom, ...extra })
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
  created.push(r.json.code as string)
  return { code: r.json.code as string, anon: r.json.anonToken as string | undefined, id: r.json.id as string }
}
async function join(code: string, actor: Actor, displayName = 'Joiner') {
  await resetLimits()
  const r = await call(joinRoute.POST, 'POST', '/api/session/join', actor, { code, displayName })
  return { status: r.status, anon: r.json?.anonToken as string | undefined, id: r.json?.id as string }
}
const visit = (code: string, actor: Actor) => call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, actor, {}, { code })
async function addWine(code: string, actor: Actor, name: string, position?: number) {
  const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, { name, type: 'red', ...(position ? { position } : {}) }, { code })
  if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id as string
}
const rate = (code: string, actor: Actor, wineId: string, score = 4) =>
  call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, { wineId, score, flavors: {}, notes: 'nice wine' }, { code })
const setRole = (code: string, actor: Actor, targetId: string, role: string) =>
  call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, actor, { action: 'set-role', targetId, role }, { code })
const ban = (code: string, actor: Actor, identityId: string, mode: 'kick' | 'ban', deleteAddedWines = false) =>
  call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, actor, { identityId, mode, deleteAddedWines }, { code })

const liveRow = async (code: string) =>
  (await prisma.$queryRaw<{ id: number; lifespan: string | null; hide_lineup: boolean | null; hide_lineup_minutes_before: number | null; show_provenance: boolean | null; host_user_id: number | null; host_name: string | null; created_at: Date }[]>`
    SELECT id, lifespan, hide_lineup, hide_lineup_minutes_before, show_provenance, host_user_id, host_name, created_at
      FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0]
const redisWines = async (code: string) => JSON.parse((await redis.get(k.wines(code))) ?? '[]') as { id: string; addedByIdentityId?: string; addedByDisplayName?: string }[]
async function positionsMatch(code: string): Promise<boolean> {
  const row = await liveRow(code)
  const pg = await prisma.$queryRaw<{ id: string; position: number | null }[]>`SELECT id, position FROM wines WHERE session_id = ${row.id}`
  const arr = await redisWines(code)
  const byId = new Map(pg.map(w => [w.id, w.position]))
  return arr.length === pg.length && arr.every((w, i) => byId.get(w.id) === i)
}

// A durable-state fingerprint for "byte-for-byte unchanged" (auth_sessions and
// BA's Redis copies are excluded on purpose: native revocation is the pre-step
// that commits before the account transaction — revoke-first, documented).
async function fingerprint(userId: number, codes: string[]): Promise<string> {
  const sids = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM sessions WHERE code = ANY(${codes}::text[])`).map(r => r.id)
  const [users, ratings, wines, sessions, members, bans, tombs] = await Promise.all([
    prisma.$queryRaw`SELECT id, name, email FROM users WHERE id = ${userId}`,
    prisma.$queryRaw`SELECT id, user_id, session_id, rater_name, tombstone_key, score::text, notes FROM ratings WHERE user_id = ${userId} OR session_id = ANY(${sids}::int[]) ORDER BY id`,
    prisma.$queryRaw`SELECT id, session_id, added_by_identity_id, added_by_display_name, position FROM wines WHERE session_id = ANY(${sids}::int[]) OR added_by_identity_id = ${`u:${userId}`} ORDER BY id`,
    prisma.$queryRaw`SELECT id, code, host_user_id, host_name, deleted_at, lifespan FROM sessions WHERE id = ANY(${sids}::int[]) ORDER BY id`,
    prisma.$queryRaw`SELECT user_id, session_code, role, removed_state FROM session_members WHERE session_code = ANY(${codes}::text[]) ORDER BY 1, 2`,
    prisma.$queryRaw`SELECT session_code, identity_id FROM session_bans WHERE session_code = ANY(${codes}::text[]) ORDER BY 1, 2`,
    prisma.$queryRaw`SELECT code, created_at FROM session_tombstones WHERE code = ANY(${codes}::text[]) ORDER BY 1, 2`,
  ])
  return JSON.stringify({ users, ratings, wines, sessions, members, bans, tombs })
}

function runWorker(cfg: { userId: number; pauseAt?: string; native?: boolean }, env: Record<string, string> = {}) {
  // ONE process: `node --import tsx`, not the tsx CLI (which spawns a second
  // node and would take the SIGKILL itself while the real worker lived on).
  const child = spawn(process.execPath, ['--import', 'tsx', SELF, '--worker', JSON.stringify(cfg)], {
    cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', () => {})
  const exited = new Promise<{ code: number | null; out: string }>(res => child.on('exit', code => res({ code, out })))
  return { child, exited }
}
// Armed BEFORE the worker is spawned: LISTEN is established and the handler
// attached first, so a notification the worker sends immediately is not lost.
async function listenFor(signal: string) {
  const { Client } = await import('pg')
  const c = new Client({ connectionString: DB })
  let hit = false
  let wake: () => void = () => {}
  c.on('notification', n => { if (n.payload === signal) { hit = true; wake() } })
  await c.connect()
  await c.query('LISTEN test_worker')
  return {
    wait: async (ms = 30_000) => {
      try {
        if (!hit) await new Promise<void>(res => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res() } })
        return hit
      } finally { await c.end() }
    },
  }
}
// Resolves true if `p` is still pending after `ms`.
async function stillPending(p: Promise<unknown>, ms = 600): Promise<boolean> {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  await sleep(ms)
  return !settled
}
function gate() { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }
// "B is blocked" means a backend of this database is waiting on a LOCK while B
// is still pending — not merely that time passed.
async function lockWaiters(): Promise<number> {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
  return Number(n)
}
async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!(await stillPending(p, 100))) return false
    if ((await lockWaiters()) > 0) return await stillPending(p, 100)
  }
  return false
}
// The session advisory locks (hashtext('session:' || code)) still held or awaited.
async function advisoryHolders(codes: string[]): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l
     WHERE l.locktype = 'advisory' AND l.objsubid = 1
       AND l.objid::bigint = ANY(SELECT (hashtext('session:' || c)::bigint & 4294967295) FROM unnest(${codes}::text[]) AS c)`
  return rows.map(r => r.pid)
}

// ── § 1 Mirror completeness ─────────────────────────────────────────────────
async function mirrors() {
  section('§ 1 mirror completeness — wines, positions, members, bans, columns')
  const H = await mkUser('Host H')
  await prisma.user.update({ where: { id: H.id }, data: { pro: true } })
  const s = await createSession({ cookie: H.cookie }, { hideLineup: true, hideLineupMinutesBefore: 30 })
  let row = await liveRow(s.code)
  check('logged-in create writes lifespan + hide-lineup columns', row?.lifespan === 'unlimited' && row.hide_lineup === true && row.hide_lineup_minutes_before === 30, row)

  const A = await join(s.code, {}, 'Anon A')
  check('anon joined', A.status === 200 && !!A.anon)
  check('anon made provider', (await setRole(s.code, { cookie: H.cookie }, A.id, 'provider')).status === 200)
  const w1 = await addWine(s.code, { anon: A.anon }, 'Anon wine')
  check('ANONYMOUS add to a Postgres-backed session is mirrored', !!(await prisma.wine.findUnique({ where: { id: w1 } })))
  const w2 = await addWine(s.code, { cookie: H.cookie }, 'Second')
  const w3 = await addWine(s.code, { cookie: H.cookie }, 'Inserted first', 1)
  check('mid-list insert renormalizes every position', await positionsMatch(s.code) && (await redisWines(s.code))[0].id === w3)
  const r = await call(reorderRoute.POST, 'POST', `/api/session/${s.code}/wines/reorder`, { cookie: H.cookie }, { orderedIds: [w1, w2, w3] }, { code: s.code })
  check('reorder renormalizes', r.status === 200 && await positionsMatch(s.code))
  const e = await call(wineRoute.PATCH, 'PATCH', `/api/session/${s.code}/wines/${w2}`, { cookie: H.cookie }, { name: 'Renamed', type: 'red' }, { code: s.code, wineId: w2 })
  check('edit mirrors content', e.status === 200 && (await prisma.wine.findUnique({ where: { id: w2 } }))?.name === 'Renamed')
  const d = await call(wineRoute.DELETE, 'DELETE', `/api/session/${s.code}/wines/${w2}`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w2 })
  check('delete removes the row and renormalizes the survivors', d.status === 200 && !(await prisma.wine.findUnique({ where: { id: w2 } })) && await positionsMatch(s.code))
  // Release B: the rate's FK row is written inside its contract from the array
  // read under the locks — a rate on the deleted wine is refused and resurrects nothing.
  check('a rate after the delete does not resurrect the wine (R1 finding 1)', (await rate(s.code, { cookie: H.cookie }, w2)).status === 404 && !(await prisma.wine.findUnique({ where: { id: w2 } })))

  const J = await mkUser('Joiner J')
  const jr = await join(s.code, { cookie: J.cookie }, 'Taster J')
  check('/join-only logged-in member has a row', !!(await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: J.id, sessionCode: s.code } } })), jr)
  const R = await mkUser('Rater R')
  await join(s.code, { cookie: R.cookie }, 'Taster R')
  // Release B: admission is the record's — a historical RATER without a member
  // row is admitted as an author (a registration with neither is 'invalid', Q2).
  await rate(s.code, { cookie: R.cookie }, w3)
  await prisma.sessionMember.deleteMany({ where: { userId: R.id, sessionCode: s.code } })
  const rr = await rate(s.code, { cookie: R.cookie }, w1)
  check('/rate by a member-less historical rater writes the member row', (rr.status === 200 || (console.log(rr), false)) && !!(await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: R.id, sessionCode: s.code } } })))

  // § 1b mirror token
  const ratingRow = (await prisma.$queryRaw<{ id: number; ms: number }[]>`
    SELECT id, floor(extract(epoch from mirror_at) * 1000)::float8 AS ms FROM ratings WHERE user_id = ${R.id} AND wine_id = ${w1}`)[0]
  const at = JSON.parse((await redis.get(k.rating(s.code, `u:${R.id}`, w1)))!).at
  check('rate POST: mirror_at equals the Redis `at` token', ratingRow && ratingRow.ms === at, { ms: ratingRow?.ms, at })
  const feed = await prisma.feedItem.findFirst({ where: { userId: R.id, kind: 'session' }, select: { id: true } })
  const pr = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${feed!.id}`, { cookie: R.cookie }, { wineId: w1, score: 3 }, { id: String(feed!.id) })
  const ratingRow2 = (await prisma.$queryRaw<{ ms: number; score: string }[]>`
    SELECT floor(extract(epoch from mirror_at) * 1000)::float8 AS ms, score::text AS score FROM ratings WHERE id = ${ratingRow.id}`)[0]
  const at2 = JSON.parse((await redis.get(k.rating(s.code, `u:${R.id}`, w1)))!).at
  check('check-in PATCH: one statement, mirror_at equals the Redis `at` token', pr.status === 200 && ratingRow2.ms === at2 && Number(ratingRow2.score) === 3 && at2 > at, { pr: pr.status, ratingRow2, at2 })

  // § 1b2 a wine DELETE whose Postgres mirror failed, then another list write:
  // positions stay unique and all set; the stale row is not removed (owner
  // ruling — see mirrorLineup)
  const wd1 = await addWine(s.code, { cookie: H.cookie }, 'Doomed by a failed mirror')
  await redis.set(k.wines(s.code), JSON.stringify((await redisWines(s.code)).filter(w => w.id !== wd1)), { XX: true, KEEPTTL: true })   // Redis delete; its mirror "failed"
  const wd2 = await addWine(s.code, { cookie: H.cookie }, 'Added after')
  const sid = (await liveRow(s.code)).id
  const pos = await prisma.$queryRaw<{ id: string; position: number | null }[]>`SELECT id, position FROM wines WHERE session_id = ${sid} ORDER BY position`
  const arr = await redisWines(s.code)
  check('after a failed delete mirror, the next list write keeps positions unique, all set, array order first',
    pos.every(p => p.position !== null) && new Set(pos.map(p => p.position)).size === pos.length
    && arr.every((w, i) => pos.find(p => p.id === w.id)?.position === i)
    && pos.find(p => p.id === wd1)?.position === arr.length && arr.some(w => w.id === wd2), { pos, arr: arr.map(w => w.id) })
  await call(wineRoute.DELETE, 'DELETE', `/api/session/${s.code}/wines/${wd2}`, { cookie: H.cookie }, undefined, { code: s.code, wineId: wd2 })
  await prisma.$executeRaw`DELETE FROM wines WHERE id = ${wd1}`

  // § 1c bans
  check('ban writes a session_bans row', (await ban(s.code, { cookie: H.cookie }, `u:${J.id}`, 'ban')).status === 200
    && !!(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: s.code, identityId: `u:${J.id}` } } })))
  const held = (await acquireSessionLock(s.code))!
  const busy = await call(unbanRoute.DELETE, 'DELETE', `/api/session/${s.code}/bans/u%3A${J.id}`, { cookie: H.cookie }, undefined, { code: s.code, identityId: `u%3A${J.id}` })
  await releaseSessionLock(s.code, held)
  check('unban serializes on the session lock (promotion holds it while copying bans)', busy.status === 409, busy)
  const ub = await call(unbanRoute.DELETE, 'DELETE', `/api/session/${s.code}/bans/u%3A${J.id}`, { cookie: H.cookie }, undefined, { code: s.code, identityId: `u%3A${J.id}` })
  check('unban removes the row, then the Redis entry', ub.status === 200
    && !(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: s.code, identityId: `u:${J.id}` } } }))
    && !(await redis.sIsMember(k.bans(s.code), `u:${J.id}`)))

  // § 1d ban-wipe as the first list mutation after deploy (positions all NULL)
  const A2 = await join(s.code, {}, 'Anon A2')
  await setRole(s.code, { cookie: H.cookie }, A2.id, 'provider')
  const wA2 = await addWine(s.code, { anon: A2.anon }, 'A2 wine')
  await prisma.$executeRaw`UPDATE wines SET position = NULL WHERE session_id = ${row.id}`
  const bw = await ban(s.code, { cookie: H.cookie }, A2.id, 'ban', true)
  const orphan = await prisma.wine.findUnique({ where: { id: wA2 }, select: { sessionId: true } })
  check('ban-wipe with deleteAddedWines renormalizes the survivors', bw.status === 200 && orphan?.sessionId === null && await positionsMatch(s.code))
  check('anonymous ban in a Postgres-backed session has its row', !!(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: s.code, identityId: A2.id } } })))

  // § 1e settings mirror
  const st = await call(settingsRoute.PATCH, 'PATCH', `/api/session/${s.code}/settings`, { cookie: H.cookie }, { showProvenance: false, lifespan: '1w' }, { code: s.code })
  row = await liveRow(s.code)
  check('settings PATCH mirrors show_provenance + lifespan', st.status === 200 && row.show_provenance === false && row.lifespan === '1w', { st: st.status, row })

  // § 1f promotion copies lineup + bans
  const anonHost = await createSession({})
  const pa = await addWine(anonHost.code, { anon: anonHost.anon }, 'Pre-promotion 1')
  const pb = await addWine(anonHost.code, { anon: anonHost.anon }, 'Pre-promotion 2')
  const B = await join(anonHost.code, {}, 'Anon B')
  await ban(anonHost.code, { anon: anonHost.anon }, B.id, 'ban')
  check('anonymous-only session has no row and no ban row', !(await liveRow(anonHost.code)) && (await prisma.sessionBan.count({ where: { sessionCode: anonHost.code } })) === 0)
  const V = await mkUser('Visitor V')
  await join(anonHost.code, { cookie: V.cookie }, 'Taster V')
  check('logged-in /join does NOT promote', !(await liveRow(anonHost.code)))
  await visit(anonHost.code, { cookie: V.cookie })
  const prow = await liveRow(anonHost.code)
  check('promotion (logged-in visit) copies the lineup with positions', !!prow && await positionsMatch(anonHost.code)
    && !!(await prisma.wine.findUnique({ where: { id: pa } })) && !!(await prisma.wine.findUnique({ where: { id: pb } })))
  check('promotion copies the Redis bans set', !!(await prisma.sessionBan.findUnique({ where: { sessionCode_identityId: { sessionCode: anonHost.code, identityId: B.id } } })))
  check('promotion writes the columns from meta (lifespan)', prow?.lifespan === '48h', prow)
  check('promotion writes the visitor member row', !!(await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: V.id, sessionCode: anonHost.code } } })))
  return { H, s, A }
}

// ── § 2 Backfill script ─────────────────────────────────────────────────────
async function backfill(code: string) {
  section('§ 2 backfill-session-meta.mts')
  await prisma.$executeRaw`UPDATE sessions SET lifespan = NULL, hide_lineup = NULL, hide_lineup_minutes_before = NULL, show_provenance = NULL WHERE code = ${code}`
  const run = async (args: string[]) => {
    const { exited } = (() => {
      const child = spawn(pjoin(REPO, 'node_modules', '.bin', 'tsx'), [pjoin(REPO, 'scripts', 'backfill-session-meta.mts'), ...args], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += String(d) })
      return { exited: new Promise<{ code: number | null; out: string }>(res => child.on('exit', c => res({ code: c, out }))) }
    })()
    const { code: exit, out } = await exited
    const line = out.split('\n').find(l => l.startsWith('{"mode"'))
    return { exit, report: line ? JSON.parse(line) : null }
  }
  const dry = await run([])
  check('dry run reports the session, writes nothing', dry.exit === 0 && dry.report?.changed >= 1 && (await liveRow(code)).lifespan === null, dry)
  const apply = await run(['--apply'])
  const row = await liveRow(code)
  const meta = JSON.parse((await redis.get(k.meta(code)))!)
  check('--apply projects meta into the new columns', apply.exit === 0 && row.lifespan === meta.lifespan && row.hide_lineup === meta.hideLineup
    && row.hide_lineup_minutes_before === meta.hideLineupMinutesBefore && row.show_provenance === meta.showProvenance, { row, meta })
  const again = await run(['--apply'])
  check('re-running is a no-op', again.exit === 0 && again.report?.changed === 0, again.report)
}

// ── § 3 Registry ────────────────────────────────────────────────────────────
async function registry(H: User, code: string) {
  section('§ 3 delete registry (session_tombstones)')
  const row = await liveRow(code)
  const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, { cookie: H.cookie }, undefined, { code })
  const t = await prisma.sessionTombstone.findUnique({ where: { code_createdAt: { code, createdAt: row.created_at } } })
  check('session DELETE writes the registry row and removes the session_bans rows', del.status === 200 && !!t && (await prisma.sessionBan.count({ where: { sessionCode: code } })) === 0)
  const anon = await createSession({})
  const meta = JSON.parse((await redis.get(k.meta(anon.code)))!)
  const d2 = await call(codeRoute.DELETE, 'DELETE', `/api/session/${anon.code}`, { anon: anon.anon }, undefined, { code: anon.code })
  check('anonymous-only (no row) DELETE writes the registry row too', d2.status === 200
    && !!(await prisma.sessionTombstone.findUnique({ where: { code_createdAt: { code: anon.code, createdAt: new Date(meta.createdAt) } } })))
}

// ── § 4 Account deletion ────────────────────────────────────────────────────
async function accountDeletion() {
  section('§ 4 account deletion — one transaction, tombstones, provenance')
  const Hx = await mkUser('Other host')
  const O = await mkUser('Other rater')
  const X = await mkUser('Doomed X', { webPassword: true })
  const SA = await createSession({ cookie: Hx.cookie })
  const SB = await createSession({ cookie: Hx.cookie })
  const SC = await createSession({ cookie: Hx.cookie })
  const wa = await addWine(SA.code, { cookie: Hx.cookie }, 'SA wine')
  const wb = await addWine(SB.code, { cookie: Hx.cookie }, 'SB wine')
  const wc = await addWine(SC.code, { cookie: Hx.cookie }, 'SC wine')
  for (const S of [SA, SB, SC]) { await join(S.code, { cookie: X.cookie }, 'Taster X'); await visit(S.code, { cookie: X.cookie }) }
  await setRole(SA.code, { cookie: Hx.cookie }, `u:${X.id}`, 'provider')
  const wx = await addWine(SA.code, { cookie: X.cookie }, 'Brought by X')
  await rate(SA.code, { cookie: X.cookie }, wa)
  await rate(SB.code, { cookie: X.cookie }, wb)
  await rate(SC.code, { cookie: X.cookie }, wc)
  await ban(SC.code, { cookie: Hx.cookie }, `u:${X.id}`, 'kick')
  const SE = await createSession({ cookie: X.cookie })
  const we = await addWine(SE.code, { cookie: X.cookie }, 'SE wine')
  await rate(SE.code, { cookie: X.cookie }, we)
  const SF = await createSession({ cookie: X.cookie })
  const wf = await addWine(SF.code, { cookie: X.cookie }, 'SF wine')
  await join(SF.code, { cookie: O.cookie }, 'Taster O'); await visit(SF.code, { cookie: O.cookie })
  await rate(SF.code, { cookie: O.cookie }, wf)
  // images on the new hard-delete paths (kicked-session rating, empty-session host rating)
  const scRating = await prisma.rating.findFirstOrThrow({ where: { userId: X.id, wineId: wc } })
  const seRating = await prisma.rating.findFirstOrThrow({ where: { userId: X.id, wineId: we } })
  await prisma.$executeRaw`INSERT INTO rating_images (rating_id, image_url, sort_order) VALUES (${scRating.id}, 'https://img.test/sc.jpg', 0), (${seRating.id}, 'https://img.test/se.jpg', 0)`
  const codes = [SA.code, SB.code, SC.code, SE.code, SF.code]
  const before = await fingerprint(X.id, codes)
  const xRatings = (await prisma.rating.findMany({ where: { userId: X.id }, select: { id: true, sessionId: true } }))

  // (a) failure AFTER the first session's durable statements → nothing changed
  const reclaimed: string[] = []
  let first = ''
  let threw: unknown = null
  try {
    await deleteAccountDurable(X.id, { hooks: {
      afterSession: async (code) => { if (!first) { first = code; throw new Error('injected failure after the first session') } },
      onReclaim: (u) => reclaimed.push(u),
    } })
  } catch (err) { threw = err }
  check('injected failure after S1 fails the whole deletion', !!threw && !!first)
  check('…and every durable reference is byte-for-byte unchanged', (await fingerprint(X.id, codes)) === before)
  check('…and nothing was reclaimed', reclaimed.length === 0)

  // the user acts again before the retry
  await rate(SA.code, { cookie: X.cookie }, wx)

  // (b) retry through the FULL request (password re-auth, native revoke, the transaction)
  await resetLimits()
  const del = await call(accountRoute.DELETE, 'DELETE', '/api/me/account', { cookie: X.cookie }, { password: X.password })
  check('full-request retry completes', del.status === 200, del)
  check('user row is gone', !(await prisma.user.findUnique({ where: { id: X.id } })))
  const after = await prisma.rating.findMany({ where: { id: { in: xRatings.map(r => r.id) } }, select: { id: true, sessionId: true, userId: true, tombstoneKey: true, raterName: true } })
  const sa = await liveRow(SA.code), sb = await liveRow(SB.code)
  const keysIn = async (sid: number) => (await prisma.$queryRaw<{ k: string }[]>`SELECT DISTINCT tombstone_key AS k FROM ratings WHERE session_id = ${sid} AND user_id IS NULL`).map(r => r.k)
  const kSA = await keysIn(sa.id), kSB = await keysIn(sb.id)
  check('exactly one d: identity per (user, session), incl. the rating made between attempts', kSA.length === 1 && kSB.length === 1 && kSA[0] !== kSB[0]
    && (await prisma.rating.count({ where: { sessionId: sa.id, tombstoneKey: kSA[0] } })) === 2, { kSA, kSB })
  check('kicked-session ratings are hard-deleted', !after.some(r => r.id === scRating.id))
  check('no session rating is left with neither identity (the release-B CHECK predicate)', (await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM ratings WHERE session_id IS NOT NULL AND user_id IS NULL AND tombstone_key IS NULL`)[0].n === 0n)
  const wxRow = await prisma.wine.findUnique({ where: { id: wx }, select: { addedByIdentityId: true, addedByDisplayName: true } })
  check('provenance rewritten in Postgres', wxRow?.addedByIdentityId === kSA[0] && wxRow?.addedByDisplayName === '[deleted]', wxRow)
  const seGone = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM session_tombstones WHERE code = ${SE.code}`
  check('empty hosted session wiped: soft-deleted, registry row, Redis keys gone', !(await liveRow(SE.code)) && seGone[0].n === 1n && (await scanKeys(`s:${SE.code}:*`)).length === 0)
  const sf = await liveRow(SF.code)
  const sfMeta = JSON.parse((await redis.get(k.meta(SF.code)))!)
  check('engaged hosted session anonymized (record + cache)', sf?.host_user_id === null && sf?.host_name === '[deleted]' && sfMeta.host === '[deleted]' && !sfMeta.hostUserId && !sfMeta.hostIdentityId
    && (await prisma.rating.count({ where: { sessionId: sf!.id, userId: O.id } })) === 1)
  const ids = await redis.hGetAll(k.identities(SA.code))
  const ratingKeys = await scanKeys(`s:${SA.code}:r:*`)
  check('live Redis migrated to the same d: identity (identities, rating keys, wines provenance)',
    !ids[`u:${X.id}`] && ids[kSA[0]] === '[deleted]' && ratingKeys.filter(x => x.includes(`:r:${kSA[0]}:`)).length === 2
    && !ratingKeys.some(x => x.includes(`:r:u:${X.id}:`)) && (await redisWines(SA.code)).find(w => w.id === wx)?.addedByIdentityId === kSA[0], { ids })
  const wg = await call(winesRoute.GET, 'GET', `/api/session/${SA.code}/wines`, { cookie: Hx.cookie }, undefined, { code: SA.code })
  const wire = (wg.json as unknown as { wines?: { id: string; addedByDisplayName: string | null }[] })?.wines ?? (wg.json as unknown as { id: string; addedByDisplayName: string | null }[])
  check('brought-by reads "[deleted]" on the wire (R3-5)', Array.isArray(wire) && wire.find(w => w.id === wx)?.addedByDisplayName === '[deleted]', wg.status)
  const reassign = (wine: Record<string, unknown>) => prisma.$transaction(async (tx) => {
    const ws = await redisWines(SA.code) as unknown as Parameters<typeof reassignProvenance>[2]
    await reassignProvenance(tx, sa.id, ws, wine as unknown as Parameters<typeof reassignProvenance>[3])
  }).then(() => false, () => true)
  await prisma.$executeRaw`UPDATE wines SET session_id = NULL WHERE id = ${wa}`
  check('a reassignment of a wine whose row was orphaned (ban-wipe cleanup failed) is refused, not a silent 200',
    await reassign({ id: wa, name: 'SA wine', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '', addedByIdentityId: `u:${Hx.id}`, addedByDisplayName: 'Other host' }))
  await prisma.$executeRaw`UPDATE wines SET session_id = ${sa.id} WHERE id = ${wa}`
  check('a reassignment to the deleted user is refused (R1 finding 1)', await reassign({ id: wx, name: 'Brought by X', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '', addedByIdentityId: `u:${X.id}`, addedByDisplayName: 'X' }))

  // (c) d: is a kick-delete target only — release B (G4): POST /bans mode 'kick'
  // on a d: runs kick-DELETE; mode 'ban' stays 400; a direct kick-keep throws.
  const banD = await ban(SA.code, { cookie: Hx.cookie }, kSA[0], 'ban')
  check('ban of a d: identity → 400', banD.status === 400)
  check('a direct kick-keep of a d: identity throws', await sessionWipe({ code: SA.code, identityId: kSA[0], scope: 'kick-keep', caller: { id: `u:${Hx.id}`, displayName: '', kind: 'user' }, label: 'test', authorize: () => {} }).then(() => false, () => true))
  check('kick of a d: identity runs kick-delete through the real route', (await ban(SA.code, { cookie: Hx.cookie }, kSA[0], 'kick', true)).status === 200)
  check('kick-delete of a d: identity removes its ratings and keys, never wine provenance',
    (await prisma.rating.count({ where: { tombstoneKey: kSA[0] } })) === 0 && (await scanKeys(`s:${SA.code}:r:${kSA[0]}:*`)).length === 0
    && (await prisma.wine.findUnique({ where: { id: wx } }))?.addedByIdentityId === kSA[0])
}

// ── § 5 Worker kill, Redis-unreachable, post-commit failure, size bound ─────
async function crashAndRedis() {
  section('§ 5 worker kill · Redis unreachable · projection failure · size bound')
  const Hy = await mkUser('Host for crash')
  const SB = await createSession({ cookie: Hy.cookie })
  const wb = await addWine(SB.code, { cookie: Hy.cookie }, 'crash wine')

  // (a) kill the worker after the first session's durable statements
  const Y = await mkUser('Killed worker Y')
  await join(SB.code, { cookie: Y.cookie }, 'Taster Y'); await visit(SB.code, { cookie: Y.cookie }); await rate(SB.code, { cookie: Y.cookie }, wb)
  const SG = await createSession({ cookie: Y.cookie })
  await addWine(SG.code, { cookie: Y.cookie }, 'SG wine')
  const before = await fingerprint(Y.id, [SB.code, SG.code])
  const probe = await listenFor('test:worker:probe')
  await prisma.$executeRawUnsafe(`NOTIFY test_worker, 'test:worker:probe'`)
  check('an immediate notification is captured (LISTEN armed first)', await probe.wait(2000))
  const listener = await listenFor(`test:worker:${Y.id}:afterSession`)
  const w = runWorker({ userId: Y.id, pauseAt: 'afterSession' })
  const paused = await listener.wait()
  const heldWhilePaused = (await advisoryHolders([SB.code, SG.code])).length
  w.child.kill('SIGKILL')
  await w.exited
  let released = false
  for (let i = 0; i < 30 && !released; i++) { released = (await advisoryHolders([SB.code, SG.code])).length === 0; if (!released) await sleep(100) }
  check('worker paused inside the transaction holding its advisory locks, then SIGKILLed', paused && heldWhilePaused > 0, { paused, heldWhilePaused })
  check('…its backend and locks are gone within 3 s', released)
  check('killed worker: every durable reference unchanged (Postgres rolled back)', (await fingerprint(Y.id, [SB.code, SG.code])) === before)
  // Release B: the dead worker's Redis lease on its wipe candidate lives out its
  // 15 s — an immediate retry is told "busy, try again" (retryable, nothing
  // changed); once the lease has expired the retry completes.
  const early = await deleteAccountDurable(Y.id).then(() => null, e => e)
  check('…an immediate retry while the dead worker\'s lease lives is refused retryably', early instanceof AccountDeleteRetryableError && (await fingerprint(Y.id, [SB.code, SG.code])) === before, String(early))
  const { sessionLockKey } = await import('../../lib/sessionLock.ts')
  for (let i = 0; i < 170 && (await redis.exists(sessionLockKey(SG.code))); i++) await sleep(100)
  const retry = await deleteAccountDurable(Y.id)
  check('retry from another worker completes once', !(await prisma.user.findUnique({ where: { id: Y.id } })) && retry.plan.toDelete.includes(SG.code))

  // (b) Redis unreachable, no empty hosted session → PG-only path completes
  const Z1 = await mkUser('Redis-down Z1')
  await join(SB.code, { cookie: Z1.cookie }, 'Taster Z1'); await visit(SB.code, { cookie: Z1.cookie }); await rate(SB.code, { cookie: Z1.cookie }, wb)
  await prisma.$executeRaw`DELETE FROM auth_sessions WHERE user_id = ${Z1.id}`
  const { createConnection } = await import('node:net')
  const ru = new URL(process.env.REDIS_URL!)
  const monitor = createConnection({ host: ru.hostname, port: Number(ru.port || 6379) })
  let seenRaw = ''
  monitor.on('data', d => { seenRaw += String(d) })
  monitor.write('MONITOR\r\n')
  await sleep(200)
  const r1 = runWorker({ userId: Z1.id, native: true }, { REDIS_URL: 'redis://127.0.0.1:1' })
  const out1 = await r1.exited
  await sleep(200)
  monitor.destroy()
  const seen = seenRaw.split('\n')
  check('Redis unreachable, nothing to wipe → deletion completes', out1.code === 0 && !(await prisma.user.findUnique({ where: { id: Z1.id } })), out1.out)
  check('…with no Redis command against the session issued (MONITOR)', !seen.some(l => l.includes(SB.code)))
  check('…and the record holds the tombstone', (await prisma.rating.count({ where: { sessionId: (await liveRow(SB.code)).id, userId: null, tombstoneKey: { not: null } } })) >= 2)

  // (c) Redis unreachable WITH an empty hosted session → retryable, nothing changed
  const Z2 = await mkUser('Redis-down Z2')
  const SZ = await createSession({ cookie: Z2.cookie })
  await prisma.$executeRaw`DELETE FROM auth_sessions WHERE user_id = ${Z2.id}`
  const before2 = await fingerprint(Z2.id, [SZ.code])
  const r2 = runWorker({ userId: Z2.id }, { REDIS_URL: 'redis://127.0.0.1:1' })
  const out2 = await r2.exited
  const res2 = JSON.parse(out2.out.trim().split('\n').pop() || '{}')
  check('Redis unreachable with an empty hosted session → fails retryably', out2.code === 3 && res2.retryable === true, res2)
  check('…and nothing changed', (await fingerprint(Z2.id, [SZ.code])) === before2)

  // (d) native revocation cannot complete: a user WITH a native session, Redis
  // down → the mandatory pre-step fails bounded and retryably, and the durable
  // account cleanup never starts.
  const N = await mkUser('Native N')
  await join(SB.code, { cookie: N.cookie }, 'Taster N'); await visit(SB.code, { cookie: N.cookie }); await rate(SB.code, { cookie: N.cookie }, wb)
  const nativeRows = await prisma.authSession.count({ where: { userId: N.id } })
  const beforeN = await fingerprint(N.id, [SB.code])
  const t0 = Date.now()
  const r3 = runWorker({ userId: N.id, native: true }, { REDIS_URL: 'redis://127.0.0.1:1' })
  const out3 = await r3.exited
  const res3 = JSON.parse(out3.out.trim().split('\n').pop() || '{}')
  check('native revoke with Redis down: bounded, retryable failure', nativeRows > 0 && out3.code === 3 && res3.retryable === true && (Date.now() - t0) < 30_000, { nativeRows, res3 })
  check('…the native session row survives and no durable cleanup started', (await prisma.authSession.count({ where: { userId: N.id } })) === nativeRows
    && (await fingerprint(N.id, [SB.code])) === beforeN)

  // (e) post-commit projection fails → deletion completes; warm repair later
  const P = await mkUser('Projection-fail P')
  await join(SB.code, { cookie: P.cookie }, 'Pauline Real'); await visit(SB.code, { cookie: P.cookie }); await rate(SB.code, { cookie: P.cookie }, wb)
  await setRole(SB.code, { cookie: Hy.cookie }, `u:${P.id}`, 'provider')
  const wp = await addWine(SB.code, { cookie: P.cookie }, 'Brought by Pauline')
  // Both the d: migration AND its invalidation fail (residual (ii)): the cache stays stale.
  const res = await deleteAccountDurable(P.id, { hooks: { failProjection: true, failInvalidation: true } })
  const staleWine = (await redisWines(SB.code)).find(w => w.id === wp)
  const wg = await call(winesRoute.GET, 'GET', `/api/session/${SB.code}/wines`, { cookie: Hy.cookie }, undefined, { code: SB.code })
  const wire = ((wg.json as unknown as { wines?: unknown[] })?.wines ?? wg.json) as unknown as { id: string; addedByDisplayName: string | null; addedByUserId: number | null }[]
  const ww = Array.isArray(wire) ? wire.find(w => w.id === wp) : undefined
  check('projection never ran: the wire still renders "[deleted]" despite stale identities + wine JSON (gone-user guard)',
    staleWine?.addedByIdentityId === `u:${P.id}` && (await redis.hGet(k.identities(SB.code), `u:${P.id}`)) === 'Pauline Real'
    && ww?.addedByDisplayName === '[deleted]' && ww?.addedByUserId === null, { staleWine, ww })
  const sbRow = await liveRow(SB.code)
  const key = res.sessions.find(s => s.code === SB.code)!.key
  check('projection failure: deletion completes, the record is correct', !(await prisma.user.findUnique({ where: { id: P.id } }))
    && (await prisma.rating.count({ where: { sessionId: sbRow.id, tombstoneKey: key } })) === 1)
  check('…the cache is stale (u: entry still there)', !!(await redis.hGet(k.identities(SB.code), `u:${P.id}`)))
  // Release B: a failed projection invalidates (meta DEL + generation bump); the
  // next open rebuilds from the record — reconciliation removes the gone user.
  const { scopedInvalidate } = await import('../../lib/sessionMutation.ts')
  await scopedInvalidate(SB.code, sbRow.created_at.getTime())   // what the invalidation fallback does
  check('…scoped invalidation drops this incarnation\'s meta', !(await redis.get(k.meta(SB.code))))
  await call(winesRoute.GET, 'GET', `/api/session/${SB.code}/wines`, { cookie: Hy.cookie }, undefined, { code: SB.code })
  check('…and the next open rebuilds: the gone user is reconciled away, the d: group projected', !(await redis.hGet(k.identities(SB.code), `u:${P.id}`))
    && (await redis.hGet(k.identities(SB.code), key)) === '[deleted]')
  const tok = (await acquireSessionLock(SB.code))!
  check('…re-running the migration under a lease is a no-op', (await migrateTombstonedSession(P.id, res.sessions.find(s => s.code === SB.code)!, tok)) === 'ok'
    && (await redis.hGet(k.identities(SB.code), key)) === '[deleted]')
  await releaseSessionLock(SB.code, tok)

  // (f0) the bound counts ACTUAL wipe decisions: a hosted session engaged only by
  // an anonymous rating (Redis) is anonymized, so maxWipes 0 does not refuse it
  const Z4 = await mkUser('Bound Z4')
  const SV = await createSession({ cookie: Z4.cookie })
  const wv = await addWine(SV.code, { cookie: Z4.cookie }, 'SV wine')
  const anonV = await join(SV.code, {}, 'Anon rater')
  check('setup: an anonymous rating exists only in Redis', (await rate(SV.code, { anon: anonV.anon }, wv)).status === 200
    && (await prisma.rating.count({ where: { wineId: wv } })) === 0)
  // Release B (spec § 6): the bound also counts the leased CANDIDATES (Postgres-
  // unengaged hosted sessions) up front — refused before anything — while the
  // decision under the lock still anonymizes an anonymously-engaged one.
  const refusedV = await deleteAccountDurable(Z4.id, { maxWipes: 0 }).then(() => null, e => e)
  check('…maxWipes 0 refuses up front (the candidate is leased before it is classified)', refusedV instanceof AccountDeleteTooManyWipesError && !!(await prisma.user.findUnique({ where: { id: Z4.id } })))
  const resV = await deleteAccountDurable(Z4.id, { maxWipes: 1 }).then(r => r, e => e)
  check('…with room for it, the account is deleted and that moment anonymized (not wiped)', !(resV instanceof Error) && !(await prisma.user.findUnique({ where: { id: Z4.id } }))
    && !!(await liveRow(SV.code)) && (resV as { plan: { toPseudonymize: string[] } }).plan.toPseudonymize.includes(SV.code), String(resV))

  // (f) the size bound fails BEFORE any durable statement
  const Z3 = await mkUser('Bound Z3')
  const SY = await createSession({ cookie: Z3.cookie })
  const before3 = await fingerprint(Z3.id, [SY.code])
  const bound = await deleteAccountDurable(Z3.id, { maxWipes: 0 }).then(() => null, e => e)
  check('candidate set over the bound → retryable error naming the count, nothing changed', bound instanceof AccountDeleteTooManyWipesError
    && (await fingerprint(Z3.id, [SY.code])) === before3)
}

// ── § 6 Fresh decisions under the locks, blocked writers, kick admission ────
async function schedules() {
  section('§ 6 decisions under the lock (R7-1A) · blocked writers · admission re-check')
  const O = await mkUser('Late rater O')

  // (a) unengaged at discovery, engaged before the lock → anonymized, not wiped
  const F = await mkUser('Host F')
  const SH = await createSession({ cookie: F.cookie })
  const wh = await addWine(SH.code, { cookie: F.cookie }, 'SH wine')
  await join(SH.code, { cookie: O.cookie }, 'Taster O'); await visit(SH.code, { cookie: O.cookie })
  const g1 = gate(), in1 = gate()
  const p1 = deleteAccountDurable(F.id, { hooks: { afterDiscovery: () => { in1.open(); return g1.p } } })
  await in1.p
  check('another member rates after discovery', (await rate(SH.code, { cookie: O.cookie }, wh)).status === 200)
  g1.open()
  const r1 = await p1
  check('…the moment stays live with their rating and an anonymized host', !!(await liveRow(SH.code)) && r1.plan.toPseudonymize.includes(SH.code)
    && (await prisma.rating.count({ where: { userId: O.id, wineId: wh } })) === 1)

  // (b) engaged at discovery, empty before the lock → wiped under the lock
  const F2 = await mkUser('Host F2')
  const SI = await createSession({ cookie: F2.cookie })
  const wi = await addWine(SI.code, { cookie: F2.cookie }, 'SI wine')
  await join(SI.code, { cookie: O.cookie }, 'Taster O'); await visit(SI.code, { cookie: O.cookie }); await rate(SI.code, { cookie: O.cookie }, wi)
  await rate(SI.code, { cookie: F2.cookie }, wi)
  const hostRating = await prisma.rating.findFirstOrThrow({ where: { userId: F2.id, wineId: wi } })
  await prisma.$executeRaw`INSERT INTO rating_images (rating_id, image_url, sort_order) VALUES (${hostRating.id}, 'https://img.test/si.jpg', 0)`
  const g2 = gate()
  const reclaimed2: string[] = []
  const in2 = gate()
  const p2 = deleteAccountDurable(F2.id, { hooks: { afterDiscovery: () => { in2.open(); return g2.p }, onReclaim: (u) => reclaimed2.push(u) } })
  await in2.p
  await prisma.rating.deleteMany({ where: { userId: O.id, wineId: wi } })
  await redis.del(k.rating(SI.code, `u:${O.id}`, wi))
  g2.open()
  const r2 = await p2
  check('…the now-empty moment is wiped (decided under the lock, no stale classification)', r2.plan.toDelete.includes(SI.code) && !(await liveRow(SI.code)))
  check('…and the host rating image captured in the transaction is reclaimed after COMMIT', reclaimed2.includes('https://img.test/si.jpg'), reclaimed2)

  // (c) a writer on a locked session is BLOCKED until the deletion commits
  const G = await mkUser('Host G')
  const SJ = await createSession({ cookie: G.cookie })
  const wj = await addWine(SJ.code, { cookie: G.cookie }, 'SJ wine')
  const wj2 = await addWine(SJ.code, { cookie: G.cookie }, 'SJ wine 2')
  await join(SJ.code, { cookie: O.cookie }, 'Taster O'); await visit(SJ.code, { cookie: O.cookie }); await rate(SJ.code, { cookie: O.cookie }, wj)
  const g3 = gate(), in3 = gate()
  const p3 = deleteAccountDurable(G.id, { hooks: { afterLocks: () => { in3.open(); return g3.p } } })
  await in3.p
  const b = rate(SJ.code, { cookie: O.cookie }, wj2)
  check('another member\'s rate on a locked session waits on a lock (assert B blocked)', await blockedOnLock(b))
  g3.open()
  await p3
  const bres = await b
  check('…released: the deletion commits, then the rate lands', bres.status === 200 && (await prisma.rating.count({ where: { userId: O.id, wineId: wj2 } })) === 1)

  // (d) the deleting user's OWN concurrent write (the deadlock-prone schedule)
  const D = await mkUser('Host D')
  const SK = await createSession({ cookie: D.cookie })
  const wk = await addWine(SK.code, { cookie: D.cookie }, 'SK wine')
  await join(SK.code, { cookie: O.cookie }, 'Taster O'); await visit(SK.code, { cookie: O.cookie }); await rate(SK.code, { cookie: O.cookie }, wk)
  const g4 = gate(), in4 = gate()
  const p4 = deleteAccountDurable(D.id, { hooks: { afterLocks: () => { in4.open(); return g4.p } } })
  await in4.p
  const own = rate(SK.code, { cookie: D.cookie }, wk)
  check('the user\'s own rate on a locked session waits on a lock', await blockedOnLock(own))
  g4.open()
  await p4
  await own
  check('…the deletion completes and leaves no rating referencing the user', !(await prisma.user.findUnique({ where: { id: D.id } }))
    && (await prisma.rating.count({ where: { userId: D.id } })) === 0)

  // (e) the member write's admission re-check under the lock (R1 finding 2) —
  // release B: /visit decides from the fresh grant read under the locks
  const Hk = await mkUser('Host K')
  const K = await mkUser('Kicked K')
  const SL = await createSession({ cookie: Hk.cookie })
  await join(SL.code, { cookie: K.cookie }, 'Taster K'); await visit(SL.code, { cookie: K.cookie })
  const g5 = gate(), in5 = gate()
  const kick = prisma.$transaction(async (tx) => {
    // the kick's shape: Redis kicked SADD first, then the row-locked transaction
    await redis.sAdd(k.kicked(SL.code), `u:${K.id}`)
    await tx.$queryRaw`SELECT id FROM sessions WHERE code = ${SL.code} AND deleted_at IS NULL FOR UPDATE`
    await tx.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE user_id = ${K.id} AND session_code = ${SL.code}`
    in5.open()
    await g5.p
  }, { timeout: 30_000 })
  await in5.p
  const em = visit(SL.code, { cookie: K.cookie })
  check('a member write racing a kick waits on the row lock', await blockedOnLock(em))
  g5.open()
  await kick
  const emRes = await em
  const m = await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: K.id, sessionCode: SL.code } } })
  check('…and sees the kick: no self-heal, the completed kick survives', emRes.status === 401 && m?.removedState === 'kicked', { emRes, m })

  // (f) a rate racing a kick: blocked on the row lock, then nothing archived
  const K2 = await mkUser('Kicked rater K2')
  const wl = await addWine(SL.code, { cookie: Hk.cookie }, 'SL wine')
  await join(SL.code, { cookie: K2.cookie }, 'Taster K2'); await visit(SL.code, { cookie: K2.cookie })
  const g6 = gate(), in6 = gate()
  const kick2 = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sessions WHERE code = ${SL.code} AND deleted_at IS NULL FOR UPDATE`
    in6.open()
    await g6.p
    await redis.sAdd(k.kicked(SL.code), `u:${K2.id}`)
    await tx.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE user_id = ${K2.id} AND session_code = ${SL.code}`
  }, { timeout: 30_000 })
  await in6.p
  const rk = rate(SL.code, { cookie: K2.cookie }, wl)
  check('a rate racing a kick waits on the row lock', await blockedOnLock(rk))
  g6.open()
  await kick2
  const rkRes = await rk
  check('…then answers removed and archives nothing', rkRes.status === 401 && (await prisma.rating.count({ where: { userId: K2.id } })) === 0, rkRes)

  // (g) an explicit rejoin racing a FRESH kick: the kick wins. Release B: /join
  // re-admits only from a kick already in place when it arrived (K2 is kicked
  // since (f) — rejoin first, so this kick is fresh). A RE-kick racing a rejoin
  // from the first kick lets the rejoin win (no kick version in the record —
  // documented in the build log).
  check('setup: K2 rejoins from the earlier kick', (await join(SL.code, { cookie: K2.cookie }, 'Taster K2')).status === 200)
  const g7 = gate()
  let holding = false
  const kick3 = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sessions WHERE code = ${SL.code} AND deleted_at IS NULL FOR UPDATE`
    holding = true
    await g7.p
    await redis.sAdd(k.kicked(SL.code), `u:${K2.id}`)
    await tx.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE user_id = ${K2.id} AND session_code = ${SL.code}`
  }, { timeout: 30_000 })
  while (!holding) await sleep(20)
  const rj = join(SL.code, { cookie: K2.cookie }, 'Taster K2')
  check('an explicit rejoin waits on the row lock', await blockedOnLock(rj))
  g7.open()
  await kick3
  const rjRes = await rj
  const m2 = await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: K2.id, sessionCode: SL.code } } })
  check('…the kick committed meanwhile survives (no reset outside the lock)', rjRes.status === 401 && m2?.removedState === 'kicked', { rjRes, m2 })

  // (h) the in-transaction wipe never replays after a rollback (fail-fast client)
  const W = await mkUser('Wipe-abort W')
  const SW = await createSession({ cookie: W.cookie })
  const ww = await addWine(SW.code, { cookie: W.cookie }, 'SW wine')
  const beforeW = await fingerprint(W.id, [SW.code])
  const keysBefore = (await scanKeys(`s:${SW.code}:*`)).length
  const aborted = await deleteAccountDurable(W.id, { hooks: { beforeWipeDel: async (c) => { await c.disconnect() } } }).then(() => null, e => e)
  check('Redis lost right before the wipe DEL → retryable failure, nothing durable changed', aborted instanceof AccountDeleteRetryableError
    && (await fingerprint(W.id, [SW.code])) === beforeW, String(aborted))
  await join(SW.code, { cookie: O.cookie }, 'Taster O'); await visit(SW.code, { cookie: O.cookie })
  await rate(SW.code, { cookie: O.cookie }, ww)
  await sleep(500)
  check('…and the abandoned DEL never runs later (the now-engaged moment keeps its keys)', (await scanKeys(`s:${SW.code}:*`)).length >= keysBefore && !!(await liveRow(SW.code)))

  // (j) the transaction's backend dies while the wipe step awaits Redis; another
  // participant then commits a rating; the DEL must not run
  for (const mode of ['backend killed', 'transaction timed out'] as const) {
    const T = await mkUser(`Wipe ${mode}`)
    const SX = await createSession({ cookie: T.cookie })
    const wx = await addWine(SX.code, { cookie: T.cookie }, 'SX wine')
    await join(SX.code, { cookie: O.cookie }, 'Taster O'); await visit(SX.code, { cookie: O.cookie })
    let rated = 0
    const res = await deleteAccountDurable(T.id, {
      txTimeoutMs: mode === 'transaction timed out' ? 1500 : undefined,
      hooks: { beforeWipeDel: async () => {
        if (mode === 'backend killed') {
          for (const pid of await advisoryHolders([SX.code])) await prisma.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`
          await sleep(300)
        } else {
          await sleep(2500)
        }
        rated = (await rate(SX.code, { cookie: O.cookie }, wx)).status
      } },
    }).then(() => null, e => e)
    check(`${mode} before the wipe DEL: the deletion fails`, res instanceof Error && !!(await prisma.user.findUnique({ where: { id: T.id } })), String(res))
    check(`…another participant's rating committed meanwhile, and the moment keeps every key`, rated === 200
      && (await prisma.rating.count({ where: { userId: O.id, wineId: wx } })) === 1
      && !!(await redis.get(k.meta(SX.code))) && !!(await redis.get(k.rating(SX.code, `u:${O.id}`, wx))) && !!(await liveRow(SX.code)))
  }

  // (k) the fail-fast client never leaks its socket: a startup handshake that
  // stalls, and a Redis that never answers QUIT — bounded, socket closed
  // server-side, no connection retained
  {
    const { createServer } = await import('node:net')
    const { DurableRedis } = await import('../../lib/accountDelete.ts')
    const fakeRedis = async (answer: (cmd: string) => boolean) => {
      const server = createServer(sock => {
        let buf = ''
        sock.on('data', d => {
          buf += String(d)
          for (;;) {
            const m = /^\*(\d+)\r\n/.exec(buf)
            if (!m) return
            let pos = m[0].length
            const parts: string[] = []
            for (let i = 0; i < Number(m[1]); i++) {
              const lm = /^\$(\d+)\r\n/.exec(buf.slice(pos))
              if (!lm || buf.length < pos + lm[0].length + Number(lm[1]) + 2) return
              parts.push(buf.slice(pos + lm[0].length, pos + lm[0].length + Number(lm[1])))
              pos += lm[0].length + Number(lm[1]) + 2
            }
            buf = buf.slice(pos)
            if (answer((parts[0] ?? '').toUpperCase())) sock.write('+OK\r\n')
          }
        })
      })
      await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
      const conns = () => new Promise<number>(r => server.getConnections((_, n) => r(n)))
      return { url: `redis://127.0.0.1:${(server.address() as { port: number }).port}`, conns, stop: () => server.close() }
    }
    const drained = async (conns: () => Promise<number>) => {
      for (let i = 0; i < 20; i++) { if ((await conns()) === 0) return true; await sleep(50) }
      return false
    }
    const silent = await fakeRedis(() => false)
    const d1 = new DurableRedis(silent.url)
    const t1 = Date.now()
    const r1 = await d1.step('handshake', async () => 'ran', 500).catch(e => e)
    check('a stalled startup handshake: bounded retryable failure, socket closed, nothing retained',
      r1 instanceof AccountDeleteRetryableError && Date.now() - t1 < 2000 && await drained(silent.conns), { r1: String(r1), ms: Date.now() - t1 })
    silent.stop()
    const noQuit = await fakeRedis(cmd => cmd !== 'QUIT')
    const d2 = new DurableRedis(noQuit.url)
    const t2 = Date.now()
    const r2 = await d2.step('probe', async () => 'ran', 2000).catch(e => e)
    const openDuring = await noQuit.conns()
    await d2.close()
    check('a Redis that never answers QUIT: teardown bounded, socket closed, nothing retained',
      r2 === 'ran' && openDuring === 1 && Date.now() - t2 < 2000 && await drained(noQuit.conns), { r2: String(r2), openDuring, ms: Date.now() - t2 })
    noQuit.stop()
  }

  // (i) a delayed FIRST mirror after the adder's deletion cannot restore their name
  const Hm = await mkUser('Host M')
  const X2 = await mkUser('Delayed adder')
  const SM = await createSession({ cookie: Hm.cookie })
  await join(SM.code, { cookie: X2.cookie }, 'Real Adder'); await visit(SM.code, { cookie: X2.cookie })
  // the add's Redis write landed; its Postgres mirror has not run yet
  await redis.set(k.wines(SM.code), JSON.stringify([...(await redisWines(SM.code)), { id: `late${Date.now()}`.slice(0, 21), name: 'Late wine', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '', addedByIdentityId: `u:${X2.id}`, addedByDisplayName: 'Real Adder' }]), { XX: true, KEEPTTL: true })
  const lateId = (await redisWines(SM.code)).find(w => w.addedByIdentityId === `u:${X2.id}`)!.id
  await deleteAccountDurable(X2.id, { hooks: { failProjection: true, failInvalidation: true } })
  await addWine(SM.code, { cookie: Hm.cookie }, 'next list write')   // its mirror projects the whole array
  const late = await prisma.wine.findUnique({ where: { id: lateId }, select: { addedByIdentityId: true, addedByDisplayName: true } })
  check('…the delayed first mirror writes no adder and "[deleted]"', late?.addedByIdentityId === null && late?.addedByDisplayName === '[deleted]', late)
}

// ── § 7 Redis-only registrations, Lua conflicts, legacy + old writer ────────
async function misc() {
  section('§ 7 Redis-only registration · migration CAS · legacy backfill · old writer')
  // (a) logged-in /join on a Redis-only session, then account deletion
  const anonHost = await createSession({})
  const Q = await mkUser('Redis-only Q')
  await join(anonHost.code, { cookie: Q.cookie }, 'Q real name')
  check('setup: Q is registered in Redis only', !!(await redis.hGet(k.identities(anonHost.code), `u:${Q.id}`)) && !(await liveRow(anonHost.code)))
  await deleteAccountDurable(Q.id)
  check('account deletion removes the Redis-only registration without promoting', !(await redis.hGet(k.identities(anonHost.code), `u:${Q.id}`)) && !(await liveRow(anonHost.code)))

  // (b) the migration script validates every compare-and-set before mutating
  const code = anonHost.code
  await redis.set(k.rating(code, 'u:999999', 'wz'), '{"score":1}')
  const { sessionLockKey } = await import('../../lib/sessionLock.ts')
  const lease = (await acquireSessionLock(code))!
  const keys = [sessionLockKey(code), k.gen(code), k.meta(code), k.wines(code), k.identities(code), k.lastSeen(code), k.kicked(code), k.kickv(code), k.rating(code, 'u:999999', 'wz'), k.rating(code, 'd:x', 'wz')]
  const tail = (token: string) => [token, 'gen-token', '60000']
  const r0 = await redis.eval(D_MIGRATION_SCRIPT, { keys, arguments: ['x', 'x', '__absent__', '', 'u:999999', 'd:x', '1', 'rename', '999999', ...tail('not-the-lease')] })
  check('wrong lease → explicit lost and NO mutation', r0 === 'lost' && !!(await redis.get(k.rating(code, 'u:999999', 'wz'))))
  const r = await redis.eval(D_MIGRATION_SCRIPT, { keys, arguments: ['stale meta', 'x', '__absent__', '', 'u:999999', 'd:x', '1', 'rename', '999999', ...tail(lease)] })
  check('stale meta → explicit conflict and NO mutation', r === 'conflict' && !!(await redis.get(k.rating(code, 'u:999999', 'wz'))) && !(await redis.get(k.rating(code, 'd:x', 'wz'))))
  const metaNow = (await redis.get(k.meta(code)))!
  const winesNow = (await redis.get(k.wines(code)))!
  const r2 = await redis.eval(D_MIGRATION_SCRIPT, { keys: [...keys, k.rating(code, 'u:999999', 'gone'), k.rating(code, 'd:x', 'gone')], arguments: [metaNow, metaNow, winesNow, winesNow, 'u:999999', 'd:x', '0', 'rename', '999999', ...tail(lease)] })
  check('fresh values → applied; a missing key is skipped; the generation is bumped', r2 === 'ok' && !!(await redis.get(k.rating(code, 'd:x', 'wz'))) && !(await redis.get(k.rating(code, 'u:999999', 'wz'))) && (await redis.get(k.gen(code))) === 'gen-token')
  await releaseSessionLock(code, lease)

  // (c) old writer against release A's schema, then the legacy catch-up
  const Hl = await mkUser('Host legacy')
  const L = await mkUser('Legacy L')
  const S = await createSession({ cookie: Hl.cookie })
  await join(S.code, { cookie: L.cookie }, 'Taster L'); await visit(S.code, { cookie: L.cookie })
  await setRole(S.code, { cookie: Hl.cookie }, `u:${L.id}`, 'provider')
  const wl = await addWine(S.code, { cookie: L.cookie }, 'Legacy brought')
  await rate(S.code, { cookie: L.cookie }, wl)
  // Release B (plan § 12, r1-14): B's CHECK correctly refuses the old writer, so
  // the release-A case runs on A's schema EXACTLY — inside one transaction that
  // first drops the constraint, and is rolled back at the end.
  const ROLLBACK = new Error('rollback')
  const outcome: Record<string, unknown> = {}
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE ratings DROP CONSTRAINT ratings_session_rater_known')
    // today's (pre-release-A) account-delete SQL, verbatim in shape
    await tx.$executeRaw`DELETE FROM ratings WHERE user_id = ${L.id} AND session_id IS NULL`
    await tx.$executeRaw`UPDATE ratings SET user_id = NULL, rater_name = '[deleted]' WHERE user_id = ${L.id} AND session_id IS NOT NULL`
    await tx.$executeRaw`UPDATE hall_of_fame SET user_id = NULL, rater_name = '[deleted]' WHERE user_id = ${L.id}`
    await tx.$executeRaw`UPDATE sessions SET host_user_id = NULL, host_name = '[deleted]' WHERE host_user_id = ${L.id}`
    await tx.$executeRaw`DELETE FROM users WHERE id = ${L.id}`
    outcome.oldWriter = true
    const violating = async () => (await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM ratings WHERE session_id IS NOT NULL AND user_id IS NULL AND tombstone_key IS NULL`)[0].n
    outcome.left = await violating()
    const sql = readFileSync(pjoin(REPO, 'prisma/migrations/20261108072132_redis_rehydration_release_a/migration.sql'), 'utf8')
    const recipe = sql.slice(sql.indexOf('-- @recipe:legacy-tombstones'), sql.indexOf('-- @endrecipe'))
    await tx.$executeRawUnsafe(recipe)
    outcome.wlRow = await tx.wine.findUnique({ where: { id: wl }, select: { addedByIdentityId: true, addedByDisplayName: true } })
    outcome.lRating = await tx.rating.findFirst({ where: { wineId: wl, userId: null }, select: { tombstoneKey: true } })
    outcome.after = await violating()
    const snap = JSON.stringify(await tx.$queryRaw`SELECT id, tombstone_key FROM ratings WHERE tombstone_key IS NOT NULL ORDER BY id`)
    await tx.$executeRawUnsafe(recipe)
    outcome.idempotent = JSON.stringify(await tx.$queryRaw`SELECT id, tombstone_key FROM ratings WHERE tombstone_key IS NOT NULL ORDER BY id`) === snap
    throw ROLLBACK
  }, { timeout: 30_000 }).catch(e => { if (e !== ROLLBACK) outcome.error = String(e) })
  check('the OLD writer succeeds against release A\'s schema (no CHECK)', outcome.oldWriter === true, outcome.error ?? '')
  check('…leaving a both-NULL tombstone (what B\'s catch-up exists for)', (outcome.left as bigint) >= 1n)
  const { wlRow, lRating } = outcome as { wlRow: { addedByIdentityId: string | null; addedByDisplayName: string | null } | null; lRating: { tombstoneKey: string | null } | null }
  check('catch-up recipe stamps the key and re-attributes the gone user\'s wine to it', outcome.after === 0n
    && !!lRating?.tombstoneKey && wlRow?.addedByIdentityId === lRating.tombstoneKey && wlRow?.addedByDisplayName === '[deleted]', { wlRow, lRating })
  check('…and is idempotent (second run changes nothing)', outcome.idempotent === true)
  check('…and the whole case rolled back (the CHECK is in place again)', !!(await prisma.user.findUnique({ where: { id: L.id } })))
}

// ── Run ─────────────────────────────────────────────────────────────────────
try {
  const { H, s } = await mirrors()
  await backfill(s.code)
  await registry(H, s.code)
  await accountDeletion()
  await crashAndRedis()
  await schedules()
  await misc()
} catch (err) {
  failed++
  console.error('\n💥 suite aborted:', err)
} finally {
  for (const code of created) {
    const ks = await scanKeys(`s:${code}:*`)
    if (ks.length) await redis.del(ks)
  }
  await resetLimits()
}
console.log(`\n${pass} passed, ${failed} failed`)
void AccountDeleteRetryableError
await redis.quit().catch(() => {})
await prisma.$disconnect()
process.exit(failed === 0 ? 0 : 1)
