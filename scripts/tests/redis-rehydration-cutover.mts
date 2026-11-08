// Redis rehydration — release B ("cutover") integration suite.
// docs/dev/proposals/redis-rehydration.md § 9 "Cutover" + the release-B plan § 12:
// the rebuild round trip, record-grants / cache-denies, NX/XX, the B1/B2
// schedules, deletion races and crashes, fencing, the generation, eviction
// belts, the D1 blind crash, code recycling, and the CHECK.
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only (refuses the dev db `verre`); it
// deletes only the keys of the sessions it creates and rate-limit keys.
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/redis-rehydration-cutover.mts [--only <section>]
//
// Orchestration rule for "A pauses, B proceeds" (§ 9): pause A at a hook while
// it holds its locks, start B, ASSERT B IS BLOCKED, release A, then await B.
// Kill schedules run the request in a child process (this file with --worker)
// and SIGKILL it at a hook; assertions run here, in a separate process.
import { spawn } from 'node:child_process'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
import { prisma } from '../../lib/prisma.ts'
import { redis, k, scanKeys } from '../../lib/redis.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pjoin(HERE, '..', '..')
const SELF = fileURLToPath(import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: pathToFileURL(pjoin(HERE, 'stubs', 'nextauth-anonymous.mts')).href, shortCircuit: true }
    return next(specifier, context)
  },
})

type Actor = { cookie?: string; anon?: string }
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
  return { status: res.status, json: json as Record<string, unknown>, headers: res.headers }
}

// ── Worker mode (child process): one route call, SIGKILLed at a hook ────────
if (process.argv[2] === '--worker') {
  const cfg = JSON.parse(process.argv[3]) as {
    module: string; method: string; path: string; actor: Actor; body?: unknown; params: Record<string, string>
    killAt: string; label: string; earlyMeta?: string; signal: string
  }
  const { mutationHooks } = await import('../../lib/sessionMutation.ts')
  const { lockTiming } = await import('../../lib/sessionLock.ts')
  lockTiming.leaseMs = 1500   // the dead worker's lease lapses quickly
  mutationHooks.at = async (point, code, label) => {
    if (point !== cfg.killAt || label !== cfg.label) return
    // Simulates the OLD (rejected) order — a projection written before COMMIT.
    if (cfg.earlyMeta) await redis.set(k.meta(code), cfg.earlyMeta, { XX: true, KEEPTTL: true })
    await prisma.$executeRawUnsafe(`NOTIFY test_worker, '${cfg.signal}'`)
    process.kill(process.pid, 'SIGKILL')
  }
  const mod = await import(pjoin(REPO, cfg.module))
  await call(mod[cfg.method], cfg.method, cfg.path, cfg.actor, cfg.body, cfg.params)
  process.exit(0)
}

// ── Guards ──────────────────────────────────────────────────────────────────
const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required (Better Auth)')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

const { betterAuthServer } = await import('../../lib/betterAuth.ts')
const sessionRoute = await import('../../app/api/session/route.ts')
const codeRoute = await import('../../app/api/session/[code]/route.ts')
const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
const ratingsRoute = await import('../../app/api/session/[code]/ratings/route.ts')
const joinRoute = await import('../../app/api/session/join/route.ts')
const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
const reorderRoute = await import('../../app/api/session/[code]/wines/reorder/route.ts')
const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
const rateDelRoute = await import('../../app/api/session/[code]/rate/[wineId]/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const unbanRoute = await import('../../app/api/session/[code]/bans/[identityId]/route.ts')
const leaveRoute = await import('../../app/api/session/[code]/leave/route.ts')
const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const { ensureSessionLive, SESSION_META_FIELDS, WINE_META_FIELDS } = await import('../../lib/sessionRehydrate.ts')
const { mutationHooks, scopedInvalidate, ContractCold } = await import('../../lib/sessionMutation.ts')
const { acquireSessionLock, releaseSessionLock, sessionLockKey, fencedExec, lockTiming, LockLost } = await import('../../lib/sessionLock.ts')
const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')
const { mutateWines } = await import('../../lib/session.ts')
const { sessionIsOver } = await import('../../lib/sessionFeedWines.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TAG = `cut-${Date.now()}`
const created: string[] = []
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }
type User = { id: number; cookie: string }
let userSeq = 0
async function mkUser(name: string, opts: { pro?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const password = `pw-${TAG}-${userSeq}`
  await betterAuthServer.api.signUpEmail({ body: { name, email, password } })
  const { headers } = await betterAuthServer.api.signInEmail({ body: { email, password }, returnHeaders: true })
  const cookie = (headers.get('set-cookie') ?? '').split(';')[0]
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  if (opts.pro) await prisma.user.update({ where: { id: row.id }, data: { pro: true } })
  return { id: row.id, cookie }
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
  return { status: r.status, anon: r.json?.anonToken as string | undefined, id: r.json?.id as string, json: r.json }
}
const visit = (code: string, actor: Actor) => call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, actor, {}, { code })
const enter = async (code: string, actor: Actor, name: string) => { const j = await join(code, actor, name); await visit(code, actor); return j }
async function addWine(code: string, actor: Actor, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, { name, type: 'red', ...extra }, { code })
  if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id as string
}
const rate = (code: string, actor: Actor, wineId: string, score = 4, extra: Record<string, unknown> = {}) =>
  call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, { wineId, score, flavors: {}, notes: 'nice wine', ...extra }, { code })
const unrate = (code: string, actor: Actor, wineId: string) => call(rateDelRoute.DELETE, 'DELETE', `/api/session/${code}/rate/${wineId}`, actor, undefined, { code, wineId })
const setRole = (code: string, actor: Actor, targetId: string, role: string) =>
  call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, actor, { action: 'set-role', targetId, role }, { code })
const ban = (code: string, actor: Actor, identityId: string, mode: 'kick' | 'ban', deleteAddedWines = false) =>
  call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, actor, { identityId, mode, deleteAddedWines }, { code })
const settings = (code: string, actor: Actor, body: Record<string, unknown>) => call(settingsRoute.PATCH, 'PATCH', `/api/session/${code}/settings`, actor, body, { code })
const state = (code: string, actor: Actor) => call(stateRoute.GET, 'GET', `/api/session/${code}/state`, actor, undefined, { code })
const winesGet = (code: string, actor: Actor) => call(winesRoute.GET, 'GET', `/api/session/${code}/wines`, actor, undefined, { code })
const delWine = (code: string, actor: Actor, wineId: string) => call(wineRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wineId}`, actor, undefined, { code, wineId })
const editWine = (code: string, actor: Actor, wineId: string, body: Record<string, unknown>) => call(wineRoute.PATCH, 'PATCH', `/api/session/${code}/wines/${wineId}`, actor, body, { code, wineId })
const liveRow = async (code: string) => (await prisma.$queryRaw<{ id: number; created_at: Date; host_user_id: number | null }[]>`
  SELECT id, created_at, host_user_id FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0]
const redisWines = async (code: string) => JSON.parse((await redis.get(k.wines(code))) ?? '[]') as { id: string; name: string; revealedAt?: string | null; addedByIdentityId?: string }[]
const metaOf = async (code: string) => JSON.parse((await redis.get(k.meta(code))) ?? 'null') as Record<string, unknown> | null
async function wipeCache(code: string) { const ks = await scanKeys(`s:${code}:*`); if (ks.length) await redis.del(ks) }
function gate() { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }
async function stillPending(p: Promise<unknown>, ms = 600): Promise<boolean> {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  await sleep(ms)
  return !settled
}
async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (!(await stillPending(p, 100))) return false
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(n) > 0) return await stillPending(p, 100)
  }
  return false
}
async function advisoryHolders(codes: string[]): Promise<number[]> {
  return (await prisma.$queryRaw<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l
     WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted
       AND l.objid::bigint = ANY(SELECT (hashtext('session:' || c)::bigint & 4294967295) FROM unnest(${codes}::text[]) AS c)`).map(r => r.pid)
}
const terminate = async (code: string) => { for (const pid of await advisoryHolders([code])) await prisma.$queryRaw`SELECT pg_terminate_backend(${pid}::int)` }
// Pause the FIRST matching hook point; returns {entered, release}.
function pauseAt(point: string, code: string, label?: string) {
  const entered = gate(), release = gate()
  let fired = false
  const prev = mutationHooks.at
  mutationHooks.at = async (p, c, l) => {
    if (!fired && p === point && c === code && (!label || l === label)) {
      fired = true
      entered.open()
      await release.p
    }
  }
  return { entered: entered.p, release: () => { release.open(); mutationHooks.at = prev } }
}
const noHooks = () => { mutationHooks.at = async () => {} }
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
// One route call in a child process, SIGKILLed at a hook.
async function killedAt(cfg: { module: string; method: string; path: string; actor: Actor; body?: unknown; params: Record<string, string>; killAt: string; label: string; earlyMeta?: string }) {
  const signal = `cut:${Date.now()}:${Math.random()}`
  const l = await listenFor(signal)
  const child = spawn(process.execPath, ['--import', 'tsx', SELF, '--worker', JSON.stringify({ ...cfg, signal })], { cwd: REPO, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', d => { err += String(d) })
  const exited = new Promise<number | null>(res => child.on('exit', (_c, sig) => res(sig === 'SIGKILL' ? -9 : _c)))
  const hit = await l.wait()
  const code = await exited
  // the killed backend's transaction and the dead worker's lease must be gone
  // before anyone asserts
  for (let i = 0; i < 50 && (await advisoryHolders([cfg.params.code])).length; i++) await sleep(100)
  for (let i = 0; i < 40 && (await redis.exists(sessionLockKey(cfg.params.code))); i++) await sleep(100)
  return { hit, killed: code === -9, err }
}
// Redis MONITOR tap: the commands any client sent while `fn` ran (a raw RESP
// socket — node-redis 4 has no MONITOR API).
async function monitored(fn: () => Promise<unknown>): Promise<string[]> {
  const { createConnection } = await import('node:net')
  const u = new URL(process.env.REDIS_URL!)
  const sock = createConnection({ host: u.hostname, port: Number(u.port || 6379) })
  let buf = ''
  sock.on('data', d => { buf += String(d) })
  await new Promise<void>(r => sock.once('connect', () => r()))
  sock.write('MONITOR\r\n')
  await sleep(100)
  await fn()
  await sleep(150)
  sock.destroy()
  return buf.split('\r\n').filter(l => l.startsWith('+') && l !== '+OK')
}

// A snapshot of every key of a session: type + normalized value.
async function snapshot(code: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of (await scanKeys(`s:${code}:*`)).sort()) {
    const t = await redis.type(key)
    const str = t === 'string' ? (await redis.get(key))! : ''
    let parsed: unknown = str
    try { parsed = JSON.parse(str) } catch {}
    out[key] = t === 'string' ? parsed : t === 'hash' ? await redis.hGetAll(key) : t === 'set' ? (await redis.sMembers(key)).sort() : t
  }
  return out
}

// ── § 1 Round trip + field coverage ─────────────────────────────────────────
async function roundTrip() {
  section('§ 1 round trip — FLUSH the session, ensureSessionLive, key-by-key diff')
  const H = await mkUser('Host H', { pro: true })
  const C = await mkUser('Cohost C'), P = await mkUser('Provider P'), T = await mkUser('Taster T')
  const R = await mkUser('Rater R'), K = await mkUser('Kicked K'), B = await mkUser('Banned B'), X = await mkUser('Doomed X')
  const s = await createSession({ cookie: H.cookie }, {
    blind: true, hideLineup: true, hideLineupMinutesBefore: 15, address: 'Rue 1', description: 'desc', link: 'https://x.test', timezone: 'Europe/Zurich',
    dateTo: new Date(Date.now() + 7200_000).toISOString(),
  })
  await settings(s.code, { cookie: H.cookie }, { showProvenance: false, blindForEveryone: true })
  for (const [u, n] of [[C, 'Cohost C'], [P, 'Provider P'], [T, 'Taster T'], [K, 'Kicked K'], [B, 'Banned B'], [X, 'Doomed X']] as const) await enter(s.code, { cookie: u.cookie }, n)
  await join(s.code, { cookie: R.cookie }, 'Rater R')   // joined + rated, never visited
  const A = await join(s.code, {}, 'Anon A')
  await setRole(s.code, { cookie: H.cookie }, `u:${C.id}`, 'co_host')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  await setRole(s.code, { cookie: H.cookie }, `u:${X.id}`, 'provider')
  const w1 = await addWine(s.code, { cookie: H.cookie }, 'One', { producer: 'Prod', vintage: '2019', grape: 'Pinot', region: 'Valais', country: 'CH', description: 'd', vinification: 'v', purchaseUrl: 'https://buy.test' })
  const w2 = await addWine(s.code, { cookie: P.cookie }, 'Two (provider)')
  const w3 = await addWine(s.code, { cookie: X.cookie }, 'Three (by X)')
  const w4 = await addWine(s.code, { cookie: H.cookie }, 'Inserted first', { position: 1 })
  await call(reorderRoute.POST, 'POST', `/api/session/${s.code}/wines/reorder`, { cookie: H.cookie }, { orderedIds: [w4, w2, w1, w3] }, { code: s.code })
  await call(revealRoute.POST, 'POST', `/api/session/${s.code}/wines/${w1}/reveal`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w1 })
  await rate(s.code, { cookie: T.cookie }, w1, 4)
  await rate(s.code, { cookie: T.cookie }, w2, 0, { flavors: { body: 3 }, notes: '' })   // chips-only
  await rate(s.code, { cookie: R.cookie }, w2, 3.5)
  await rate(s.code, { cookie: K.cookie }, w1, 2)
  await rate(s.code, { cookie: X.cookie }, w1, 5)
  await rate(s.code, { anon: A.anon }, w1, 1)
  await ban(s.code, { cookie: H.cookie }, `u:${K.id}`, 'kick')
  await ban(s.code, { cookie: H.cookie }, `u:${B.id}`, 'ban')
  await deleteAccountDurable(X.id)
  // Settle every projection, then snapshot and flush ONLY this session's keys.
  await state(s.code, { cookie: H.cookie })
  const before = await snapshot(s.code)
  await wipeCache(s.code)
  check('cold: the session has no keys', (await scanKeys(`s:${s.code}:*`)).length === 0)
  check('ensureSessionLive rebuilds it', (await ensureSessionLive(s.code)) === 'live')
  const after = await snapshot(s.code)
  // Expected differences: tokens, lastseen, gen, kickv (cache-only: the Redis-only
  // kick version — a Postgres-backed moment versions kicks by the member row), anonymous entries.
  const anon = (id: string) => id.startsWith('a:')
  const drop = (key: string) => /:(tokens|lastseen|gen|kickv)$/.test(key) || key.includes(':r:a:')
  const keysB = Object.keys(before).filter(x => !drop(x)), keysA = Object.keys(after).filter(x => !drop(x))
  check('same key set (modulo tokens / lastseen / gen / kickv / anonymous rating keys)', JSON.stringify(keysB) === JSON.stringify(keysA), { onlyBefore: keysB.filter(x => !keysA.includes(x)), onlyAfter: keysA.filter(x => !keysB.includes(x)) })
  const mB = before[k.meta(s.code)] as Record<string, unknown>, mA = after[k.meta(s.code)] as Record<string, unknown>
  const norm = (f: string, v: unknown) => (f === 'dateFrom' || f === 'dateTo') && typeof v === 'string' ? Date.parse(v)
    : Array.isArray(v) ? [...v].filter(x => !anon(String(x))).sort() : v ?? null
  const metaDiff = (Object.keys(SESSION_META_FIELDS) as string[]).filter(f => f !== 'promotedAt' && JSON.stringify(norm(f, mB[f])) !== JSON.stringify(norm(f, mA[f])))
  check('meta: every rebuilt field round-trips (dates by instant; promotedAt is new)', metaDiff.length === 0, metaDiff.map(f => ({ f, before: mB[f], after: mA[f] })))
  check('meta: promotedAt stamped from archived_at', typeof mA.promotedAt === 'number')
  const wB = before[k.wines(s.code)] as Record<string, unknown>[], wA = after[k.wines(s.code)] as Record<string, unknown>[]
  const wineFields = (Object.keys(WINE_META_FIELDS) as string[]).filter(f => (WINE_META_FIELDS as Record<string, string>)[f] === 'rebuilt')
  const wn = (v: unknown) => (v === '' || v === undefined ? null : v)
  const wineDiff = wB.flatMap((w, i) => wineFields.filter(f => JSON.stringify(wn(w[f])) !== JSON.stringify(wn(wA[i]?.[f]))).map(f => ({ i, f, before: w[f], after: wA[i]?.[f] })))
  check('lineup: same order, every rebuilt field (incl. revealedAt, provenance, d: owner)', wB.length === wA.length && wineDiff.length === 0, wineDiff)
  const idsB = before[k.identities(s.code)] as Record<string, string>, idsA = after[k.identities(s.code)] as Record<string, string>
  const strip = (n: string) => n.replace(/ \S+$/u, (m) => /[\p{Extended_Pictographic}]/u.test(m) ? '' : m)
  const nonAnon = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([id]) => !anon(id)).map(([id, n]) => [id, strip(n)]).sort())
  // Spec § 5.2: a rebuilt `u:` entry is the ACCOUNT name (the create/join body
  // name is presentation the record does not keep — the clients send the
  // account name anyway); d: groups are '[deleted]'.
  const accountNames = Object.fromEntries((await prisma.user.findMany({ where: { id: { in: Object.keys(idsB).filter(id => id.startsWith('u:')).map(id => Number(id.slice(2))) } }, select: { id: true, name: true } })).map(u => [`u:${u.id}`, u.name]))
  const expected = Object.fromEntries(Object.entries(nonAnon(idsB)).map(([id, n]) => [id, accountNames[id] ?? n]))
  check('identities: same ids; u: names are the account names (spec § 5.2), d: → [deleted]', JSON.stringify(expected) === JSON.stringify(nonAnon(idsA)), { expected, after: nonAnon(idsA) })
  check('…the kicked member is absent from identities and present in kicked', !idsA[`u:${K.id}`] && (after[k.kicked(s.code)] as string[]).includes(`u:${K.id}`))
  check('bans + kicked sets match', JSON.stringify(before[k.bans(s.code)]) === JSON.stringify(after[k.bans(s.code)]) && JSON.stringify(before[k.kicked(s.code)]) === JSON.stringify(after[k.kicked(s.code)]))
  const ratingKeys = keysB.filter(x => x.includes(':r:'))
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x)
  const rdiff = ratingKeys.filter(x => canon({ ...(before[x] as object), aromas: (before[x] as { aromas?: unknown }).aromas ?? [] }) !== canon(after[x]))
  check('rating keys: same values incl. the mirror token `at` and the chips-only score 0', rdiff.length === 0, rdiff.map(x => ({ x, before: before[x], after: after[x] })))
  const ttls = async () => Object.fromEntries(await Promise.all((await scanKeys(`s:${s.code}:*`)).map(async x => [x, await redis.ttl(x)] as const)))
  const short = (t: Record<string, number>) => Object.entries(t).filter(([, v]) => !(v > 360 * 86400))
  const t1 = await ttls()
  check('every key carries the lifespan TTL (unlimited → ~1 year)', Object.keys(t1).length > 5 && short(t1).length === 0, short(t1))
  // r1 P2-5: a PARTIAL rebuild (wines evicted, meta about to expire) refreshes
  // the readiness pair too — never siblings at full lifespan beside a dying meta
  await redis.pExpire(k.meta(s.code), 5000)
  await redis.del(k.wines(s.code))
  check('(r1 P2-5) setup: a partial rebuild reopens the moment', (await state(s.code, { cookie: H.cookie })).status === 200)
  const t2 = await ttls()
  check('(r1 P2-5) …and every key, meta and wines included, carries the full lifespan again', short(t2).length === 0, short(t2))
  return { H, C, P, T, K, B, R, s, w1, w2 }
}

// ── § 2 Record grants, cache denies ──────────────────────────────────────────
async function grants() {
  section('§ 2 record grants, cache denies (R5-1)')
  const H = await mkUser('Host H2', { pro: true }), T = await mkUser('Taster T2'), P = await mkUser('Ex-provider P2'), V = await mkUser('Victim V')
  const s = await createSession({ cookie: H.cookie }, { blind: true })
  await enter(s.code, { cookie: T.cookie }, 'Taster T2'); await enter(s.code, { cookie: P.cookie }, 'Provider P2'); await enter(s.code, { cookie: V.cookie }, 'Victim V')
  const w = await addWine(s.code, { cookie: H.cookie }, 'Secret wine')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  const wp = await addWine(s.code, { cookie: P.cookie }, 'P wine')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'taster')
  // (1) cohost grant projected BEFORE commit (the rejected old order), worker killed before COMMIT
  const meta = (await metaOf(s.code))!
  const k1 = await killedAt({ module: 'app/api/session/[code]/route.ts', method: 'PATCH', path: `/api/session/${s.code}`, actor: { cookie: H.cookie }, body: { action: 'set-role', targetId: `u:${T.id}`, role: 'co_host' }, params: { code: s.code },
    killAt: 'beforeCommit', label: 'set-role', earlyMeta: JSON.stringify({ ...meta, coHostIds: [...(meta.coHostIds as string[]), `u:${T.id}`] }) })
  check('(1) worker killed before COMMIT with a cohost entry already in the cache', k1.hit && k1.killed && ((await metaOf(s.code))!.coHostIds as string[]).includes(`u:${T.id}`), k1)
  check('…the record never granted it', (await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: T.id, sessionCode: s.code } } }))?.role === 'taster')
  check('…settings PATCH by that user → 403', (await settings(s.code, { cookie: T.cookie }, { name: 'hijack' })).status === 403)
  check('…wine delete → 403', (await delWine(s.code, { cookie: T.cookie }, w)).status === 403 && (await redisWines(s.code)).some(x => x.id === w))
  const wg = await winesGet(s.code, { cookie: T.cookie })
  check('…blind wines GET is redacted', (wg.json as unknown as { _blind?: boolean; name: string }[]).find(x => x.id === w)?._blind === true)
  // (2) the same with the commit succeeding → 200
  const sr2 = await setRole(s.code, { cookie: H.cookie }, `u:${V.id}`, 'co_host')
  const st2 = await settings(s.code, { cookie: V.cookie }, { name: 'renamed by cohost' })
  check('(2) a committed grant works', sr2.status === 200 && st2.status === 200, { sr2: [sr2.status, sr2.json], st2: [st2.status, st2.json] })
  // (3) unban whose Postgres side is aborted after the Redis SREM
  await ban(s.code, { cookie: H.cookie }, `u:${V.id}`, 'ban')
  await redis.sRem(k.bans(s.code), `u:${V.id}`)
  const v3 = await visit(s.code, { cookie: V.cookie })
  check('(3) unban aborted after its SREM: /visit still bounced', v3.status === 401, [v3.status, v3.json])
  check('…and the poll', (await state(s.code, { cookie: V.cookie })).headers.get('x-vr-auth') === 'removed')
  check('…and the Redis entry is re-seeded', await redis.sIsMember(k.bans(s.code), `u:${V.id}`))
  // (4) stale cached cohost entry for a record taster
  const m4 = (await metaOf(s.code))!
  await redis.set(k.meta(s.code), JSON.stringify({ ...m4, coHostIds: [...(m4.coHostIds as string[]), `u:${T.id}`] }), { XX: true, KEEPTTL: true })
  check('(4) stale cached cohost: settings 403, reveal 403, set-role 403', (await settings(s.code, { cookie: T.cookie }, { name: 'x' })).status === 403
    && (await call(revealRoute.POST, 'POST', `/api/session/${s.code}/wines/${w}/reveal`, { cookie: T.cookie }, undefined, { code: s.code, wineId: w })).status === 403
    && (await setRole(s.code, { cookie: T.cookie }, `u:${P.id}`, 'provider')).status === 403)
  check('…badge still shown until reconciliation (presentation)', ((await state(s.code, { cookie: H.cookie })).json.meta as { coHostIds: string[] }).coHostIds.includes(`u:${T.id}`))
  // (4b) stale cached provider entry for the demoted ex-provider
  const m4b = (await metaOf(s.code))!
  await redis.set(k.meta(s.code), JSON.stringify({ ...m4b, providerIds: [...(m4b.providerIds as string[]), `u:${P.id}`] }), { XX: true, KEEPTTL: true })
  check('(4b) stale cached provider: own-wine PATCH and DELETE → 403, add → 403',
    (await editWine(s.code, { cookie: P.cookie }, wp, { name: 'edited', type: 'red' })).status === 403
    && (await delWine(s.code, { cookie: P.cookie }, wp)).status === 403
    && (await call(winesRoute.POST, 'POST', `/api/session/${s.code}/wines`, { cookie: P.cookie }, { name: 'n', type: 'red' }, { code: s.code })).status === 403)
  // (5) anonymous cohost keeps host powers from meta alone
  const anon = await createSession({})
  const A2 = await join(anon.code, {}, 'Anon cohost')
  await setRole(anon.code, { anon: anon.anon }, A2.id, 'co_host')
  check('(5) an anonymous cohost keeps host powers from meta', (await addWine(anon.code, { anon: A2.anon }, 'by anon cohost')).length > 0)
  // (6) target cached as cohost, record says taster → a cohost may remove them
  const C6 = await mkUser('Cohost C6'), T6 = await mkUser('Taster T6')
  await enter(s.code, { cookie: C6.cookie }, 'Cohost C6'); await enter(s.code, { cookie: T6.cookie }, 'Taster T6')
  await setRole(s.code, { cookie: H.cookie }, `u:${C6.id}`, 'co_host')
  const m6 = (await metaOf(s.code))!
  await redis.set(k.meta(s.code), JSON.stringify({ ...m6, coHostIds: [...(m6.coHostIds as string[]), `u:${T6.id}`] }), { XX: true, KEEPTTL: true })
  check('(6) the strict-host-only "remove a cohost" rule reads the target fresh: a record taster is kickable by a cohost', (await ban(s.code, { cookie: C6.cookie }, `u:${T6.id}`, 'kick')).status === 200)
  return { s, H }
}

// ── § 3 Idempotent / no-op, absent, restoring ───────────────────────────────
async function idempotent() {
  section('§ 3 idempotent / no-op · absent · restoring')
  const H = await mkUser('Host I')
  const s = await createSession({ cookie: H.cookie })
  await addWine(s.code, { cookie: H.cookie }, 'w')
  const cmds = await monitored(() => ensureSessionLive(s.code))
  check('readiness pair present → zero writes', !cmds.some(c => /"(set|hset|hsetnx|sadd|srem|del|expire|hdel)"/i.test(c)), cmds.filter(c => !/"(exists|get|mget)"/i.test(c)))
  await wipeCache(s.code)
  let rebuilds = 0
  const prevLog = console.log
  console.log = (...a: unknown[]) => { if (String(a[0]).startsWith('[rehydrate]')) rebuilds++; else prevLog(...a) }
  const [r1, r2] = await Promise.all([ensureSessionLive(s.code), ensureSessionLive(s.code)])
  console.log = prevLog
  check('two concurrent ensures → one rebuild, both answer live or restoring', rebuilds === 1 && [r1, r2].includes('live'), { rebuilds, r1, r2 })
  await ban(s.code, { cookie: H.cookie }, 'u:999999999', 'ban').catch(() => null)
  const B = await mkUser('Banned BI')
  await enter(s.code, { cookie: B.cookie }, 'Banned B')
  await ban(s.code, { cookie: H.cookie }, `u:${B.id}`, 'ban')
  const snap = await snapshot(s.code)
  await redis.del(k.bans(s.code))
  await ensureSessionLive(s.code, { force: true })
  const snap2 = await snapshot(s.code)
  check('force over a session with only `bans` missing re-seeds bans and changes nothing else (R3-6)',
    JSON.stringify((snap2[k.bans(s.code)] as string[])) === JSON.stringify(snap[k.bans(s.code)])
    && Object.keys(snap).filter(x => !/:gen$/.test(x)).every(x => JSON.stringify(snap[x]) === JSON.stringify(snap2[x])))
  // empty-roster anon-hosted Postgres-backed session
  const an = await createSession({})
  const V = await mkUser('Visitor once')
  await enter(an.code, { cookie: V.cookie }, 'Visitor V')
  await call(bansRoute.POST, 'POST', `/api/session/${an.code}/bans`, { anon: an.anon }, { identityId: `u:${V.id}`, mode: 'ban' }, { code: an.code })
  await wipeCache(an.code)
  check('an empty-roster anon-hosted session rebuilds once', (await ensureSessionLive(an.code)) === 'live')
  const c2 = await monitored(() => ensureSessionLive(an.code))
  check('…and reads live afterwards with no writes (R2-10)', !c2.some(c => /"(set|hsetnx|sadd)"/i.test(c)))
  // absent
  const gone = await createSession({ cookie: H.cookie })
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${gone.code}`, { cookie: H.cookie }, undefined, { code: gone.code })
  check("soft-deleted → 'absent'", (await ensureSessionLive(gone.code)) === 'absent')
  const anonOnly = await createSession({})
  await wipeCache(anonOnly.code)
  check("anonymous-only with its keys gone → 'absent' (404)", (await ensureSessionLive(anonOnly.code)) === 'absent' && (await state(anonOnly.code, {})).status === 404)
  // restoring
  await wipeCache(s.code)
  const held = (await acquireSessionLock(s.code))!
  const t0 = Date.now()
  const r = await state(s.code, { cookie: H.cookie })
  await releaseSessionLock(s.code, held)
  check("lock held past the wait → 503 + Retry-After, never 404", r.status === 503 && r.headers.get('retry-after') === '1' && Date.now() - t0 >= 2900, { status: r.status, ms: Date.now() - t0 })
}

