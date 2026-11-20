// Catalogue model change, build step 3: occurrence persistence
// (docs/dev/proposals/wine-catalog-model-change.md § 8a; build plan step 3).
// Record-first bottle writes in a Postgres-backed moment, the line-up revision
// (`sessions.lineup_revision` + the sibling key `s:{C}:wrev`), NULL = not
// reconciled, client ids + insert-only create, image attach on its own,
// check-in replay, the old-tab refusal, the build id, the census gate, and the
// previous release's mirror over a line-up the new code projected.
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only (refuses the dev db `verre`).
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/occurrence-persistence.mts [--only <section>]
import { toWire, fromWire, wireParams } from './lib/wireIds.mts'
import { linkLegacy, entryFor } from './lib/catalogFixture.mts'
import { fixtureUsername } from './lib/fixtureUsername.mjs'
import { oldMirrorLineup } from './lib/oldMirrorLineup.mts'
import { spawn, execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { prisma } from '../../lib/prisma.ts'
import { redis, k, scanKeys } from '../../lib/redis.ts'
import type { SessionMeta, WineMeta } from '../../lib/session.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = pjoin(HERE, '..', '..')
const SELF = fileURLToPath(import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: pathToFileURL(pjoin(HERE, 'stubs', 'nextauth-anonymous.mts')).href, shortCircuit: true }
    return next(specifier, context)
  },
})

type Actor = { cookie?: string; anon?: string; headers?: Record<string, string> }
const BASE = 'http://localhost:3000'
function request(method: string, path: string, actor: Actor = {}, body?: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(actor.headers ?? {}) }
  if (actor.cookie) headers.cookie = actor.cookie
  if (actor.anon) headers['x-vr-anon-token'] = actor.anon
  return new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}) {
  // Catalogue model change step 4: a typed bottle becomes a minted entry + its pick.
  body = await linkLegacy(method, path, body)
  if (typeof handler !== 'function') return { status: -1, json: { error: 'no such handler (not built yet)' } as Record<string, unknown>, headers: new Headers() }
  const res = await (handler as Handler)(request(method, path, actor, await toWire(body)), { params: Promise.resolve(await wireParams(params)) })
  let json: unknown = null
  try { json = await fromWire(await res.json()) } catch {}
  return { status: res.status, json: json as Record<string, unknown>, headers: res.headers }
}
// A module this step adds: absent on today's code (the test then fails).
async function optional(path: string): Promise<Record<string, unknown>> {
  try { return await import(path) } catch { return {} }
}

// ── Worker mode (child process): one route call, SIGKILLed at a hook ────────
if (process.argv[2] === '--worker') {
  const cfg = JSON.parse(process.argv[3]) as {
    module: string; method: string; path: string; actor: Actor; body?: unknown; params: Record<string, string>
    killAt: string; label: string; signal: string
  }
  const { mutationHooks } = await import('../../lib/sessionMutation.ts')
  const { lockTiming } = await import('../../lib/sessionLock.ts')
  lockTiming.leaseMs = 1500
  mutationHooks.at = async (point, _code, label) => {
    if (point !== cfg.killAt || label !== cfg.label) return
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
const joinRoute = await import('../../app/api/session/join/route.ts')
const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
const revealAllRoute = await import('../../app/api/session/[code]/wines/reveal-all/route.ts')
const hideAllRoute = await import('../../app/api/session/[code]/wines/hide-all/route.ts')
const reorderRoute = await import('../../app/api/session/[code]/wines/reorder/route.ts')
const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
const checkinsRoute = await import('../../app/api/checkins/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const imageRoute = await optional('../../app/api/session/[code]/wines/[wineId]/image/route.ts')
const buildRoute = await optional('../../app/api/build/route.ts')
const imageIO = (await optional('../../lib/occurrenceImage.ts')).occurrenceImageIO as
  { upload: (keyBase: string, dataUrl: string) => Promise<string>; reclaim: (urls: string[]) => void } | undefined
const { proxy } = await import('../../proxy.ts')
const { WEB_WIRE_GENERATION } = await import('../../lib/clientVersion.ts')
const { mutationHooks } = await import('../../lib/sessionMutation.ts')
const { sessionLockKey } = await import('../../lib/sessionLock.ts')
const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')
const { createProducer, createProduct, createVintage } = await import('../../lib/catalogWrite.ts')
const { ensureSessionLive } = await import('../../lib/sessionRehydrate.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TAG = `occ-${Date.now()}`
const created: string[] = []
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }
type User = { id: number; cookie: string }
let userSeq = 0
async function mkUser(name: string, opts: { pro?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const { headers } = await betterAuthServer.api.signUpEmail({ body: { name, email, password: `pw-${TAG}-${userSeq}`, username: fixtureUsername() } as never, returnHeaders: true })
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
  return { code: r.json.code as string, anon: r.json.anonToken as string | undefined }
}
async function join(code: string, actor: Actor, displayName = 'Joiner') {
  await resetLimits()
  const r = await call(joinRoute.POST, 'POST', '/api/session/join', actor, { code, displayName })
  return { status: r.status, anon: r.json?.anonToken as string | undefined, id: r.json?.id as string }
}
const visit = (code: string, actor: Actor) => call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, actor, {}, { code })
const enter = async (code: string, actor: Actor, name: string) => { const j = await join(code, actor, name); await visit(code, actor); return j }
const postWine = (code: string, actor: Actor, body: Record<string, unknown>) =>
  call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, { type: 'red', ...body }, { code })
async function addWine(code: string, actor: Actor, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = (extra.id as string | undefined) ?? nanoid()
  const r = await postWine(code, actor, { id, name, ...extra })
  if (r.status !== 200) throw new Error(`add wine failed ${r.status} ${JSON.stringify(r.json)}`)
  return id
}
const rate = (code: string, actor: Actor, wineId: string, score = 4) =>
  call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, { wineId, score, flavors: {}, notes: 'nice wine' }, { code })
const setRole = (code: string, actor: Actor, targetId: string, role: string) =>
  call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, actor, { action: 'set-role', targetId, role }, { code })
const settings = (code: string, actor: Actor, body: Record<string, unknown>) => call(settingsRoute.PATCH, 'PATCH', `/api/session/${code}/settings`, actor, body, { code })
const state = (code: string, actor: Actor) => call(stateRoute.GET, 'GET', `/api/session/${code}/state`, actor, undefined, { code })
const winesGet = (code: string, actor: Actor) => call(winesRoute.GET, 'GET', `/api/session/${code}/wines`, actor, undefined, { code })
// An edit sends the whole form (the edit has always required name + type);
// the brought-by reassign is ownership-only.
const editWine = (code: string, actor: Actor, wineId: string, body: Record<string, unknown>) =>
  call(wineRoute.PATCH, 'PATCH', `/api/session/${code}/wines/${wineId}`, actor, 'broughtByIdentityId' in body ? body : { type: 'red', ...body }, { code, wineId })