// ── § 4 NX/XX after a wipe ──────────────────────────────────────────────────
async function nxxx() {
  section('§ 4 NX/XX — a stale writer recreates nothing')
  const H = await mkUser('Host N', { pro: true })
  const s = await createSession({ cookie: H.cookie })
  await addWine(s.code, { cookie: H.cookie }, 'w')
  const anon = await createSession({})
  const w = await addWine(anon.code, { anon: anon.anon }, 'anon wine')
  const token = (await acquireSessionLock(anon.code))!
  await wipeCache(anon.code)
  const fence = { code: anon.code, token, client: redis, exec: (b: Parameters<typeof fencedExec>[2]) => fencedExec(anon.code, token, b) }
  const mw = await mutateWines(fence, ws => [...ws, { id: 'stale', name: 's', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]).then(() => 'wrote', e => e)
  await releaseSessionLock(anon.code, token)
  check('mutateWines on an absent lineup rejects (ContractCold), creates nothing', mw instanceof ContractCold && !(await redis.exists(k.wines(anon.code))))
  check('settings PATCH after a wipe of an anonymous-only session → 404, nothing recreated', (await settings(anon.code, { anon: anon.anon }, { name: 'x' })).status === 404 && (await scanKeys(`s:${anon.code}:*`)).length === 0)
  void w
  // a stale XX write never recreates meta
  await redis.del(k.meta(s.code))
  await redis.set(k.meta(s.code), '{}', { XX: true, KEEPTTL: true })
  check('SET meta XX on an absent key creates nothing', !(await redis.exists(k.meta(s.code))))
  check('…and the next request rebuilds it from the record', (await state(s.code, { cookie: H.cookie })).status === 200 && !!(await metaOf(s.code))?.createdAt)
  const lint = spawn(process.execPath, [pjoin(REPO, 'scripts', 'tests', 'lint-boundary-units.mjs')], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  const lintOk = await new Promise<boolean>(r => lint.on('exit', c => r(c === 0)))
  check('the lint gate pins (bare SET of meta/wines is an error) pass', lintOk)
}


// ── § 5 B1 schedules (§ 5.4) ────────────────────────────────────────────────
async function b1() {
  section('§ 5 B1 schedules — the advisory lock orders, the lease only fences')
  const H = await mkUser('Host B1'), T = await mkUser('Target T1')
  const s = await createSession({ cookie: H.cookie })
  await enter(s.code, { cookie: T.cookie }, 'Target T1')
  // (1) role A paused holding the advisory lock before its write; lease expires; B queues
  lockTiming.leaseMs = 800
  const pa = pauseAt('locked', s.code, 'set-role')
  const A = setRole(s.code, { cookie: H.cookie }, `u:${T.id}`, 'co_host')
  await pa.entered
  lockTiming.leaseMs = 15_000
  const Bq = setRole(s.code, { cookie: H.cookie }, `u:${T.id}`, 'provider')
  check('(1) B waits on the advisory lock A holds (assert B blocked)', await blockedOnLock(Bq))
  check('…meanwhile the target has no host power (record: taster)', (await settings(s.code, { cookie: T.cookie }, { name: 'x' })).status === 403)
  pa.release()
  const [ra, rb] = [await A, await Bq]
  const role = (await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: T.id, sessionCode: s.code } } }))?.role
  // A's refused projection may have invalidated meta after B's entry check (B's
  // XX projection then lands on nothing): the next open rebuilds from the record.
  await state(s.code, { cookie: H.cookie })
  const m = await metaOf(s.code)
  check('…A commits, B then applies its intent: both stores hold B\'s role', ra.status === 200 && rb.status === 200 && role === 'provider'
    && (m?.providerIds as string[]).includes(`u:${T.id}`) && !(m?.coHostIds as string[]).includes(`u:${T.id}`), { ra: ra.status, rb: [rb.status, rb.json], role, m: { c: m?.coHostIds, p: m?.providerIds } })
  // (2) promotion paused after its snapshot; anonymous add queued; lease expired
  const an = await createSession({})
  await addWine(an.code, { anon: an.anon }, 'before promotion')
  const V = await mkUser('Promoter V')
  await join(an.code, { cookie: V.cookie }, 'Visitor V')
  lockTiming.leaseMs = 800
  const pp = pauseAt('beforeCommit', an.code, 'promote')
  const vis = visit(an.code, { cookie: V.cookie })
  await pp.entered
  lockTiming.leaseMs = 15_000
  const add = call(winesRoute.POST, 'POST', `/api/session/${an.code}/wines`, { anon: an.anon }, { name: 'concurrent add', type: 'red' }, { code: an.code })
  check('(2) the anonymous add waits on the advisory lock promotion holds', await blockedOnLock(add))
  pp.release()
  const [rv, radd] = [await vis, await add]
  const addedId = radd.json?.id as string
  check('…promotion commits, the add finds the row and mirrors: the wine is in Postgres exactly once', rv.status === 200 && radd.status === 200
    && (await prisma.wine.count({ where: { id: addedId } })) === 1 && (await redisWines(an.code)).some(w => w.id === addedId), { rv: rv.status, radd: [radd.status, radd.json] })
  // (3) old content mirror paused after its write; successor queued; released
  const w1 = await addWine(s.code, { cookie: H.cookie }, 'first')
  lockTiming.leaseMs = 800
  const pe = pauseAt('beforeCommit', s.code, 'wine-edit')
  const e1 = editWine(s.code, { cookie: H.cookie }, w1, { name: 'edited by A', type: 'red' })
  await pe.entered
  lockTiming.leaseMs = 15_000
  const e2 = call(winesRoute.POST, 'POST', `/api/session/${s.code}/wines`, { cookie: H.cookie }, { name: 'successor', type: 'white' }, { code: s.code })
  check('(3) the successor waits on the advisory lock', await blockedOnLock(e2))
  pe.release()
  await e1; await e2
  const row = await liveRow(s.code)
  const pg = await prisma.$queryRaw<{ id: string; name: string; position: number }[]>`SELECT id, name, position FROM wines WHERE session_id = ${row.id} ORDER BY position`
  const rw = await redisWines(s.code)
  check('…Postgres holds the successor\'s array (names + positions = Redis)', JSON.stringify(pg.map(w => [w.id, w.name])) === JSON.stringify(rw.map(w => [w.id, w.name])) && pg.some(w => w.name === 'edited by A'), { pg, rw: rw.map(w => w.name) })
  // (4) DELETE loses its lease before its wipe
  const d = await createSession({ cookie: H.cookie })
  await addWine(d.code, { cookie: H.cookie }, 'w')
  lockTiming.leaseMs = 600
  const pd = pauseAt('locked', d.code, 'delete')
  const del = call(codeRoute.DELETE, 'DELETE', `/api/session/${d.code}`, { cookie: H.cookie }, undefined, { code: d.code })
  await pd.entered
  lockTiming.leaseMs = 15_000
  await sleep(700)
  const thief = (await acquireSessionLock(d.code))!
  pd.release()
  const rdel = await del
  await releaseSessionLock(d.code, thief)
  const tomb = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM session_tombstones WHERE code = ${d.code}`
  check('(4) DELETE that lost its lease: 503, row live, no registry row', rdel.status === 503 && !!(await liveRow(d.code)) && tomb[0].n === 0n, rdel.status)
  check('…and the next open serves the session', (await state(d.code, { cookie: H.cookie })).status === 200)
  // (5) A's delayed projection after A was deleted and its code reused by B
  const r5 = await createSession({ cookie: H.cookie })
  const T5 = await mkUser('Target T5')
  await enter(r5.code, { cookie: T5.cookie }, 'Target T5')
  lockTiming.leaseMs = 600
  const p5 = pauseAt('beforeProjection', r5.code, 'set-role')
  const sr5 = setRole(r5.code, { cookie: H.cookie }, `u:${T5.id}`, 'co_host')
  await p5.entered
  lockTiming.leaseMs = 15_000
  await sleep(700)
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${r5.code}`, { cookie: H.cookie }, undefined, { code: r5.code })
  // B: a new anonymous-only incarnation under the same code
  const bMeta = { host: 'B host', name: 'B', createdAt: Date.now(), hostUserId: null, hostIdentityId: 'a:00000000-0000-4000-8000-000000000001', blind: false, coHostIds: [], providerIds: [] }
  await redis.set(k.wines(r5.code), '[]', { NX: true, EX: 600 })
  await redis.set(k.meta(r5.code), JSON.stringify(bMeta), { NX: true, EX: 600 })
  p5.release()
  await sr5
  check('(5) A\'s delayed projection lands on nothing: B\'s keys intact', JSON.stringify(await metaOf(r5.code)) === JSON.stringify(bMeta))
}