const delWine = (code: string, actor: Actor, wineId: string) => call(wineRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wineId}`, actor, undefined, { code, wineId })
const putImage = (code: string, actor: Actor, wineId: string, image: unknown) => call(imageRoute.PUT, 'PUT', `/api/session/${code}/wines/${wineId}/image`, actor, { image }, { code, wineId })
const delImage = (code: string, actor: Actor, wineId: string) => call(imageRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wineId}/image`, actor, undefined, { code, wineId })
const liveRow = async (code: string) => (await prisma.$queryRaw<{ id: number; lineup_revision: number | null }[]>`
  SELECT id, lineup_revision FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0]
const revisionOf = async (code: string) => (await liveRow(code))?.lineup_revision ?? null
const wrevOf = async (code: string) => redis.get(`s:${code}:wrev`)
const redisWines = async (code: string) => JSON.parse((await redis.get(k.wines(code))) ?? '[]') as WineMeta[]
const metaOf = async (code: string) => JSON.parse((await redis.get(k.meta(code))) ?? 'null') as SessionMeta | null
const recordRows = async (code: string) => {
  const row = await liveRow(code)
  if (!row) return []
  return prisma.$queryRaw<{ id: string; name: string; position: number | null; added_by_identity_id: string | null; image_url: string | null; revealed_at: Date | null }[]>`
    SELECT id, name, position, added_by_identity_id, image_url, revealed_at FROM wines WHERE session_id = ${row.id} ORDER BY position NULLS LAST, created_at, id`
}
const winesById = async (id: string) => prisma.$queryRaw<{ id: string; session_id: number | null; name: string; added_by_identity_id: string | null }[]>`
  SELECT id, session_id, name, added_by_identity_id FROM wines WHERE id = ${id}`
// The line-up the next read serves, as names.
const servedNames = async (code: string, actor: Actor) => {
  const s = await state(code, actor)
  return { status: s.status, names: ((s.json?.wines as { name: string }[] | null) ?? []).map(w => w.name) }
}
async function wipeCache(code: string) { const ks = await scanKeys(`s:${code}:*`); if (ks.length) await redis.del(ks) }
const noHooks = () => { mutationHooks.at = async () => {} }
// A promoted moment: a logged-in host (create writes the row), one bottle.
async function promotedMoment(H: User) {
  const s = await createSession({ cookie: H.cookie })
  return s
}
// A Redis-only moment: an anonymous host.
async function guestMoment() {
  const s = await createSession({})
  return s
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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
async function advisoryHolders(code: string): Promise<number> {
  return (await prisma.$queryRaw<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l
     WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted
       AND l.objid::bigint = (hashtext('session:' || ${code})::bigint & 4294967295)`).length
}
async function killedAt(cfg: { module: string; method: string; path: string; actor: Actor; body?: unknown; params: Record<string, string>; killAt: string; label: string }) {
  const signal = `occ:${Date.now()}:${Math.random()}`
  const l = await listenFor(signal)
  const child = spawn(process.execPath, ['--import', 'tsx', SELF, '--worker', JSON.stringify({ ...cfg, signal })], { cwd: REPO, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', d => { err += String(d) })
  const exited = new Promise<number | null>(res => child.on('exit', (_c, sig) => res(sig === 'SIGKILL' ? -9 : _c)))
  const hit = await l.wait()
  const code = await exited
  for (let i = 0; i < 50 && (await advisoryHolders(cfg.params.code)); i++) await sleep(100)
  for (let i = 0; i < 40 && (await redis.exists(sessionLockKey(cfg.params.code))); i++) await sleep(100)
  return { hit, killed: code === -9, err }
}

// ── § 1 Client ids, insert-only create, the acknowledgement ─────────────────
async function ids() {
  section('§ 1 client ids — a retried create is ONE bottle, a foreign id is 409, a bad id 400')
  const H = await mkUser('Host Ids')
  const s = await promotedMoment(H)
  const id = nanoid()
  const a = await postWine(s.code, { cookie: H.cookie }, { id, name: 'Retry Red' })
  const b = await postWine(s.code, { cookie: H.cookie }, { id, name: 'Retry Red' })
  const rows = await recordRows(s.code)
  check('(1a) a create retried after a lost response yields ONE occurrence (record)', rows.filter(r => r.name === 'Retry Red').length === 1 && rows.some(r => r.id === id), rows.map(r => [r.id, r.name]))
  check('(1a) …and one in the cached line-up', (await redisWines(s.code)).filter(w => w.name === 'Retry Red').length === 1)
  check('(1a) the first answer is the bottle, the retry an identity-free acknowledgement (id + alreadyAdded only)',
    a.status === 200 && a.json?.id === id && b.status === 200 && b.json?.id === id && b.json?.alreadyAdded === true && !('name' in (b.json ?? {})),
    [a.status, a.json?.id, b.status, b.json])

  // A foreign id: another adder in the same moment (a provider), and an id of
  // another moment's bottle.
  const P = await mkUser('Provider Ids')
  await enter(s.code, { cookie: P.cookie }, 'Provider Ids')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  const before = (await winesById(id))[0]
  const c = await postWine(s.code, { cookie: P.cookie }, { id, name: 'Hijack' })
  const after = (await winesById(id))[0]
  check('(1b) a provider POSTing the host\'s id → 409, the row unchanged', c.status === 409 && after?.name === 'Retry Red' && after?.added_by_identity_id === before?.added_by_identity_id, [c.status, c.json, after])
  const s2 = await promotedMoment(H)
  const d = await postWine(s2.code, { cookie: H.cookie }, { id, name: 'Other moment' })
  check('(1b) the same adder POSTing that id into ANOTHER moment → 409, nothing moves', d.status === 409 && (await winesById(id))[0]?.session_id === (await liveRow(s.code))!.id, [d.status, d.json])
  check('(1b) …and the other moment lists nothing', (await recordRows(s2.code)).length === 0 && (await redisWines(s2.code)).length === 0)

  for (const bad of [undefined, '', 'short', 'x'.repeat(22), 'bad id with spaces!!', '1700000000000', 42]) {
    const r = await postWine(s.code, { cookie: H.cookie }, { id: bad, name: 'Bad id' })
    check(`(1c) id ${JSON.stringify(bad)} → 400, nothing written`, r.status === 400 && !(await recordRows(s.code)).some(w => w.name === 'Bad id'), [r.status, r.json])
  }
  const img = await postWine(s.code, { cookie: H.cookie }, { id: nanoid(), name: 'With photo', image: PNG })
  check('(1d) a create carrying an image → 400 (the photo has its own call), nothing written', img.status === 400 && !(await recordRows(s.code)).some(w => w.name === 'With photo'), [img.status, img.json])

  // Redis-only: the same rule in the pure transform.
  const g = await guestMoment()
  const gid = nanoid()
  const g1 = await postWine(g.code, { anon: g.anon }, { id: gid, name: 'Guest Retry' })
  const g2 = await postWine(g.code, { anon: g.anon }, { id: gid, name: 'Guest Retry' })
  check('(1e) Redis-only: a retried create is one bottle, the retry acknowledged',
    g1.status === 200 && g2.status === 200 && g2.json?.alreadyAdded === true && (await redisWines(g.code)).filter(w => w.id === gid).length === 1, [g1.status, g2.status, g2.json])
  const j = await join(g.code, {}, 'Other Guest')
  const gh = await call(codeRoute.PATCH, 'PATCH', `/api/session/${g.code}`, { anon: g.anon }, { action: 'set-role', targetId: j.id, role: 'provider' }, { code: g.code })
  const g3 = await postWine(g.code, { anon: j.anon }, { id: gid, name: 'Guest Hijack' })
  check('(1e) Redis-only: another provider POSTing that id → 409, the bottle unchanged',
    gh.status === 200 && g3.status === 409 && (await redisWines(g.code)).find(w => w.id === gid)?.name === 'Guest Retry', [gh.status, g3.status, g3.json])
}

// ── § 2 The acknowledgement leaks nothing a host changed since ──────────────
async function ack() {
  section('§ 2 a retry\'s answer carries no label the viewer may not see (Blind for Everyone, hidden line-up)')
  const H = await mkUser('Host Ack', { pro: true })
  const P = await mkUser('Provider Ack')
  const s = await promotedMoment(H)
  await enter(s.code, { cookie: P.cookie }, 'Provider Ack')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  const id = nanoid()
  await addWine(s.code, { cookie: P.cookie }, 'Typed by provider', { id })
  const bl = await settings(s.code, { cookie: H.cookie }, { blind: true, blindForEveryone: true })
  const ed = await editWine(s.code, { cookie: H.cookie }, id, { name: 'Secret Label', producer: 'Secret House' })
  const retry = await postWine(s.code, { cookie: P.cookie }, { id, name: 'Typed by provider' })
  const text = JSON.stringify(retry.json)
  check('(2a) under Blind for Everyone, the adder\'s retry answers id + alreadyAdded only (no new label)',
    bl.status === 200 && ed.status === 200 && retry.status === 200 && retry.json?.alreadyAdded === true && !/Secret/.test(text) && Object.keys(retry.json ?? {}).sort().join() === 'alreadyAdded,id', [bl.status, ed.status, retry.status, retry.json])

  const H2 = await mkUser('Host Ack2', { pro: true })
  const P2 = await mkUser('Provider Ack2')
  const t = await createSession({ cookie: H2.cookie }, { dateFrom: new Date(Date.now() + 86_400_000).toISOString() })
  await enter(t.code, { cookie: P2.cookie }, 'Provider Ack2')
  await setRole(t.code, { cookie: H2.cookie }, `u:${P2.id}`, 'provider')
  const id2 = nanoid()
  await addWine(t.code, { cookie: P2.cookie }, 'Hidden typed', { id: id2 })
  const hl = await settings(t.code, { cookie: H2.cookie }, { hideLineup: true, hideLineupMinutesBefore: 0 })
  await editWine(t.code, { cookie: H2.cookie }, id2, { name: 'Hidden Secret' })
  const r2 = await postWine(t.code, { cookie: P2.cookie }, { id: id2, name: 'Hidden typed' })
  check('(2b) under a hidden line-up, the retry answers id + alreadyAdded only', hl.status === 200 && r2.status === 200 && r2.json?.alreadyAdded === true && !/Secret/.test(JSON.stringify(r2.json)), [hl.status, r2.status, r2.json])
}

// ── § 3 The revision ────────────────────────────────────────────────────────
async function revision() {
  section('§ 3 the line-up revision — every write bumps, the cache is stamped, the read compares')
  const H = await mkUser('Host Rev', { pro: true })
  const s = await promotedMoment(H)
  check('(3a) a logged-in create stamps the record at 1 and the cache with it', await revisionOf(s.code) === 1 && await wrevOf(s.code) === '1', [await revisionOf(s.code), await wrevOf(s.code)])
  const steps: [string, () => Promise<{ status: number }>][] = []
  const w1 = nanoid(), w2 = nanoid()
  steps.push(['add', () => postWine(s.code, { cookie: H.cookie }, { id: w1, name: 'Rev One' })])
  steps.push(['add (2nd)', () => postWine(s.code, { cookie: H.cookie }, { id: w2, name: 'Rev Two' })])
  steps.push(['edit', () => editWine(s.code, { cookie: H.cookie }, w1, { name: 'Rev One Edited', type: 'white' })])
  steps.push(['reorder', () => call(reorderRoute.POST, 'POST', `/api/session/${s.code}/wines/reorder`, { cookie: H.cookie }, { orderedIds: [w2, w1] }, { code: s.code })])
  steps.push(['reveal', () => call(revealRoute.POST, 'POST', `/api/session/${s.code}/wines/${w1}/reveal`, { cookie: H.cookie }, {}, { code: s.code, wineId: w1 })])
  steps.push(['hide', () => call(revealRoute.DELETE, 'DELETE', `/api/session/${s.code}/wines/${w1}/reveal`, { cookie: H.cookie }, undefined, { code: s.code, wineId: w1 })])
  steps.push(['reveal-all', () => call(revealAllRoute.POST, 'POST', `/api/session/${s.code}/wines/reveal-all`, { cookie: H.cookie }, {}, { code: s.code })])
  steps.push(['hide-all', () => call(hideAllRoute.POST, 'POST', `/api/session/${s.code}/wines/hide-all`, { cookie: H.cookie }, {}, { code: s.code })])
  steps.push(['delete', () => delWine(s.code, { cookie: H.cookie }, w2)])
  let prev = await revisionOf(s.code) ?? 0
  for (const [name, fn] of steps) {
    const r = await fn()
    const rev = await revisionOf(s.code)
    const wrev = await wrevOf(s.code)
    check(`(3b) ${name}: 200, the record bumped by one and the cache stamped with it`, r.status === 200 && rev === prev + 1 && wrev === String(rev), { status: r.status, prev, rev, wrev })
    prev = rev ?? prev
  }
  const cached = await redisWines(s.code)
  const rec = await recordRows(s.code)
  check('(3c) after the run the cache IS the record (ids, order, names)', JSON.stringify(cached.map(w => [w.id, w.name])) === JSON.stringify(rec.map(r => [r.id, r.name])), { cached: cached.map(w => w.name), rec: rec.map(r => r.name) })
  check('(3c) positions stay contiguous 0..n-1 (the old mirror reads the array index as the position)', rec.every((r, i) => r.position === i), rec.map(r => r.position))
  check('(3c) the blob keeps the old shape: no colour / sparkling / abv / origin keys', cached.every(w => !('colour' in w) && !('sparkling' in w) && !('abv' in w) && !('origin' in w)))
  const snap = await prisma.$queryRaw<{ style: string | null; colour: string | null; sparkling: boolean; origin: string | null }[]>`SELECT style, colour, sparkling, origin FROM wines WHERE id = ${w1}`
  check('(3d) an edited type writes style AND its colour / sparkling in the same statement, origin session', snap[0]?.style === 'white' && snap[0]?.colour === 'white' && snap[0]?.sparkling === false && snap[0]?.origin === 'session', snap[0])

  // The style rule (spec § 8a.0): since every new bottle links (step 4) its
  // token is derived from the entry's PAIR, so an alcohol-free entry (abv 0,
  // no colour) gives no token; the alcohol-free fact is the abv, and an
  // unrelated edit keeps it. (A legacy `nonalc` token surviving an unrelated
  // edit: catalog-every-write.mts § 9c.) A re-link re-derives the pair.
  const na = await addWine(s.code, { cookie: H.cookie }, 'Alcohol Free Bottle', { type: 'nonalc' })
  await editWine(s.code, { cookie: H.cookie }, na, { description: 'Unrelated edit' })
  const naRow = await prisma.$queryRaw<{ style: string | null; colour: string | null; sparkling: boolean; abv: unknown; description: string | null }[]>`SELECT style, colour, sparkling, abv, description FROM wines WHERE id = ${na}`
  check('(3d) a linked alcohol-free bottle edited for an unrelated field: no token, neither colour nor sparkling, abv 0 kept', naRow[0]?.style === null && naRow[0]?.colour === null && naRow[0]?.sparkling === false && Number(naRow[0]?.abv) === 0 && naRow[0]?.description === 'Unrelated edit' && (await redisWines(s.code)).find(w => w.id === na)?.type === '', naRow[0])
  await editWine(s.code, { cookie: H.cookie }, na, { name: 'Alcohol Free Bottle', type: 'spark' })
  const spRow = await prisma.$queryRaw<{ style: string | null; colour: string | null; sparkling: boolean }[]>`SELECT style, colour, sparkling FROM wines WHERE id = ${na}`
  check('(3d) …a type change to spark sets sparkling, colour unknown, in the same statement', spRow[0]?.style === 'spark' && spRow[0]?.colour === null && spRow[0]?.sparkling === true, spRow[0])
  await delWine(s.code, { cookie: H.cookie }, na)
  prev = await revisionOf(s.code) ?? 0

  // Behind: the record moved, the cache did not (a write whose projection never ran).
  const G = await mkUser('Guest Rev')
  await enter(s.code, { cookie: G.cookie }, 'Guest Rev')
  const row = (await liveRow(s.code))!
  await prisma.$executeRaw`UPDATE wines SET name = 'Behind Name' WHERE id = ${w1}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${row.id}`
  const behind = await servedNames(s.code, { cookie: G.cookie })
  check('(3e) a cache BEHIND the record: the next read serves the record\'s line-up (white-box: record changed + bumped, no projection)', behind.names.includes('Behind Name'), behind)
  check('(3e) …and re-stamps the cache', await wrevOf(s.code) === String(await revisionOf(s.code)))
  // Ahead: the cache names a revision the record never committed.
  await redis.set(`s:${s.code}:wrev`, '999', { KEEPTTL: true })
  await redis.set(k.wines(s.code), JSON.stringify([...(await redisWines(s.code)), { id: nanoid(), name: 'Ghost', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]), { XX: true, KEEPTTL: true })
  const ahead = await servedNames(s.code, { cookie: G.cookie })
  check('(3f) a cache AHEAD of the record (an EXEC before a failed COMMIT): replaced from the record', !ahead.names.includes('Ghost') && await wrevOf(s.code) === String(await revisionOf(s.code)), ahead)
  // Missing stamp.
  await redis.del(`s:${s.code}:wrev`)
  await redis.set(k.wines(s.code), JSON.stringify((await redisWines(s.code)).map(w => ({ ...w, name: 'Unstamped' }))), { XX: true, KEEPTTL: true })
  const miss = await servedNames(s.code, { cookie: G.cookie })
  check('(3g) a cache with no stamp: replaced from the record', !miss.names.includes('Unstamped') && await wrevOf(s.code) === String(await revisionOf(s.code)), miss)
  // A guest (no grant) reads through the same check.
  const A = await join(s.code, {}, 'Anon Rev')
  await prisma.$executeRaw`UPDATE wines SET name = 'Behind For Guests' WHERE id = ${w1}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${row.id}`
  const ga = await servedNames(s.code, { anon: A.anon })
  check('(3h) a guest\'s read (no grant) compares too', ga.names.includes('Behind For Guests'), ga)
  const wg = await winesGet(s.code, { anon: A.anon })
  check('(3h) …and the wines GET', wg.status === 200 && (wg.json as unknown as { name: string }[]).some(w => w.name === 'Behind For Guests'))
}

// ── § 4 Failures: record-first, the stale-cache cases ───────────────────────
async function failures() {
  section('§ 4 failures — a failed Postgres write fails the request; a lost projection never leaves a stale line-up')
  const H = await mkUser('Host Fail')
  const s = await promotedMoment(H)
  const w = await addWine(s.code, { cookie: H.cookie }, 'Fail Base')
  // A Postgres write that fails (a test trigger on the bottle's name).
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION occ_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name LIKE '%BOOM%' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`)
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS occ_test_boom ON wines`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER occ_test_boom BEFORE INSERT OR UPDATE ON wines FOR EACH ROW EXECUTE FUNCTION occ_test_boom()`)
  try {
    const add = await postWine(s.code, { cookie: H.cookie }, { id: nanoid(), name: 'BOOM add' })
    check('(4a) an add whose Postgres write fails → the request fails (5xx), nothing in the cache', add.status >= 500 && !(await redisWines(s.code)).some(x => x.name === 'BOOM add'), [add.status, add.json])
    const ed = await editWine(s.code, { cookie: H.cookie }, w, { name: 'BOOM edit' })
    check('(4b) an edit whose Postgres write fails → the request fails, the cache keeps the old name', ed.status >= 500 && (await redisWines(s.code)).find(x => x.id === w)?.name === 'Fail Base', [ed.status, ed.json])
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS occ_test_boom ON wines`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS occ_test_boom()`)
  }
  // A transaction that rolls back after the work: nothing may reach Redis first.
  mutationHooks.at = async (p, c, l) => { if (p === 'beforeCommit' && c === s.code && l === 'wine-edit') throw new Error('test: rollback') }
  const rb = await editWine(s.code, { cookie: H.cookie }, w, { name: 'Rolled Back' })
  noHooks()
  const after = await servedNames(s.code, { cookie: H.cookie })
  check('(4c) an edit rolled back after its work: the next read serves the record (no Redis-first write survived)', rb.status >= 500 && !after.names.includes('Rolled Back') && after.names.includes('Fail Base'), [rb.status, after])
  // The projection fails after COMMIT (the lease is stolen).
  mutationHooks.at = async (p, c, l) => { if (p === 'beforeProjection' && c === s.code && l === 'wine-edit') await redis.set(sessionLockKey(s.code), 'stolen', { XX: true, KEEPTTL: true }) }
  const pf = await editWine(s.code, { cookie: H.cookie }, w, { name: 'Projected Later' })
  noHooks()
  await redis.del(sessionLockKey(s.code))
  const pfRead = await servedNames(s.code, { cookie: H.cookie })
  check('(4d) a projection that fails after COMMIT: the request succeeded and the next read serves the record', pf.status === 200 && pfRead.names.includes('Projected Later'), [pf.status, pfRead])
  // A process killed between COMMIT and the projection.
  const kill = await killedAt({
    module: 'app/api/session/[code]/wines/[wineId]/route.ts', method: 'PATCH', path: `/api/session/${s.code}/wines/${w}`,
    actor: { cookie: H.cookie }, body: { name: 'Killed After Commit', type: 'red' }, params: { code: s.code, wineId: w }, killAt: 'afterCommit', label: 'wine-edit',
  })
  const kRead = await servedNames(s.code, { cookie: H.cookie })
  check('(4e) a process killed between COMMIT and the projection: the next read serves the record', kill.hit && kill.killed && kRead.names.includes('Killed After Commit'), { kill: { hit: kill.hit, killed: kill.killed, err: kill.err.slice(0, 300) }, kRead })
}

// ── § 5 Reconciliation (NULL = not reconciled) ──────────────────────────────
async function reconcile() {
  section('§ 5 reconciliation — a NULL revision copies cache-only bottles in and orphans record-only rows, then stamps 1')
  const H = await mkUser('Host Rec')
  const R = await mkUser('Rater Rec')
  const s = await promotedMoment(H)
  const keep = await addWine(s.code, { cookie: H.cookie }, 'Rec Keep')
  const leftover = await addWine(s.code, { cookie: H.cookie }, 'Rec Leftover')
  await enter(s.code, { cookie: R.cookie }, 'Rater Rec')
  await rate(s.code, { cookie: R.cookie }, leftover, 4)
  const row = (await liveRow(s.code))!
  // The pre-deploy state: revision NULL, no stamp; the cache holds a bottle whose
  // mirror failed (cache-only) and lacks one whose DELETE mirror failed (record-only).
  const cacheOnly = nanoid()
  const cached = (await redisWines(s.code)).filter(w => w.id !== leftover)
  cached.push({ id: cacheOnly, name: 'Rec Cache Only', producer: 'P', vintage: '2019', grape: '', type: 'nonalc', image: '', imageUrl: '', addedByIdentityId: `u:${H.id}`, addedByDisplayName: 'Hana Host' })
  await redis.set(k.wines(s.code), JSON.stringify(cached), { XX: true, KEEPTTL: true })
  await redis.del(`s:${s.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE id = ${row.id}`
  const read = await servedNames(s.code, { cookie: H.cookie })
  const recIds = (await recordRows(s.code)).map(r => r.id)
  check('(5a) the first read serves the cache-only bottle (a tolerant old blob: type only, no stamp)', read.names.includes('Rec Cache Only') && read.names.includes('Rec Keep'), read)
  check('(5a) …copied into the record strictly', recIds.includes(cacheOnly), recIds)
  const co = await prisma.$queryRaw<{ style: string | null; colour: string | null; sparkling: boolean; abv: unknown; origin: string | null; added_by_identity_id: string | null }[]>`
    SELECT style, colour, sparkling, abv, origin, added_by_identity_id FROM wines WHERE id = ${cacheOnly}`
  check('(5a) …keeping its legacy token (nonalc survives) with the snapshot derived, provenance kept', co[0]?.style === 'nonalc' && co[0]?.colour === null && co[0]?.sparkling === false && Number(co[0]?.abv) === 0 && co[0]?.origin === 'session' && co[0]?.added_by_identity_id === `u:${H.id}`, co[0])
  const lo = (await winesById(leftover))[0]
  const loRatings = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ratings WHERE wine_id = ${leftover}`
  check('(5b) the failed-DELETE leftover is ORPHANED (session_id NULL), its rating kept', !!lo && lo.session_id === null && Number(loRatings[0].n) === 1, { lo, ratings: Number(loRatings[0].n) })
  check('(5c) stamped 1, cache and record agree', await revisionOf(s.code) === 1 && await wrevOf(s.code) === '1', [await revisionOf(s.code), await wrevOf(s.code)])
  await addWine(s.code, { cookie: H.cookie }, 'Rec After')
  const again = await servedNames(s.code, { cookie: H.cookie })
  check('(5d) the leftover does not come back on the next write or read', !again.names.includes('Rec Leftover') && (await winesById(leftover))[0]?.session_id === null, again)
  void keep

  // A cold session with a NULL revision stamps 1 from the record.
  const t = await promotedMoment(H)
  await addWine(t.code, { cookie: H.cookie }, 'Cold One')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${t.code} AND deleted_at IS NULL`
  await wipeCache(t.code)
  const cold = await servedNames(t.code, { cookie: H.cookie })
  check('(5e) a cold session with a NULL revision rebuilds from the record and stamps 1', cold.status === 200 && cold.names.includes('Cold One') && await revisionOf(t.code) === 1 && await wrevOf(t.code) === '1', [cold, await revisionOf(t.code), await wrevOf(t.code)])

  // A writer that meets a NULL revision reconciles before it writes.
  const u = await promotedMoment(H)
  const uw = await addWine(u.code, { cookie: H.cookie }, 'Writer Base')
  const urow = (await liveRow(u.code))!
  const uOnly = nanoid()
  await redis.set(k.wines(u.code), JSON.stringify([...(await redisWines(u.code)), { id: uOnly, name: 'Writer Cache Only', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]), { XX: true, KEEPTTL: true })
  await redis.del(`s:${u.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE id = ${urow.id}`
  const r = await editWine(u.code, { cookie: H.cookie }, uw, { name: 'Writer Edited' })
  const urec = (await recordRows(u.code)).map(x => x.name)
  // Revision 1, not 2: the reconciliation stamps 1 inside the edit's own
  // transaction and no cache was ever stamped 1 before (NULL = never stamped).
  check('(5f) an edit on an unreconciled moment first copies the cache-only bottle, then edits; stamped 1, the cache with it', r.status === 200 && urec.includes('Writer Cache Only') && urec.includes('Writer Edited') && await revisionOf(u.code) === 1 && await wrevOf(u.code) === '1', [r.status, urec, await revisionOf(u.code)])
  // The rate route (no lease) reconciles too: a cache-only bottle is ratable.
  const v = await promotedMoment(H)
  await addWine(v.code, { cookie: H.cookie }, 'Rate Base')
  const vOnly = nanoid()
  await redis.set(k.wines(v.code), JSON.stringify([...(await redisWines(v.code)), { id: vOnly, name: 'Rate Cache Only', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]), { XX: true, KEEPTTL: true })
  await redis.del(`s:${v.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${v.code} AND deleted_at IS NULL`
  const rr = await rate(v.code, { cookie: H.cookie }, vOnly, 3)
  check('(5g) a rate on an unreconciled moment reconciles (the cache-only bottle gets its row) and rates it', rr.status === 200 && (await winesById(vOnly))[0]?.session_id === (await liveRow(v.code))!.id && await revisionOf(v.code) === 1, [rr.status, rr.json])
  // …but in a RECONCILED moment the record decides: a bottle only the cache
  // lists (an old instance's failed mirror during the rollout) does not exist.
  const ghost = nanoid()
  await redis.set(k.wines(v.code), JSON.stringify([...(await redisWines(v.code)), { id: ghost, name: 'Rollout Ghost', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]), { XX: true, KEEPTTL: true })
  const rg = await rate(v.code, { cookie: H.cookie }, ghost, 3)
  check('(5h) in a reconciled moment the rate decides on the record: a cache-only bottle is 404, no row created', rg.status === 404 && (await winesById(ghost)).length === 0, [rg.status, rg.json])
}

// ── § 6 Redis-only moments and image attach ─────────────────────────────────
async function images() {
  section('§ 6 image attach — its own call, Redis-only refused, a failed write leaves no object')
  const H = await mkUser('Host Img')
  const g = await guestMoment()
  const gw = await addWine(g.code, { anon: g.anon }, 'Guest Bottle')
  const ro = await putImage(g.code, { anon: g.anon }, gw, PNG)
  check('(6a) a Redis-only moment refuses an image: 403, copy says to sign in, no em dash', ro.status === 403 && /sign in/i.test(String(ro.json?.error)) && !String(ro.json?.error).includes('—'), [ro.status, ro.json])
  if (!imageIO) { check('(6) the image seam exists (lib/occurrenceImage.ts)', false); return }
  const uploads: string[] = [], reclaims: string[] = []
  const real = { ...imageIO }
  imageIO.upload = async (keyBase) => { const url = `https://s3.test/verre/${keyBase}.png`; uploads.push(url); return url }
  imageIO.reclaim = (urls) => { reclaims.push(...urls) }
  try {
    check('(6a) …and uploaded nothing', uploads.length === 0)
    const s = await promotedMoment(H)
    const w = await addWine(s.code, { cookie: H.cookie }, 'Photo Bottle')
    const rev0 = await revisionOf(s.code)
    const a = await putImage(s.code, { cookie: H.cookie }, w, PNG)
    const url1 = uploads.at(-1)!
    check('(6b) attach: 200, the URL on the record and in the cache, revision bumped', a.status === 200 && (await recordRows(s.code))[0]?.image_url === url1 && (await redisWines(s.code))[0]?.imageUrl === url1 && await revisionOf(s.code) === (rev0 ?? 0) + 1, [a.status, a.json])
    // The shape IS the guarantee (lib/imageKeys.ts): a kind marker + 32 random
    // hex characters, nothing else (a short user id can occur in random hex).
    check('(6b) …the key is fresh and names no person', /^https:\/\/s3\.test\/verre\/wines\/oc_[0-9a-f]{32}\.png$/.test(url1), url1)
    const b = await putImage(s.code, { cookie: H.cookie }, w, PNG)
    const url2 = uploads.at(-1)!
    check('(6c) replace: a NEW key, the replaced object reclaimed after COMMIT', b.status === 200 && url2 !== url1 && reclaims.includes(url1) && !reclaims.includes(url2), { uploads, reclaims })
    mutationHooks.at = async (p, c, l) => { if (p === 'beforeCommit' && c === s.code && l === 'wine-image') throw new Error('test: write fails') }
    const f = await putImage(s.code, { cookie: H.cookie }, w, PNG)
    noHooks()
    const url3 = uploads.at(-1)!
    check('(6d) an image whose DB write fails: error answered, the NEW object reclaimed before answering, the old kept', f.status >= 500 && url3 !== url2 && reclaims.includes(url3) && !reclaims.includes(url2) && (await recordRows(s.code))[0]?.image_url === url2, { status: f.status, uploads, reclaims })
    const bad = await putImage(s.code, { cookie: H.cookie }, w, 'data:image/png;base64,AAAA')
    check('(6e) an invalid image (magic bytes) → 400 before any upload', bad.status === 400 && uploads.length === 3, [bad.status, uploads.length])
    const d = await delImage(s.code, { cookie: H.cookie }, w)
    check('(6f) remove: the URL gone from record and cache, the object reclaimed after COMMIT', d.status === 200 && !(await recordRows(s.code))[0]?.image_url && !(await redisWines(s.code))[0]?.imageUrl && reclaims.includes(url2), [d.status, reclaims])
    // A provider may attach only to its own bottle (from the record).
    const P = await mkUser('Provider Img')
    await enter(s.code, { cookie: P.cookie }, 'Provider Img')
    await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
    const n = uploads.length
    const pr = await putImage(s.code, { cookie: P.cookie }, w, PNG)
    check('(6g) a provider attaching to the host\'s bottle → 403, and NO upload was made (checked on the record first)', pr.status === 403 && uploads.length === n, [pr.status, uploads.length - n])
    const nf = await putImage(s.code, { cookie: H.cookie }, nanoid(), PNG)
    check('(6g) a photo for a bottle the record does not have → 404, no upload', nf.status === 404 && uploads.length === n, [nf.status, uploads.length - n])
    const edit = await editWine(s.code, { cookie: H.cookie }, w, { name: 'No image here', image: PNG })
    check('(6h) the PATCH no longer carries an image → 400', edit.status === 400, [edit.status, edit.json])
  } finally {
    imageIO.upload = real.upload
    imageIO.reclaim = real.reclaim
    noHooks()
  }
}

// ── § 7 The previous release's mirror over a new-projected line-up ──────────
async function oldMirror() {
  section('§ 7 the OLD mirrorLineup (main) over a line-up the new code projected changes no row')
  const H = await mkUser('Host Old')
  const s = await promotedMoment(H)
  // The bottle's grape, region and origin come from its entry since step 4.
  const product = await prisma.$transaction(async (tx) => {
    const p = await createProducer({ name: `${TAG} Old Producer` }, H.id, tx)
    const pr = await createProduct({ name: `${TAG} Old Wine`, producerId: p.id, colour: 'red', grapes: ['Pinot Noir'], region: 'Burgundy', country: 'FR' }, H.id, [], tx)
    const v = await createVintage(pr.id, 2019, H.id, null, tx)
    return { productId: pr.id, vintageId: v.id }
  })
  const full = await addWine(s.code, { cookie: H.cookie }, 'Full Fifteen', {
    producer: 'Maison Test', vintage: '2019', grape: 'Pinot Noir', type: 'red', description: 'A description.', region: 'Burgundy',
    country: 'FR', vinification: 'Oak, 12 months.', purchaseUrl: 'https://shop.example/wine', ...product,
  })
  // A LEGACY alcohol-free bottle (a linked one has no token since step 4):
  // written as the expand migration left such rows, then projected by the
  // reveal below like every bottle of the record.
  const nonalc = nanoid()
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, origin, name, style, colour, sparkling, abv, position)
    VALUES (${nonalc}, ${(await liveRow(s.code))!.id}, 'session', 'Alcohol Free', 'nonalc', NULL, false, 0, 1)`
  if (imageIO) {
    const real = imageIO.upload
    imageIO.upload = async (keyBase) => `https://s3.test/verre/${keyBase}.png`
    try { await putImage(s.code, { cookie: H.cookie }, full, PNG) } finally { imageIO.upload = real }
  }
  await call(revealRoute.POST, 'POST', `/api/session/${s.code}/wines/${full}/reveal`, { cookie: H.cookie }, {}, { code: s.code, wineId: full })
  const row = (await liveRow(s.code))!
  const cols = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, name, producer, vintage, grape, style, image_url, description, region, country, vinification, purchase_url, revealed_at, product_id, vintage_id, position
      FROM wines WHERE id = ${full}`
  const filled = Object.entries(cols[0] ?? {}).filter(([, v]) => v !== null && v !== '').map(([key]) => key)
  check('(7a) fixture: all fifteen compared columns filled on one bottle (+ a nonalc bottle)', filled.length === 16, filled)
  const before = await prisma.$queryRaw<{ id: string; xmin: string }[]>`SELECT id, xmin::text FROM wines WHERE session_id = ${row.id} ORDER BY id`
  const blob = await redisWines(s.code)
  await prisma.$transaction(async (tx) => { await oldMirrorLineup(tx, row.id, blob as never) })
  const after = await prisma.$queryRaw<{ id: string; xmin: string }[]>`SELECT id, xmin::text FROM wines WHERE session_id = ${row.id} ORDER BY id`
  check('(7b) the old mirror over the projected blob rewrote NO row (xmin unchanged for every bottle)', JSON.stringify(before) === JSON.stringify(after), { before, after })
  const na = await prisma.$queryRaw<{ style: string | null }[]>`SELECT style FROM wines WHERE id = ${nonalc}`
  check('(7c) the nonalc token survives in the record and the blob', na[0]?.style === 'nonalc' && blob.find(w => w.id === nonalc)?.type === 'nonalc')
}

// ── § 8 Check-in replay ─────────────────────────────────────────────────────
async function checkins() {
  section('§ 8 check-in replay — one occurrence, one rating, one feed item; a foreign id 409; photos on their own call')
  const U = await mkUser('Checkin Owner')
  const V = await mkUser('Checkin Other')
  const body = (occurrenceId: string, extra: Record<string, unknown> = {}) => ({ occurrenceId, wineName: 'Replay Wine', type: 'red', score: 4, flavors: {}, notes: 'n', ...extra })
  const counts = async (occ: string) => {
    const [w] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wines WHERE id = ${occ}`
    const [r] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ratings WHERE wine_id = ${occ}`
    const [f] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM feed_items fi JOIN ratings r ON r.id = fi.rating_id WHERE r.wine_id = ${occ}`
    return [Number(w.n), Number(r.n), Number(f.n)]
  }
  const post = async (actor: Actor, b: Record<string, unknown>) => { await resetLimits(); return call(checkinsRoute.POST, 'POST', '/api/checkins', actor, b) }
  const occ = nanoid()
  const a = await post({ cookie: U.cookie }, body(occ))
  const b = await post({ cookie: U.cookie }, body(occ))
  check('(8a) a check-in retried after a lost response: exactly one wine, one rating, one feed item', JSON.stringify(await counts(occ)) === '[1,1,1]', await counts(occ))
  check('(8a) the retry answers the existing check-in (same feed id, 200)', a.status === 201 && b.status === 200 && a.json?.id === b.json?.id, [a.status, a.json?.id, b.status, b.json?.id])
  const occ2 = nanoid()
  const [c1, c2, c3] = await Promise.all([post({ cookie: U.cookie }, body(occ2)), post({ cookie: U.cookie }, body(occ2)), post({ cookie: U.cookie }, body(occ2))])
  check('(8b) three concurrent retries: exactly one of each, every answer the same check-in', JSON.stringify(await counts(occ2)) === '[1,1,1]' && new Set([c1.json?.id, c2.json?.id, c3.json?.id]).size === 1 && [c1, c2, c3].every(x => x.status === 200 || x.status === 201), { counts: await counts(occ2), st: [c1.status, c2.status, c3.status] })
  const f = await post({ cookie: V.cookie }, body(occ))
  check('(8c) another person POSTing that occurrence id → 409, nothing added', f.status === 409 && JSON.stringify(await counts(occ)) === '[1,1,1]', [f.status, f.json])
  for (const bad of [undefined, 'short', 7]) {
    const r = await post({ cookie: U.cookie }, body(bad as string))
    check(`(8d) occurrenceId ${JSON.stringify(bad)} → 400`, r.status === 400, [r.status, r.json])
  }
  const img = await post({ cookie: U.cookie }, body(nanoid(), { imageData: PNG }))
  check('(8e) a check-in create carrying image data → 400 (the photo goes through the check-in\'s own PATCH)', img.status === 400, [img.status, img.json])
  const so = await prisma.$queryRaw<{ origin: string | null; colour: string | null; sparkling: boolean }[]>`SELECT origin, colour, sparkling FROM wines WHERE id = ${occ}`
  check('(8f) the standalone occurrence carries origin standalone and its snapshot', so[0]?.origin === 'standalone' && so[0]?.colour === 'red' && so[0]?.sparkling === false, so[0])
  const p = await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${a.json?.id}`, { cookie: U.cookie }, { imageData: PNG }, { id: String(a.json?.id) })
  check('(8g) the photo attaches through PATCH /api/checkins/<id> with only imageData (S3 off here: answered, never a 500)', p.status === 200 || p.status === 502, [p.status, p.json])
  // Ruled 2026-11-20: the first photo, sent alone right after posting, costs no
  // second slot of the shared rl:checkin budget; anything else is charged.
  const RL = `rl:checkin:${U.id}:1h`
  await resetLimits()
  const fresh = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: U.cookie }, body(nanoid()))
  const pid = String(fresh.json?.id)
  const n0 = Number(await redis.get(RL))
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${pid}`, { cookie: U.cookie }, { imageData: PNG }, { id: pid })
  check('(8h) the first photo alone, right after posting, is not charged', Number(await redis.get(RL)) === n0 && n0 === 1, [n0, await redis.get(RL)])
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${pid}`, { cookie: U.cookie }, { imageData: PNG, notes: 'and a note' }, { id: pid })
  check('(8h) a photo sent with another field is charged', Number(await redis.get(RL)) === n0 + 1, await redis.get(RL))
  await prisma.$executeRaw`UPDATE feed_items SET created_at = now() - interval '11 minutes' WHERE id = ${Number(pid)}`
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${pid}`, { cookie: U.cookie }, { imageData: PNG }, { id: pid })
  check('(8h) a photo on a check-in posted more than 10 minutes ago is charged', Number(await redis.get(RL)) === n0 + 2, await redis.get(RL))
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${pid}`, { cookie: V.cookie }, { imageData: PNG }, { id: pid })
  check('(8h) someone else\'s check-in: charged, 404', Number(await redis.get(`rl:checkin:${V.id}:1h`)) === 1, await redis.get(`rl:checkin:${V.id}:1h`))
}

// ── § 9 Every writer bumps; the scrubs NULL it ──────────────────────────────
async function writers() {
  section('§ 9 every writer bumps — ban-with-delete, reassign, account deletion; the scrubs NULL the revision')
  const H = await mkUser('Host Wr')
  const P = await mkUser('Provider Wr')
  const T = await mkUser('Target Wr')
  const s = await promotedMoment(H)
  await enter(s.code, { cookie: P.cookie }, 'Provider Wr')
  await enter(s.code, { cookie: T.cookie }, 'Target Wr')
  await setRole(s.code, { cookie: H.cookie }, `u:${P.id}`, 'provider')
  const pw = await addWine(s.code, { cookie: P.cookie }, 'By Provider')
  let rev = await revisionOf(s.code)
  const ra = await editWine(s.code, { cookie: H.cookie }, pw, { broughtByIdentityId: `u:${T.id}` })
  check('(9a) reassign brought-by: bumped, the cache stamped and naming the new owner', ra.status === 200 && await revisionOf(s.code) === (rev ?? 0) + 1 && await wrevOf(s.code) === String(await revisionOf(s.code)) && (await redisWines(s.code)).find(w => w.id === pw)?.addedByIdentityId === `u:${T.id}`, [ra.status, ra.json])
  rev = await revisionOf(s.code)
  const tw = await addWine(s.code, { cookie: P.cookie }, 'Provider Two')
  await editWine(s.code, { cookie: H.cookie }, tw, { broughtByIdentityId: `u:${T.id}` })
  rev = await revisionOf(s.code)
  const b = await call(bansRoute.POST, 'POST', `/api/session/${s.code}/bans`, { cookie: H.cookie }, { identityId: `u:${T.id}`, mode: 'ban', deleteAddedWines: true }, { code: s.code })
  check('(9b) ban with delete-their-bottles: orphaned in the record, gone from the cache, bumped + stamped', b.status === 200 && (await winesById(pw))[0]?.session_id === null && !(await redisWines(s.code)).some(w => w.id === pw || w.id === tw) && await revisionOf(s.code) === (rev ?? 0) + 1 && await wrevOf(s.code) === String(await revisionOf(s.code)), [b.status, b.json, await revisionOf(s.code)])
  // Account deletion's provenance tombstone bumps a reconciled moment.
  const D = await mkUser('Deleted Adder')
  const t = await promotedMoment(H)
  await enter(t.code, { cookie: D.cookie }, 'Deleted Adder')
  await setRole(t.code, { cookie: H.cookie }, `u:${D.id}`, 'provider')
  const dw = await addWine(t.code, { cookie: D.cookie }, 'Adder Gone')
  rev = await revisionOf(t.code)
  await deleteAccountDurable(D.id)
  check('(9c) account deletion tombstones the adder and bumps the revision', (await winesById(dw))[0]?.added_by_identity_id?.startsWith('d:') === true && await revisionOf(t.code) === (rev ?? 0) + 1, [(await winesById(dw))[0], await revisionOf(t.code)])
  const after = await servedNames(t.code, { cookie: H.cookie })
  check('(9c) …and the next read serves the tombstoned line-up, stamped', after.names.includes('Adder Gone') && await wrevOf(t.code) === String(await revisionOf(t.code)), after)
  // …but never turns a NULL (unreconciled) revision into a number.
  const u = await promotedMoment(H)
  const D2 = await mkUser('Deleted Adder 2')
  await enter(u.code, { cookie: D2.cookie }, 'Deleted Adder 2')
  await setRole(u.code, { cookie: H.cookie }, `u:${D2.id}`, 'provider')
  await addWine(u.code, { cookie: D2.cookie }, 'Adder Gone 2')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${u.code} AND deleted_at IS NULL`
  await deleteAccountDurable(D2.id)
  check('(9d) account deletion leaves a NULL revision NULL (it cannot reconcile)', await revisionOf(u.code) === null, await revisionOf(u.code))
  // The scrubs.
  const del = await promotedMoment(H)
  await addWine(del.code, { cookie: H.cookie }, 'Deleted With Moment')
  const delId = (await liveRow(del.code))!.id
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = 5 WHERE id = ${delId}`
  const dr = await call(codeRoute.DELETE, 'DELETE', `/api/session/${del.code}`, { cookie: H.cookie }, undefined, { code: del.code })
  const scrub = await prisma.$queryRaw<{ lineup_revision: number | null }[]>`SELECT lineup_revision FROM sessions WHERE id = ${delId}`
  check('(9e) the session DELETE scrub NULLs lineup_revision', dr.status === 200 && scrub[0]?.lineup_revision === null, [dr.status, scrub[0]])
  const E = await mkUser('Empty Host')
  const em = await promotedMoment(E)
  const emId = (await liveRow(em.code))!.id
  await addWine(em.code, { cookie: E.cookie }, 'Empty Moment Bottle')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = 5 WHERE id = ${emId}`
  await deleteAccountDurable(E.id)
  const es = await prisma.$queryRaw<{ deleted_at: Date | null; lineup_revision: number | null }[]>`SELECT deleted_at, lineup_revision FROM sessions WHERE id = ${emId}`
  check('(9f) account deletion\'s empty-moment wipe NULLs lineup_revision', !!es[0]?.deleted_at && es[0]?.lineup_revision === null, es[0])
}

// ── § 10 The promotion race ─────────────────────────────────────────────────
async function promotion() {
  section('§ 10 promotion stamps 1; an add waiting on it lands in the record, bumped')
  const g = await guestMoment()
  await addWine(g.code, { anon: g.anon }, 'Before Promotion')
  check('setup: a Redis-only moment has no stamp', !(await liveRow(g.code)) && await wrevOf(g.code) === null)
  const U = await mkUser('Promoter')
  await join(g.code, { cookie: U.cookie }, 'Promoter')
  let entered!: () => void, release!: () => void
  const inP = new Promise<void>(r => { entered = r }), relP = new Promise<void>(r => { release = r })
  mutationHooks.at = async (p, c, l) => { if (p === 'beforeCommit' && c === g.code && l === 'promote') { entered(); await relP } }
  const promoting = visit(g.code, { cookie: U.cookie })
  await inP
  const racedId = nanoid()
  const adding = postWine(g.code, { anon: g.anon }, { id: racedId, name: 'Raced Add' })
  await sleep(500)
  release()
  const [pv, ad] = await Promise.all([promoting, adding])
  noHooks()
  const row = await liveRow(g.code)
  check('(10a) the promotion committed and the raced add succeeded', pv.status === 200 && ad.status === 200 && !!row, [pv.status, ad.status, ad.json])
  check('(10b) the raced add landed in the record (record-first, after the promotion)', (await winesById(racedId))[0]?.session_id === row?.id)
  check('(10c) promotion stamped 1, the add bumped to 2, the cache stamped 2', row?.lineup_revision === 2 && await wrevOf(g.code) === '2', [row?.lineup_revision, await wrevOf(g.code)])
}

// ── § 11 The old web tab, the build id ──────────────────────────────────────
async function edges() {
  section('§ 11 the old web tab gets one 409 on a moment write; the build id')
  const ev = {} as never
  const req = (method: string, path: string, headers: Record<string, string> = {}) => new NextRequest(`${BASE}${path}`, { method, headers })
  const W = '/api/session/ABCD2345/wines'
  check('(11a) the web wire generation is 3', WEB_WIRE_GENERATION === '3', WEB_WIRE_GENERATION)
  for (const [label, headers] of [['no marker', {}], ['X-Verre-Web: 2', { 'x-verre-web': '2' }]] as const) {
    const r = await proxy(req('POST', W, headers), ev) as Response | undefined
    check(`(11b) a guest moment WRITE with ${label} → 409, no X-Vr-Auth (the tab keeps its token)`, r?.status === 409 && !r.headers.get('x-vr-auth'), r?.status)
  }
  for (const m of ['PATCH', 'DELETE', 'PUT']) {
    const r = await proxy(req(m, `${W}/abc`, {}), ev) as Response | undefined
    check(`(11b) ${m} without the marker → 409`, r?.status === 409)
  }
  check('(11c) the new web (X-Verre-Web: 3) passes', (await proxy(req('POST', W, { 'x-verre-web': WEB_WIRE_GENERATION }), ev)) === undefined)
  check('(11c) the app (X-Verre-Client) passes', (await proxy(req('POST', W, { 'x-verre-client': 'ios/9.9.9/embedded' }), ev)) === undefined)
  check('(11c) a guest READ without the marker passes', (await proxy(req('GET', W), ev)) === undefined)
  check('(11c) the removed-tab calls stay exempt', (await proxy(req('POST', '/api/session/ABCD2345/leave'), ev)) === undefined && (await proxy(req('POST', '/api/session/ABCD2345/removed-state'), ev)) === undefined)
  check('(11c) create and join are not moment paths', (await proxy(req('POST', '/api/session'), ev)) === undefined && (await proxy(req('POST', '/api/session/join'), ev)) === undefined)
  const prev = process.env.DEPLOIO_GIT_REVISION
  process.env.DEPLOIO_GIT_REVISION = 'abc123def'
  const b = await call(buildRoute.GET, 'GET', '/api/build', {})
  if (prev === undefined) delete process.env.DEPLOIO_GIT_REVISION; else process.env.DEPLOIO_GIT_REVISION = prev
  check('(11d) GET /api/build reports the commit the instance runs, never cached', b.status === 200 && b.json?.build === 'abc123def' && /no-store/.test(b.headers.get('cache-control') ?? ''), [b.status, b.json])
}

// ── § 12 The census gate ────────────────────────────────────────────────────
async function census() {
  section('§ 12 the census gate (scripts/check-wine-writes.mjs)')
  let self = '', run = '', selfOk = false, runOk = false
  try { self = execFileSync('node', ['scripts/check-wine-writes.mjs', '--self-test'], { cwd: REPO, encoding: 'utf8' }); selfOk = true } catch (e) { self = String((e as { stdout?: string }).stdout ?? e) }
  try { run = execFileSync('node', ['scripts/check-wine-writes.mjs'], { cwd: REPO, encoding: 'utf8' }); runOk = true } catch (e) { run = String((e as { stderr?: string }).stderr ?? e) }
  check('(12a) the gate\'s negative control passes (every write idiom caught, every read passed)', selfOk, self.slice(0, 400))
  check('(12b) the gate is green on the tree', runOk, run.slice(0, 600))
}

// ── § 13 The warm-up script ─────────────────────────────────────────────────
async function warmup() {
  section('§ 13 the warm-up script (scripts/warm-lineups.mts) — dry run lists, --apply reconciles, residuals only reported')
  const H = await mkUser('Host Warm')
  const s = await promotedMoment(H)
  await addWine(s.code, { cookie: H.cookie }, 'Warm Keep')
  const left = await addWine(s.code, { cookie: H.cookie }, 'Warm Leftover')
  const only = nanoid()
  await redis.set(k.wines(s.code), JSON.stringify([...(await redisWines(s.code)).filter(w => w.id !== left),
    { id: only, name: 'Warm Cache Only', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }]), { XX: true, KEEPTTL: true })
  await redis.del(`s:${s.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${s.code} AND deleted_at IS NULL`
  // A residual: stamped equal, content differs.
  const t = await promotedMoment(H)
  const tw = await addWine(t.code, { cookie: H.cookie }, 'Residual Bottle')
  await prisma.$executeRaw`UPDATE wines SET name = 'Residual Record Name' WHERE id = ${tw}`
  const u = new URL(DB)
  const run = (extra: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/warm-lineups.mts', ...extra],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, DATABASE_CONNECTION_LIMIT: '2' }, stdio: ['ignore', 'pipe', 'ignore'] })) as
    { counts: Record<string, number>; moments: Record<string, { class: string; toCopy?: { id: string }[]; toOrphan?: { id: string; name: string; ratings: number }[]; applied?: string; fields?: { id: string }[] }> }
  const dry = run([])
  const e = dry.moments[s.code]
  check('(13a) dry run: the unreconciled moment lists the bottle to copy and the one to orphan, by id and NAME', e?.class === 'unreconciled' && e.toCopy?.[0]?.id === only && e.toOrphan?.[0]?.id === left && e.toOrphan?.[0]?.name === 'Warm Leftover', e)
  check('(13a) …and changes nothing', await revisionOf(s.code) === null && (await winesById(left))[0]?.session_id !== null && (await winesById(only)).length === 0)
  check('(13b) dry run: a stamped moment whose content differs is a RESIDUAL (for a human)', dry.moments[t.code]?.class === 'residual' && dry.moments[t.code]?.fields?.[0]?.id === tw, dry.moments[t.code])
  let refused = false
  try { run(['--apply', '--expect-db', `${u.hostname}/wrong_db`]) } catch { refused = true }
  check('(13c) --apply with the wrong --expect-db refuses', refused && await revisionOf(s.code) === null)
  const ap = run(['--apply', '--expect-db', `${u.hostname}/${u.pathname.slice(1)}`])
  check('(13d) --apply reconciles: copied, orphaned, stamped 1, the cache stamped', ap.moments[s.code]?.applied === 'reconciled' && (await winesById(only))[0]?.session_id === (await liveRow(s.code))!.id && (await winesById(left))[0]?.session_id === null && await revisionOf(s.code) === 1 && await wrevOf(s.code) === '1', ap.moments[s.code])
  check('(13d) …and never touches a residual', (await redisWines(t.code)).find(w => w.id === tw)?.name === 'Residual Bottle')
  const again = run([])
  check('(13e) a second dry run finds the moment ok', !again.moments[s.code], again.moments[s.code])
}

// ── § 14 Review round 1 ─────────────────────────────────────────────────────
async function review1() {
  section('§ 14 review r1 — id squat at promotion, damaged caches, the rebuild stamp, guest photo removal, the photo burst, replayed tags, the rate fallback')
  // (a) A taster claims a guest moment's bottle id in the record first.
  const g = await guestMoment()
  const victim = await addWine(g.code, { anon: g.anon }, 'Guest Victim')
  const T = await join(g.code, {}, 'Guest Taster')
  await rate(g.code, { anon: T.anon }, victim, 5)
  const A = await mkUser('Squatter')
  await resetLimits()
  const sq = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: A.cookie }, { occurrenceId: victim, wineName: 'Squat', type: 'red', score: 1, flavors: {} })
  const P = await mkUser('Promoter R1')
  await join(g.code, { cookie: P.cookie }, 'Promoter R1')
  await visit(g.code, { cookie: P.cookie })
  const row = await liveRow(g.code)
  const rec = await recordRows(g.code)
  const reminted = rec.find(r => r.name === 'Guest Victim')
  check('(14a) setup: the squat landed (a check-in took the guest bottle\'s id)', sq.status === 201 && !!row)
  check('(14a) the guest bottle survives promotion under a FRESH id (never a silent drop)', !!reminted && reminted.id !== victim && (await redisWines(g.code)).some(w => w.id === reminted.id && w.name === 'Guest Victim'), { rec: rec.map(r => [r.id, r.name]) })
  check('(14a) …its guest rating followed it', !!reminted && !!(await redis.get(k.rating(g.code, T.id, reminted.id))) && !(await redis.get(k.rating(g.code, T.id, victim))), T.id)
  check('(14a) …and the squatter\'s check-in is untouched', (await winesById(victim))[0]?.name === 'Squat')

  // (b) A damaged cache on an unreconciled moment: duplicate id, unknown style,
  // a catalogue link that is gone, an adder id the CHECK refuses, a bad time.
  const H = await mkUser('Host R1')
  const m = await promotedMoment(H)
  await addWine(m.code, { cookie: H.cookie }, 'R1 Base')
  const d1 = nanoid(), d2 = nanoid()
  const junk = { producer: '', vintage: '', grape: '', image: '', imageUrl: '' }
  await redis.set(k.wines(m.code), JSON.stringify([...(await redisWines(m.code)),
    { ...junk, id: d1, name: 'R1 Dup', type: 'red' }, { ...junk, id: d1, name: 'R1 Dup Again', type: 'white' },
    { ...junk, id: d2, name: 'R1 Odd', type: 'bogus', productId: 'p_gone_000000000000000', vintageId: 'v_gone_000000000000000', addedByIdentityId: 'u:abc', revealedAt: 'not a time' },
    { id: 7, name: 'no string id' }]), { XX: true, KEEPTTL: true })
  await redis.del(`s:${m.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${m.code} AND deleted_at IS NULL`
  const rd = await servedNames(m.code, { cookie: H.cookie })
  const odd = await prisma.$queryRaw<{ style: string | null; product_id: string | null; added_by_identity_id: string | null; revealed_at: Date | null }[]>`SELECT style, product_id, added_by_identity_id, revealed_at FROM wines WHERE id = ${d2}`
  check('(14b) a damaged cache reconciles (200, stamped 1): the duplicate kept once, the odd bottle made writable', rd.status === 200 && await revisionOf(m.code) === 1 && rd.names.filter(n => n.startsWith('R1 Dup')).length === 1 && rd.names.includes('R1 Odd'), rd)
  check('(14b) …unknown style → none, gone link → unlinked, refused adder → none, bad time → hidden', odd[0]?.style === null && odd[0]?.product_id === null && odd[0]?.added_by_identity_id === null && odd[0]?.revealed_at === null, odd[0])

  // (c) A blob that is not an array never orphans the record's bottles.
  const n = await promotedMoment(H)
  await addWine(n.code, { cookie: H.cookie }, 'R1 Safe')
  await redis.set(k.wines(n.code), '{"not":"an array"}', { XX: true, KEEPTTL: true })
  await redis.del(`s:${n.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${n.code} AND deleted_at IS NULL`
  const nr = await servedNames(n.code, { cookie: H.cookie })
  check('(14c) an unusable cached blob: the record kept (nothing orphaned), the cache replaced from it', nr.status === 200 && nr.names.includes('R1 Safe') && (await recordRows(n.code)).length === 1, nr)

  // (d) A reconciliation that cannot complete: reads serve the cache, never 500.
  const o = await promotedMoment(H)
  await addWine(o.code, { cookie: H.cookie }, 'R1 Readable')
  await redis.set(k.wines(o.code), JSON.stringify([...(await redisWines(o.code)), { ...junk, id: nanoid(), name: 'BOOM2 cache only', type: 'red' }]), { XX: true, KEEPTTL: true })
  await redis.del(`s:${o.code}:wrev`)
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${o.code} AND deleted_at IS NULL`
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION occ_test_boom2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name LIKE 'BOOM2%' THEN RAISE EXCEPTION 'boom2'; END IF; RETURN NEW; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER occ_test_boom2 BEFORE INSERT OR UPDATE ON wines FOR EACH ROW EXECUTE FUNCTION occ_test_boom2()`)
  try {
    const od = await servedNames(o.code, { cookie: H.cookie })
    const G = await join(o.code, {}, 'Guest R1')
    const og = await servedNames(o.code, { anon: G.anon })
    check('(14d) a reconciliation that throws: reads still answer 200 from the cache (signed-in and guest)', od.status === 200 && og.status === 200 && od.names.includes('BOOM2 cache only') && og.names.includes('R1 Readable'), [od, og])
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS occ_test_boom2 ON wines`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS occ_test_boom2()`)
  }

  // (e) A rebuild that does the NULL → 1 stamp itself publishes no stamp.
  const q = await promotedMoment(H)
  await addWine(q.code, { cookie: H.cookie }, 'R1 Rebuilt')
  await redis.del([k.meta(q.code), `s:${q.code}:wrev`])
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${q.code} AND deleted_at IS NULL`
  const live = await ensureSessionLive(q.code)
  check('(14e) the rebuild reconciled (revision 1) but wrote NO stamp (it publishes before its COMMIT)', live === 'live' && await revisionOf(q.code) === 1 && await wrevOf(q.code) === null, [live, await revisionOf(q.code), await wrevOf(q.code)])
  await servedNames(q.code, { cookie: H.cookie })
  check('(14e) …the next read stamps it after its own COMMIT', await wrevOf(q.code) === '1')

  // (f) A guest moment may REMOVE a photo it carries from before the rule.
  if (imageIO) {
    const reclaims: string[] = []
    const realReclaim = imageIO.reclaim
    imageIO.reclaim = (urls) => { reclaims.push(...urls) }
    try {
      const gg = await guestMoment()
      const gw = await addWine(gg.code, { anon: gg.anon }, 'Guest Old Photo')
      await redis.set(k.wines(gg.code), JSON.stringify((await redisWines(gg.code)).map(w => w.id === gw ? { ...w, imageUrl: 'https://s3.test/verre/wines/legacy.png' } : w)), { XX: true, KEEPTTL: true })
      const rm = await delImage(gg.code, { anon: gg.anon }, gw)
      check('(14f) a guest moment removes its old photo (200), the bytes reclaimed after', rm.status === 200 && (await redisWines(gg.code)).find(w => w.id === gw)?.imageUrl === '' && reclaims.includes('https://s3.test/verre/wines/legacy.png'), [rm.status, rm.json, reclaims])
    } finally { imageIO.reclaim = realReclaim }
  }

  // (g) A parallel burst of first photos: only ONE is free.
  const U = await mkUser('Burst R1')
  await resetLimits()
  const post = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: U.cookie }, { occurrenceId: nanoid(), wineName: 'Burst', type: 'red', score: 3, flavors: {} })
  const id = String(post.json?.id)
  await Promise.all(Array.from({ length: 5 }, () => call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${id}`, { cookie: U.cookie }, { imageData: PNG }, { id })))
  check('(14g) five parallel first photos: one free, four charged (1 for the post + 4)', Number(await redis.get(`rl:checkin:${U.id}:1h`)) === 5, await redis.get(`rl:checkin:${U.id}:1h`))

  // (h) A replayed check-in never rewrites its tags.
  const X = await mkUser('Tagger R1'), Y = await mkUser('Tagged R1')
  await prisma.follow.createMany({ data: [{ followerId: X.id, followingId: Y.id }, { followerId: Y.id, followingId: X.id }] })
  const yPid = (await prisma.user.findUniqueOrThrow({ where: { id: Y.id }, select: { publicId: true } })).publicId
  const occ = nanoid()
  const b = { occurrenceId: occ, wineName: 'Tagged Bottle', type: 'red', score: 3, flavors: {}, taggedUserIds: [yPid] }
  await resetLimits()
  const first = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: X.cookie }, b)
  await prisma.feedItemTag.deleteMany({ where: { feedItemId: Number(first.json?.id) } })   // the owner removed the tag since
  await resetLimits()
  const again = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: X.cookie }, b)
  check('(14h) a late duplicate of the create answers the stored check-in and re-adds no removed tag', again.status === 200 && (await prisma.feedItemTag.count({ where: { feedItemId: Number(first.json?.id) } })) === 0, [again.status, await prisma.feedItemTag.count({ where: { feedItemId: Number(first.json?.id) } })])

  // (i) The rate's early check falls back to the record (a cache behind it).
  const r = await promotedMoment(H)
  const rw = await addWine(r.code, { cookie: H.cookie }, 'R1 Behind')
  await redis.set(k.wines(r.code), '[]', { XX: true, KEEPTTL: true })
  const rr = await rate(r.code, { cookie: H.cookie }, rw, 4)
  check('(14i) a bottle the record has and a stale cache lacks is ratable (200, not 404)', rr.status === 200, [rr.status, rr.json])

  // ── Review round 2 ──
  // (j) A replayed check-in answers numbers for its location (the Decimal trap).
  const L = await mkUser('Located R2')
  const lb = { occurrenceId: nanoid(), wineName: 'Located', type: 'red', score: 3, flavors: {}, venueName: 'Bar', lat: 47.3769, lng: 8.5417 }
  await resetLimits()
  const l1 = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: L.cookie }, lb)
  await resetLimits()
  const l2 = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: L.cookie }, lb)
  check('(14j) a replayed check-in answers lat / lng as numbers, like the first answer', l2.status === 200 && typeof l2.json?.lat === 'number' && l2.json?.lat === l1.json?.lat && typeof l2.json?.lng === 'number', [l1.json?.lat, l2.json?.lat, typeof l2.json?.lat])
  // (k) A photo for a cache-only bottle of an unreconciled moment lands.
  if (imageIO) {
    const real = imageIO.upload
    imageIO.upload = async (keyBase) => `https://s3.test/verre/${keyBase}.png`
    try {
      const cm = await promotedMoment(H)
      await addWine(cm.code, { cookie: H.cookie }, 'R2 Base')
      const co = nanoid()
      await redis.set(k.wines(cm.code), JSON.stringify([...(await redisWines(cm.code)), { ...junk, id: co, name: 'R2 Cache Only', type: 'red', addedByIdentityId: `u:${H.id}` }]), { XX: true, KEEPTTL: true })
      await redis.del(`s:${cm.code}:wrev`)
      await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${cm.code} AND deleted_at IS NULL`
      const ph = await putImage(cm.code, { cookie: H.cookie }, co, PNG)
      check('(14k) a photo for a cache-only bottle of an unreconciled moment: 200, the bottle reconciled in with its photo', ph.status === 200 && !!(await prisma.$queryRaw<{ image_url: string | null }[]>`SELECT image_url FROM wines WHERE id = ${co}`)[0]?.image_url, [ph.status, ph.json])
    } finally { imageIO.upload = real }
  }
  // (m) The operator's dry-run plan tolerates a damaged blob.
  const dm = await promotedMoment(H)
  await addWine(dm.code, { cookie: H.cookie }, 'R2 Dry')
  await redis.set(k.wines(dm.code), '{"not":"an array"}', { XX: true, KEEPTTL: true })
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE code = ${dm.code} AND deleted_at IS NULL`
  const { rehydrateSession } = await import('../../lib/sessionRehydrate.ts')
  const plan = await rehydrateSession(dm.code, { force: true, dryRun: true }).then(r => r.outcome, e => `threw: ${e}`)
  check('(14m) a forced dry-run plan over a damaged blob answers, never throws', plan === 'planned', plan)
  // (l) The verify-and-re-mint loop (recheck r2): an id that another row of the
  // record took AFTER the foreign-id check (simulated: `renames` empty while a
  // session-less row holds the id) still lands, under a fresh id, with a lease;
  // without one the copy asks for the lock (ContractNeedsLease).
  {
    const { copyCachedLineup } = await import('../../lib/occurrences.ts')
    const { makeFence, ContractNeedsLease } = await import('../../lib/sessionMutation.ts')
    const { acquireSessionLock, releaseSessionLock } = await import('../../lib/sessionLock.ts')
    const vm = await promotedMoment(H)
    const vrow = (await liveRow(vm.code))!
    const taken = nanoid()
    await prisma.$executeRaw`INSERT INTO wines (id, session_id, origin, name) VALUES (${taken}, NULL, 'standalone', 'Taken meanwhile')`
    await redis.set(k.rating(vm.code, 'a:00000000-0000-4000-8000-0000000000aa', taken), JSON.stringify({ score: 4, flavors: {}, notes: '', at: 1 }), { EX: 600 })
    // A session rating of THIS moment the record holds on the taken id (an old
    // rate POST through a skipped mirror): it must follow the bottle.
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, rated_at)
      VALUES (${taken}, ${H.id}, ${vrow.id}, 'session', 'Hana Host', 3, '{}'::jsonb, now())`
    const bottle = { id: taken, name: 'Raced Bottle', producer: '', vintage: '', grape: '', type: 'red', image: '', imageUrl: '' }
    const ctxOf = (fence: unknown) => ({ code: vm.code, row: { id: vrow.id }, fence, after: { reclaim: [] as string[], dropKeys: [] as string[] } }) as never
    let noLease: unknown = null
    await prisma.$transaction(tx => copyCachedLineup(tx, ctxOf(null), vrow.id, { clean: [bottle], renames: new Map() })).catch(e => { noLease = e })
    check('(14l) without a lease, a copy that lost the race asks for the lock (ContractNeedsLease)', noLease instanceof ContractNeedsLease, String(noLease))
    const token = (await acquireSessionLock(vm.code))!
    const ctx = ctxOf(makeFence(vm.code, token)) as { after: { dropKeys: string[] } }
    try { await prisma.$transaction(tx => copyCachedLineup(tx, ctx as never, vrow.id, { clean: [bottle], renames: new Map() })) }
    finally { await releaseSessionLock(vm.code, token) }
    const landed = (await recordRows(vm.code)).find(r => r.name === 'Raced Bottle')
    check('(14l) with the lease it lands under a fresh id, the taken row untouched', !!landed && landed.id !== taken && (await winesById(taken))[0]?.name === 'Taken meanwhile', (await recordRows(vm.code)).map(r => [r.id, r.name]))
    const moved = await prisma.$queryRaw<{ wine_id: string }[]>`SELECT wine_id FROM ratings WHERE session_id = ${vrow.id} AND user_id = ${H.id}`
    check('(14l) …this moment\'s session rating on the taken id moved with it; the taken row keeps none', !!landed && moved.length === 1 && moved[0].wine_id === landed.id && (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ratings WHERE wine_id = ${taken} AND session_id IS NOT NULL`)[0].n === 0n, moved)
    check('(14l) …its rating key copied to the new id, the old one queued for deletion after COMMIT', !!landed && !!(await redis.get(k.rating(vm.code, 'a:00000000-0000-4000-8000-0000000000aa', landed.id))) && ctx.after.dropKeys.includes(k.rating(vm.code, 'a:00000000-0000-4000-8000-0000000000aa', taken)), ctx.after.dropKeys)
  }
  // (n) The re-mint COPIES rating keys before COMMIT and deletes the old ones after.
  check('(14n) the re-minted bottle\'s old rating key is gone, its copy present (14a)', !!reminted && !(await redis.get(k.rating(g.code, T.id, victim))) && !!(await redis.get(k.rating(g.code, T.id, reminted.id))))
}