// ── § 6 Fencing ─────────────────────────────────────────────────────────────
async function fencing() {
  section('§ 6 fencing — a holder past its lease writes nothing, releases nothing')
  const code = `FENCE${Date.now() % 100000}`
  const t1 = (await acquireSessionLock(code, { leaseMs: 200 }))!
  await sleep(300)
  const t2 = (await acquireSessionLock(code))!
  const r = await fencedExec(code, t1, m => { m.set(`s:${code}:probe`, 'stale') }).then(() => 'wrote', e => e)
  check('the expired holder\'s fenced write is refused', r instanceof LockLost && !(await redis.exists(`s:${code}:probe`)))
  check('…its release does not delete the successor\'s lock', !(await releaseSessionLock(code, t1)) && (await redis.get(sessionLockKey(code))) === t2)
  check('…the successor\'s fenced write lands', (await fencedExec(code, t2, m => { m.set(`s:${code}:probe`, 'ok', { EX: 5 }) }).then(() => true)) && (await redis.get(`s:${code}:probe`)) === 'ok')
  await releaseSessionLock(code, t2); await redis.del(`s:${code}:probe`)
}

// ── § 7 Deletion races and crashes ──────────────────────────────────────────
async function deletions() {
  section('§ 7 deletion races and crashes (R2-1, R2-2, R3-2, R3-7)')
  const H = await mkUser('Host D7')
  // rebuild in flight vs DELETE
  const a = await createSession({ cookie: H.cookie })
  await addWine(a.code, { cookie: H.cookie }, 'w')
  await wipeCache(a.code)
  const pr = pauseAt('beforePublish', a.code)
  const eb = ensureSessionLive(a.code)
  await pr.entered
  const del = call(codeRoute.DELETE, 'DELETE', `/api/session/${a.code}`, { cookie: H.cookie }, undefined, { code: a.code })
  await sleep(400)
  pr.release()
  const [re, rd] = [await eb, await del]
  check('rebuild in flight vs DELETE: the delete waits, then removes everything', re === 'live' && rd.status === 200 && !(await liveRow(a.code)) && (await scanKeys(`s:${a.code}:*`)).length === 0, { re, rd: rd.status })
  // a logged-in rate holding live meta of an anonymous-only session vs its DELETE (phantom row)
  const an = await createSession({})
  const wa = await addWine(an.code, { anon: an.anon }, 'w')
  const L = await mkUser('Late rater')
  check('setup: the late rater joined', (await join(an.code, { cookie: L.cookie }, 'Late L')).status === 200)
  const pl = pauseAt('beforeLock', an.code, 'promote')
  const rl = rate(an.code, { cookie: L.cookie }, wa)
  await pl.entered
  const dl = await call(codeRoute.DELETE, 'DELETE', `/api/session/${an.code}`, { anon: an.anon }, undefined, { code: an.code })
  pl.release()
  const rr = await rl
  check('a rate holding the deleted session\'s meta creates no phantom row', dl.status === 200 && rr.status === 404 && !(await prisma.session.findFirst({ where: { code: an.code } })), { dl: dl.status, rr: rr.status })
  // promotion paused after its checks vs DELETE
  const an2 = await createSession({})
  const V = await mkUser('Promoter V2')
  await join(an2.code, { cookie: V.cookie }, 'Visitor V2')
  lockTiming.leaseMs = 600
  const pp = pauseAt('locked', an2.code, 'promote')
  const vv = visit(an2.code, { cookie: V.cookie })
  await pp.entered
  lockTiming.leaseMs = 15_000
  await sleep(700)
  const dd = call(codeRoute.DELETE, 'DELETE', `/api/session/${an2.code}`, { anon: an2.anon }, undefined, { code: an2.code })
  check('promotion paused vs DELETE: the delete waits on the advisory lock', await blockedOnLock(dd))
  pp.release()
  await vv; await dd
  const t2 = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM session_tombstones WHERE code = ${an2.code}`
  check('…nothing live survives, the registry row exists', !(await liveRow(an2.code)) && t2[0].n >= 1n)
  // ban in flight vs DELETE
  const b = await createSession({ cookie: H.cookie })
  const Bn = await mkUser('Banned in flight')
  await enter(b.code, { cookie: Bn.cookie }, 'Banned Bn')
  const pb = pauseAt('beforeCommit', b.code, 'ban')
  const bq = ban(b.code, { cookie: H.cookie }, `u:${Bn.id}`, 'ban')
  await pb.entered
  const db = call(codeRoute.DELETE, 'DELETE', `/api/session/${b.code}`, { cookie: H.cookie }, undefined, { code: b.code })
  await sleep(300)
  pb.release()
  await bq; await db
  check('ban in flight vs DELETE: no ban row survives', (await prisma.sessionBan.count({ where: { sessionCode: b.code } })) === 0 && !(await liveRow(b.code)))
  // DELETE's worker killed after its wipe, before COMMIT
  const c = await createSession({ cookie: H.cookie })
  await addWine(c.code, { cookie: H.cookie }, 'w')
  const kd = await killedAt({ module: 'app/api/session/[code]/route.ts', method: 'DELETE', path: `/api/session/${c.code}`, actor: { cookie: H.cookie }, params: { code: c.code }, killAt: 'beforeCommit', label: 'delete' })
  const tc = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM session_tombstones WHERE code = ${c.code}`
  check('DELETE killed after its wipe before COMMIT: row live, no registry row, keys gone', kd.killed && !!(await liveRow(c.code)) && tc[0].n === 0n && !(await redis.exists(k.meta(c.code))), kd)
  check('…the next open rebuilds it', (await state(c.code, { cookie: H.cookie })).status === 200 && (await redisWines(c.code)).length === 1)
  // a terminated rebuild whose lease expired: DELETE completes; the rebuild's publish is refused
  const z = await createSession({ cookie: H.cookie })
  await addWine(z.code, { cookie: H.cookie }, 'w')
  await wipeCache(z.code)
  lockTiming.leaseMs = 600
  const pz = pauseAt('beforePublish', z.code)
  const ez = ensureSessionLive(z.code).catch(e => e)
  await pz.entered
  lockTiming.leaseMs = 15_000
  await terminate(z.code)
  await sleep(700)
  const dz = await call(codeRoute.DELETE, 'DELETE', `/api/session/${z.code}`, { cookie: H.cookie }, undefined, { code: z.code })
  pz.release()
  await ez
  check('a zombie rebuild publishes nothing after the DELETE', dz.status === 200 && (await scanKeys(`s:${z.code}:*`)).length === 0, dz.status)
  // anonymous-only DELETE, then a stale promotion
  const ao = await createSession({})
  const staleMeta = (await metaOf(ao.code))!
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${ao.code}`, { anon: ao.anon }, undefined, { code: ao.code })
  const { ensurePromoted } = await import('../../lib/session.ts')
  const sp = await ensurePromoted(ao.code, staleMeta as never).then(() => 'promoted', e => e?.constructor?.name)
  check('anonymous-only DELETE: keys gone, registry row, a later stale promotion creates nothing',
    (await scanKeys(`s:${ao.code}:*`)).length === 0 && sp !== 'promoted' && !(await prisma.session.findFirst({ where: { code: ao.code } })), sp)
  // the registry alone fences a stale promotion: the deleted incarnation's meta
  // comes back (a replayed key), the promotion's entry checks all pass
  await redis.set(k.wines(ao.code), '[]', { NX: true, EX: 600 })
  await redis.set(k.meta(ao.code), JSON.stringify(staleMeta), { NX: true, EX: 600 })
  const sp2 = await ensurePromoted(ao.code, staleMeta as never).then(() => 'promoted', e => e?.constructor?.name)
  check('…even with the deleted incarnation\'s meta replayed, the registry refuses the promotion', sp2 !== 'promoted' && !(await prisma.session.findFirst({ where: { code: ao.code } })), sp2)
  await wipeCache(ao.code)
}

// ── § 8 D1 — the blind crash ────────────────────────────────────────────────
async function d1() {
  section('§ 8 D1 — settings tighten the cache BEFORE COMMIT (blind crash)')
  const H = await mkUser('Host D1', { pro: true }), T = await mkUser('Taster D1')
  const s = await createSession({ cookie: H.cookie })
  await enter(s.code, { cookie: T.cookie }, 'Taster D1')
  const w = await addWine(s.code, { cookie: H.cookie }, 'Identity to hide')
  const kd = await killedAt({ module: 'app/api/session/[code]/settings/route.ts', method: 'PATCH', path: `/api/session/${s.code}/settings`, actor: { cookie: H.cookie }, body: { blind: true, hideLineup: true, hideLineupMinutesBefore: 0, dateFrom: new Date(Date.now() + 86400_000).toISOString() }, params: { code: s.code }, killAt: 'afterCommit', label: 'settings' })
  const rec = await prisma.session.findFirst({ where: { code: s.code, deletedAt: null }, select: { blind: true, hideLineup: true } })
  check('worker killed after COMMIT, before the projection: the record is blind', kd.killed && rec?.blind === true && rec.hideLineup === true, { kd, rec })
  const meta = await metaOf(s.code)
  check('…the cache was tightened before COMMIT (blind, hideLineup, later reveal time)', meta?.blind === true && meta?.hideLineup === true && Date.parse(String(meta?.dateFrom)) > Date.now() + 3600_000, meta)
  const wg = await winesGet(s.code, { cookie: T.cookie })
  check('…tasters do not see the wine (lineup hidden, nothing to identify)', wg.status === 200 && !(wg.json as unknown as { name: string }[]).some(x => x.name === 'Identity to hide'), wg.json)
  void w
}


// ── § 9 B2 schedules, roster, a member-less author ──────────────────────────
async function b2() {
  section('§ 9 B2 — one eligibility rule, reconciliation both ways')
  const H = await mkUser('Host B2'), U = await mkUser('Kicked U'), R = await mkUser('Author R')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  await enter(s.code, { cookie: U.cookie }, 'Kicked U')
  await rate(s.code, { cookie: U.cookie }, w)
  // (1) kick committed, its cache cleanup "never ran"
  await ban(s.code, { cookie: H.cookie }, `u:${U.id}`, 'kick')
  await redis.hSet(k.identities(s.code), `u:${U.id}`, 'Kicked U')
  await redis.sRem(k.kicked(s.code), `u:${U.id}`)
  const p1 = await state(s.code, { cookie: U.cookie })
  check('(1) kick whose cleanup never ran: the user\'s next poll answers removed', p1.status === 401 && p1.headers.get('x-vr-auth') === 'removed')
  await ensureSessionLive(s.code, { force: true })
  const rv = (await state(s.code, { cookie: H.cookie })).json.ratings as Record<string, unknown>
  check('…after reconciliation their ratings are hidden from live views, kept in their history', !rv?.[`u:${U.id}`] && (await prisma.rating.count({ where: { userId: U.id } })) === 1)
  check('…roster: absent from identities, present in kicked', !(await redis.hExists(k.identities(s.code), `u:${U.id}`)) && await redis.sIsMember(k.kicked(s.code), `u:${U.id}`))
  // (4) explicit /join re-admits; /join while banned is rejected
  check('(4) explicit /join after a kick re-admits', (await join(s.code, { cookie: U.cookie }, 'Kicked U')).status === 200 && (await state(s.code, { cookie: U.cookie })).status === 200)
  // (2) evict only identities for a historical author with no member row
  await enter(s.code, { cookie: R.cookie }, 'Author R')
  await rate(s.code, { cookie: R.cookie }, w)
  await prisma.sessionMember.deleteMany({ where: { userId: R.id, sessionCode: s.code } })
  await redis.del(k.identities(s.code))
  const p2 = await state(s.code, { cookie: R.cookie })
  check('(2) identities evicted: a member-less author\'s poll answers 200 and the hash holds them again', p2.status === 200 && await redis.hExists(k.identities(s.code), `u:${R.id}`), p2.status)
  // kick-keep of that member-less author stays kicked across a rebuild (r1-4)
  await ban(s.code, { cookie: H.cookie }, `u:${R.id}`, 'kick')
  await wipeCache(s.code)
  await ensureSessionLive(s.code)
  check('kick-keep of a member-less author stays kicked across a rebuild (r1-4)', !(await redis.hExists(k.identities(s.code), `u:${R.id}`))
    && await redis.sIsMember(k.kicked(s.code), `u:${R.id}`) && (await state(s.code, { cookie: R.cookie })).status === 401)
  // (3) healer with a dead backend: kick completes meanwhile; nothing registers
  const G = await mkUser('Healed G')
  await enter(s.code, { cookie: G.cookie }, 'Healed G')
  await redis.hDel(k.identities(s.code), `u:${G.id}`)
  lockTiming.leaseMs = 600
  const ph = pauseAt('beforeCommit', s.code, 'heal')
  const poll = state(s.code, { cookie: G.cookie })
  await ph.entered
  lockTiming.leaseMs = 15_000
  await terminate(s.code)
  await sleep(700)
  const kq = await ban(s.code, { cookie: H.cookie }, `u:${G.id}`, 'kick')
  ph.release()
  await poll
  check('(3) healer with a dead backend: the kick completes, the heal registers nothing, the poll stays removed', kq.status === 200
    && !(await redis.hExists(k.identities(s.code), `u:${G.id}`)) && (await state(s.code, { cookie: G.cookie })).status === 401)
  // (3b) healthy healer paused: the kick waits, then removes the entry
  const G2 = await mkUser('Healed G2')
  await enter(s.code, { cookie: G2.cookie }, 'Healed G2')
  await redis.hDel(k.identities(s.code), `u:${G2.id}`)
  const ph2 = pauseAt('beforeCommit', s.code, 'heal')
  const poll2 = state(s.code, { cookie: G2.cookie })
  await ph2.entered
  const kick2 = ban(s.code, { cookie: H.cookie }, `u:${G2.id}`, 'kick')
  check('(3b) a kick waits behind a healthy healer', await stillPending(kick2, 500))
  ph2.release()
  await poll2
  check('…then removes the healed entry', (await kick2).status === 200 && !(await redis.hExists(k.identities(s.code), `u:${G2.id}`)))
  // banned /join
  const Bj = await mkUser('Banned join')
  await enter(s.code, { cookie: Bj.cookie }, 'Banned join')
  await ban(s.code, { cookie: H.cookie }, `u:${Bj.id}`, 'ban')
  const jb = await join(s.code, { cookie: Bj.cookie }, 'Banned join')
  check('/join while banned is rejected with the client-contract "banned"', jb.status === 403 && jb.json?.error === 'banned')
}

// ── § 10 Live tombstones, anon host ─────────────────────────────────────────
async function tombstones() {
  section('§ 10 live tombstones · anonymous host')
  const H = await mkUser('Host TB'), X = await mkUser('Doomed TB')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  await enter(s.code, { cookie: X.cookie }, 'Doomed TB')
  await rate(s.code, { cookie: X.cookie }, w)
  await deleteAccountDurable(X.id)
  await redis.del(k.wines(s.code))   // partial loss
  await ensureSessionLive(s.code)
  const ids = await redis.hGetAll(k.identities(s.code))
  check('partial rebuild over a live-migrated d: rater → exactly one roster entry for them', Object.keys(ids).filter(id => id.startsWith('d:')).length === 1 && !ids[`u:${X.id}`])
  await redis.hSet(k.identities(s.code), 'u:999999991', 'Ghost')
  await redis.set(k.rating(s.code, 'u:999999991', w), JSON.stringify({ score: 1, flavors: {}, notes: '', at: 1 }))
  await ensureSessionLive(s.code, { force: true })
  check('a u: entry whose user is gone is removed, with its rating keys', !(await redis.hExists(k.identities(s.code), 'u:999999991')) && !(await redis.exists(k.rating(s.code, 'u:999999991', w))))
  // anonymous host
  const an = await createSession({})
  const C = await mkUser('Cohost AH'), T = await mkUser('Taster AH')
  await enter(an.code, { cookie: C.cookie }, 'Cohost AH')
  await enter(an.code, { cookie: T.cookie }, 'Taster AH')
  await setRole(an.code, { anon: an.anon }, `u:${C.id}`, 'co_host')
  const wa = await addWine(an.code, { cookie: C.cookie }, 'by cohost')
  await wipeCache(an.code)
  await ensureSessionLive(an.code)
  const m = await metaOf(an.code)
  check('anon host: the rebuilt meta has no hostIdentityId (ruling 4)', !!m && !m.hostIdentityId && m.hostUserId === null)
  check('…a taster\'s settings PATCH and DELETE → 403', (await settings(an.code, { cookie: T.cookie }, { name: 'x' })).status === 403
    && (await call(codeRoute.DELETE, 'DELETE', `/api/session/${an.code}`, { cookie: T.cookie }, undefined, { code: an.code })).status === 403)
  check('…the cohost\'s wine edit succeeds', (await editWine(an.code, { cookie: C.cookie }, wa, { name: 'edited', type: 'red' })).status === 200)
  check('…and the cohost may delete the host-less moment (§ 4.5)', (await call(codeRoute.DELETE, 'DELETE', `/api/session/${an.code}`, { cookie: C.cookie }, undefined, { code: an.code })).status === 200)
}

// ── § 11 Eviction belts, 503 never 404 ──────────────────────────────────────
async function belts() {
  section('§ 11 eviction belts · a live row never answers 404')
  const H = await mkUser('Host EB'), B = await mkUser('Banned EB'), K = await mkUser('Kicked EB'), R = await mkUser('Rater EB')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  for (const [u, n] of [[B, 'Banned EB'], [K, 'Kicked EB'], [R, 'Rater EB']] as const) await enter(s.code, { cookie: u.cookie }, n)
  await rate(s.code, { cookie: R.cookie }, w)
  await ban(s.code, { cookie: H.cookie }, `u:${B.id}`, 'ban')
  await ban(s.code, { cookie: H.cookie }, `u:${K.id}`, 'kick')
  await redis.del(k.bans(s.code))
  const v = await visit(s.code, { cookie: B.cookie }), j = await join(s.code, { cookie: B.cookie }, 'Banned EB'), p = await state(s.code, { cookie: B.cookie })
  check('bans evicted: the banned user\'s /visit, /join and poll are bounced', v.status === 401 && j.status === 403 && p.status === 401)
  check('…and the set contains them again', await redis.sIsMember(k.bans(s.code), `u:${B.id}`))
  await redis.del(k.kicked(s.code))
  check('kicked evicted: /visit bounces and re-seeds', (await visit(s.code, { cookie: K.cookie })).status === 401 && await redis.sIsMember(k.kicked(s.code), `u:${K.id}`))
  await redis.del(k.kicked(s.code))
  const jk = await join(s.code, { cookie: K.cookie }, 'Kicked EB')
  check('…/join admits and clears removed_state', jk.status === 200 && (await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: K.id, sessionCode: s.code } } }))?.removedState === null)
  for (const key of await scanKeys(`s:${s.code}:r:*`)) await redis.del(key)
  const rr = await call(ratingsRoute.GET, 'GET', `/api/session/${s.code}/ratings`, { cookie: H.cookie }, undefined, { code: s.code })
  check('rating keys evicted: the next /ratings read restores them (scan trigger)', rr.status === 200 && !!(rr.json as Record<string, unknown>)[`u:${R.id}`])
  // a wines-only eviction before the rate POST's wine check (r1-9 / r2)
  const pr = pauseAt('beforeLock', s.code, 'rate')
  const rq = rate(s.code, { cookie: R.cookie }, w, 5)
  await pr.entered
  await redis.del(k.wines(s.code))
  pr.release()
  const rres = await rq
  check('wines evicted between open and the rate\'s wine check → 200 after a rebuild, never 404', rres.status === 200 && (await redisWines(s.code)).length === 1, rres.status)
  // an invalidation (meta gone) right before a contract → 200, never 404
  await redis.del(k.meta(s.code))
  check('meta invalidated before a write → the write rebuilds and succeeds', (await addWine(s.code, { cookie: H.cookie }, 'after invalidation')).length > 0)
  // eviction of everything → the moment is intact through the real routes
  await wipeCache(s.code)
  const st = await state(s.code, { cookie: H.cookie })
  check('every key gone → the state poll answers 200 with the moment intact', st.status === 200 && (st.json.wines as unknown[]).length === 2)
}

// ── § 12 Code recycling, member rows, counters ──────────────────────────────
async function recycling() {
  section('§ 12 code recycling · durable roles only from the record · create counters')
  // an orphan member row for a recycled code grants nothing
  const an = await createSession({})
  const U = await mkUser('Orphan U')
  await prisma.$executeRaw`INSERT INTO session_members (user_id, session_code, role) VALUES (${U.id}, ${an.code}, 'co_host')`
  await join(an.code, { cookie: U.cookie }, 'Orphan U')
  check('an orphan co_host row for a Redis-only code grants nothing', (await settings(an.code, { cookie: U.cookie }, { name: 'x' })).status === 403)
  const V = await mkUser('Promoter RC')
  await enter(an.code, { cookie: V.cookie }, 'Promoter RC')
  const m = await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: U.id, sessionCode: an.code } } })
  check('…promotion deletes it first and writes the role from the cache (taster)', !!(await liveRow(an.code)) && m?.role === 'taster', m)
  // a stale cached cohost entry never becomes a durable role through /visit
  const H = await mkUser('Host RC')
  const before = await prisma.user.findUniqueOrThrow({ where: { id: H.id }, select: { lifetimeSessionsHosted: true, lifetimeSessionsJoined: true } })
  const s = await createSession({ cookie: H.cookie })
  check('the logged-in host reads with no /visit (member row from create)', (await state(s.code, { cookie: H.cookie })).status === 200
    && (await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: H.id, sessionCode: s.code } } }))?.role === 'host')
  await visit(s.code, { cookie: H.cookie })
  const after = await prisma.user.findUniqueOrThrow({ where: { id: H.id }, select: { lifetimeSessionsHosted: true, lifetimeSessionsJoined: true } })
  check('create bumps hosted + joined once; the host\'s later /visit bumps nothing (r4-3)', after.lifetimeSessionsHosted === before.lifetimeSessionsHosted + 1 && after.lifetimeSessionsJoined === before.lifetimeSessionsJoined + 1, { before, after })
  const T = await mkUser('Stale cohost T')
  await join(s.code, { cookie: T.cookie }, 'Stale cohost T')
  await prisma.sessionMember.deleteMany({ where: { userId: T.id, sessionCode: s.code } })
  const meta = (await metaOf(s.code))!
  await redis.set(k.meta(s.code), JSON.stringify({ ...meta, coHostIds: [`u:${T.id}`] }), { XX: true, KEEPTTL: true })
  await visit(s.code, { cookie: T.cookie })
  check('a stale cached cohost entry never becomes a durable role through /visit (r1-3)', (await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: T.id, sessionCode: s.code } } }))?.role === 'taster')
  // r2-1: create vs a paused promotion on the same code after a flush
  const { codeTestQueue } = await import('../../lib/sessionCode.ts')
  const p = await createSession({})
  const O = await mkUser('Old member O')
  await join(p.code, { cookie: O.cookie }, 'Old member O')
  await setRole(p.code, { anon: p.anon }, `u:${O.id}`, 'co_host')
  const pp = pauseAt('locked', p.code, 'promote')
  const vis = visit(p.code, { cookie: O.cookie })
  await pp.entered
  await wipeCache(p.code)   // the flush lands under the paused promotion
  codeTestQueue.push(p.code)
  const cr = call(sessionRoute.POST, 'POST', '/api/session', {}, { hostDisplayName: 'New host', sessionName: 'new', dateFrom }, {})
  const crRes = await cr
  pp.release()
  await vis
  created.push(crRes.json.code as string)
  check('(r2-1) a create while the code\'s promotion holds its locks takes ANOTHER code', crRes.status === 200 && crRes.json.code !== p.code, crRes.json)
  const newCode = crRes.json.code as string
  const g = await settings(newCode, { cookie: O.cookie }, { name: 'x' })
  check('…and no old member gets a grant in it', g.status === 401 || g.status === 403, g.status)
  // code review r1 P1-1/P1-2: ONE incarnation per request — a code deleted and
  // reused between a route's open and its grant read / its contract refuses.
  const { participantOrBanned } = await import('../../lib/identity.ts')
  const { resolveUser } = await import('../../lib/resolveUser.ts')
  const R = await mkUser('Recycler R', { pro: true })
  const ra = await createSession({ cookie: R.cookie })
  const metaA = (await metaOf(ra.code))!
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${ra.code}`, { cookie: R.cookie }, undefined, { code: ra.code })
  codeTestQueue.push(ra.code)
  const rb = await createSession({ cookie: R.cookie })
  check('setup: the code was reused by a new moment of the same host', rb.code === ra.code)
  const preq = request('GET', `/api/session/${ra.code}/state`, { cookie: R.cookie })
  const adm = await participantOrBanned(ra.code, preq, await resolveUser(preq), metaA)
  check('(r1 P1-1) a grant of the successor never admits against the opened snapshot of the predecessor → unavailable', adm.status === 'unavailable', adm.status)
  const admB = await participantOrBanned(rb.code, preq, await resolveUser(preq), (await metaOf(rb.code))!)
  check('…while the same caller against the successor\'s own snapshot is admitted', admB.status === 'ok', admB.status)
  // the wine add paused before its lock; the code is deleted and reused under it
  const pw = pauseAt('beforeLock', rb.code, 'wine-add')
  const late = call(winesRoute.POST, 'POST', `/api/session/${rb.code}/wines`, { cookie: R.cookie }, { name: 'Late from A', type: 'red' }, { code: rb.code })
  await pw.entered
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${rb.code}`, { cookie: R.cookie }, undefined, { code: rb.code })
  codeTestQueue.push(rb.code)
  const rc2 = await createSession({ cookie: R.cookie })
  pw.release()
  const lateRes = await late
  const cWines = JSON.parse((await redis.get(k.wines(rc2.code))) ?? '[]') as { name: string }[]
  const pgLate = await prisma.wine.count({ where: { name: 'Late from A', session: { code: rc2.code, deletedAt: null } } })
  check('(r1 P1-2) a wine add opened against the predecessor never lands in the successor', rc2.code === rb.code && lateRes.status >= 400 && !cWines.some(w => w.name === 'Late from A') && pgLate === 0, { status: lateRes.status, code: rc2.code === rb.code, pgLate })
}


// ── § 13 The generation, zombie rebuilds, content races ─────────────────────
async function generation() {
  section('§ 13 publication generation · zombie rebuilds · content races (r2-2 … r5-1)')
  const H = await mkUser('Host G13', { pro: true }), R = await mkUser('Rater G13')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  await enter(s.code, { cookie: R.cookie }, 'Rater G13')
  const key = k.rating(s.code, `u:${R.id}`, w)
  const feedId = async (u: User) => (await prisma.feedItem.findFirstOrThrow({ where: { userId: u.id, kind: 'session' }, select: { id: true } })).id
  const patch = async (u: User, body: Record<string, unknown>) => { const id = await feedId(u); return call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${id}`, { cookie: u.cookie }, body, { id: String(id) }) }
  const scoreOf = async () => { const raw = await redis.get(key); return raw ? JSON.parse(raw).score : null }

  // r2-2: force rebuild paused before its publish; rate DELETE waits; released
  await rate(s.code, { cookie: R.cookie }, w, 3)
  const p1 = pauseAt('beforePublish', s.code)
  const e1 = ensureSessionLive(s.code, { force: true })
  await p1.entered
  const d1 = unrate(s.code, { cookie: R.cookie }, w)
  check('(r2-2) the rate DELETE waits on the rebuild\'s lease', await stillPending(d1, 500))
  p1.release()
  await e1
  check('…released: the deleted rating is not republished', (await d1).status === 200 && !(await redis.exists(key)) && (await prisma.rating.count({ where: { userId: R.id, wineId: w } })) === 0)
  // r3-3: same, the rebuild's backend terminated after its read (lease still valid)
  await rate(s.code, { cookie: R.cookie }, w, 3)
  const p2 = pauseAt('beforePublish', s.code)
  const e2 = ensureSessionLive(s.code, { force: true }).catch(e => e)
  await p2.entered
  await terminate(s.code)
  const d2 = unrate(s.code, { cookie: R.cookie }, w)
  check('(r3-3) the rate DELETE waits on the zombie\'s lease (not on Postgres)', await stillPending(d2, 500))
  p2.release()
  await e2
  check('…the DELETE completes after it: no ghost rating', (await d2).status === 200 && !(await redis.exists(key)) && (await prisma.rating.count({ where: { userId: R.id, wineId: w } })) === 0)
  // r4-1: a cold rebuild's backend dies after its read; a non-reaping check-in PATCH commits v2
  await rate(s.code, { cookie: R.cookie }, w, 3)
  await wipeCache(s.code)
  const p3 = pauseAt('beforePublish', s.code)
  const e3 = ensureSessionLive(s.code).catch(e => e)
  await p3.entered
  await terminate(s.code)
  const pa = await patch(R, { wineId: w, score: 4.5 })
  p3.release()
  const z3 = await e3
  check('(r4-1) the check-in PATCH commits v2 while the zombie holds its lease', pa.status === 200)
  check('…the zombie\'s stale publish is refused by the generation', z3 === 'restoring' || z3 instanceof Error, String(z3))
  check('…and the cache never holds v1', (await scoreOf()) !== 3)
  await state(s.code, { cookie: H.cookie })
  check('…the next open rebuilds v2', (await scoreOf()) === 4.5)
  // gen evicted between the read and the publish
  await wipeCache(s.code)
  const p4 = pauseAt('beforePublish', s.code)
  const e4 = ensureSessionLive(s.code)
  await p4.entered
  await redis.del(k.gen(s.code))
  p4.release()
  check('a generation evicted mid-rebuild refuses the publish (fail-safe)', (await e4) === 'restoring' && !(await redis.exists(k.meta(s.code))))
  // r4-2: account deletion anonymizes S while a terminated rebuild holds S's lease; the migration fails
  const X = await mkUser('Doomed G13')
  await enter(s.code, { cookie: X.cookie }, 'Doomed G13')
  await rate(s.code, { cookie: X.cookie }, w, 2)
  await wipeCache(s.code)
  const p5 = pauseAt('beforePublish', s.code)
  const e5 = ensureSessionLive(s.code).catch(e => e)
  await p5.entered
  await terminate(s.code)
  await deleteAccountDurable(X.id, { hooks: { failProjection: true } })
  p5.release()
  await e5
  check('(r4-2) the zombie publish after the deletion is refused (invalidation bumped the generation)', !(await redis.exists(k.rating(s.code, `u:${X.id}`, w))))
  await state(s.code, { cookie: H.cookie })
  const ids = await redis.hGetAll(k.identities(s.code))
  check('…the next open rebuilds the deleted user as [deleted]', !ids[`u:${X.id}`] && Object.entries(ids).some(([id, n]) => id.startsWith('d:') && n === '[deleted]'))
  // r3-2: wine PATCH prepared before its lock, host hides the wine meanwhile
  await call(revealRoute.POST, 'POST', `/api/session/${s.code}/wines/${w}/reveal`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w })
  const p6 = pauseAt('beforeLock', s.code, 'wine-edit')
  const ed = editWine(s.code, { cookie: H.cookie }, w, { name: 'renamed', type: 'red' })
  await p6.entered
  await call(revealRoute.DELETE, 'DELETE', `/api/session/${s.code}/wines/${w}/reveal`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w })
  p6.release()
  await ed
  check('(r3-2) the edit prepared before a concurrent hide keeps the wine hidden', !(await redisWines(s.code)).find(x => x.id === w)?.revealedAt
    && !(await prisma.wine.findUnique({ where: { id: w }, select: { revealedAt: true } }))?.revealedAt)
  // r2-3: cold rebuild paused after its read; a session-rating check-in PATCH waits; cache ends on v2
  await rate(s.code, { cookie: R.cookie }, w, 1)
  await wipeCache(s.code)
  const p7 = pauseAt('beforePublish', s.code)
  const e7 = ensureSessionLive(s.code)
  await p7.entered
  const pq = patch(R, { wineId: w, score: 2 })
  check('(r2-3) the check-in PATCH waits on the rebuild\'s advisory lock', await blockedOnLock(pq))
  p7.release()
  await e7
  check('…released: the cache ends on v2', (await pq).status === 200 && (await scoreOf()) === 2)
  // stale-mirror ordering (R1-3): the rebuild stamps mirror_at, not rated_at
  await prisma.$executeRaw`UPDATE ratings SET rated_at = rated_at - interval '1 hour' WHERE user_id = ${R.id} AND wine_id = ${w}`
  await wipeCache(s.code)
  await ensureSessionLive(s.code)
  const row = (await prisma.$queryRaw<{ ms: number }[]>`SELECT floor(extract(epoch from mirror_at) * 1000)::float8 AS ms FROM ratings WHERE user_id = ${R.id} AND wine_id = ${w}`)[0]
  check('(R1-3) the rebuilt `at` is the durable mirror token, not rated_at', JSON.parse((await redis.get(key))!).at === row.ms)
  // r3-4: a kick-keep owner edits their retained rating; cold + soft-deleted are PG-only
  await ban(s.code, { cookie: H.cookie }, `u:${R.id}`, 'kick')
  check('(r3-4) a kick-keep owner may still edit their rating (owner admission)', (await patch(R, { wineId: w, score: 3.5 })).status === 200)
  await wipeCache(s.code)
  check('…a cold session edits PG-only (no key written)', (await patch(R, { wineId: w, score: 3.75 })).status === 200 && !(await redis.exists(key))
    && Number((await prisma.rating.findFirst({ where: { userId: R.id, wineId: w } }))?.score) === 3.75)
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${s.code}`, { cookie: H.cookie }, undefined, { code: s.code })
  check('…a soft-deleted session edits PG-only', (await patch(R, { wineId: w, score: 4 })).status === 200 && Number((await prisma.rating.findFirst({ where: { userId: R.id, wineId: w } }))?.score) === 4)
  // code review r1 — a fresh moment for the fence cases
  const s2 = await createSession({ cookie: H.cookie })
  const w2 = await addWine(s2.code, { cookie: H.cookie }, 'w2')
  await enter(s2.code, { cookie: R.cookie }, 'Rater G13')
  const key2 = k.rating(s2.code, `u:${R.id}`, w2)
  // P2-3: an edit that empties the rating through a note only scrub() empties
  // (U+200B) deletes the key — so it takes the Redis lease (here: waits on it)
  await rate(s2.code, { cookie: R.cookie }, w2, 0, { notes: 'only a note' })
  const held = await acquireSessionLock(s2.code, { waitMs: 1000 })
  const zw = (async () => { const id = await prisma.feedItem.findFirst({ where: { userId: R.id, kind: 'session', sessionId: (await liveRow(s2.code))!.id }, select: { id: true } }); return call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${id!.id}`, { cookie: R.cookie }, { wineId: w2, score: 0, flavors: {}, aromas: [], notes: '\u200b' }, { id: String(id!.id) }) })()
  check('(r1 P2-3) a reaping check-in edit (zero-width note) waits for the Redis lease', await stillPending(zw, 800))
  await releaseSessionLock(s2.code, held!)
  const zr = await zw
  check('…then reaps the rating and its key under it', zr.status === 200 && !(await redis.exists(key2)) && !(await prisma.rating.findFirst({ where: { userId: R.id, wineId: w2 } })), zr.status)
  // P2-6: a rating-key write fenced by a SUPERSEDED generation is a no-op (a
  // writer whose backend died after its SQL, overtaken by a newer committer)
  await rate(s2.code, { cookie: R.cookie }, w2, 4.5)
  const v2 = await redis.get(key2)
  const { ratingKeyWrite } = await import('../../lib/sessionMutation.ts')
  const staleCtx = { code: s2.code, meta: null, row: null, caller: null, callerStatus: null, fence: null, gen: 'superseded-token' }
  let superseded = false
  try { await ratingKeyWrite(staleCtx, key2, JSON.stringify({ score: 1, flavors: {}, aromas: [], notes: '', at: 1 }), { pxMs: 60_000 }) } catch (e) { superseded = e?.constructor?.name === 'ContractSuperseded' }
  check('(r1 P2-6) a stale writer\'s SET after a newer commit is refused (ContractSuperseded — r2 N2); the newer value stays', superseded && (await redis.get(key2)) === v2 && JSON.parse(v2!).score === 4.5)
  let needsLease = false
  try { await ratingKeyWrite({ ...staleCtx, gen: (await redis.get(k.gen(s2.code)))! }, key2, null) } catch (e) { needsLease = e?.constructor?.name === 'ContractNeedsLease' }
  check('…and a rating-key DEL without the lease is refused structurally (ContractNeedsLease)', needsLease && (await redis.exists(key2)) === 1)
}

// ── § 14 Moderation × provenance ────────────────────────────────────────────
async function moderation() {
  section('§ 14 moderation × provenance (r5-1, r3-5)')
  const H = await mkUser('Host M14'), U = await mkUser('Provider U'), B = await mkUser('Owner B')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'host wine')
  await enter(s.code, { cookie: U.cookie }, 'Provider U'); await enter(s.code, { cookie: B.cookie }, 'Owner B')
  await setRole(s.code, { cookie: H.cookie }, `u:${U.id}`, 'provider')
  const wu = await addWine(s.code, { cookie: U.cookie }, 'U wine')
  await rate(s.code, { cookie: U.cookie }, wu); await rate(s.code, { cookie: U.cookie }, w)
  // r5-1: kick with deleteAddedWines, then the user's own full cleanup
  await ban(s.code, { cookie: H.cookie }, `u:${U.id}`, 'kick', true)
  const lv = await call(leaveRoute.POST, 'POST', `/api/session/${s.code}/leave?cleanup=full`, { cookie: U.cookie }, undefined, { code: s.code })
  const sid = (await liveRow(s.code)).id
  check('(r5-1) full cleanup after a wine-removing kick deletes every rating of theirs in the session, incl. on the orphaned wine',
    lv.status === 200 && (await prisma.rating.count({ where: { userId: U.id, sessionId: sid } })) === 0, lv)
  await ensureSessionLive(s.code, { force: true })
  check('…and a rebuild does not re-admit them', !(await redis.hExists(k.identities(s.code), `u:${U.id}`)) && (await state(s.code, { cookie: U.cookie })).status === 401)
  // r3-5: reassign A→B committed, its projection refused; then kick A with deleteAddedWines
  const A = await mkUser('Provider A')
  await enter(s.code, { cookie: A.cookie }, 'Provider A')
  await setRole(s.code, { cookie: H.cookie }, `u:${A.id}`, 'provider')
  const wa = await addWine(s.code, { cookie: A.cookie }, 'A wine')
  lockTiming.leaseMs = 600
  const pr = pauseAt('beforeProjection', s.code, 'reassign')
  const re = editWine(s.code, { cookie: H.cookie }, wa, { broughtByIdentityId: `u:${B.id}` })
  await pr.entered
  lockTiming.leaseMs = 15_000
  await sleep(700)
  const thief = (await acquireSessionLock(s.code))!
  pr.release()
  const rres = await re
  await releaseSessionLock(s.code, thief)
  check('setup: the reassign committed, its Redis projection was refused', rres.status === 200
    && (await prisma.wine.findUnique({ where: { id: wa }, select: { addedByIdentityId: true } }))?.addedByIdentityId === `u:${B.id}`)
  await ban(s.code, { cookie: H.cookie }, `u:${A.id}`, 'kick', true)
  check('(r3-5) kicking the former owner with deleteAddedWines leaves B\'s wine in Redis and Postgres',
    (await redisWines(s.code)).some(x => x.id === wa) && (await prisma.wine.findUnique({ where: { id: wa }, select: { sessionId: true } }))?.sessionId === sid)
}