// ── § 15 Codex round 1 ──────────────────────────────────────────────────────
async function codex1() {
  section('§ 15 Codex r1 — rating keys after COMMIT, a known-stale cache never served, the incarnation, the check-in edit, the sip replay')
  const H = await mkUser('Host C1')
  // (a) A bottle DELETE rolled back after its work keeps the guests' ratings.
  const s = await promotedMoment(H)
  const w = await addWine(s.code, { cookie: H.cookie }, 'C1 Rated')
  const G = await join(s.code, {}, 'Guest C1')
  await rate(s.code, { anon: G.anon }, w, 4)
  mutationHooks.at = async (p, c, l) => { if (p === 'beforeCommit' && c === s.code && l === 'wine-delete') throw new Error('test: rollback') }
  const d = await delWine(s.code, { cookie: H.cookie }, w)
  noHooks()
  check('(15a) a DELETE rolled back after its work: the bottle stays AND the guest\'s rating key survives', d.status >= 500 && (await winesById(w)).length === 1 && !!(await redis.get(k.rating(s.code, G.id, w))), [d.status, await redis.get(k.rating(s.code, G.id, w))])
  const d2 = await delWine(s.code, { cookie: H.cookie }, w)
  check('(15a) …a committed DELETE removes the rating key after COMMIT', d2.status === 200 && !(await redis.get(k.rating(s.code, G.id, w))), d2.status)

  // (b) A KNOWN mismatch whose refresh cannot run serves the record, never the cache.
  const t = await promotedMoment(H)
  const tw = await addWine(t.code, { cookie: H.cookie }, 'C1 Revealed')
  await call(revealRoute.POST, 'POST', `/api/session/${t.code}/wines/${tw}/reveal`, { cookie: H.cookie }, {}, { code: t.code, wineId: tw })
  const trow = (await liveRow(t.code))!
  // A hide that committed and whose projection died: record hidden, revision bumped, cache still revealed.
  await prisma.$executeRaw`UPDATE wines SET revealed_at = NULL WHERE id = ${tw}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${trow.id}`
  const { acquireSessionLock, releaseSessionLock } = await import('../../lib/sessionLock.ts')
  const TG = await join(t.code, {}, 'Guest C1b')   // (a join takes the lock itself)
  const held = (await acquireSessionLock(t.code))!   // the dead writer's lease
  try {
    const sg = await state(t.code, { anon: TG.anon })
    const served = (sg.json?.wines as { id: string; revealedAt?: string | null }[] | null)?.find(x => x.id === tw)
    check('(15b) a guest read while the refresh is blocked serves the RECORD (hidden), not the cached reveal', sg.status === 200 && !!served && !served.revealedAt, [sg.status, served])
    const sh = await state(t.code, { cookie: H.cookie })
    const sh2 = (sh.json?.wines as { id: string; revealedAt?: string | null }[] | null)?.find(x => x.id === tw)
    check('(15b) …and a signed-in read', sh.status === 200 && !!sh2 && !sh2.revealedAt, [sh.status, sh2])
    check('(15b) …without projecting (the cache still holds the stale reveal: nothing written under another lease)', !!(await redisWines(t.code)).find(x => x.id === tw)?.revealedAt)
  } finally { await releaseSessionLock(t.code, held) }

  // (c) A refresh bound to another incarnation answers absent.
  const { refreshLineup } = await import('../../lib/sessionRehydrate.ts')
  check('(15c) refreshLineup with another incarnation\'s creation time → absent (never the successor\'s bottles)', await refreshLineup(t.code, 1) === 'absent')

  // (d) The check-in edit: the snapshot follows the stored style; omitted fields are not written.
  const U = await mkUser('Checkin C1')
  await resetLimits()
  const ci = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: U.cookie }, { occurrenceId: nanoid(), wineName: 'C1 Standalone', producer: 'P1', type: 'red', score: 3, flavors: {} })
  const cid = String(ci.json?.id)
  const occ = (await prisma.$queryRaw<{ wine_id: string }[]>`SELECT r.wine_id FROM feed_items fi JOIN ratings r ON r.id = fi.rating_id WHERE fi.id = ${Number(cid)}`)[0].wine_id
  await resetLimits()
  // Since step 4 the kind is the entry's: a re-link to a sparkling wine (a
  // type-only edit is ignored, identity text never becomes the snapshot).
  const fizz = await entryFor('C1 Fizz', 'spark', { producer: 'P2' })
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${cid}`, { cookie: U.cookie }, { type: 'red' }, { id: cid })
  const unchanged = (await prisma.$queryRaw<{ style: string | null }[]>`SELECT style FROM wines WHERE id = ${occ}`)[0]?.style
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${cid}`, { cookie: U.cookie }, { productId: fizz.productId, vintageId: null }, { id: cid })
  const sp = await prisma.$queryRaw<{ style: string | null; colour: string | null; sparkling: boolean; producer: string | null }[]>`SELECT style, colour, sparkling, producer FROM wines WHERE id = ${occ}`
  check('(15d) a type-only edit changes nothing; a re-link writes the new entry\'s pair (spark: sparkling, colour unknown) and producer', unchanged === 'red' && sp[0]?.style === 'spark' && sp[0]?.colour === null && sp[0]?.sparkling === true && sp[0]?.producer === 'P2', { unchanged, row: sp[0] })
  await prisma.$executeRaw`UPDATE wines SET producer = 'Changed Elsewhere' WHERE id = ${occ}`
  await resetLimits()
  await call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${cid}`, { cookie: U.cookie }, { notes: 'only a note' }, { id: cid })
  check('(15d) …a notes-only edit writes no wine field (a value changed meanwhile stays)', (await prisma.$queryRaw<{ producer: string | null }[]>`SELECT producer FROM wines WHERE id = ${occ}`)[0]?.producer === 'Changed Elsewhere')

  // (e) A "had a sip" retry whose source was deleted meanwhile still replays.
  const Au = await mkUser('Sip Author C1'), Vu = await mkUser('Sip Viewer C1')
  await prisma.follow.create({ data: { followerId: Vu.id, followingId: Au.id } })
  await resetLimits()
  const src = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: Au.cookie }, { occurrenceId: nanoid(), wineName: 'Sip Source', type: 'red', score: 4, flavors: {} })
  const sipBody = { occurrenceId: nanoid(), wineName: 'Sip Source', type: 'red', score: 2, flavors: {}, copyFromCheckinId: Number(src.json?.id) }
  await resetLimits()
  const sip1 = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: Vu.cookie }, sipBody)
  await resetLimits()
  await call((await import('../../app/api/checkins/[id]/route.ts')).DELETE, 'DELETE', `/api/checkins/${src.json?.id}`, { cookie: Au.cookie }, undefined, { id: String(src.json?.id) })
  await resetLimits()
  const sip2 = await call(checkinsRoute.POST, 'POST', '/api/checkins', { cookie: Vu.cookie }, sipBody)
  check('(15e) a "had a sip" retry after its source was deleted: the stored check-in (200), not the copy check\'s 400', sip1.status === 201 && sip2.status === 200 && sip2.json?.id === sip1.json?.id, [sip1.status, sip2.status, sip2.json])

  // (f) Codex r2: a refreshed line-up is redacted by settings read WITH it. A
  // guest's poll opens a non-blind moment whose cache is behind; before its
  // refresh takes the lock, the host turns blind tasting on and adds a bottle.
  const HB = await mkUser('Host C2', { pro: true })
  const b = await promotedMoment(HB)
  await addWine(b.code, { cookie: HB.cookie }, 'C2 Visible')
  const GB = await join(b.code, {}, 'Guest C2')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${b.code} AND deleted_at IS NULL`
  let fired = false
  mutationHooks.at = async (p, c, l) => {
    if (fired || p !== 'beforeLock' || c !== b.code || l !== 'lineup-refresh') return
    fired = true
    noHooks()
    await settings(b.code, { cookie: HB.cookie }, { blind: true, blindForEveryone: true })
    await addWine(b.code, { cookie: HB.cookie }, 'C2 Secret Label', { producer: 'C2 Secret House' })
  }
  const poll = await state(b.code, { anon: GB.anon })
  noHooks()
  const text = JSON.stringify(poll.json?.wines ?? null)
  check('(15f) the guest\'s answer never names the bottle added under blind tasting mid-request', fired && poll.status === 200 && !/C2 Secret/.test(text), { fired, status: poll.status, wines: poll.json?.wines })

  // (g) Codex r3: …also when the moment's meta is evicted before the refresh
  // (the settings then come from the record, never the request's earlier ones).
  const b2 = await promotedMoment(HB)
  await addWine(b2.code, { cookie: HB.cookie }, 'C3 Visible')
  const GB2 = await join(b2.code, {}, 'Guest C3')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${b2.code} AND deleted_at IS NULL`
  let fired2 = false
  mutationHooks.at = async (p, c, l) => {
    if (fired2 || p !== 'beforeLock' || c !== b2.code || l !== 'lineup-refresh') return
    fired2 = true
    noHooks()
    await settings(b2.code, { cookie: HB.cookie }, { blind: true, blindForEveryone: true })
    await addWine(b2.code, { cookie: HB.cookie }, 'C3 Secret Label')
    await redis.del(k.meta(b2.code))
  }
  const poll2 = await state(b2.code, { anon: GB2.anon })
  noHooks()
  check('(15g) meta evicted before the refresh: the answer still never names the bottle (settings from the record)', fired2 && !/C3 Secret/.test(JSON.stringify(poll2.json ?? null)), { fired2, status: poll2.status, wines: poll2.json?.wines })

  // (h) Codex r3: the ban preview re-checks the power with the refreshed context.
  const previewRoute = await import('../../app/api/session/[code]/bans/preview/[identityId]/route.ts')
  const HC = await mkUser('Host C3'), CH = await mkUser('Cohost C3'), TT = await mkUser('Target C3')
  const pm = await promotedMoment(HC)
  await enter(pm.code, { cookie: CH.cookie }, 'Cohost C3')
  await enter(pm.code, { cookie: TT.cookie }, 'Target C3')
  await setRole(pm.code, { cookie: HC.cookie }, `u:${CH.id}`, 'co_host')
  await addWine(pm.code, { cookie: HC.cookie }, 'C3 Preview Base')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${pm.code} AND deleted_at IS NULL`
  let fired3 = false
  mutationHooks.at = async (p, c, l) => {
    if (fired3 || p !== 'beforeLock' || c !== pm.code || l !== 'lineup-refresh') return
    fired3 = true
    noHooks()
    await setRole(pm.code, { cookie: HC.cookie }, `u:${CH.id}`, 'taster')
  }
  const pv = await call(previewRoute.GET, 'GET', `/api/session/${pm.code}/bans/preview/u:${TT.id}`, { cookie: CH.cookie }, undefined, { code: pm.code, identityId: `u:${TT.id}` })
  noHooks()
  check('(15h) a cohost demoted while its preview waited for the refresh: 403, no moderation payload', fired3 && pv.status === 403, { fired3, status: pv.status })

  // (i) Codex r4: a caller banned while its poll waited for the refresh gets the
  // removed answer, never the newer bottles.
  const bi = await promotedMoment(HC)
  await addWine(bi.code, { cookie: HC.cookie }, 'C4 Visible')
  const GI = await join(bi.code, {}, 'Guest C4')
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${bi.code} AND deleted_at IS NULL`
  let fired4 = false
  mutationHooks.at = async (p, c, l) => {
    if (fired4 || p !== 'beforeLock' || c !== bi.code || l !== 'lineup-refresh') return
    fired4 = true
    noHooks()
    await call(bansRoute.POST, 'POST', `/api/session/${bi.code}/bans`, { cookie: HC.cookie }, { identityId: GI.id, mode: 'ban' }, { code: bi.code })
    await addWine(bi.code, { cookie: HC.cookie }, 'C4 After The Ban')
  }
  const pi = await state(bi.code, { anon: GI.anon })
  noHooks()
  check('(15i) banned while its poll waited for the refresh: the removed answer, no newer bottle', fired4 && pi.status === 401 && pi.headers.get('x-vr-auth') === 'removed' && !/C4 After/.test(JSON.stringify(pi.json ?? null)), { fired4, status: pi.status, auth: pi.headers.get('x-vr-auth') })
}

const SECTIONS: Record<string, () => Promise<unknown>> = { ids, ack, revision, failures, reconcile, images, oldMirror, checkins, writers, promotion, edges, census, warmup, review1, codex1 }
try {
  noHooks()
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (ONLY && ONLY !== name) continue
    try { await fn() }
    catch (err) { failed++; console.error(`\n💥 section ${name} aborted:`, err) }
    noHooks()
  }
} finally {
  for (const code of created) await wipeCache(code)
  await resetLimits()
}
console.log(`\n${pass} passed, ${failed} failed`)
void [metaOf, settingsRoute]
await redis.quit().catch(() => {})
await prisma.$disconnect()
process.exit(failed === 0 ? 0 : 1)