// ── § 15 The CHECK and B's migration body ───────────────────────────────────
async function checkConstraint() {
  section('§ 15 ratings_session_rater_known + B\'s migration body (R6-2)')
  const A = readFileSync(pjoin(REPO, 'prisma/migrations/20261108072132_redis_rehydration_release_a/migration.sql'), 'utf8')
  const B = readFileSync(pjoin(REPO, 'prisma/migrations/20261108140000_redis_rehydration_release_b/migration.sql'), 'utf8')
  const recipe = (sql: string) => sql.slice(sql.indexOf('-- @recipe:legacy-tombstones'), sql.indexOf('-- @endrecipe'))
  check('B repeats A\'s legacy catch-up byte for byte', recipe(A).length > 100 && recipe(A) === recipe(B))
  const H = await mkUser('Host CK'), L = await mkUser('Legacy CK')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  await enter(s.code, { cookie: L.cookie }, 'Legacy CK')
  await rate(s.code, { cookie: L.cookie }, w)
  const oldWriter = await prisma.$executeRaw`UPDATE ratings SET user_id = NULL, rater_name = '[deleted]' WHERE user_id = ${L.id} AND session_id IS NOT NULL`.then(() => 'ok', e => String(e))
  check('the OLD account-delete writer is refused by the CHECK', /ratings_session_rater_known/.test(oldWriter), oldWriter)
  const body = B.slice(B.indexOf('BEGIN;') + 6, B.lastIndexOf('COMMIT;'))
  const statements = body.match(/(DO \$\$[\s\S]*?END \$\$;|ALTER TABLE[\s\S]*?;)/g) ?? []
  const ROLLBACK = new Error('rollback')
  const out: Record<string, unknown> = { statements: statements.length }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE ratings DROP CONSTRAINT ratings_session_rater_known')
    await tx.$executeRaw`UPDATE ratings SET user_id = NULL, rater_name = '[deleted]' WHERE user_id = ${L.id} AND session_id IS NOT NULL`
    await tx.$executeRaw`INSERT INTO session_members (user_id, session_code, role) VALUES (${L.id}, 'ORPHAN99', 'co_host')`
    for (const st of statements) await tx.$executeRawUnsafe(st)
    out.stamped = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ratings WHERE session_id IS NOT NULL AND user_id IS NULL AND tombstone_key IS NULL`)[0].n
    out.constraint = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'ratings_session_rater_known'`)[0].n
    out.orphan = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM session_members WHERE session_code = 'ORPHAN99'`)[0].n
    await tx.$executeRawUnsafe('SAVEPOINT p')
    out.rejected = await tx.$executeRawUnsafe(`UPDATE ratings SET tombstone_key = NULL WHERE user_id IS NULL AND session_id IS NOT NULL`)
      .then(() => false, (e) => /ratings_session_rater_known/.test(String(e)))
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT p')
    throw ROLLBACK
  }, { timeout: 30_000 }).catch(e => { if (e !== ROLLBACK) out.error = String(e) })
  check('B\'s migration body on a planted both-NULL row: catch-up stamps it, the CHECK is added, the orphan member row goes',
    out.statements === 4 && out.stamped === 0n && out.constraint === 1n && out.orphan === 0n && !out.error, out)
  check('…and a new both-NULL session rating is rejected', out.rejected === true, out)
}


// ── § 16 Account deletion: leases, 'replan' carry-over ───────────────────────
async function replan() {
  section('§ 16 account deletion — leases and the \'replan\' carry-over (R7-1A)')
  const O = await mkUser('Other rater O16')
  // (a) engaged at discovery, empty before the locks → replan → leased → wiped
  const F = await mkUser('Host F16')
  const a = await createSession({ cookie: F.cookie })
  const wa = await addWine(a.code, { cookie: F.cookie }, 'w')
  await enter(a.code, { cookie: O.cookie }, 'Other O16'); await rate(a.code, { cookie: O.cookie }, wa)
  let discoveries = 0
  const g = gate()
  const pa = deleteAccountDurable(F.id, { hooks: { afterDiscovery: async () => { if (++discoveries === 1) await g.p } } })
  while (discoveries === 0) await sleep(20)
  await unrate(a.code, { cookie: O.cookie }, wa)
  g.open()
  const ra = await pa
  check('(a) a moment that became empty after discovery is replanned, then leased and wiped', discoveries === 2 && ra.plan.toDelete.includes(a.code) && !(await liveRow(a.code)), { discoveries, plan: ra.plan })
  // (b) anonymously rated + its only Postgres rater leaves after discovery → one replan, then anonymized — no loop
  const F2 = await mkUser('Host F16b')
  const b = await createSession({ cookie: F2.cookie })
  const wb = await addWine(b.code, { cookie: F2.cookie }, 'w')
  const anon = await join(b.code, {}, 'Anon rater')
  await rate(b.code, { anon: anon.anon }, wb)
  await enter(b.code, { cookie: O.cookie }, 'Other O16'); await rate(b.code, { cookie: O.cookie }, wb)
  let d2 = 0
  const g2 = gate()
  const pb = deleteAccountDurable(F2.id, { hooks: { afterDiscovery: async () => { if (++d2 === 1) await g2.p } } })
  while (d2 === 0) await sleep(20)
  await unrate(b.code, { cookie: O.cookie }, wb)
  g2.open()
  const rb = await pb
  check('(b) anonymously engaged: one replan, then leased and anonymized — the moment stays live, no loop', d2 === 2 && rb.plan.toPseudonymize.includes(b.code) && !!(await liveRow(b.code))
    && !(await redis.exists(sessionLockKey(b.code))), { d2, plan: rb.plan })
}

// ── Run ─────────────────────────────────────────────────────────────────────
// ── Code review round 2 ─────────────────────────────────────────────────────
async function round2() {
  section('code review r2 — incarnation on cache authority, removed roles, superseded writes, retries, provenance, re-kick, tombstone order')
  const { participantOrBanned } = await import('../../lib/identity.ts')
  const { resolveUser } = await import('../../lib/resolveUser.ts')
  const { codeTestQueue } = await import('../../lib/sessionCode.ts')
  const { withSessionMutation, ratingKeyWrite } = await import('../../lib/sessionMutation.ts')
  // R1-1: a Redis-only successor's roster never admits against the predecessor's snapshot
  const U = await mkUser('Roster U')
  const a = await createSession({})
  const metaA = (await metaOf(a.code))!
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${a.code}`, { anon: a.anon }, undefined, { code: a.code })
  codeTestQueue.push(a.code)
  const b = await createSession({})
  await join(b.code, { cookie: U.cookie }, 'Roster U')
  const req = request('GET', `/api/session/${b.code}/state`, { cookie: U.cookie })
  check('(r2 R1-1) setup: reused by a Redis-only moment the user joined', b.code === a.code && !(await liveRow(b.code)))
  check('(r2 R1-1) cache authority: the successor\'s roster never admits against the predecessor\'s snapshot',
    (await participantOrBanned(b.code, req, await resolveUser(req), metaA)).status === 'unavailable')
  check('…and admits against its own', (await participantOrBanned(b.code, req, await resolveUser(req), (await metaOf(b.code))!)).status === 'ok')

  // R1-6: a wipe and a wine delete bump the generation
  const H = await mkUser('Host R2', { pro: true }), T = await mkUser('Taster R2')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  const w2 = await addWine(s.code, { cookie: H.cookie }, 'w2')
  await enter(s.code, { cookie: T.cookie }, 'Taster R2')
  await rate(s.code, { cookie: T.cookie }, w, 4); await rate(s.code, { cookie: T.cookie }, w2, 4)
  const g0 = await redis.get(k.gen(s.code))
  await call(wineRoute.DELETE, 'DELETE', `/api/session/${s.code}/wines/${w2}`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w2 })
  const g1 = await redis.get(k.gen(s.code))
  await ban(s.code, { cookie: H.cookie }, `u:${T.id}`, 'kick')
  const g2 = await redis.get(k.gen(s.code))
  check('(r2 R1-6) a wine delete and a wipe each bump the generation (a stale unleased SET cannot recreate their deletions)', !!g0 && g1 !== g0 && g2 !== g1 && !!g2)

  // N1: a kicked member gets no role, and a role grants nothing while kicked or cached-banned
  const sr = await setRole(s.code, { cookie: H.cookie }, `u:${T.id}`, 'co_host')
  check('(r2 N1) assigning co_host to a kicked member → 409', sr.status === 409, sr)
  await prisma.$executeRaw`UPDATE session_members SET role = 'co_host' WHERE session_code = ${s.code} AND user_id = ${T.id}`
  const lst = await call(bansRoute.GET, 'GET', `/api/session/${s.code}/bans`, { cookie: T.cookie }, undefined, { code: s.code })
  check('(r2 N1) a kicked member holding co_host in the record gets no host-only moderation read', lst.status === 403 || lst.status === 401, lst.status)
  const C = await mkUser('Cohost R2')
  await enter(s.code, { cookie: C.cookie }, 'Cohost R2')
  await setRole(s.code, { cookie: H.cookie }, `u:${C.id}`, 'co_host')
  check('setup: the cohost reads the ban list', (await call(bansRoute.GET, 'GET', `/api/session/${s.code}/bans`, { cookie: C.cookie }, undefined, { code: s.code })).status === 200)
  await redis.sAdd(k.bans(s.code), `u:${C.id}`)
  const lc = await call(bansRoute.GET, 'GET', `/api/session/${s.code}/bans`, { cookie: C.cookie }, undefined, { code: s.code })
  check('(r2 N1) …a CACHED ban alone (deny-first window) already refuses it', lc.status === 403 || lc.status === 401, lc.status)
  await redis.sRem(k.bans(s.code), `u:${C.id}`)

  // N2: an anonymous rate whose key write is superseded is re-run, never acknowledged unsaved
  const an = await createSession({})
  const aw = await addWine(an.code, { anon: an.anon }, 'anon w')
  const steal = (() => { const prev = mutationHooks.at; let fired = false
    mutationHooks.at = async (pt, c, l) => { if (!fired && pt === 'locked' && c === an.code && l === 'rate') { fired = true; await redis.set(k.gen(an.code), 'someone-else', { XX: true, KEEPTTL: true }) } }
    return () => { mutationHooks.at = prev } })()
  const ar = await rate(an.code, { anon: an.anon }, aw, 3.5)
  steal()
  const akey = (await scanKeys(`s:${an.code}:r:*`))[0]
  check('(r2 N2) a superseded anonymous rating write is re-run: 200 AND the rating is stored', ar.status === 200 && !!akey && JSON.parse((await redis.get(akey))!).score === 3.5, { status: ar.status, akey })

  // N3: cold recovery and the lease upgrade retry independently
  let attempts = 0
  const out = await withSessionMutation(s.code, { label: 'r2-n3', redisLock: false, bumpGen: true }, async (_tx, ctx) => {
    attempts++
    if (attempts === 1) { await redis.del(k.wines(s.code)); throw new ContractCold(s.code) }
    await ratingKeyWrite(ctx, k.rating(s.code, 'u:0', 'none'), null)
    return 'done'
  })
  check('(r2 N3) cold → rebuild, then a lease upgrade → both recover (no shared counter)', out === 'done' && attempts === 3, attempts)

  // N4: a record-backed provider's ownership is the record's; a rebuild repairs stale cached provenance
  const P = await mkUser('Provider R2')
  await enter(s.code, { cookie: P.cookie }, 'Provider R2')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  const pw = await addWine(s.code, { cookie: P.cookie }, 'P wine')
  const stale = (await redisWines(s.code)).map(x => x.id === pw ? { ...x, addedByIdentityId: `u:${H.id}`, addedByDisplayName: 'Someone else' } : x)
  await redis.set(k.wines(s.code), JSON.stringify(stale), { XX: true, KEEPTTL: true })
  const pe = await editWine(s.code, { cookie: P.cookie }, pw, { name: 'P wine edited', type: 'red' })
  check('(r2 N4) stale cached provenance: the record owner\'s edit is decided by the record (200, not 403)', pe.status === 200, pe)
  await redis.set(k.wines(s.code), JSON.stringify((await redisWines(s.code)).map(x => x.id === pw ? { ...x, addedByIdentityId: `u:${H.id}` } : x)), { XX: true, KEEPTTL: true })
  await redis.del(k.meta(s.code))
  check('setup: the next open rebuilds', (await state(s.code, { cookie: H.cookie })).status === 200)
  check('(r2 N4) …and the rebuild repairs the cached provenance from the record', (await redisWines(s.code)).find(x => x.id === pw)?.addedByIdentityId === `u:${P.id}`)

  // N5: a rejoin observed kick #1; another device rejoins, the host kicks again → the paused rejoin does not undo kick #2
  const J = await mkUser('Rejoiner J')
  await enter(s.code, { cookie: J.cookie }, 'Rejoiner J')
  await ban(s.code, { cookie: H.cookie }, `u:${J.id}`, 'kick')
  const pj = pauseAt('beforeLock', s.code, 'join')
  const j1 = join(s.code, { cookie: J.cookie }, 'Rejoiner J')
  await pj.entered
  noHooks()
  const j2 = await join(s.code, { cookie: J.cookie }, 'Rejoiner J')
  await ban(s.code, { cookie: H.cookie }, `u:${J.id}`, 'kick')
  pj.release()
  const j1r = await j1
  const ms = await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: J.id, sessionCode: s.code } }, select: { removedState: true } })
  check('(r2 N5) a paused rejoin of kick #1 does not undo kick #2', j2.status === 200 && j1r.status !== 200 && ms?.removedState === 'kicked', { j2: j2.status, j1: j1r.status, ms })

  // N6: duplicate legacy deleted raters in one tombstone group → the LATEST rating wins the rebuilt key
  const sid = (await liveRow(s.code)).id
  for (const [score, at] of [[2, '2026-01-02'], [5, '2026-03-04'], [3, '2026-02-03']] as const) {
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at, mirror_at, tombstone_key)
      VALUES (${w}, NULL, ${sid}, 'session', '[deleted]', ${score}::numeric, '{}'::jsonb, '[]'::jsonb, NULL, ${at}::timestamptz, ${at}::timestamptz, 'd:legacy-r2')`
  }
  const { recordRatings } = await import('../../lib/sessionRehydrate.ts')
  const rr = await recordRatings(prisma, sid, s.code)
  const tomb = [...rr.entries()].find(([kk]) => kk.includes(':r:d:legacy-r2:'))
  check('(r2 N6) the rebuilt key of a duplicate legacy tombstone group carries the LATEST rating', !!tomb && Number(tomb[1].score) === 5, tomb)
}

// ── Code review round 3 ─────────────────────────────────────────────────────
async function round3() {
  section('code review r3 — cached denial without a grant, kick version incl. absence, bump liveness, provenance patch vs eviction')
  // N1: an anonymous cohost banned before its role strip landed has no moderation power
  const an = await createSession({})
  const jc = await join(an.code, {}, 'Anon Cohost')
  await setRole(an.code, { anon: an.anon }, jc.id, 'co_host')
  const ok0 = await call(bansRoute.GET, 'GET', `/api/session/${an.code}/bans`, { anon: jc.anon }, undefined, { code: an.code })
  check('setup: the anonymous cohost reads the ban list', ok0.status === 200, ok0.status)
  await redis.sAdd(k.bans(an.code), jc.id)
  const den = await call(bansRoute.GET, 'GET', `/api/session/${an.code}/bans`, { anon: jc.anon }, undefined, { code: an.code })
  check('(r3 N1) a cached ban denies a cache-authority role too (stale meta still lists them)', den.status === 403 || den.status === 401, den.status)

  // N5: kick-DELETE observed (no member row), another device rejoins, the host kicks again → no undo
  const H = await mkUser('Host R3', { pro: true }), J = await mkUser('Rejoiner R3')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  const w2 = await addWine(s.code, { cookie: H.cookie }, 'w2')
  await enter(s.code, { cookie: J.cookie }, 'Rejoiner R3')
  await ban(s.code, { cookie: H.cookie }, `u:${J.id}`, 'kick')
  await prisma.sessionMember.deleteMany({ where: { userId: J.id, sessionCode: s.code } })   // kick-delete: no row, the cached kicked marker remains
  const pj = pauseAt('beforeLock', s.code, 'join')
  const j1 = join(s.code, { cookie: J.cookie }, 'Rejoiner R3')
  await pj.entered
  const j2 = await join(s.code, { cookie: J.cookie }, 'Rejoiner R3')
  await ban(s.code, { cookie: H.cookie }, `u:${J.id}`, 'kick')
  pj.release()
  const j1r = await j1
  const ms = await prisma.sessionMember.findUnique({ where: { userId_sessionCode: { userId: J.id, sessionCode: s.code } }, select: { removedState: true } })
  check('(r3 N5) a paused rejoin of a kick-DELETE does not undo the later kick-keep', j2.status === 200 && j1r.status !== 200 && ms?.removedState === 'kicked', { j2: j2.status, j1: j1r.status, ms })

  // P2-3: an unleased writer whose backend died BEFORE its bump never writes under its own bump
  const a3 = await createSession({})
  const aw = await addWine(a3.code, { anon: a3.anon }, 'anon w')
  const pg = pauseAt('beforeGen', a3.code, 'rate')
  const r1 = rate(a3.code, { anon: a3.anon }, aw, 1).catch((e: unknown) => ({ status: -1, json: { error: String(e) } }))
  await pg.entered
  await terminate(a3.code)
  const r2 = await rate(a3.code, { anon: a3.anon }, aw, 5)
  pg.release()
  const r1r = await r1
  const akey = (await scanKeys(`s:${a3.code}:r:*`))[0]
  check('(r3 P2-3) a writer whose backend died before its bump fails before any Redis write; the successor\'s value stays',
    r2.status === 200 && r1r.status !== 200 && !!akey && JSON.parse((await redis.get(akey))!).score === 5, { r1: r1r.status, r2: r2.status, v: akey && await redis.get(akey) })

  // P2-4: the provenance patch never overwrites a lineup evicted (and NX-rebuilt) after it was read
  const stale = (await redisWines(s.code)).filter(x => x.id === w).map(x => ({ ...x, addedByIdentityId: 'u:999999999' }))
  await redis.set(k.wines(s.code), JSON.stringify(stale), { XX: true, KEEPTTL: true })
  await redis.del(k.meta(s.code))
  const pr = pauseAt('beforePublish', s.code)
  const e1 = ensureSessionLive(s.code)
  await pr.entered
  await redis.del(k.wines(s.code))
  pr.release()
  await e1
  if (!(await redis.exists(k.wines(s.code)))) await ensureSessionLive(s.code)
  const after = await redisWines(s.code)
  check('(r3 P2-4) after the eviction the lineup is the record\'s (no wine lost to the stale patch), provenance correct',
    after.some(x => x.id === w2) && after.find(x => x.id === w)?.addedByIdentityId === `u:${H.id}`, after.map(x => [x.id === w ? 'w' : x.id === w2 ? 'w2' : x.id, x.addedByIdentityId]))
}

// ── Code review round 4 ─────────────────────────────────────────────────────
async function round4() {
  section('code review r4 — kicked cache-authority roles, Redis-only kick version, failed upload keeps the current image')
  // N1: an anonymous cohost KICKED (SADD + HDEL landed, the role strip did not) has no moderation power
  const an = await createSession({})
  const jc = await join(an.code, {}, 'Anon Cohost K')
  await setRole(an.code, { anon: an.anon }, jc.id, 'co_host')
  check('setup: the anonymous cohost reads the ban list', (await call(bansRoute.GET, 'GET', `/api/session/${an.code}/bans`, { anon: jc.anon }, undefined, { code: an.code })).status === 200)
  await redis.sAdd(k.kicked(an.code), jc.id); await redis.hDel(k.identities(an.code), jc.id)
  const den = await call(bansRoute.GET, 'GET', `/api/session/${an.code}/bans`, { anon: jc.anon }, undefined, { code: an.code })
  check('(r4 N1) a kicked, off-roster cache-authority cohost (stale meta) gets no moderation read', den.status === 403 || den.status === 401, den.status)

  // N5: Redis-only — a paused rejoin of kick #1 does not undo kick #2
  const rs = await createSession({})
  const J = await mkUser('Rejoiner R4')
  await join(rs.code, { cookie: J.cookie }, 'Rejoiner R4')
  await ban(rs.code, { anon: rs.anon }, `u:${J.id}`, 'kick')
  check('setup: a Redis-only moment', !(await liveRow(rs.code)))
  const pj = pauseAt('beforeLock', rs.code, 'join')
  const j1 = join(rs.code, { cookie: J.cookie }, 'Rejoiner R4')
  await pj.entered
  const j2 = await join(rs.code, { cookie: J.cookie }, 'Rejoiner R4')
  await ban(rs.code, { anon: rs.anon }, `u:${J.id}`, 'kick')
  pj.release()
  const j1r = await j1
  check('(r4 N5) Redis-only: a paused rejoin of kick #1 does not undo kick #2', j2.status === 200 && j1r.status !== 200 && await redis.sIsMember(k.kicked(rs.code), `u:${J.id}`), { j2: j2.status, j1: j1r.status })

  // P1-2: an edit whose upload did not produce a URL keeps the CURRENT image (not its stale snapshot)
  const H = await mkUser('Host R4', { pro: true })
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'img wine')
  const setUrl = async (url: string) => redis.set(k.wines(s.code), JSON.stringify((await redisWines(s.code)).map(x => x.id === w ? { ...x, imageUrl: url } : x)), { XX: true, KEEPTTL: true })
  await setUrl('http://s3.test/verre/wines/x-snapshot.jpg')
  const pe = pauseAt('beforeLock', s.code, 'wine-edit')
  const ed = editWine(s.code, { cookie: H.cookie }, w, { name: 'img wine', type: 'red', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' })
  await pe.entered
  await setUrl('http://s3.test/verre/wines/y-current.jpg')   // a concurrent edit replaced X with Y (and reclaimed X)
  pe.release()
  const er = await ed
  check('(r4 P1-2) a failed upload keeps the CURRENT image — never the snapshot\'s already-replaced URL', er.status === 200 && (await redisWines(s.code) as { id: string; imageUrl?: string }[]).find(x => x.id === w)?.imageUrl === 'http://s3.test/verre/wines/y-current.jpg', { status: er.status, json: er.json })
}

// ── Code review round 5 ─────────────────────────────────────────────────────
async function round5() {
  section('code review r5 — kick token survives eviction, evicted host keeps powers, account deletion clears kick traces')
  // N5: a kick-version eviction between the observation and kick #2 cannot recreate the observed version
  const rs = await createSession({})
  const J = await mkUser('Rejoiner R5')
  await join(rs.code, { cookie: J.cookie }, 'Rejoiner R5')
  await ban(rs.code, { anon: rs.anon }, `u:${J.id}`, 'kick')
  const pj = pauseAt('beforeLock', rs.code, 'join')
  const j1 = join(rs.code, { cookie: J.cookie }, 'Rejoiner R5')
  await pj.entered
  const j2 = await join(rs.code, { cookie: J.cookie }, 'Rejoiner R5')
  await redis.del(k.kickv(rs.code))   // evicted
  await ban(rs.code, { anon: rs.anon }, `u:${J.id}`, 'kick')
  pj.release()
  const j1r = await j1
  check('(r5 N5) after a kick-version eviction a paused rejoin still does not undo kick #2', j2.status === 200 && j1r.status !== 200 && await redis.sIsMember(k.kicked(rs.code), `u:${J.id}`), { j2: j2.status, j1: j1r.status })

  // P2: an anonymous strict host whose identities hash was evicted keeps its moderation reads
  const an = await createSession({})
  await redis.del(k.identities(an.code))
  const hb = await call(bansRoute.GET, 'GET', `/api/session/${an.code}/bans`, { anon: an.anon }, undefined, { code: an.code })
  check('(r5) an evicted roster does not demote the meta-proven anonymous strict host (no removal marker)', hb.status === 200, hb.status)

  // P2: account deletion clears the deleted user's kick traces in a Redis-only moment
  const K = await mkUser('Kicked deleter R5')
  const ks = await createSession({})
  await join(ks.code, { cookie: K.cookie }, 'Kicked deleter R5')
  await ban(ks.code, { anon: ks.anon }, `u:${K.id}`, 'kick')
  check('setup: kicked marker + kick version present', await redis.sIsMember(k.kicked(ks.code), `u:${K.id}`) && !!(await redis.hGet(k.kickv(ks.code), `u:${K.id}`)))
  await deleteAccountDurable(K.id)
  check('(r5) account deletion removes the kicked marker and the kick version of a kicked-only registration',
    !(await redis.sIsMember(k.kicked(ks.code), `u:${K.id}`)) && !(await redis.hGet(k.kickv(ks.code), `u:${K.id}`)))
}

// ── Code review round 6 ─────────────────────────────────────────────────────
async function round6() {
  section('code review r6 — evicted host writes, kick version inside the d: migration')
  // P2: the meta-proven anonymous strict host missing from the roster can still kick and unban
  const an = await createSession({})
  const p = await join(an.code, {}, 'Anon P')
  await redis.hDel(k.identities(an.code), (await metaOf(an.code))!.hostIdentityId as string)
  const kb = await ban(an.code, { anon: an.anon }, p.id, 'ban')
  const ub = await call(unbanRoute.DELETE, 'DELETE', `/api/session/${an.code}/bans/${encodeURIComponent(p.id)}`, { anon: an.anon }, undefined, { code: an.code, identityId: p.id })
  check('(r6) an evicted-roster anonymous strict host can still ban and unban (host-only writes)', kb.status === 200 && ub.status === 200, { ban: kb.status, unban: ub.status, json: kb.json })
  // P2: account deletion removes the kick version in the SAME fenced step as the d: migration
  const H = await mkUser('Host R6'), K = await mkUser('Kicked deleter R6')
  const s = await createSession({ cookie: H.cookie })
  const w = await addWine(s.code, { cookie: H.cookie }, 'w')
  await enter(s.code, { cookie: K.cookie }, 'Kicked deleter R6')
  await rate(s.code, { cookie: K.cookie }, w, 4)
  await ban(s.code, { cookie: H.cookie }, `u:${K.id}`, 'kick')
  check('setup: a Postgres-backed moment with the kick version', !!(await liveRow(s.code)) && !!(await redis.hGet(k.kickv(s.code), `u:${K.id}`)))
  await deleteAccountDurable(K.id)
  check('(r6) the d: migration removes the deleted user\'s kick version', !(await redis.hGet(k.kickv(s.code), `u:${K.id}`)))
}

// ── Release C: the operator script (scripts/rehydrate-sessions.mts) ─────────
// Release-C plan § 7, checks 1–16. Semantic checks drive runRehydration
// in-process; CLI, abort, outage and privacy checks spawn the CLI or the worker
// bootstrap (scripts/tests/stubs/rehydrate-sessions-worker.mts).
const SCRIPT = pjoin(REPO, 'scripts', 'rehydrate-sessions.mts')
const WORKER = pjoin(HERE, 'stubs', 'rehydrate-sessions-worker.mts')
type ScriptLine = Record<string, unknown> & { code?: string; outcome?: string; planned?: Counts; confirmed?: Counts; meta?: Record<string, unknown>; info?: Record<string, unknown>; drift?: boolean }
type Counts = { rebuilt: Record<string, number | boolean>; reconciled: Record<string, number | string[]> & { metaFields: string[] } }
async function runScript(o: { codes?: string[]; activeSinceDays?: number; apply?: boolean; force?: boolean; concurrency?: number; perCodeTimeoutMs?: number }) {
  const { runRehydration } = await import('../rehydrate-sessions.mts')
  const lines: ScriptLine[] = []
  const r = await runRehydration({ apply: false, force: false, concurrency: 2, perCodeTimeoutMs: 30_000, ...o }, l => { lines.push(l as ScriptLine) })
  return { lines, summary: r.summary as Record<string, unknown> & { retry: string[]; aborted: string | null }, line: (c: string) => lines.find(l => l.code === c) }
}
// A child that outlives `timeoutMs` is SIGKILLed (exit null) — a hang fails its check instead of the suite.
async function runCli(args: string[], o: { env?: Record<string, string>; unset?: string[]; worker?: Record<string, unknown>; timeoutMs?: number } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...o.env }
  for (const u of o.unset ?? []) delete env[u]
  if (o.worker) env.REHYDRATE_WORKER = JSON.stringify(o.worker)
  const t0 = Date.now()
  const child = spawn(process.execPath, ['--import', 'tsx', o.worker ? WORKER : SCRIPT, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const killer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 60_000)
  // 'close', not 'exit': it fires only after the child's stdio has drained (r1-4).
  const exit = await new Promise<number | null>(res => child.on('close', c => res(c)))
  clearTimeout(killer)
  const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as ScriptLine } catch { return { unparsable: l } as ScriptLine } })
  return { exit, out, err, ms: Date.now() - t0, lines, summary: lines.at(-1)?.summary as Record<string, unknown> | undefined }
}
const WRITE_CMDS = /^(SET|SETNX|SETEX|PSETEX|HSET|HSETNX|HDEL|HINCRBY|SADD|SREM|DEL|UNLINK|EXPIRE|PEXPIRE|PERSIST|RENAME|EVAL|EVALSHA|MULTI|EXEC|INCR|FLUSHDB|FLUSHALL)$/
function parseMonitor(lines: string[]): string[][] {
  return lines.map((l) => {
    const m = l.match(/^\+[\d.]+ \[[^\]]+\] (.*)$/)
    const args = [...(m ? m[1] : l).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1].replace(/\\(["\\])/g, '$1'))
    if (args[0]) args[0] = args[0].toUpperCase()
    return args
  })
}
const writesIn = (cmds: string[][]) => cmds.filter(a => WRITE_CMDS.test(a[0] ?? ''))
const zeroCounts = (c: Counts | undefined) => !!c && Object.values(c.rebuilt).every(v => v === 0 || v === false)
  && Object.entries(c.reconciled).every(([f, v]) => (f === 'metaFields' ? (v as string[]).length === 0 : v === 0))
async function freePort(): Promise<number> {
  const net = await import('node:net')
  const srv = net.createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  await new Promise<void>(r => srv.close(() => r()))
  return port
}
// A TCP proxy that can be BLACKHOLED: from then on nothing is forwarded in
// either direction and a closing client no longer closes its upstream — the
// server keeps its socket, as under a network partition.
async function tcpProxy(target: URL, defaultPort: number) {
  const net = await import('node:net')
  let blackholed = false
  const sockets: import('node:net').Socket[] = []
  const server = net.createServer((c) => {
    const u = net.connect(Number(target.port || defaultPort), target.hostname)
    sockets.push(c, u)
    c.on('data', d => { if (!blackholed) u.write(d) })
    u.on('data', d => { if (!blackholed) c.write(d) })
    c.on('close', () => { if (!blackholed) u.destroy() })
    u.on('close', () => { if (!blackholed) c.destroy() })
    c.on('error', () => {})
    u.on('error', () => {})
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const via = (raw: string) => { const x = new URL(raw); x.hostname = '127.0.0.1'; x.port = String(port); return x.toString() }
  return { via, blackhole: () => { blackholed = true }, close: () => { for (const s of sockets) s.destroy(); server.close() } }
}
async function untilFree(code: string, ms: number): Promise<number | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await advisoryHolders([code])).length) return Date.now() - t0
    await sleep(100)
  }
  return null
}

// A dead child's lease lapses on its own (≤ the 15 s lease): wait for it.
async function leaseGone(code: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) { if (!(await redis.exists(sessionLockKey(code)))) return true; await sleep(100) }
  return false
}

async function operatorScript() {
  section('release C — the operator script (scripts/rehydrate-sessions.mts)')
  const { readLiveRow, readRecordRoles, metaFromRecord } = await import('../../lib/sessionRecord.ts')
  const { lifespanTTL } = await import('../../lib/redis.ts')
  const recordMeta = async (code: string, cache: Record<string, unknown> | null) => {
    const row = (await readLiveRow(prisma, code))!
    return metaFromRecord(row, await readRecordRoles(prisma, code), cache as never)
  }

  // ── 1. Cold, dry run writes nothing ──
  const H = await mkUser('Host OS'), C = await mkUser('Cohost OS'), P = await mkUser('Provider OS'), T = await mkUser('Taster OS')
  const K = await mkUser('Kicked OS'), B = await mkUser('Banned OS'), X = await mkUser('Doomed OS'), Z = await mkUser('Stranger OS')
  const s = await createSession({ cookie: H.cookie })
  for (const [u, n] of [[C, 'Cohost OS'], [P, 'Provider OS'], [T, 'Taster OS'], [K, 'Kicked OS'], [B, 'Banned OS'], [X, 'Doomed OS']] as const) await enter(s.code, { cookie: u.cookie }, n)
  const A = await join(s.code, {}, 'Anon OS')
  const AB = await join(s.code, {}, 'Anon banned OS')
  await setRole(s.code, { cookie: H.cookie }, `u:${C.id}`, 'co_host')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  await setRole(s.code, { cookie: H.cookie }, `u:${X.id}`, 'provider')
  const w1 = await addWine(s.code, { cookie: H.cookie }, 'One OS')
  const w2 = await addWine(s.code, { cookie: P.cookie }, 'Two OS')
  const w3 = await addWine(s.code, { cookie: X.cookie }, 'Three OS')
  await rate(s.code, { cookie: T.cookie }, w1, 4); await rate(s.code, { cookie: T.cookie }, w2, 4)
  await rate(s.code, { cookie: K.cookie }, w1, 2); await rate(s.code, { cookie: X.cookie }, w2, 5); await rate(s.code, { anon: A.anon }, w1, 1)
  await ban(s.code, { cookie: H.cookie }, `u:${K.id}`, 'kick')
  await ban(s.code, { cookie: H.cookie }, `u:${B.id}`, 'ban')
  await ban(s.code, { cookie: H.cookie }, AB.id, 'ban')
  await deleteAccountDurable(X.id)
  await state(s.code, { cookie: H.cookie })
  check('setup: the recorded a: ban exists', (await prisma.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM session_bans WHERE session_code = ${s.code} AND identity_id = ${AB.id}`).length === 1)
  await wipeCache(s.code)
  let r1!: Awaited<ReturnType<typeof runScript>>
  const m1 = parseMonitor(await monitored(async () => { r1 = await runScript({ codes: [s.code] }) }))
  const l1 = r1.line(s.code)
  check('(1) cold dry run: outcome planned, state cold', l1?.outcome === 'planned' && l1?.state === 'cold', l1)
  check('(1) …no write command from any client', writesIn(m1).length === 0, writesIn(m1))
  check('(1) …planned = the expected cold fill', JSON.stringify(l1?.planned) === JSON.stringify({
    rebuilt: { meta: true, lineup: true, wines: 3, members: 4, tombstones: 1, ratings: 4, bans: 2, kicked: 1 },
    reconciled: { metaFields: [], identities: 0, ratingKeys: 0, bans: 0, kicked: 0, provenance: 0 },
  }), l1?.planned)
  check('(1) …meta write nx/create, info tombstone 1, lineup order kept', JSON.stringify(l1?.meta) === '{"write":"nx","expect":"create"}'
    && l1?.info?.tombstoneGroups === 1 && l1?.info?.lineupOrderLost === false, { meta: l1?.meta, info: l1?.info })
  check('(1) …the keys are still absent', (await scanKeys(`s:${s.code}:*`)).length === 0)

  // ── 2. Apply = plan ──
  const r2 = await runScript({ codes: [s.code], apply: true })
  const l2 = r2.line(s.code)
  check('(2) apply: confirmed = planned, drift false, meta acked', l2?.outcome === 'applied' && JSON.stringify(l2?.confirmed) === JSON.stringify(l2?.planned)
    && l2?.drift === false && l2?.meta?.acked === true && JSON.stringify(l2?.planned) === JSON.stringify(l1?.planned), l2)
  const ids2 = await redis.hGetAll(k.identities(s.code))
  const dKey = Object.keys(ids2).find(id => id.startsWith('d:'))
  check('(2) …roster = H, C, P, T + one [deleted] group', JSON.stringify(Object.keys(ids2).filter(id => id.startsWith('u:')).sort()) === JSON.stringify([H, C, P, T].map(u => `u:${u.id}`).sort()) && !!dKey && ids2[dKey!] === '[deleted]', ids2)
  check('(2) …bans {u:B, a:AB}, kicked {u:K}', JSON.stringify((await redis.sMembers(k.bans(s.code))).sort()) === JSON.stringify([`u:${B.id}`, AB.id].sort())
    && JSON.stringify(await redis.sMembers(k.kicked(s.code))) === JSON.stringify([`u:${K.id}`]))
  check('(2) …rating keys = the record (incl. the kicked user and the d: group)', JSON.stringify((await scanKeys(`s:${s.code}:r:*`)).sort()) === JSON.stringify([
    k.rating(s.code, `u:${T.id}`, w1), k.rating(s.code, `u:${T.id}`, w2), k.rating(s.code, `u:${K.id}`, w1), k.rating(s.code, dKey!, w2)].sort()))
  check('(2) …meta = metaFromRecord, lineup of 3 with the d: owner', JSON.stringify(await metaOf(s.code)) === JSON.stringify(await recordMeta(s.code, null))
    && (await redisWines(s.code)).length === 3 && (await redisWines(s.code)).find(w => w.id === w3)?.addedByIdentityId === dKey)
  let r2b!: Awaited<ReturnType<typeof runScript>>
  const m2 = parseMonitor(await monitored(async () => { r2b = await runScript({ codes: [s.code] }) }))
  check('(2) a second plain dry run → warm, only the readiness EXISTS, no lock', r2b.line(s.code)?.outcome === 'warm'
    && m2.length === 1 && m2[0][0] === 'EXISTS' && r2b.summary.converged === null, { m2, converged: r2b.summary.converged })

  // ── 3. Converged ──
  const r3d = await runScript({ codes: [s.code], force: true })
  const r3a = await runScript({ codes: [s.code], force: true, apply: true })
  check('(3) forced dry run on the warm moment: every actionable count 0, metaFields []', zeroCounts(r3d.line(s.code)?.planned) && r3d.summary.converged === true, r3d.line(s.code))
  check('(3) forced apply: planned and confirmed all 0, drift false', zeroCounts(r3a.line(s.code)?.planned) && zeroCounts(r3a.line(s.code)?.confirmed) && r3a.line(s.code)?.drift === false, r3a.line(s.code))
  check('(3) informational stays: tombstoneGroups 1', r3a.line(s.code)?.info?.tombstoneGroups === 1 && r3a.line(s.code)?.meta?.expect === 'rewrite')

  // ── 4. Force, both directions ──
  const staleD = `d:${crypto.randomUUID()}`, anonBan = `a:${crypto.randomUUID()}`, goneKey = k.rating(s.code, 'u:999999999', w1)
  await redis.del([k.rating(s.code, `u:${T.id}`, w1), k.rating(s.code, `u:${K.id}`, w1)])
  await redis.hDel(k.identities(s.code), `u:${T.id}`)
  await redis.sRem(k.bans(s.code), [`u:${B.id}`, AB.id])
  await redis.hSet(k.identities(s.code), { [`u:${Z.id}`]: 'Stale Z', [staleD]: '[deleted]' })
  await redis.sAdd(k.bans(s.code), [`u:${Z.id}`, anonBan])
  await redis.set(goneKey, JSON.stringify({ score: 3, flavors: {}, aromas: [], notes: '', at: 1 }), { EX: 3600 })
  const m4 = (await metaOf(s.code))!
  delete m4.hostIdentityId
  await redis.set(k.meta(s.code), JSON.stringify({ ...m4, coHosts: ['Legacy'], Zqxsentinelfield: 1 }), { XX: true, KEEPTTL: true })
  const tw2 = k.rating(s.code, `u:${T.id}`, w2)
  const tw2v = { ...JSON.parse((await redis.get(tw2))!), score: 1 }
  await redis.set(tw2, JSON.stringify(tw2v), { XX: true, KEEPTTL: true })
  const lineup4 = await redisWines(s.code)
  lineup4[0].revealedAt = '2026-01-01T00:00:00.000Z'
  await redis.set(k.wines(s.code), JSON.stringify(lineup4), { XX: true, KEEPTTL: true })
  await redis.expire(k.identities(s.code), 100)
  const metaBefore4 = await metaOf(s.code)
  const want4 = {
    rebuilt: { meta: false, lineup: false, wines: 0, members: 1, tombstones: 0, ratings: 2, bans: 2, kicked: 0 },
    reconciled: { metaFields: ['<other>', 'coHosts', 'hostIdentityId'], identities: 2, ratingKeys: 1, bans: 1, kicked: 0, provenance: 0 },
  }
  const r4d = await runScript({ codes: [s.code], force: true })
  check('(4) forced dry run plans each repair', JSON.stringify(r4d.line(s.code)?.planned) === JSON.stringify(want4) && r4d.line(s.code)?.info?.orphans === 1, r4d.line(s.code))
  const r4a = await runScript({ codes: [s.code], force: true, apply: true })
  check('(4) forced apply: confirmed = planned, drift false', JSON.stringify(r4a.line(s.code)?.confirmed) === JSON.stringify(want4) && r4a.line(s.code)?.drift === false, r4a.line(s.code))
  const ids4 = await redis.hGetAll(k.identities(s.code)), bans4 = new Set(await redis.sMembers(k.bans(s.code)))
  check('(4) …roster entry back, stale u: and d: out', !!ids4[`u:${T.id}`] && !ids4[`u:${Z.id}`] && !ids4[staleD])
  check('(4) …u: + recorded a: bans back, stale u: ban out, cache-only a: ban kept', bans4.has(`u:${B.id}`) && bans4.has(AB.id) && !bans4.has(`u:${Z.id}`) && bans4.has(anonBan), [...bans4])
  check('(4) …missing rating keys back, the gone user\'s key deleted', !!(await redis.get(k.rating(s.code, `u:${T.id}`, w1))) && !!(await redis.get(k.rating(s.code, `u:${K.id}`, w1))) && !(await redis.exists(goneKey)))
  check('(4) …content kept: the differing cached rating value and the cache-only revealedAt', JSON.parse((await redis.get(tw2))!).score === 1
    && (await redisWines(s.code))[0].revealedAt === '2026-01-01T00:00:00.000Z')
  check('(4) an unknown cached meta key is reported as <other>, never by name', !JSON.stringify(r4d.lines).includes('Zqxsentinelfield'))
  check('(4) …meta = metaFromRecord (legacy coHosts dropped, hostIdentityId back)', JSON.stringify(await metaOf(s.code)) === JSON.stringify(await recordMeta(s.code, metaBefore4)))
  const life = lifespanTTL((await readLiveRow(prisma, s.code))!.lifespan ?? undefined)
  const ttls = await Promise.all((await scanKeys(`s:${s.code}:*`)).map(async key => [key, await redis.ttl(key)] as const))
  check('(4) …every key\'s TTL = the lifespan (the shortened identities TTL refreshed)', ttls.every(([, t]) => t >= life - 10 && t <= life), ttls.filter(([, t]) => t < life - 10 || t > life))

  // ── 5. Deferred account-delete projection ──
  const H5 = await mkUser('Host OS5'), Y = await mkUser('Doomed cohost OS5'), Y2 = await mkUser('Doomed banned OS5'), Y3 = await mkUser('Doomed kicked OS5'), T5 = await mkUser('Taster OS5')
  const s5 = await createSession({ cookie: H5.cookie })
  for (const [u, n] of [[Y, 'Y'], [Y2, 'Y2'], [Y3, 'Y3'], [T5, 'Taster OS5']] as const) await enter(s5.code, { cookie: u.cookie }, n)
  const A5 = await join(s5.code, {}, 'Anon OS5')
  await setRole(s5.code, { cookie: H5.cookie }, `u:${Y.id}`, 'co_host')
  const w5 = await addWine(s5.code, { cookie: Y.cookie }, 'By Y')
  const w5b = await addWine(s5.code, { cookie: H5.cookie }, 'By host')
  await rate(s5.code, { cookie: Y.cookie }, w5, 3); await rate(s5.code, { cookie: Y.cookie }, w5b, 4.5)
  await rate(s5.code, { cookie: T5.cookie }, w5, 2); await rate(s5.code, { anon: A5.anon }, w5, 1)
  await ban(s5.code, { cookie: H5.cookie }, `u:${Y2.id}`, 'ban')
  await ban(s5.code, { cookie: H5.cookie }, `u:${Y3.id}`, 'kick')
  await state(s5.code, { cookie: H5.cookie })
  for (const u of [Y, Y2, Y3]) await deleteAccountDurable(u.id, { hooks: { failProjection: true, failInvalidation: true } })
  const pre5 = await snapshot(s5.code)
  const preIds = pre5[k.identities(s5.code)] as Record<string, string>
  check('(5) setup: the projection never ran (u:Y still cached, u:Y2 ban still cached)', !!preIds[`u:${Y.id}`] && (pre5[k.bans(s5.code)] as string[]).includes(`u:${Y2.id}`))
  const metaBefore5 = await metaOf(s5.code)
  const r5 = await runScript({ codes: [s5.code], force: true, apply: true })
  const l5 = r5.line(s5.code)
  const ids5 = await redis.hGetAll(k.identities(s5.code))
  const d5 = Object.keys(ids5).find(id => id.startsWith('d:'))
  check('(5) forced apply: planned the deletion repairs', JSON.stringify(l5?.planned) === JSON.stringify({
    rebuilt: { meta: false, lineup: false, wines: 0, members: 0, tombstones: 1, ratings: 2, bans: 0, kicked: 0 },
    reconciled: { metaFields: ['coHostIds'], identities: 1, ratingKeys: 2, bans: 1, kicked: 0, provenance: 1 },
  }) && l5?.drift === false, l5)
  check('(5) …u:Y out of identities + its rating keys gone; u:Y2 ban gone', !ids5[`u:${Y.id}`] && (await scanKeys(`s:${s5.code}:r:u:${Y.id}:*`)).length === 0
    && !(await redis.sIsMember(k.bans(s5.code), `u:${Y2.id}`)))
  check('(5) …d: group in as [deleted] with the record values', !!d5 && ids5[d5!] === '[deleted]'
    && JSON.parse((await redis.get(k.rating(s5.code, d5!, w5)))!).score === 3 && JSON.parse((await redis.get(k.rating(s5.code, d5!, w5b)))!).score === 4.5)
  const byY = (await redisWines(s5.code)).find(w => w.id === w5) as { addedByIdentityId?: string; addedByDisplayName?: string } | undefined
  check('(5) …Y\'s wine provenance = d: / [deleted]', byY?.addedByIdentityId === d5 && byY?.addedByDisplayName === '[deleted]', byY)
  check('(5) …meta role lists from the record (u:Y gone)', JSON.stringify(await metaOf(s5.code)) === JSON.stringify(await recordMeta(s5.code, metaBefore5))
    && !((await metaOf(s5.code))!.coHostIds as string[]).includes(`u:${Y.id}`))
  check('(5) …preserved: other roster names, other rating values, anonymous entries',
    ids5[`u:${H5.id}`] === preIds[`u:${H5.id}`] && ids5[`u:${T5.id}`] === preIds[`u:${T5.id}`] && ids5[A5.id] === preIds[A5.id]
    && JSON.stringify(JSON.parse((await redis.get(k.rating(s5.code, `u:${T5.id}`, w5)))!)) === JSON.stringify(pre5[k.rating(s5.code, `u:${T5.id}`, w5)])
    && !!(await redis.get(k.rating(s5.code, A5.id, w5))))
  check('(5) …the inert residuals stay: Y3 kicked marker + kick version, Y lastseen', await redis.sIsMember(k.kicked(s5.code), `u:${Y3.id}`)
    && !!(await redis.hGet(k.kickv(s5.code), `u:${Y3.id}`)) && !!(await redis.hGet(k.lastSeen(s5.code), String(Y.id))))

  // ── 6. Busy is skipped, once ──
  const H6 = await mkUser('Host OS6')
  const s6 = await createSession({ cookie: H6.cookie })
  await addWine(s6.code, { cookie: H6.cookie }, 'w6')
  await wipeCache(s6.code)
  const held6 = (await acquireSessionLock(s6.code))!
  let lockEntries = 0
  mutationHooks.at = async (p, c, l) => { if (p === 'beforeLock' && c === s6.code && l === 'rebuild') lockEntries++ }
  let r6!: Awaited<ReturnType<typeof runScript>>
  const m6 = parseMonitor(await monitored(async () => { r6 = await runScript({ codes: [s6.code], apply: true }) }))
  noHooks()
  check('(6) busy: outcome busy, exactly one lock attempt (never retried), code in retry', r6.line(s6.code)?.outcome === 'busy' && lockEntries === 1
    && r6.summary.retry.includes(s6.code) && String(r6.summary.retryCommand).includes(`--apply ${s6.code}`) && r6.summary.converged === false, { line: r6.line(s6.code), lockEntries, s: r6.summary })
  check('(6) …nothing written but the refused SET NX lock attempts', writesIn(m6).every(a => a[0] === 'SET' && a[1] === sessionLockKey(s6.code) && a.includes('NX')) && !(await redis.exists(k.meta(s6.code))))
  const { renewSessionLock } = await import('../../lib/sessionLock.ts')
  check('setup: the held lock renewed for the CLI run', await renewSessionLock(s6.code, held6))
  const c6 = await runCli(['--apply', s6.code])
  check('(6) …the CLI exits 1', c6.exit === 1 && c6.lines.find(l => l.code === s6.code)?.outcome === 'busy', { exit: c6.exit, out: c6.out })
  await releaseSessionLock(s6.code, held6)

  // ── 7. Refused + healthy serialization ──
  const H7 = await mkUser('Host OS7'), T7 = await mkUser('Taster OS7')
  const s7 = await createSession({ cookie: H7.cookie })
  await enter(s7.code, { cookie: T7.cookie }, 'Taster OS7')
  const w7 = await addWine(s7.code, { cookie: H7.cookie }, 'w7')
  await rate(s7.code, { cookie: T7.cookie }, w7, 4)
  await wipeCache(s7.code)
  const p7 = pauseAt('beforePublish', s7.code, 'rebuild')
  const r7p = runScript({ codes: [s7.code], apply: true })
  await p7.entered
  await redis.set(k.gen(s7.code), crypto.randomUUID(), { EX: 3600 })
  p7.release()
  const r7 = await r7p
  check('(7a) a generation change after the baseline → refused, nothing published', r7.line(s7.code)?.outcome === 'refused' && !(await redis.exists(k.meta(s7.code))) && !(await redis.exists(k.wines(s7.code))), r7.line(s7.code))
  await ensureSessionLive(s7.code)
  const p7b = pauseAt('beforePublish', s7.code, 'rebuild:force')
  const r7bp = runScript({ codes: [s7.code], apply: true, force: true })
  await p7b.entered
  const rate7 = rate(s7.code, { cookie: T7.cookie }, w7, 2)
  check('(7b) a real rate during the forced apply is BLOCKED on the advisory lock', await blockedOnLock(rate7))
  p7b.release()
  const r7b = await r7bp, rr7 = await rate7
  check('(7b) …the rebuild applies, then the rate commits and its key holds the new value', r7b.line(s7.code)?.outcome === 'applied' && rr7.status === 200
    && JSON.parse((await redis.get(k.rating(s7.code, `u:${T7.id}`, w7)))!).score === 2, { line: r7b.line(s7.code), rate: rr7.status })

  // ── 8. No live row ──
  const s8 = await createSession({})
  check('setup: an anonymous moment is Redis-only', !(await liveRow(s8.code)))
  await redis.del(k.wines(s8.code))
  let r8!: Awaited<ReturnType<typeof runScript>>
  const absentCode = `Z${crypto.randomUUID().replace(/[^0-9]/g, '').slice(0, 7).padEnd(7, '9')}`
  const m8 = parseMonitor(await monitored(async () => { r8 = await runScript({ codes: [s8.code, absentCode], apply: true }) }))
  check('(8) Redis-only with its wines evicted → redisOnly, no write (no D5 re-seed from the script)', r8.line(s8.code)?.outcome === 'redisOnly' && writesIn(m8).length === 0 && !(await redis.exists(k.wines(s8.code))), { line: r8.line(s8.code), w: writesIn(m8) })
  check('(8) a code with nothing anywhere → absent', r8.line(absentCode)?.outcome === 'absent')

  // ── 9. Selection + warming effects ──
  const H9 = await mkUser('Host OS9'), T9 = await mkUser('Taster OS9')
  const mk9 = async () => {
    const x = await createSession({ cookie: H9.cookie })
    await enter(x.code, { cookie: T9.cookie }, 'Taster OS9')
    const w = await addWine(x.code, { cookie: H9.cookie }, 'w9')
    await rate(x.code, { cookie: T9.cookie }, w, 3)
    const row = (await liveRow(x.code))!
    await prisma.$executeRaw`UPDATE session_members SET joined_at = now() - interval '30 days' WHERE session_code = ${x.code}`
    await prisma.$executeRaw`UPDATE wines SET created_at = now() - interval '30 days' WHERE session_id = ${row.id}`
    await prisma.$executeRaw`UPDATE ratings SET rated_at = now() - interval '30 days', mirror_at = now() - interval '30 days' WHERE session_id = ${row.id}`
    return { code: x.code, id: row.id, wine: w }
  }
  const [sel1, sel2, sel3, old4, vis5, del6] = [await mk9(), await mk9(), await mk9(), await mk9(), await mk9(), await mk9()]
  await prisma.$executeRaw`UPDATE session_members SET joined_at = now() WHERE session_code = ${sel1.code} AND user_id = ${T9.id}`
  await prisma.$executeRaw`UPDATE wines SET created_at = now() WHERE session_id = ${sel2.id}`
  await prisma.$executeRaw`UPDATE ratings SET mirror_at = now() WHERE session_id = ${sel3.id}`
  await visit(vis5.code, { cookie: T9.cookie })
  await prisma.$executeRaw`UPDATE wines SET created_at = now() WHERE session_id = ${del6.id}`
  await call(codeRoute.DELETE, 'DELETE', `/api/session/${del6.code}`, { cookie: H9.cookie }, undefined, { code: del6.code })
  const r9 = await runScript({ activeSinceDays: 7, concurrency: 8 })
  const picked = new Set([...r9.lines.map(l => l.code).filter(Boolean) as string[], ...r9.summary.retry])
  check('(9) --active-since: recent member / recent wine / recent mirror_at selected', picked.has(sel1.code) && picked.has(sel2.code) && picked.has(sel3.code))
  check('(9) …all old, visited-only (the named gap) and soft-deleted are not', !picked.has(old4.code) && !picked.has(vis5.code) && !picked.has(del6.code))
  const meSessions = async () => ((await call((await import('../../app/api/me/sessions/route.ts')).GET, 'GET', '/api/me/sessions', { cookie: H9.cookie })).json as unknown as { code: string; status: string }[])
  const fut = await createSession({ cookie: H9.cookie })
  await wipeCache(fut.code)
  const before9 = (await meSessions()).find(x => x.code === fut.code)?.status
  await runScript({ codes: [fut.code], apply: true })
  const after9 = (await meSessions()).find(x => x.code === fut.code)?.status
  check('(9) warming a future-dated moment: /api/me/sessions past → upcoming', before9 === 'past' && after9 === 'upcoming', { before9, after9 })

  // ── 10. Watchdog abort (child) ──
  const s10 = await createSession({ cookie: H9.cookie })
  await wipeCache(s10.code)
  const c10 = await runCli(['--apply', '--per-code-timeout', '2', s10.code], { worker: { at: 'beforePublish', label: 'rebuild', hang: true } })
  check('(10) watchdog: exit 3 within the bound, the code reported unknown, summary aborted', c10.exit === 3 && c10.ms < 15_000
    && c10.lines.find(l => l.code === s10.code)?.outcome === 'unknown' && typeof c10.summary?.aborted === 'string', { exit: c10.exit, ms: c10.ms, out: c10.out })
  const pttl10 = Number(await redis.pTTL(sessionLockKey(s10.code)))
  check('(10) …afterwards the advisory lock is free, the Redis lease self-expires, nothing published', (await untilFree(s10.code, 5000)) !== null
    && pttl10 <= lockTiming.leaseMs && !(await redis.exists(k.meta(s10.code))), { pttl10 })

  const c10b = await runCli([s10.code], { worker: { hangQuit: true }, timeoutMs: 20_000 })
  check('(10b) a Redis QUIT that never answers after the summary does not hold the CLI (bounded close, exit 0)', c10b.exit === 0 && !!c10b.summary && c10b.ms < 12_000, { exit: c10b.exit, ms: c10b.ms })

  // ── 11. Outages + server bounds (child) ──
  const c11a = await runCli([s10.code], { env: { REDIS_URL: `redis://127.0.0.1:${await freePort()}` } })
  check('(11a) Redis unreachable → exit 3 within 10 s, nothing selected', c11a.exit === 3 && c11a.ms < 12_000 && c11a.out === '', { exit: c11a.exit, ms: c11a.ms, out: c11a.out })
  check('setup: check 10\'s dead holder\'s lease lapsed', await leaseGone(s10.code))
  const rp = await tcpProxy(new URL(process.env.REDIS_URL!), 6379)
  const sig11b = `c11b:${Date.now()}`
  const l11b = await listenFor(sig11b)
  const c11bp = runCli(['--apply', '--per-code-timeout', '2', s10.code], { env: { REDIS_URL: rp.via(process.env.REDIS_URL!) }, worker: { at: 'locked', label: 'rebuild', notify: sig11b, holdMs: 500 } })
  check('setup: the worker reached the lock', await l11b.wait(20_000))
  rp.blackhole()
  const c11b = await c11bp
  rp.close()
  check('(11b) Redis blackholed mid-run → exit 3 via the watchdog, nothing published', c11b.exit === 3 && !(await redis.exists(k.meta(s10.code))) && (await untilFree(s10.code, 5000)) !== null, { exit: c11b.exit, out: c11b.out })
  check('setup: the blackholed holder\'s lease lapsed', await leaseGone(s10.code))
  const pp = await tcpProxy(new URL(DB), 5432)
  const sig11c = `c11c:${Date.now()}`
  const l11c = await listenFor(sig11c)
  const c11cp = runCli(['--apply', '--per-code-timeout', '2', s10.code], { env: { DATABASE_URL: pp.via(DB), PGOPTIONS: '-c idle_in_transaction_session_timeout=4s' }, worker: { at: 'locked', label: 'rebuild', notify: sig11c, holdMs: 300 } })
  check('setup: the worker reached the lock (via the Postgres proxy)', await l11c.wait(20_000))
  const tHook = Date.now()
  pp.blackhole()
  const c11c = await c11cp
  const heldAtExit = (await advisoryHolders([s10.code])).length > 0
  const freedC = await untilFree(s10.code, 10_000)
  const sinceHook = Date.now() - tHook
  pp.close()
  check(`(11c) Postgres blackholed mid-transaction → exit 3; the client exit does NOT free the lock, the server's idle timeout does (freed ${sinceHook} ms after the hook, idle 4 s)`, c11c.exit === 3 && heldAtExit && freedC !== null && sinceHook <= 4000 + 2500, { exit: c11c.exit, heldAtExit, sinceHook })
  check('setup: the 11c holder\'s lease lapsed', await leaseGone(s10.code))
  const pp2 = await tcpProxy(new URL(DB), 5432)
  const { Client } = await import('pg')
  const holder = new Client({ connectionString: DB })
  await holder.connect()
  await holder.query('BEGIN')
  await holder.query('SELECT 1 FROM sessions WHERE code = $1 AND deleted_at IS NULL FOR UPDATE', [s10.code])
  const c11dp = runCli(['--apply', '--per-code-timeout', '2', s10.code], { env: { DATABASE_URL: pp2.via(DB), PGOPTIONS: '-c idle_in_transaction_session_timeout=4s' } })
  let waiting = false
  for (let i = 0; i < 200 && !waiting; i++) {
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    waiting = Number(n) > 0
    if (!waiting) await sleep(50)
  }
  check('setup: the worker\'s contract waits inside its row-lock statement', waiting)
  const tBlack = Date.now()
  pp2.blackhole()
  await sleep(1000)
  await holder.query('COMMIT')
  await holder.end()
  const c11d = await c11dp
  const freedD = await untilFree(s10.code, 12_000)
  const elapsedD = Date.now() - tBlack
  pp2.close()
  check(`(11c′) blackholed DURING a statement: freed after the statement ends + the idle timeout (the combined bound: ${elapsedD} ms, wait 1 s + idle 4 s)`, c11d.exit === 3 && freedD !== null
    && elapsedD > 4000 && elapsedD <= 1000 + 4000 + 2500, { exit: c11d.exit, elapsedD })
  check('setup: the 11c′ holder\'s lease lapsed', await leaseGone(s10.code))
  const header = (err: string) => {
    const m = err.match(/idle_in_transaction_session_timeout (\S+), lock_timeout (\S+), statement_timeout (\S+), TimeZone (\S+)/)
    return m ? m.slice(1).join(' ') : null
  }
  const c11e = await runCli([s10.code], { unset: ['PGOPTIONS', 'DATABASE_STATEMENT_TIMEOUT_MS'] })
  check('(11d) defaults: the header reports 20s / 5s / 15s / UTC', header(c11e.err) === '20s 5s 15s UTC' && c11e.exit === 0, { h: header(c11e.err), exit: c11e.exit })
  const c11f = await runCli([s10.code], { env: { PGOPTIONS: '-c lock_timeout=2s' }, unset: ['DATABASE_STATEMENT_TIMEOUT_MS'] })
  check('(11e) an operator override is preserved, the others stay default', header(c11f.err) === '20s 2s 15s UTC', header(c11f.err))
  const c11g = await runCli([s10.code], { env: { PGOPTIONS: '-c idle_in_transaction_session_timeout=0' } })
  const c11h = await runCli([s10.code], { env: { DATABASE_STATEMENT_TIMEOUT_MS: 'abc' } })
  check('(11f) a disabled bound refuses: idle 0 → exit 2, nothing selected', c11g.exit === 2 && c11g.out === '', { exit: c11g.exit, h: header(c11g.err) })
  check('(11f) …an invalid DATABASE_STATEMENT_TIMEOUT_MS (effective 0) → exit 2', c11h.exit === 2 && c11h.out === '', { exit: c11h.exit, h: header(c11h.err) })

  // ── 12. Command order ──
  const H12 = await mkUser('Host OS12'), T12 = await mkUser('Taster OS12')
  const s12 = await createSession({ cookie: H12.cookie })
  await enter(s12.code, { cookie: T12.cookie }, 'Taster OS12')
  const w12 = await addWine(s12.code, { cookie: H12.cookie }, 'w12')
  await rate(s12.code, { cookie: T12.cookie }, w12, 4)
  await wipeCache(s12.code)
  const m12 = parseMonitor(await monitored(() => runScript({ codes: [s12.code], apply: true })))
  const sig = (a: string[]) => `${a[0]} ${a.slice(1).filter(x => x.startsWith('s:') || x.startsWith('lock:')).join(' ')}`
  const prefix = m12.slice(0, 5).map(sig)
  check('(12) entry reads: EXISTS readiness → SET lock NX PX → GET lock → GET meta → MGET meta wines', JSON.stringify(prefix) === JSON.stringify([
    `EXISTS ${k.meta(s12.code)} ${k.wines(s12.code)}`, `SET ${sessionLockKey(s12.code)}`, `GET ${sessionLockKey(s12.code)}`, `GET ${k.meta(s12.code)}`, `MGET ${k.meta(s12.code)} ${k.wines(s12.code)}`,
  ]) && m12[1].includes('NX') && m12[1].includes('PX'), prefix)
  const at = (pred: (a: string[]) => boolean) => m12.findIndex(pred)
  const iEval = at(a => a[0] === 'EVAL' && a[3] === k.gen(s12.code))
  const planning = [at(a => a[0] === 'HGETALL' && a[1] === k.identities(s12.code)), at(a => a[0] === 'SCAN'), at(a => a[0] === 'SMEMBERS' && a[1] === k.bans(s12.code)),
    at(a => a[0] === 'SMEMBERS' && a[1] === k.kicked(s12.code)), at(a => a[0] === 'GET' && a[1] === k.wines(s12.code))]
  check('(12) the generation baseline precedes every planning read', iEval > 4 && planning.every(i => i > iEval), { iEval, planning })
  const iWatch = at(a => a[0] === 'WATCH'), iMulti = at(a => a[0] === 'MULTI'), iExec = at(a => a[0] === 'EXEC')
  const inMulti = m12.slice(iMulti + 1, iExec)
  check('(12) WATCH before MULTI; wines SET NX first, meta SET NX last; rating SETs carry NX', iWatch > 0 && iWatch < iMulti
    && inMulti[0][0] === 'SET' && inMulti[0][1] === k.wines(s12.code) && inMulti[0].includes('NX')
    && inMulti.at(-1)![0] === 'SET' && inMulti.at(-1)![1] === k.meta(s12.code) && inMulti.at(-1)!.includes('NX')
    && inMulti.filter(a => a[0] === 'SET' && a[1].startsWith(`s:${s12.code}:r:`)).every(a => a.includes('NX'))
    && inMulti.some(a => a[0] === 'SET' && a[1].startsWith(`s:${s12.code}:r:`)), inMulti.map(a => a.slice(0, 2).join(' ')))
  const lw12 = await redisWines(s12.code)
  lw12[0].addedByIdentityId = 'u:999999999'
  await redis.set(k.wines(s12.code), JSON.stringify(lw12), { XX: true, KEEPTTL: true })
  const m12b = parseMonitor(await monitored(() => runScript({ codes: [s12.code], apply: true, force: true })))
  const inMultiB = m12b.slice(m12b.findIndex(a => a[0] === 'MULTI') + 1, m12b.findIndex(a => a[0] === 'EXEC'))
  check('(12) forced warm apply: provenance patch XX KEEPTTL, meta XX KEEPTTL', inMultiB.some(a => a[0] === 'SET' && a[1] === k.wines(s12.code) && a.includes('XX') && a.includes('KEEPTTL'))
    && inMultiB.at(-1)![1] === k.meta(s12.code) && inMultiB.at(-1)!.includes('XX') && inMultiB.at(-1)!.includes('KEEPTTL'))
  await wipeCache(s12.code)
  const labels: string[] = []
  mutationHooks.at = async (p, c, l) => { if (c === s12.code && (p === 'beforeLock' || p === 'beforePublish')) labels.push(`${p}:${l}`) }
  await runScript({ codes: [s12.code], apply: true, force: true })
  noHooks()
  check('(12) forced COLD apply: contract label rebuild:force, beforePublish label rebuild', JSON.stringify(labels) === JSON.stringify(['beforeLock:rebuild:force', 'beforePublish:rebuild']), labels)
  await wipeCache(s12.code)
  const prevAt = mutationHooks.at
  mutationHooks.at = async (p, c, l) => { if (p === 'recordRead' && c === s12.code && l === 'rebuild') await redis.set(k.gen(s12.code), crypto.randomUUID(), { EX: 3600 }) }
  const r12 = await runScript({ codes: [s12.code], apply: true })
  mutationHooks.at = prevAt
  check('(12) the baseline precedes the record reads: a generation change at recordRead refuses the publish', r12.line(s12.code)?.outcome === 'refused' && !(await redis.exists(k.meta(s12.code))), r12.line(s12.code))
  const s12d = await createSession({})
  await redis.del(k.wines(s12d.code))
  const m12d = parseMonitor(await monitored(() => ensureSessionLive(s12d.code)))
  check('(12) D5 (the app on a Redis-only moment) still re-seeds [] NX PX', m12d.some(a => a[0] === 'SET' && a[1] === k.wines(s12d.code) && a[2] === '[]' && a.includes('NX') && a.includes('PX')))

  // ── 13. Dry run is an estimate ──
  await ensureSessionLive(s12.code)
  const N = await mkUser('Newcomer OS13')
  const p13 = pauseAt('beforeProjection', s12.code, 'join')
  const j13 = join(s12.code, { cookie: N.cookie }, 'Newcomer OS13')
  await p13.entered
  const r13d = await runScript({ codes: [s12.code], force: true })
  check('(13) a forced dry run during the join\'s projection window plans the joiner (no lease, no wait)', r13d.line(s12.code)?.planned?.rebuilt.members === 1, r13d.line(s12.code))
  const a13 = runScript({ codes: [s12.code], force: true, apply: true })
  check('(13) …a forced apply meanwhile waits for the lease', await stillPending(a13, 600))
  p13.release()
  const [r13a] = await Promise.all([a13, j13])
  check('(13) …and, re-planned under its own locks, reports members 0', r13a.line(s12.code)?.outcome === 'applied' && r13a.line(s12.code)?.planned?.rebuilt.members === 0, r13a.line(s12.code))

  // ── 14. Confirmed effects ──
  await runScript({ codes: [s12.code], force: true, apply: true })
  const p14 = pauseAt('beforePublish', s12.code, 'rebuild:force')
  const r14p = runScript({ codes: [s12.code], force: true, apply: true })
  await p14.entered
  await redis.del(k.meta(s12.code))
  p14.release()
  const r14 = await r14p, l14 = r14.line(s12.code)
  check('(14) a converged moment whose meta expires before the EXEC: rewrite not acked, every count 0, drift — and the summary is NOT converged', l14?.meta?.expect === 'rewrite' && l14?.meta?.acked === false
    && zeroCounts(l14?.planned) && zeroCounts(l14?.confirmed) && l14?.drift === true && r14.summary.converged === false, { l14, converged: r14.summary.converged })
  check('(14) …the next ensureSessionLive rebuilds it', (await ensureSessionLive(s12.code)) === 'live' && !!(await redis.get(k.meta(s12.code))))
  await redis.hDel(k.identities(s12.code), `u:${T12.id}`)
  const l14b = (await runScript({ codes: [s12.code], force: true, apply: true })).line(s12.code)
  check('(14) a planned HSETNX that lands → confirmed true', l14b?.confirmed?.rebuilt.members === 1 && l14b?.drift === false, l14b)
  await redis.hDel(k.identities(s12.code), `u:${T12.id}`)
  const p14c = pauseAt('beforePublish', s12.code, 'rebuild:force')
  const r14cp = runScript({ codes: [s12.code], force: true, apply: true })
  await p14c.entered
  await redis.hSet(k.identities(s12.code), `u:${T12.id}`, 'Taster OS12')
  p14c.release()
  const l14c = (await r14cp).line(s12.code)
  check('(14) …one whose entry appears in the window → confirmed false, drift', l14c?.planned?.rebuilt.members === 1 && l14c?.confirmed?.rebuilt.members === 0 && l14c?.drift === true, l14c)

  // ── 15. Privacy ──
  const SENT = ['Zqxsentinelname', 'Zqxsentinelwine', 'Zqxsentinelnote', 'Zqxsentinelmeta', 'Zqxsentinelprisma', 'Zqxsentinelredis', 'Zqxsentinelreject', 'Zqxsentinelimport']
  const leaks = (txt: string) => SENT.filter(x => txt.includes(x))
  const HS = await mkUser('Zqxsentinelname Host'), TS = await mkUser('Taster OS15')
  const s15 = await createSession({ cookie: HS.cookie })
  await enter(s15.code, { cookie: TS.cookie }, 'Taster OS15')
  const w15 = await addWine(s15.code, { cookie: HS.cookie }, 'Zqxsentinelwine')
  await rate(s15.code, { cookie: TS.cookie }, w15, 4, { notes: 'Zqxsentinelnote' })
  const sc = await createSession({ cookie: HS.cookie })
  await redis.set(k.meta(sc.code), 'Zqxsentinelmeta{', { XX: true, KEEPTTL: true })
  await redis.del(k.identities(s15.code))
  const c15a = await runCli(['--force', s15.code, sc.code])
  const c15b = await runCli(['--force', '--apply', s15.code, sc.code])
  check('(15a) data path: no sentinel on stdout or stderr (dry run + apply)', [c15a, c15b].every(c => leaks(c.out + c.err).length === 0), [c15a, c15b].map(c => leaks(c.out + c.err)))
  check('(15a) …the corrupt code ends error with a class name only; the other plans/applies', c15a.lines.find(l => l.code === sc.code)?.error === 'SyntaxError'
    && c15a.lines.find(l => l.code === s15.code)?.outcome === 'planned' && c15b.lines.find(l => l.code === s15.code)?.outcome === 'applied', c15a.out)
  check('(15a) …no identity id on stdout', [c15a, c15b].every(c => !/\b[uad]:[0-9a-f]/.test(c.out)))
  const c15c = await runCli([s15.code], { worker: { prismaError: 'Zqxsentinelprisma' } })
  check('(15b) a real Prisma error-log line quoting a sentinel → only its tag', leaks(c15c.out + c15c.err).length === 0 && c15c.err.includes('prisma:error'), c15c.err)
  const c15d = await runCli([s15.code], { worker: { redisError: 'Zqxsentinelredis' } })
  check('(15c) the Redis client\'s error listener fed a sentinel → only tag + class', leaks(c15d.out + c15d.err).length === 0 && c15d.err.includes('redis err: Error'), c15d.err)
  const c15e = await runCli([s15.code], { worker: { rejectWith: 'Zqxsentinelreject' } })
  check('(15d) an unhandled rejection carrying a sentinel → sanitized, exit 3', leaks(c15e.out + c15e.err).length === 0 && c15e.exit === 3 && c15e.err.includes('unhandled rejection: Error'), { exit: c15e.exit, err: c15e.err })
  const c15f = await runCli([s15.code], { worker: { importFail: true } })
  check('(15e) a lib import that throws → sanitized, exit 3', leaks(c15f.out + c15f.err).length === 0 && c15f.exit === 3 && /\bError\b/.test(c15f.err), { exit: c15f.exit, err: c15f.err })

  // ── 16. CLI ──
  const u1 = await runCli([s15.code, '--active-since', '1'])
  const u2 = await runCli(['NOT-A-CODE!'])
  const u3 = await runCli(['--concurrency', '9', s15.code])
  check('(16) usage errors exit 2: codes + --active-since, an invalid code, --concurrency 9', u1.exit === 2 && u2.exit === 2 && u3.exit === 2 && !u1.out && !u2.out && !u3.out, [u1.exit, u2.exit, u3.exit])
  const ok16 = await runCli([s15.code, s12.code])
  check('(16) a dry run\'s stdout is JSON lines + one summary', ok16.exit === 0 && ok16.lines.length === 3 && ok16.lines.every(l => !('unparsable' in l))
    && ok16.lines.slice(0, 2).every(l => typeof l.code === 'string') && !!ok16.summary && (ok16.summary.selected as number) === 2, ok16.out)
}

const SECTIONS: Record<string, () => Promise<unknown>> = { roundTrip, grants, idempotent, nxxx, b1, fencing, deletions, d1, b2, tombstones, belts, recycling, generation, moderation, checkConstraint, replan, round2, round3, round4, round5, round6, operatorScript }
try {
  noHooks()
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (ONLY && ONLY !== name) continue
    try { await fn() }
    catch (err) { failed++; console.error(`\n💥 section ${name} aborted:`, err) }
    noHooks()
    lockTiming.leaseMs = 15_000
  }
} finally {
  for (const code of created) await wipeCache(code)
  await resetLimits()
}
console.log(`\n${pass} passed, ${failed} failed`)
void [sessionIsOver, scopedInvalidate, sessionLockKey, LockLost, ratingsRoute, leaveRoute, unbanRoute, checkinRoute, readFileSync, unrate]
await redis.quit().catch(() => {})
await prisma.$disconnect()
process.exit(failed === 0 ? 0 : 1)
