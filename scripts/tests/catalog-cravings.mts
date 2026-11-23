// Catalogue model change, build step 5: reads and cravings
// (docs/dev/proposals/wine-catalog-model-change.md § 5, § 5a, § 8b, § 9;
// build plan step 5 and its rulings R1-R3 of 2026-11-20). One craving per
// (user, wine, vintage) that remembers where it was first craved; hidden while
// that place is hidden for its owner; a save of a bottle hidden for you is a
// save of THAT bottle (R2); a deleted bottle's craving keeps its moment (R1);
// a re-link carries the cravings with the bottle (R3); the per-viewer `saved`
// flag on the line-up and the feed; Cravings keyed on the bookmark id; Saved
// as one wine with its vintages; merges followed on every match; D8 in one
// helper; the purge's reference clearing.
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only (refuses the dev db `verre`).
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/catalog-cravings.mts [--only <section>]
import { toWire, fromWire, wireParams } from './lib/wireIds.mts'
import { fixtureUsername } from './lib/fixtureUsername.mjs'
import { mintEntry, pick, type Entry } from './lib/catalogFixture.mts'
import { registerHooks } from 'node:module'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { prisma } from '../../lib/prisma.ts'
import { redis, scanKeys } from '../../lib/redis.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
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
type Res = { status: number; json: Record<string, unknown>; text: string }
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}): Promise<Res> {
  if (typeof handler !== 'function') return { status: -1, json: { error: 'no such handler (not built yet)' }, text: '' }
  const res = await (handler as Handler)(request(method, path, actor, await toWire(body)), { params: Promise.resolve(await wireParams(params)) })
  const text = await res.text()
  let json: unknown = null
  try { json = await fromWire(JSON.parse(text)) } catch {}
  return { status: res.status, json: json as Record<string, unknown>, text }
}
async function optional(path: string): Promise<Record<string, unknown>> {
  try { return await import(path) } catch { return {} }
}

// ── Guards ──────────────────────────────────────────────────────────────────
const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required (Better Auth)')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
delete process.env.CATALOG_PUBLIC_ENABLED

const { betterAuthServer } = await import('../../lib/betterAuth.ts')
const sessionRoute = await import('../../app/api/session/route.ts')
const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
const joinRoute = await import('../../app/api/session/join/route.ts')
const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
const codeRoute = await import('../../app/api/session/[code]/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
const bookmarkRoute = await import('../../app/api/session/[code]/wines/[wineId]/bookmark/route.ts')
const bookmarksRoute = await import('../../app/api/me/bookmarks/route.ts')
const bookmarkById = await optional('../../app/api/me/bookmarks/[id]/route.ts')
const bookmarkByWine = await optional('../../app/api/me/bookmarks/[wineId]/route.ts')
const postCrave = await optional('../../app/api/feed-items/[id]/crave/route.ts')
const cravingsRoute = await import('../../app/api/users/[id]/cravings/route.ts')
const feedRoute = await import('../../app/api/feed/route.ts')
const followRoute = await import('../../app/api/users/[id]/follow/route.ts')
const checkinsRoute = await import('../../app/api/checkins/route.ts')
const blocksRoute = await import('../../app/api/me/blocks/[id]/route.ts')
const { cravingsCount } = await import('../../lib/profileLists.ts')
const { getUserStats } = await import('../../lib/badgeService.ts')
const catalogWrite = await import('../../lib/catalogWrite.ts') as Record<string, unknown>
const occurrences = await import('../../lib/occurrences.ts') as Record<string, unknown>

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const TAG = `ccr-${Date.now()}`
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }
type User = { id: number; cookie: string; pid: string }
let userSeq = 0
async function mkUser(name: string, opts: { pro?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const { headers } = await betterAuthServer.api.signUpEmail({ body: { name, email, password: `pw-${TAG}-${userSeq}`, username: fixtureUsername() } as never, returnHeaders: true })
  const cookie = (headers.get('set-cookie') ?? '').split(';')[0]
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, publicId: true } })
  if (opts.pro) await prisma.user.update({ where: { id: row.id }, data: { pro: true } })
  return { id: row.id, cookie, pid: row.publicId }
}
const as = (u: User): Actor => ({ cookie: u.cookie })
const dateFrom = new Date(Date.now() + 3600_000).toISOString()
async function createSession(actor: Actor) {
  await resetLimits()
  const r = await call(sessionRoute.POST, 'POST', '/api/session', actor, { hostDisplayName: 'Hana Host', sessionName: `${TAG} moment`, dateFrom })
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.code as string
}
const join = async (code: string, actor: Actor, displayName: string) => { await resetLimits(); return call(joinRoute.POST, 'POST', '/api/session/join', actor, { code, displayName }) }
const visit = (code: string, actor: Actor) => call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, actor, {}, { code })
const enter = async (code: string, u: User, name: string) => { await join(code, as(u), name); await visit(code, as(u)) }
const postWine = (code: string, actor: Actor, body: Record<string, unknown>) => call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, body, { code })
const editWine = (code: string, actor: Actor, wineId: string, body: Record<string, unknown>) =>
  call(wineRoute.PATCH, 'PATCH', `/api/session/${code}/wines/${wineId}`, actor, body, { code, wineId })
const deleteWine = (code: string, actor: Actor, wineId: string) => call(wineRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wineId}`, actor, undefined, { code, wineId })
const settings = (code: string, actor: Actor, body: Record<string, unknown>) => call(settingsRoute.PATCH, 'PATCH', `/api/session/${code}/settings`, actor, body, { code })
const state = (code: string, actor: Actor) => call(stateRoute.GET, 'GET', `/api/session/${code}/state`, actor, undefined, { code })
const rate = (code: string, actor: Actor, wineId: string, extra: Record<string, unknown> = {}) =>
  call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, { wineId, score: 4, flavors: {}, notes: 'nice', ...extra }, { code })
const reveal = (code: string, actor: Actor, wineId: string) => call(revealRoute.POST, 'POST', `/api/session/${code}/wines/${wineId}/reveal`, actor, {}, { code, wineId })
const setRole = (code: string, actor: Actor, target: User, role: string) =>
  call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, actor, { action: 'set-role', targetId: `u:${target.id}`, role }, { code })
const ban = (code: string, actor: Actor, target: User, deleteAddedWines = false) =>
  call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, actor, { identityId: `u:${target.id}`, mode: 'ban', deleteAddedWines }, { code })
const crave = (code: string, u: User, wineId: string) => call(bookmarkRoute.POST, 'POST', `/api/session/${code}/wines/${wineId}/bookmark`, as(u), undefined, { code, wineId })
const uncrave = (code: string, u: User, wineId: string) => call(bookmarkRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wineId}/bookmark`, as(u), undefined, { code, wineId })
// The post's save names a moment post's row by its key (the author's rating,
// ADR-0009); a check-in's bottle is the post's own (no body). This helper
// finds the key the client would read off the row for a bottle of the post.
const cravePostBody = (u: User, itemId: number, body: Record<string, unknown>, method: 'POST' | 'DELETE' = 'POST') =>
  call(postCrave[method], method, `/api/feed-items/${itemId}/crave`, as(u), body, { id: String(itemId) })
const cravePost = async (u: User, itemId: number, wineId: string, method: 'POST' | 'DELETE' = 'POST') => {
  const it = (await prisma.$queryRaw<{ kind: string; user_id: number; session_id: number | null }[]>`SELECT kind, user_id, session_id FROM feed_items WHERE id = ${itemId}`)[0]
  const rid = it?.kind === 'session'
    ? (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${wineId} AND user_id = ${it.user_id} AND session_id = ${it.session_id}`)[0]?.id
    : undefined
  return cravePostBody(u, itemId, rid === undefined ? {} : { ratingId: rid }, method)
}
const removeById = (u: User, id: number | string) => call(bookmarkById.DELETE, 'DELETE', `/api/me/bookmarks/${id}`, as(u), undefined, { id: String(id) })
const saved = (u: User) => call(bookmarksRoute.GET, 'GET', '/api/me/bookmarks', as(u))
const feed = (u: User) => call(feedRoute.GET, 'GET', '/api/feed', as(u))
const follow = (u: User, target: User) => call(followRoute.POST, 'POST', `/api/users/${target.pid}/follow`, as(u), {}, { id: target.pid })
type CravingRow = Record<string, unknown> & { id?: number; key?: string; wineId?: string; name: string }
async function cravingsOf(owner: User, viewer: User | null, qs = ''): Promise<CravingRow[]> {
  const r = await call(cravingsRoute.GET, 'GET', `/api/users/${owner.pid}/cravings${qs}`, viewer ? as(viewer) : {}, undefined, { id: owner.pid })
  return (r.json?.items as CravingRow[] | undefined) ?? []
}
const countFor = (owner: User, viewer: User | null) => cravingsCount(owner.id, viewer ? viewer.id : null)
const badges = async (u: User) => (await getUserStats(u.id)).bookmarkCount
type BRow = { id: number; product_id: string | null; vintage_id: string | null; wine_id: string | null; source_session_id: number | null; saved_at: Date; name: string | null }
const rowsOf = (u: User) => prisma.$queryRaw<BRow[]>`
  SELECT id, product_id, vintage_id, wine_id, source_session_id, saved_at, name FROM bookmarks WHERE user_id = ${u.id} ORDER BY id`
const markersOf = async (u: User): Promise<{ id: number; wine_id: string; session_id: number | null; item_id: number | null }[] | null> => {
  try { return await prisma.$queryRaw`SELECT id, wine_id, session_id, item_id FROM blind_saves WHERE user_id = ${u.id} ORDER BY saved_at` } catch { return null }
}
type Wire = Record<string, unknown> & { id: string; ratingId?: number; _blind?: boolean; saved?: boolean }
async function lineup(code: string, u: User): Promise<Wire[]> {
  const r = await state(code, as(u))
  return ((r.json?.wines as Wire[] | undefined) ?? [])
}
const rowIn = async (code: string, u: User, wineId: string) => (await lineup(code, u)).find(w => w.id === wineId)
const sessionIdOf = async (code: string) => (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0].id
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
let seq = 0
const entry = (label: string, extra: Partial<Parameters<typeof mintEntry>[0]> = {}) =>
  mintEntry({ producer: `${TAG} Producer ${label} ${++seq}`, name: `${TAG} Wine ${label} ${seq}`, colour: 'red', year: 2019, ...extra })
async function addBottle(code: string, actor: Actor, e: Entry): Promise<string> {
  const id = nanoid()
  const r = await postWine(code, actor, { id, ...pick(e) })
  if (r.status !== 200) throw new Error(`add failed ${r.status} ${JSON.stringify(r.json)}`)
  return id
}
// A plain moment: host H (pro, so it can be made blind), taster T.
async function moment(opts: { blind?: boolean; forEveryone?: boolean } = {}) {
  const H = await mkUser('Hana Host', { pro: true })
  const code = await createSession(as(H))
  await visit(code, as(H))
  const T = await mkUser('Tess Taster')
  await enter(code, T, 'Tess')
  if (opts.blind) {
    const r = await settings(code, as(H), { blind: true, ...(opts.forEveryone ? { blindForEveryone: true } : {}) })
    if (r.status !== 200) throw new Error(`blind failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  return { H, T, code }
}
const SAVED = JSON.stringify({ ok: true, saved: true })
const UNSAVED = JSON.stringify({ ok: true, saved: false })

// ── § 1 One craving per wine, at vintage depth, remembering where ──────────
async function basics() {
  section('§ 1 a crave: one row per (user, wine, vintage), its source and moment; again or elsewhere changes nothing')
  const { H, T, code } = await moment()
  const e = await entry('Basic')
  const b1 = await addBottle(code, as(H), e)
  const xpBefore = (await prisma.user.findUniqueOrThrow({ where: { id: T.id }, select: { xp: true } })).xp
  const badgesBefore = await prisma.userBadge.count({ where: { userId: T.id } })
  const r = await crave(code, T, b1)
  check('(1a) crave a visible bottle → 200 { ok, saved: true }', r.status === 200 && JSON.stringify(r.json) === SAVED, [r.status, r.json])
  const rows = await rowsOf(T)
  const sid = await sessionIdOf(code)
  check('(1a) one row: the wine and its vintage, the bottle as its source, the moment, the entry\'s name as its snapshot',
    rows.length === 1 && rows[0].product_id === e.productId && rows[0].vintage_id === e.vintageId && rows[0].wine_id === b1
      && rows[0].source_session_id === sid && rows[0].name === e.name, rows)
  check('(1a) …no XP and no badge in the answer path',
    (await prisma.user.findUniqueOrThrow({ where: { id: T.id }, select: { xp: true } })).xp === xpBefore && (await prisma.userBadge.count({ where: { userId: T.id } })) === badgesBefore)
  check('(1b) the line-up says saved for T, not for H', (await rowIn(code, T, b1))?.saved === true && (await rowIn(code, H, b1))?.saved === false,
    [(await rowIn(code, T, b1))?.saved, (await rowIn(code, H, b1))?.saved])
  const again = await crave(code, T, b1)
  check('(1c) crave again → saved, still one row', JSON.stringify(again.json) === SAVED && (await rowsOf(T)).length === 1)
  const code2 = await createSession(as(H))
  await visit(code2, as(H))
  await enter(code2, T, 'Tess')
  const b2 = await addBottle(code2, as(H), e)
  check('(1d) another moment\'s bottle of the same wine shows saved (wine-level)', (await rowIn(code2, T, b2))?.saved === true, await rowIn(code2, T, b2))
  const r2 = await crave(code2, T, b2)
  const after = await rowsOf(T)
  check('(1d) craving it there changes nothing (one craving per wine; the first place kept)',
    JSON.stringify(r2.json) === SAVED && after.length === 1 && after[0].wine_id === b1 && after[0].id === rows[0].id, after)
  // Another vintage of the same product: its own row.
  const v2020 = await prisma.$transaction(tx => (catalogWrite.createVintage as (p: string, y: number | null, u: null, a: null, tx: unknown) => Promise<{ id: string }>)(e.productId, 2020, null, null, tx))
  const b4 = await addBottle(code2, as(H), { ...e, vintageId: v2020.id })
  check('(1e) the 2020 of the same wine is not saved by the 2019\'s craving', (await rowIn(code2, T, b4))?.saved === false)
  await crave(code2, T, b4)
  const b5 = await addBottle(code2, as(H), { ...e, vintageId: null })
  check('(1e) …nor is "this wine, any year"', (await rowIn(code2, T, b5))?.saved === false)
  await crave(code2, T, b5)
  const all = await rowsOf(T)
  check('(1e) three rows: 2019, 2020, any year', all.length === 3 && new Set(all.map(x => x.vintage_id ?? 'any')).size === 3, all)
  const list = await cravingsOf(T, T)
  check('(1f) own Cravings: three rows keyed on the craving id (key), no blind field',
    list.length === 3 && list.every(x => typeof x.key === 'string' && all.some(b => String(b.id) === x.key) && !('blind' in x) && !('_blind' in x)), list)
  check('(1f) …the count and the badges agree', (await countFor(T, T)) === 3 && (await badges(T)) === 3, [await countFor(T, T), await badges(T)])
}

// ── § 2 An unlinked bottle ──────────────────────────────────────────────────
async function unlinked() {
  section('§ 2 a visible unlinked (legacy) bottle → 409; a hidden one is still a save of that bottle')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Unlinked')
  const b = await addBottle(code, as(H), e)
  const v = await addBottle(code, as(H), await entry('Unlinked visible'))
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id IN (${b}, ${v})`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${code}`
  await reveal(code, as(H), v)
  const r = await crave(code, T, v)
  check('(2a) visible + unlinked → 409 "This bottle isn\'t in the catalogue yet", nothing stored',
    r.status === 409 && r.json?.error === "This bottle isn't in the catalogue yet" && (await rowsOf(T)).length === 0, [r.status, r.json])
  const h = await crave(code, T, b)
  check('(2b) hidden + unlinked → the same { ok, saved: true } as any blind save (decided before the link)', h.status === 200 && JSON.stringify(h.json) === SAVED, [h.status, h.json])
  check('(2b) …no craving (nothing to crave), and the bottle reads saved after a reload',
    (await rowsOf(T)).length === 0 && (await rowIn(code, T, b))?.saved === true, await rowIn(code, T, b))
}

// ── § 3 A blind save (R2) ───────────────────────────────────────────────────
async function blindSave() {
  section('§ 3 on "Wine N" a save is a save of THAT bottle: hidden from Cravings until the reveal, saved after a reload, unsave allowed')
  const { H, T, code } = await moment({ blind: true })
  const V = await mkUser('Vera Viewer')
  const eN = await entry('Blind new')
  const a = await addBottle(code, as(H), eN)
  check('(3a) T sees Wine N redacted, not saved', (await rowIn(code, T, a))?._blind === true && (await rowIn(code, T, a))?.saved === false, await rowIn(code, T, a))
  const fresh = await crave(code, T, a)
  check('(3a) save → { ok, saved: true }', fresh.status === 200 && JSON.stringify(fresh.json) === SAVED, [fresh.status, fresh.json])
  check('(3a) …absent from T\'s Cravings, the count, Saved and the badges', (await cravingsOf(T, T)).length === 0 && (await countFor(T, T)) === 0
    && ((await saved(T)).json as unknown as unknown[]).length === 0 && (await badges(T)) === 0)
  check('(3a) …and from V\'s view of T\'s list', (await cravingsOf(T, V)).length === 0 && (await countFor(T, V)) === 0)
  check('(3a) the bottle reads saved after a reload (its own save)', (await rowIn(code, T, a))?.saved === true)
  const m = await markersOf(T)
  check('(3a) 🔒 the bottle\'s save is ALL that is stored (a blind_saves row with its moment; no craving, no bookmarks id)', !!m && m.length === 1 && m[0].wine_id === a && m[0].session_id === (await sessionIdOf(code)) && (await rowsOf(T)).length === 0, [m, await rowsOf(T)])
  await reveal(code, as(H), a)
  const list = await cravingsOf(T, T)
  check('(3b) after the reveal: present once (Cravings, count, badges, Saved)', list.length === 1 && list[0].name === eN.name
    && (await countFor(T, T)) === 1 && (await badges(T)) === 1 && ((await saved(T)).json as unknown as unknown[]).length === 1, list)
  check('(3b) …and on V\'s view', (await cravingsOf(T, V)).length === 1)
  check('(3b) …the revealed bottle reads saved (now the wine\'s state)', (await rowIn(code, T, a))?.saved === true)

  section('§ 3c with the wine ALREADY craved elsewhere: the same answer, the counts unchanged, unsave touches only this bottle')
  const W = await mkUser('Will Taster')
  await enter(code, W, 'Will')
  const eK = await entry('Blind known')
  const plain = await createSession(as(H))
  await visit(plain, as(H))
  await enter(plain, W, 'Will')
  const known = await addBottle(plain, as(H), eK)
  await crave(plain, W, known)
  const before = { list: (await cravingsOf(W, W)).length, count: await countFor(W, W), badges: await badges(W), rows: await rowsOf(W) }
  const k = await addBottle(code, as(H), eK)
  const eFresh = await entry('Blind other')
  const f = await addBottle(code, as(H), eFresh)
  check('(3c) Wine N of a wine W already craves opens NOT saved (no hint)', (await rowIn(code, W, k))?.saved === false, await rowIn(code, W, k))
  const rk = await crave(code, W, k)
  const rf = await crave(code, W, f)
  check('(3c) save on it → the same answer as on an uncraved wine', JSON.stringify(rk.json) === JSON.stringify(rf.json) && JSON.stringify(rk.json) === SAVED, [rk.json, rf.json])
  check('(3c) …Cravings, count and badges exactly as before (both hidden)', (await cravingsOf(W, W)).length === before.list && (await countFor(W, W)) === before.count && (await badges(W)) === before.badges)
  check('(3c) …both bottles read saved after a reload', (await rowIn(code, W, k))?.saved === true && (await rowIn(code, W, f))?.saved === true)
  const uk = await uncrave(code, W, k)
  const uf = await uncrave(code, W, f)
  check('(3d) unsave on both → the same { ok, saved: false }', JSON.stringify(uk.json) === UNSAVED && JSON.stringify(uf.json) === UNSAVED, [uk.json, uf.json])
  const rowsAfter = await rowsOf(W)
  check('(3d) …the earlier craving of that wine is untouched; the one the save made is gone',
    rowsAfter.length === before.rows.length && rowsAfter[0]?.id === before.rows[0]?.id && !rowsAfter.some(x => x.product_id === eFresh.productId), rowsAfter)
  check('(3d) …both bottles read unsaved', (await rowIn(code, W, k))?.saved === false && (await rowIn(code, W, f))?.saved === false)
  await reveal(code, as(H), f)
  check('(3d) …and the unsaved one does not appear at its reveal', !(await cravingsOf(W, W)).some(x => x.name === eFresh.name))

  section('§ 3e two hidden bottles of one wine: unsaving one keeps the other\'s save')
  const X = await mkUser('Xan Taster')
  await enter(code, X, 'Xan')
  const eTwin = await entry('Twin')
  const t1 = await addBottle(code, as(H), eTwin)
  const t2 = await addBottle(code, as(H), eTwin)
  await crave(code, X, t1)
  await crave(code, X, t2)
  await uncrave(code, X, t1)
  const xm = await markersOf(X)
  check('(3e) the other bottle\'s save stays (each bottle has its own)', !!xm && xm.length === 1 && xm[0].wine_id === t2 && (await rowsOf(X)).length === 0, xm)
  await reveal(code, as(H), t2)
  check('(3e) …and shows at that bottle\'s reveal', (await cravingsOf(X, X)).length === 1)
}

// ── § 4 A second bottle of the same wine, revealed ──────────────────────────
async function secondBottle() {
  section('§ 4 a revealed bottle of a wine saved only on "Wine N" reads unsaved; craving it re-points (§ 5)')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Second')
  const a = await addBottle(code, as(H), e)
  const b = await addBottle(code, as(H), e)
  await reveal(code, as(H), b)
  await crave(code, T, a)
  check('(4a) the revealed bottle reads unsaved (the only craving is hidden)', (await rowIn(code, T, b))?.saved === false, await rowIn(code, T, b))
  await crave(code, T, b)
  check('(4b) after craving it: saved, and on the list', (await rowIn(code, T, b))?.saved === true && (await cravingsOf(T, T)).length === 1)
}

// ── § 5 Re-point = a fresh craving ──────────────────────────────────────────
async function repoint() {
  section('§ 5 a crave from a visible place re-points a hidden craving as DELETE + INSERT: it answers, sorts and dates like a fresh one')
  // A HIDDEN real craving: made while its bottle showed, then the moment went
  // blind (residual 3; a blind save never makes one).
  const { H, T, code } = await moment()
  const e = await entry('Repoint')
  const a = await addBottle(code, as(H), e)
  await crave(code, T, a)
  await settings(code, as(H), { blind: true })
  const hidden = (await rowsOf(T))[0]
  check('(5) setup: the craving is now hidden for T', !!hidden && (await cravingsOf(T, T)).length === 0)
  const plain = await createSession(as(H))
  await visit(plain, as(H))
  await enter(plain, T, 'Tess')
  const eOther = await entry('Repoint other')
  await pause(20)
  const o = await addBottle(plain, as(H), eOther)
  await crave(plain, T, o)
  await pause(20)
  const b = await addBottle(plain, as(H), e)
  const r = await crave(plain, T, b)
  const rows = await rowsOf(T)
  const moved = rows.find(x => x.product_id === e.productId)!
  check('(5a) the answer is a fresh craving\'s', JSON.stringify(r.json) === SAVED, r.json)
  check('(5a) a NEW row: new id, saved_at now, the visible bottle and its moment as source',
    !!moved && moved.id > hidden.id && moved.saved_at > hidden.saved_at && moved.wine_id === b && moved.source_session_id === (await sessionIdOf(plain)) && !rows.some(x => x.id === hidden.id), [hidden, rows])
  const list = await cravingsOf(T, T)
  check('(5b) it sorts first (newest), with the key and the shape of a fresh craving', list[0]?.key === String(moved.id) && Object.keys(list[0]).sort().join() === Object.keys(list[1] ?? {}).sort().join(), list)
}

// ── § 6 Deleting a bottle (R1) ──────────────────────────────────────────────
async function deletes() {
  section('§ 6 deleting a bottle: a still-hidden craving goes with it; a visible one stays with its moment (R1), for everyone')
  const { H, T, code } = await moment({ blind: true })
  const V = await mkUser('Vic Viewer')
  const eA = await entry('Delete hidden')
  const eC = await entry('Delete revealed')
  const a = await addBottle(code, as(H), eA)
  const c = await addBottle(code, as(H), eC)
  await reveal(code, as(H), c)
  await crave(code, T, a)
  await crave(code, T, c)
  const del = await deleteWine(code, as(H), a)
  check('(6a) deleting Wine N → its still-hidden craving and its save are gone', del.status === 200 && !(await rowsOf(T)).some(x => x.product_id === eA.productId)
    && !((await markersOf(T)) ?? [{ wine_id: a }]).some(x => x.wine_id === a), [del.status, await rowsOf(T)])
  const sid = await sessionIdOf(code)
  await deleteWine(code, as(H), c)
  const kept = (await rowsOf(T)).find(x => x.product_id === eC.productId)
  check('(6b) deleting a REVEALED bottle of a still-blind moment keeps its craving: bottle cleared, moment kept (R1)',
    !!kept && kept.wine_id === null && kept.source_session_id === sid, kept)
  check('(6b) …visible to the owner and to others (R1: everyone)', (await cravingsOf(T, T)).some(x => x.name === eC.name) && (await cravingsOf(T, V)).some(x => x.name === eC.name)
    && (await countFor(T, V)) === 1, [await cravingsOf(T, V)])
  check('(6b) …a source-less row carries no wineId', (await cravingsOf(T, T)).every(x => !('wineId' in x) || typeof x.wineId === 'string'))
  // An old instance's save (no stored moment) on a revealed bottle: the detach
  // takes the bottle's moment (review r1).
  const eD = await entry('Delete old-instance')
  const d = await addBottle(code, as(H), eD)
  await reveal(code, as(H), d)
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, product_id, vintage_id) VALUES (${T.id}, ${d}, ${eD.productId}, ${eD.vintageId})`
  await deleteWine(code, as(H), d)
  const od = (await rowsOf(T)).find(x => x.product_id === eD.productId)
  check('(6c) a craving that stored no moment takes its bottle\'s at the detach', !!od && od.wine_id === null && od.source_session_id === sid, od)
}

// ── § 7 Orphaned and unrated sources keep their moment ──────────────────────
async function orphaned() {
  section('§ 7 a ban-with-delete of a blind bottle, then its last rating going, leave a hidden craving hidden (its stored moment)')
  for (const rated of [false, true]) {
    const { H, T, code } = await moment({ blind: true })
    const Pv = await mkUser('Paul Provider')
    await enter(code, Pv, 'Paul')
    await setRole(code, as(H), Pv, 'provider')
    const R = await mkUser('Rita Rater')
    await enter(code, R, 'Rita')
    const e = await entry(`Orphan ${rated}`)
    const d = await addBottle(code, as(Pv), e)
    if (rated) await rate(code, as(R), d)
    await crave(code, T, d)
    const b = await ban(code, as(H), Pv, true)
    if (rated) await ban(code, as(H), R)
    const w = (await prisma.$queryRaw<{ session_id: number | null; n: bigint }[]>`
      SELECT w.session_id, (SELECT count(*) FROM ratings r WHERE r.wine_id = w.id) AS n FROM wines w WHERE w.id = ${d}`)[0]
    check(`(7${rated ? 'b' : 'a'}) ${rated ? 'rated' : 'unrated'}: the bottle is orphaned${rated ? ' and has no rating left' : ''}`, b.status === 200 && w?.session_id === null && Number(w?.n) === 0, [b.status, w])
    check(`(7${rated ? 'b' : 'a'}) …T's save stays hidden by its stored moment (list, count, badges)`, ((await markersOf(T)) ?? []).length === 1 && (await cravingsOf(T, T)).length === 0 && (await countFor(T, T)) === 0 && (await badges(T)) === 0)
    await prisma.$executeRaw`UPDATE sessions SET date_from = now() - interval '3 days', date_to = now() - interval '2 days' WHERE code = ${code}`
    check(`(7${rated ? 'b' : 'a'}) …and shows once the moment is over by its dates`, (await cravingsOf(T, T)).length === 1)
  }
}

// ── § 8 Source-less cravings ────────────────────────────────────────────────
async function sourceless() {
  section('§ 8 a craving with no source bottle (no moment either) shows, owner and others')
  const T = await mkUser('Solo Owner')
  const V = await mkUser('Solo Viewer')
  const e = await entry('Sourceless')
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, product_id, vintage_id, name, producer, vintage) VALUES (${T.id}, ${e.productId}, ${e.vintageId}, ${e.name}, ${e.producer}, '2019')`
  const own = await cravingsOf(T, T)
  check('(8a) on the owner\'s list, from the entry', own.length === 1 && own[0].name === e.name && !('wineId' in own[0]), own)
  check('(8a) …and on someone else\'s view', (await cravingsOf(T, V)).length === 1 && (await countFor(T, V)) === 1)
  const s = (await saved(T)).json as unknown as Record<string, unknown>[]
  check('(8b) Saved lists it', Array.isArray(s) && s.length === 1, s)
}

// ── § 9 An old instance's wine DELETE ───────────────────────────────────────
async function oldDelete() {
  section('§ 9 an old-code wine DELETE (a raw row delete) still cascades its cravings and saves (the FK is unchanged)')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Old delete')
  const a = await addBottle(code, as(H), e)
  const c = await addBottle(code, as(H), await entry('Old delete visible'))
  await reveal(code, as(H), c)
  await crave(code, T, a)
  await crave(code, T, c)
  await prisma.$executeRaw`DELETE FROM wines WHERE id IN (${a}, ${c})`
  check('(9a) both cravings and the save went with the rows', (await rowsOf(T)).length === 0 && ((await markersOf(T)) ?? []).length === 0, await rowsOf(T))
}

// ── § 10 The feed and crave-from-post ───────────────────────────────────────
type FeedItem = { type: string; session?: { id: number; wines: Wire[] }; checkin?: Record<string, unknown> & { id: number; saved?: boolean } }
async function feedSection() {
  section('§ 10 the feed: a "Wine N" row never shows the wine\'s saved state; crave from a post goes through the post gate')
  const { H, T, code } = await moment({ blind: true })
  await follow(T, H)
  const eN = await entry('Feed blind')
  const a = await addBottle(code, as(H), eN)
  const plain = await createSession(as(H))
  await visit(plain, as(H))
  await enter(plain, T, 'Tess')
  const pb = await addBottle(plain, as(H), eN)
  await crave(plain, T, pb)
  await rate(code, as(H), a)
  // A blind row of someone else's post carries no wine id (Moment Visibility
  // 1a): it is found by its key, the author's rating.
  const rid = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${a} AND session_id IS NOT NULL`)[0]?.id
  const items = ((await feed(T)).json?.items as FeedItem[] | undefined) ?? []
  const post = items.find(i => i.type === 'session' && i.session?.wines.some(w => w.ratingId === rid))
  const row = post?.session?.wines.find(w => w.ratingId === rid)
  check('(10a) T sees H\'s post with Wine N redacted, and NOT saved although T craves that wine', !!row && row._blind === true && row.saved !== true, row)
  check('(10a) …the feed rows carry the kind, not the legacy `type` (step 7: no reader left)', !!row && !('type' in row) && 'colour' in row && 'sparkling' in row, row)
  const cp = await cravePost(T, post!.session!.id, a)
  check('(10b) crave from the redacted post → the blind save\'s answer', cp.status === 200 && JSON.stringify(cp.json) === SAVED, [cp.status, cp.json])
  check('(10b) …T\'s craving of that wine is untouched, one row', (await rowsOf(T)).length === 1 && (await rowsOf(T))[0].wine_id === pb)
  const items2 = ((await feed(T)).json?.items as FeedItem[] | undefined) ?? []
  const row2 = items2.find(i => i.type === 'session' && i.session?.id === post!.session!.id)?.session?.wines.find(w => w.ratingId === rid)
  check('(10b) …and the feed row now reads saved (this bottle\'s own save)', row2?.saved === true, row2)
  const un = await cravePost(T, post!.session!.id, a, 'DELETE')
  check('(10c) unsave from the post → { ok, saved: false }', JSON.stringify(un.json) === UNSAVED, un.json)
  const eC = await entry('Feed checkin')
  const ci = await call(checkinsRoute.POST, 'POST', '/api/checkins', as(H), { occurrenceId: nanoid(), ...pick(eC), score: 4, flavors: {}, notes: 'n' })
  const ciId = ci.json?.id as number
  const ciWine = (await prisma.$queryRaw<{ wine_id: string }[]>`SELECT r.wine_id FROM feed_items f JOIN ratings r ON r.id = f.rating_id WHERE f.id = ${ciId}`)[0]?.wine_id
  const cv = await cravePost(T, ciId, ciWine)
  const crow = (await rowsOf(T)).find(x => x.product_id === eC.productId)
  check('(10d) crave from a visible check-in → saved, sourced from its bottle, no moment', JSON.stringify(cv.json) === SAVED && !!crow && crow.wine_id === ciWine && crow.source_session_id === null, [cv.json, crow])
  const items3 = ((await feed(T)).json?.items as FeedItem[] | undefined) ?? []
  check('(10d) …the check-in reads saved in the feed', items3.find(i => i.type === 'checkin' && i.checkin?.id === ciId)?.checkin?.saved === true)
  const ciItem = items3.find(i => i.type === 'checkin' && i.checkin?.id === ciId)?.checkin
  check('(10d) …the feed check-in carries the kind, not the legacy `type`', !!ciItem && !('type' in ciItem) && 'colour' in ciItem && 'sparkling' in ciItem, ciItem)
  // The row key must name the author's rating in THIS moment (ADR-0009).
  const sessPost = post!.session!.id
  const noKey = await cravePostBody(T, sessPost, {})
  check('(10e) a moment post without the row key → 404, like a post it isn\'t (review r1: a 400 told a moment post apart)', noKey.status === 404, [noKey.status, noKey.json])
  const bigKey = await cravePostBody(T, sessPost, { ratingId: 3_000_000_000 })
  check('(10e) …a row key past an int4 → 400, never a 500', bigKey.status === 400, [bigKey.status, bigKey.json])
  const badKey = await cravePostBody(T, sessPost, { ratingId: String(rid) })
  check('(10e) …a row key that is not a rating id → 400', badKey.status === 400, [badKey.status, badKey.json])
  await rate(plain, as(H), pb)
  const elsewhere = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${pb} AND user_id = ${H.id}`)[0]?.id
  const otherMoment = await cravePostBody(T, sessPost, { ratingId: elsewhere })
  check('(10e) …the author\'s rating in ANOTHER moment → 404, nothing saved', otherMoment.status === 404 && (await rowsOf(T)).filter(x => x.wine_id === pb).length === 1, [otherMoment.status, otherMoment.json])
  await rate(code, as(T), a)
  const tessOwn = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${a} AND user_id = ${T.id}`)[0]?.id
  const notAuthor = await cravePostBody(T, sessPost, { ratingId: tessOwn })
  check('(10e) …someone else\'s rating in the same moment → 404', !!tessOwn && notAuthor.status === 404, [tessOwn, notAuthor.status, notAuthor.json])
  const ciBody = await cravePostBody(T, ciId, { ratingId: rid })
  check('(10e) …a check-in ignores a row key: its bottle is the post\'s own (already saved: still saved)', ciBody.status === 200 && JSON.stringify(ciBody.json) === SAVED && (await rowsOf(T)).filter(x => x.product_id === eC.productId).length === 1, [ciBody.status, ciBody.json])
  await call(blocksRoute.POST, 'POST', `/api/me/blocks/${T.pid}`, as(H), {}, { id: T.pid })
  const blocked = await cravePost(T, ciId, ciWine)
  check('(10f) behind the post gate (the author blocks T) → 404', blocked.status === 404, [blocked.status, blocked.json])

  // (10g) a line-up hidden from the caller is the same 404 BEFORE the budget
  // (review r1: a charged 404 counted the hidden line-up's ratings).
  {
    const m = await moment()
    await follow(m.T, m.H)
    const eh = await entry('Feed hidden')
    const hb = await addBottle(m.code, as(m.H), eh)
    await rate(m.code, as(m.H), hb)
    await settings(m.code, as(m.H), { hideLineup: true, hideLineupMinutesBefore: 0 })
    const hp = (await prisma.$queryRaw<{ id: number }[]>`SELECT f.id FROM feed_items f JOIN sessions s ON s.id = f.session_id WHERE f.user_id = ${m.H.id} AND s.code = ${m.code} AND f.kind = 'session'`)[0]?.id
    const hr = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${hb} AND user_id = ${m.H.id}`)[0]?.id
    const budget = async () => Number(await redis.get(`rl:crave:user:${m.T.id}:1h`) ?? 0)
    const before = await budget()
    const hid = await cravePostBody(m.T, hp!, { ratingId: hr })
    check('(10g) a moment post whose line-up is hidden from the caller → 404, and the save budget untouched', !!hp && !!hr && hid.status === 404 && (await budget()) === before, [hid.status, before, await budget()])
  }
}

// ── § 10h The Cravings row's post link (step 7 review) ──────────────────────
async function cravingPostLink() {
  section('§ 10h a craving opens the post its score comes from: the row carries that rating\'s key, under the post gate')
  const m1 = await moment()
  const e = await entry('Two moments')
  const a = await addBottle(m1.code, as(m1.H), e)
  await crave(m1.code, m1.T, a)
  // T rates the SAME wine in a second moment (another bottle of it).
  const m2code = await createSession(as(m1.H))
  await visit(m2code, as(m1.H))
  await enter(m2code, m1.T, 'Tess')
  const b = await addBottle(m2code, as(m1.H), e)
  await rate(m2code, as(m1.T), b)
  const tr = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE wine_id = ${b} AND user_id = ${m1.T.id}`)[0]?.id
  const tp = (await prisma.$queryRaw<{ id: number }[]>`SELECT f.id FROM feed_items f JOIN sessions s ON s.id = f.session_id WHERE f.user_id = ${m1.T.id} AND s.code = ${m2code} AND f.kind = 'session'`)[0]?.id
  const own = (await cravingsOf(m1.T, m1.T))[0]
  check('(10h) your craving of bottle A, scored by your rating of the same wine on bottle B: postId = B\'s post, ratingId = that rating, wineId = A', !!own && own.wineId === a && own.postId === tp && own.ratingId === tr, own)
  const V = await mkUser('Vic Viewer')
  const theirs = (await cravingsOf(m1.T, V))[0]
  check('(10h) …on someone else\'s view the rating key rides with the post only (present exactly when the post is)', !!theirs && ('ratingId' in theirs) === (theirs.postId !== null && theirs.postId !== undefined), theirs)
  await prisma.$executeRaw`UPDATE users SET profile_visibility = 'public-mutual' WHERE id = ${m1.T.id}`
  const hiddenView = await cravingsOf(m1.T, V)
  check('(10h) …and a viewer the posts are hidden from gets neither (or no list at all)', hiddenView.every(x => x.postId == null && !('ratingId' in x)), hiddenView)
}

// ── § 11 Removal ────────────────────────────────────────────────────────────
async function removal() {
  section('§ 11 removal: by bookmark id (owner-scoped 404), or per bottle in the moment; the old me-scoped by-wine route is gone')
  check('(11a) DELETE /api/me/bookmarks/[wineId] no longer exists', typeof bookmarkByWine.DELETE !== 'function')
  check('(11a) DELETE /api/me/bookmarks/[id] exists', typeof bookmarkById.DELETE === 'function')
  const { H, T, code } = await moment({ blind: true })
  const V = await mkUser('Other Owner')
  const e = await entry('Remove')
  const b = await addBottle(code, as(H), e)
  await reveal(code, as(H), b)
  await crave(code, T, b)
  const id = (await rowsOf(T))[0].id
  check('(11b) someone else\'s id → 404, nothing removed', (await removeById(V, id)).status === 404 && (await rowsOf(T)).length === 1)
  for (const bad of ['abc', '01', '-1', '1e3', '99999999']) check(`(11b) "${bad}" → 404`, (await removeById(T, bad)).status === 404)
  const ok = await removeById(T, id)
  check('(11c) own id → 200, gone', ok.status === 200 && (await rowsOf(T)).length === 0, [ok.status, ok.json])
  check('(11c) …again → 404', (await removeById(T, id)).status === 404)
  await crave(code, T, b)
  const u = await uncrave(code, T, b)
  check('(11d) unsave on a visible bottle removes the wine\'s craving', JSON.stringify(u.json) === UNSAVED && (await rowsOf(T)).length === 0, u.json)
  const eH = await entry('Remove hidden')
  const h = await addBottle(code, as(H), eH)
  await crave(code, T, h)
  const hid = ((await markersOf(T)) ?? [])[0]?.id
  check('(11e) a hidden blind save\'s key → 404 and it stays (it is not on any list)', (await removeById(T, `m${hid}`)).status === 404 && ((await markersOf(T)) ?? []).length === 1)
  for (const bad of ['m0', 'mm1', 'm', 'x1']) check(`(11e) "${bad}" → 404`, (await removeById(T, bad)).status === 404)
  const outsider = await mkUser('Outsider')
  const o = await uncrave(code, outsider, b)
  check('(11f) the in-moment unsave needs a participant (403, nothing written)', o.status === 403 || o.status === 401, [o.status, o.json])
}

// ── § 12 Re-link (R3) ───────────────────────────────────────────────────────
async function relink() {
  section('§ 12 a re-link carries the cravings sourced from the bottle to the new wine (R3); collisions keep the visible / earlier row')
  const { H, T, code } = await moment({ blind: true })
  const eP = await entry('Relink P')
  const eQ = await entry('Relink Q')
  const eC = await entry('Relink C')
  const eR = await entry('Relink R')
  const a = await addBottle(code, as(H), eP)
  const c = await addBottle(code, as(H), eC)
  await reveal(code, as(H), c)
  await crave(code, T, a)
  await crave(code, T, c)
  const sid = await sessionIdOf(code)
  const r1 = await editWine(code, as(H), a, pick(eQ))
  check('(12a) a re-link of "Wine N": its save stays on the bottle, nothing shows', r1.status === 200 && ((await markersOf(T)) ?? []).some(x => x.wine_id === a)
    && !(await cravingsOf(T, T)).some(x => x.name === eQ.name || x.name === eP.name), r1.status)
  const r2 = await editWine(code, as(H), c, pick(eR))
  const vis = (await rowsOf(T)).find(x => x.wine_id === c)
  check('(12b) a VISIBLE craving moves too (R3), bottle and moment kept', r2.status === 200 && vis?.product_id === eR.productId && vis?.source_session_id === sid, [r2.status, vis])
  check('(12b) …the list shows the new wine', (await cravingsOf(T, T)).some(x => x.name === eR.name) && !(await cravingsOf(T, T)).some(x => x.name === eC.name))
  const eS = await entry('Relink S')
  const plain = await createSession(as(H))
  await visit(plain, as(H))
  await enter(plain, T, 'Tess')
  await crave(plain, T, await addBottle(plain, as(H), eS))
  const before = (await rowsOf(T)).filter(x => x.product_id === eS.productId || x.wine_id === c)
  const earliest = before.reduce((a, b) => (+a.saved_at <= +b.saved_at ? a : b))
  await editWine(code, as(H), c, pick(eS))
  const sRows = (await rowsOf(T)).filter(x => x.product_id === eS.productId)
  check('(12c) moved onto a wine already craved (both visible) → one row, the EARLIER of the two', before.length === 2 && sRows.length === 1 && sRows[0].id === earliest.id, [before, sRows])
  const eU = await entry('Relink U')
  await crave(plain, T, await addBottle(plain, as(H), eU))
  const visibleU = (await rowsOf(T)).find(x => x.product_id === eU.productId)!
  await editWine(code, as(H), a, pick(eU))
  const uRows = (await rowsOf(T)).filter(x => x.product_id === eU.productId)
  check('(12d) a hidden one moved onto a visible craving of the new wine → the visible one is kept', uRows.length === 1 && uRows[0].id === visibleU.id, uRows)
  check('(12d) …and the bottle still reads saved for T (its own save)', (await rowIn(code, T, a))?.saved === true)
}

// ── § 13 Blind for Everyone, Hide Line-up, a moment over by its dates ───────
async function modes() {
  section('§ 13 Blind for Everyone, Hide Line-up and a moment over by its dates')
  {
    const { H, code } = await moment({ blind: true, forEveryone: true })
    const e = await entry('BFE')
    const a = await addBottle(code, as(H), e)
    check('(13a) Blind for Everyone: the host\'s own bottle is "Wine N" for the host', (await rowIn(code, H, a))?._blind === true)
    const r = await crave(code, H, a)
    check('(13a) …the host\'s save is a blind save, hidden from their Cravings until the reveal', JSON.stringify(r.json) === SAVED && (await cravingsOf(H, H)).length === 0 && ((await markersOf(H)) ?? []).length === 1)
    await reveal(code, as(H), a)
    check('(13a) …shown after it', (await cravingsOf(H, H)).length === 1)
  }
  {
    const { H, T, code } = await moment()
    const e = await entry('Hide')
    const a = await addBottle(code, as(H), e)
    await crave(code, T, a)
    await settings(code, as(H), { hideLineup: true, hideLineupMinutesBefore: 0 })
    const r = await crave(code, T, a)
    check('(13b) Hide Line-up: a crave of a hidden line-up\'s bottle → 404', r.status === 404, [r.status, r.json])
    check('(13b) …and a craving made there before is left out of the lists (residual 3)', (await cravingsOf(T, T)).length === 0 && (await countFor(T, T)) === 0)
  }
  {
    const { H, T, code } = await moment({ blind: true })
    const e = await entry('Over')
    const a = await addBottle(code, as(H), e)
    await prisma.$executeRaw`UPDATE sessions SET date_from = now() - interval '3 days', date_to = now() - interval '2 days' WHERE code = ${code}`
    const r = await crave(code, T, a)
    check('(13c) over by its dates but unrevealed: the moment still shows "Wine N", the save is a blind save', (await rowIn(code, T, a))?._blind === true && JSON.stringify(r.json) === SAVED)
    check('(13c) …and the craving shows at once outside (residual 1: the outside rule reveals a moment that is over)', (await cravingsOf(T, T)).length === 1)
  }
}

// ── § 14 The cohost residual ────────────────────────────────────────────────
async function cohost() {
  section('§ 14 the cohost residual: a cohost sees labels in the moment, but the craving stays out of their Cravings until the reveal')
  const { H, T, code } = await moment({ blind: true })
  const C = await mkUser('Cora Cohost')
  await enter(code, C, 'Cora')
  await setRole(code, as(H), C, 'co_host')
  const e = await entry('Cohost')
  const a = await addBottle(code, as(H), e)
  check('(14a) the cohost sees the label', (await rowIn(code, C, a))?._blind !== true, await rowIn(code, C, a))
  const r = await crave(code, C, a)
  check('(14a) the cohost\'s crave is a plain one (answer saved)', JSON.stringify(r.json) === SAVED, r.json)
  check('(14b) hidden from the cohost\'s Cravings and from others (never a leak)', (await cravingsOf(C, C)).length === 0 && (await cravingsOf(C, T)).length === 0)
  check('(14b) …the line-up shows the state the outside rule allows (named: not saved)', (await rowIn(code, C, a))?.saved === false)
  await reveal(code, as(H), a)
  check('(14c) after the reveal it shows', (await cravingsOf(C, C)).length === 1 && (await rowIn(code, C, a))?.saved === true)
}

// ── § 15 A linked alcohol-free row keeps its badge progress ─────────────────
async function nonalc() {
  section('§ 15 a legacy alcohol-free bottle, linked to an alcohol-free entry, keeps its badge progress')
  const { H, T, code } = await moment()
  const e = await entry('Nonalc legacy')
  const a = await addBottle(code, as(H), e)
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL, style = 'nonalc', colour = NULL, sparkling = false, abv = 0 WHERE id = ${a}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${code}`
  await rate(code, as(T), a)
  const before = (await getUserStats(T.id)).nonalcCount
  const af = await mintEntry({ producer: `${TAG} AF producer`, name: `${TAG} AF wine`, colour: 'white', abv: 0.3 })
  const r = await editWine(code, as(H), a, pick(af))
  const after = (await getUserStats(T.id)).nonalcCount
  check('(15a) the alcohol-free count holds across the link', r.status === 200 && before === 1 && after === 1, [r.status, before, after])
}

// ── § 16 D8: a saved bottle's photo stays ───────────────────────────────────
async function d8() {
  section('§ 16 D8 in one helper: a photo stays while a rating or a craving sources from its bottle')
  const helper = occurrences.reclaimablePhotos as ((db: unknown, ids: string[]) => Promise<{ id: string; imageUrl: string }[]>) | undefined
  check('(16a) lib/occurrences.ts reclaimablePhotos exists', typeof helper === 'function')
  if (typeof helper !== 'function') return
  const { H, T, code } = await moment()
  const ids = [await addBottle(code, as(H), await entry('D8 craved')), await addBottle(code, as(H), await entry('D8 rated')), await addBottle(code, as(H), await entry('D8 none'))]
  for (const [i, id] of ids.entries()) await prisma.$executeRaw`UPDATE wines SET image_url = ${`https://s3.example/wines/${TAG}-${i}.jpg`} WHERE id = ${id}`
  await crave(code, T, ids[0])
  await rate(code, as(T), ids[1])
  const got = await helper(prisma, ids)
  check('(16a) only the unreferenced bottle\'s photo is reclaimable', got.length === 1 && got[0].id === ids[2], got)
  await prisma.$executeRaw`INSERT INTO blind_saves (user_id, wine_id) VALUES (${T.id}, ${ids[2]})`
  check('(16a) …and a blind save keeps it too (it counts as a craving once revealed)', (await helper(prisma, ids)).length === 0)
  await prisma.$executeRaw`DELETE FROM blind_saves WHERE user_id = ${T.id} AND wine_id = ${ids[2]}`
  const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, as(H), undefined, { code })
  check('(16b) the moment DELETE still succeeds and keeps the craved bottle', del.status === 200 && (await prisma.wine.count({ where: { id: ids[0] } })) === 1, [del.status, del.json])
  check('(16b) …its craving shows on the owner\'s list (a deleted moment reveals)', (await cravingsOf(T, T)).length === 1)
}

// ── § 17 The purge's reference clearing ─────────────────────────────────────
async function purge() {
  section('§ 17 a purge clears references, never a row of history: a bookmark collision merges, a purged craving renders')
  const pv = catalogWrite.purgeVintage as ((tx: unknown, id: string) => Promise<void>) | undefined
  const pp = catalogWrite.purgeProduct as ((tx: unknown, id: string) => Promise<void>) | undefined
  check('(17a) lib/catalogWrite.ts purgeVintage / purgeProduct exist', typeof pv === 'function' && typeof pp === 'function')
  if (typeof pv !== 'function' || typeof pp !== 'function') return
  const { H, T, code } = await moment({ blind: true })
  const W = await mkUser('Wes Collider')
  await enter(code, W, 'Wes')
  const e = await entry('Purge')
  const anyYear = { ...e, vintageId: null }
  const bv = await addBottle(code, as(H), e)
  const bp = await addBottle(code, as(H), anyYear)
  await reveal(code, as(H), bp)
  await reveal(code, as(H), bv)
  await crave(code, T, bv)
  await pause(20)
  await crave(code, T, bp)
  const tRows = await rowsOf(T)
  // W's hidden (wine, 2019) craving: a real craving on a bottle hidden for W
  // (as an old-code save of a blind bottle left one; a blind save makes none).
  const hiddenB = await addBottle(code, as(H), e)
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, product_id, vintage_id, name, source_session_id) VALUES (${W.id}, ${hiddenB}, ${e.productId}, ${e.vintageId}, ${e.name}, ${await sessionIdOf(code)})`
  await pause(20)
  await crave(code, W, bp)
  const wVisible = (await rowsOf(W)).find(x => x.vintage_id === null)!
  await prisma.$executeRaw`INSERT INTO catalog_review_items (entity_type, entity_id, reason) VALUES ('vintage', ${e.vintageId}, 'user-mint') ON CONFLICT DO NOTHING`.catch(() => 0)
  await prisma.$transaction(tx => pv(tx, e.vintageId!))
  const t2 = await rowsOf(T)
  check('(17b) T: (wine, 2019) and (wine, any year) collide → one row, the EARLIER one (both visible)', t2.length === 1 && t2[0].id === Math.min(...tRows.map(x => x.id)) && t2[0].vintage_id === null && t2[0].product_id === e.productId, t2)
  const w2 = await rowsOf(W)
  check('(17b) W: a hidden (wine, 2019) and a visible (wine, any year) → the VISIBLE one kept', w2.length === 1 && w2[0].id === wVisible.id, w2)
  check('(17b) the bottles keep their product, lose the vintage', (await prisma.wine.findUniqueOrThrow({ where: { id: bv }, select: { vintageId: true, productId: true } })).vintageId === null)
  check('(17b) the vintage row and its review item are gone', (await prisma.wineVintage.count({ where: { id: e.vintageId! } })) === 0
    && Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM catalog_review_items WHERE entity_id = ${e.vintageId}`)[0].n) === 0)
  await prisma.$transaction(tx => pp(tx, e.productId))
  const t3 = await rowsOf(T)
  check('(17c) a product purge leaves the craving, unlinked, with its snapshot', t3.length === 1 && t3[0].product_id === null && t3[0].name === e.name, t3)
  const list = await cravingsOf(T, T)
  check('(17c) …and it renders on the list from that snapshot', list.length === 1 && list[0].name === e.name, list)
  const s = (await saved(T)).json as unknown as Record<string, unknown>[]
  check('(17c) …and in Saved', Array.isArray(s) && s.length === 1 && s[0].name === e.name, s)
  check('(17c) the product row is gone, the bottles stay', (await prisma.wineProduct.count({ where: { id: e.productId } })) === 0 && (await prisma.wine.count({ where: { id: bv } })) === 1)
}

// ── § 18 Merges are followed on every match ─────────────────────────────────
async function merges() {
  section('§ 18 a craving of a merged-away wine: shown as the survivor, and a bottle of the survivor reads saved')
  const { H, T, code } = await moment()
  const old = await entry('Merge old', { year: undefined })
  const survivor = await entry('Merge new', { year: undefined })
  const b0 = await addBottle(code, as(H), old)
  await crave(code, T, b0)
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${survivor.productId} WHERE id = ${old.productId}`
  const list = await cravingsOf(T, T)
  check('(18a) the list shows the survivor\'s name', list.length === 1 && list[0].name === survivor.name, list)
  const b1 = await addBottle(code, as(H), survivor)
  check('(18b) a bottle of the survivor reads saved', (await rowIn(code, T, b1))?.saved === true, await rowIn(code, T, b1))
  await crave(code, T, b1)
  check('(18c) craving it adds no second row', (await rowsOf(T)).length === 1)
  await rate(code, as(T), b1, { score: 4.5 })
  const row = (await cravingsOf(T, T))[0]
  check('(18d) the craving (stored on the merged-away wine) takes the score of a rating of the survivor', row?.score === 4.5, row)
  const sv = (await saved(T)).json as unknown as { name: string; ratings: { score: number }[] }[]
  check('(18d) …and Saved shows the survivor with that rating as context', sv.length === 1 && sv[0].name === survivor.name && sv[0].ratings.length === 1 && sv[0].ratings[0].score === 4.5, sv)
  // The one walk agrees with resolveEffectiveIds: a two-hop chain and a cycle.
  const map = (await import('../../lib/catalogEntries.ts')) as Record<string, unknown>
  const tomb = map.tombstoneMapSql as (t: string, ids: unknown) => unknown
  const resolve = map.resolveEffectiveIds as (t: string, ids: string[]) => Promise<Map<string, string>>
  const [x, y, z] = [await entry('Chain x', { year: undefined }), await entry('Chain y', { year: undefined }), await entry('Chain z', { year: undefined })]
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${y.productId} WHERE id = ${x.productId}`
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${z.productId} WHERE id = ${y.productId}`
  const { Prisma } = await import('@prisma/client')
  const sql = (ids: string[]) => tomb('wine_products', Prisma.sql`SELECT unnest(${ids}::text[])`) as never
  const walk = async (ids: string[]) => new Map((await prisma.$queryRaw<{ id: string; eff: string }[]>`${sql(ids)}`).map(r => [r.id, r.eff]))
  const ts = await resolve('wine_products', [x.productId, y.productId, z.productId])
  const db = await walk([x.productId, y.productId, z.productId])
  check('(18e) a chain x → y → z: the one walk and resolveEffectiveIds agree (x, y → z; z itself unmapped)',
    db.get(x.productId) === z.productId && db.get(y.productId) === z.productId && !db.has(z.productId) && ts.get(x.productId) === z.productId && ts.get(y.productId) === z.productId, [Object.fromEntries(db), Object.fromEntries(ts)])
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${x.productId} WHERE id = ${z.productId}`
  const ts2 = await resolve('wine_products', [x.productId])
  const db2 = await walk([x.productId])
  check('(18e) a corrupt cycle x → y → z → x: both stop at the same node', db2.get(x.productId) === ts2.get(x.productId), [db2.get(x.productId), ts2.get(x.productId)])
  await prisma.$executeRaw`UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE id IN (${x.productId}, ${y.productId}, ${z.productId})`
}

// ── § 19 Saved: one wine with its vintages, your ratings as context ─────────
async function savedShape() {
  section('§ 19 Saved: one wine with its saved vintages, and your ratings of it that you may see')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Saved')
  const v2020 = await prisma.$transaction(tx => (catalogWrite.createVintage as (p: string, y: number | null, u: null, a: null, tx: unknown) => Promise<{ id: string }>)(e.productId, 2020, null, null, tx))
  const b19 = await addBottle(code, as(H), e)
  const b20 = await addBottle(code, as(H), { ...e, vintageId: v2020.id })
  const bAny = await addBottle(code, as(H), { ...e, vintageId: null })
  const bBlind = await addBottle(code, as(H), e)
  for (const b of [b19, b20, bAny]) { await reveal(code, as(H), b); await crave(code, T, b) }
  await rate(code, as(T), b19, { score: 4.5 })
  await rate(code, as(T), bBlind, { score: 2 })
  const s = (await saved(T)).json as unknown as { name: string; vintages?: { key: string; vintage: string | null }[]; ratings?: { score: number }[] }[]
  check('(19a) one wine', Array.isArray(s) && s.length === 1 && s[0].name === e.name, s)
  check('(19a) …with its three saved vintages, each removable by its key', s[0]?.vintages?.length === 3 && s[0].vintages.every(v => typeof v.key === 'string' && /^\d+$/.test(v.key)), s[0]?.vintages)
  check('(19b) …your rating of the revealed bottle as context, never the one of "Wine N"', s[0]?.ratings?.length === 1 && s[0].ratings[0].score === 4.5, s[0]?.ratings)
}

// ── § 20 The Cravings row ───────────────────────────────────────────────────
async function rowShape() {
  section('§ 20 a Cravings row: the score is the owner\'s latest visible rating of that wine')
  const { H, T, code } = await moment({ blind: true })
  const V = await mkUser('Row Viewer')
  const e = await entry('Row')
  const b = await addBottle(code, as(H), e)
  const blindB = await addBottle(code, as(H), e)
  await reveal(code, as(H), b)
  await crave(code, T, b)
  await rate(code, as(T), b, { score: 3 })
  await pause(20)
  await rate(code, as(T), blindB, { score: 5 })
  const own = await cravingsOf(T, T)
  check('(20a) own row: the visible rating\'s score, never the later one of "Wine N"', own.length === 1 && own[0].score === 3, own)
  check('(20a) …wineId = the source bottle', own[0]?.wineId === b)
  const other = await cravingsOf(T, V)
  check('(20b) someone else\'s view: the same row, the same score (T\'s posts are public)', other.length === 1 && other[0].score === 3 && other[0].wineId === own[0].wineId, other)
  check('(20b) …but no craving id or key there (an id is a coarse save time: the cursor is sealed for that)', !('id' in other[0]) && !('key' in other[0]), other)
}


// ── § 21 Two blind bottles of one wine (review r1) ──────────────────────────
async function twoBottles() {
  section('§ 21 two hidden bottles of one wine, both saved: the reveal of one shows it, and says nothing about the other')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Two bottles')
  const other = await entry('Two bottles other')
  const b1 = await addBottle(code, as(H), e)
  const b2 = await addBottle(code, as(H), e)
  const b3 = await addBottle(code, as(H), other)
  for (const b of [b1, b2, b3]) await crave(code, T, b)
  await reveal(code, as(H), b2)
  check('(21a) the revealed bottle reads saved and its wine is listed', (await rowIn(code, T, b2))?.saved === true && (await cravingsOf(T, T)).some(x => x.name === e.name))
  check('(21a) …the other bottle of it is still "Wine N", saved by its own save only', (await rowIn(code, T, b1))?._blind === true && (await rowIn(code, T, b1))?.saved === true)
  await reveal(code, as(H), b3)
  check('(21b) the reveal of the third bottle shows its wine too (each save matures on its own)', (await cravingsOf(T, T)).length === 2)
  await deleteWine(code, as(H), b1)
  check('(21c) deleting the still-hidden twin changes nothing on the list', (await cravingsOf(T, T)).length === 2)
}

// ── § 22 A blind save takes no bookmarks id (review r1) ─────────────────────
async function noId() {
  section('§ 22 🔒 a blind save takes no bookmarks id, whatever the wine (linked, unlinked, already craved, new)')
  const { H, T, code } = await moment({ blind: true })
  const known = await entry('NoId known')
  const plain = await createSession(as(H))
  await visit(plain, as(H))
  await enter(plain, T, 'Tess')
  await crave(plain, T, await addBottle(plain, as(H), known))
  const seq = async () => Number((await prisma.$queryRaw<{ v: bigint }[]>`SELECT last_value AS v FROM bookmarks_id_seq`)[0].v)
  const bk = await addBottle(code, as(H), known)
  const bn = await addBottle(code, as(H), await entry('NoId new'))
  const bu = await addBottle(code, as(H), await entry('NoId unlinked'))
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id = ${bu}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${code}`
  const before = await seq()
  for (const b of [bk, bn, bu]) { await crave(code, T, b); await uncrave(code, T, b); await crave(code, T, b) }
  check('(22a) the bookmarks sequence did not move', (await seq()) === before, [before, await seq()])
}

// ── § 23 Saved names no code of a moment you were not in (review r1) ────────
async function noCode() {
  section('§ 23 🔒 Saved: a save from someone else\'s post names no moment code (a code is a join credential)')
  const { H, code } = await moment()
  const U = await mkUser('Ulla Outside')
  await follow(U, H)
  const e = await entry('No code')
  const b = await addBottle(code, as(H), e)
  await rate(code, as(H), b)
  const post = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM feed_items WHERE user_id = ${H.id} AND kind = 'session' ORDER BY id DESC LIMIT 1`)[0].id
  const r = await cravePost(U, post, b)
  const s = (await saved(U)).json as unknown as { vintages: { session_code: string | null; session_id: number | null }[] }[]
  check('(23a) saved from the post, listed, with no code and no moment id', r.status === 200 && s.length === 1 && s[0].vintages[0].session_code === null && s[0].vintages[0].session_id === null, s)
  check('(23a) …the craving remembers the post', ((await rowsOf(U))[0] as unknown as { id: number }) && Number((await prisma.$queryRaw<{ i: number | null }[]>`SELECT source_item_id AS i FROM bookmarks WHERE user_id = ${U.id}`)[0].i) === post)
}

// ── § 24 A craving from a post shows its photo only where the post shows ────
async function postPhoto() {
  section('§ 24 a craving saved from someone\'s post: its bottle photo and id reach only viewers who may see that post (ruled 2026-11-20)')
  const { H, code } = await moment()
  const U = await mkUser('Uma Craver')
  const V = await mkUser('Vik Sees')
  const X = await mkUser('Xia Blocked')
  await follow(U, H)
  const e = await entry('Post photo')
  const b = await addBottle(code, as(H), e)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${`https://s3.example/wines/${TAG}-pp.jpg`} WHERE id = ${b}`
  await rate(code, as(H), b)
  const post = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM feed_items WHERE user_id = ${H.id} AND kind = 'session' ORDER BY id DESC LIMIT 1`)[0].id
  await cravePost(U, post, b)
  await call(blocksRoute.POST, 'POST', `/api/me/blocks/${X.pid}`, as(H), {}, { id: X.pid })
  const own = await cravingsOf(U, U)
  const seen = await cravingsOf(U, V)
  const shut = await cravingsOf(U, X)
  check('(24a) the craver sees the photo and the bottle', own[0]?.imageUrl?.includes(`${TAG}-pp`) === true && own[0]?.wineId === b, own)
  check('(24a) a viewer who may see the post sees them too', seen[0]?.imageUrl?.includes(`${TAG}-pp`) === true && seen[0]?.wineId === b, seen)
  check('(24b) 🔒 a viewer the post\'s author blocks sees the wine, without its photo or bottle id', shut.length === 1 && shut[0].imageUrl === null && !('wineId' in shut[0]) && shut[0].name === e.name, shut)
}

// ── § 25 Legacy unlinked cravings in the moment (review r1) ─────────────────
async function legacy() {
  section('§ 25 a legacy craving of an unlinked bottle reads saved in the moment, unsaves there, and keeps its ratings in Saved')
  const { H, T, code } = await moment()
  const b = await addBottle(code, as(H), await entry('Legacy'))
  await rate(code, as(T), b, { score: 3.5 })
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id = ${b}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${code}`
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, source_session_id) VALUES (${T.id}, ${b}, ${await sessionIdOf(code)})`
  check('(25a) the line-up reads saved', (await rowIn(code, T, b))?.saved === true, await rowIn(code, T, b))
  const s = (await saved(T)).json as unknown as { linked: boolean; vintages: { vintage: string | null }[]; ratings: { score: number }[] }[]
  check('(25b) Saved: unlinked (no "any year" claim), with its rating as context', s.length === 1 && s[0].linked === false && s[0].ratings.length === 1 && s[0].ratings[0].score === 3.5, s)
  const again = await crave(code, T, b)
  check('(25c) saving it again answers saved (no 409 for a bottle already saved)', JSON.stringify(again.json) === SAVED, [again.status, again.json])
  const u = await uncrave(code, T, b)
  check('(25d) unsave removes it', JSON.stringify(u.json) === UNSAVED && (await rowsOf(T)).length === 0 && (await rowIn(code, T, b))?.saved === false)
}

// ── § 26 A matured blind save survives its bottle's delete (R1) ─────────────
async function maturedDelete() {
  section('§ 26 a blind save whose bottle was revealed counts as a craving; deleting the bottle keeps it (R1)')
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Matured')
  const c = await addBottle(code, as(H), e)
  await crave(code, T, c)
  const at = (await prisma.$queryRaw<{ t: Date }[]>`SELECT saved_at AS t FROM blind_saves WHERE user_id = ${T.id}`)[0]?.t
  await reveal(code, as(H), c)
  check('(26a) revealed: listed', (await cravingsOf(T, T)).length === 1)
  await deleteWine(code, as(H), c)
  const rows = await rowsOf(T)
  check('(26b) deleted: now a real craving, no bottle, its moment and its date (the save\'s) kept', rows.length === 1 && rows[0].wine_id === null && rows[0].source_session_id === (await sessionIdOf(code))
    && !!at && +rows[0].saved_at === +at && (await cravingsOf(T, T)).length === 1, [rows, at])
  const u = await crave(code, T, c)
  check('(26c) the bottle is gone: a save of it → 404', u.status === 404, u.status)
}

// ── § 27 The save budget (ruled 2026-11-20) ─────────────────────────────────
async function budget() {
  section('§ 27 one save budget for both routes: 300 an hour per user, then 429')
  const { H, T, code } = await moment()
  const b = await addBottle(code, as(H), await entry('Budget'))
  await resetLimits()
  await redis.set(`rl:crave:user:${T.id}:1h`, '300', { EX: 3600 })
  const r = await crave(code, T, b)
  check('(27a) the moment\'s save at the cap → 429 with a wait', r.status === 429 && /Too many saves\. Try again in/.test(String(r.json?.error)), [r.status, r.json])
  const checkin = await call(checkinsRoute.POST, 'POST', '/api/checkins', as(H), { occurrenceId: nanoid(), ...pick(await entry('Budget ci')), score: 4, flavors: {}, notes: 'n' })
  await follow(T, H)
  const ciWine = (await prisma.$queryRaw<{ w: string }[]>`SELECT r.wine_id AS w FROM feed_items f JOIN ratings r ON r.id = f.rating_id WHERE f.id = ${checkin.json?.id as number}`)[0]?.w
  const p = await cravePost(T, checkin.json?.id as number, ciWine)
  check('(27a) …and the post\'s save shares it', p.status === 429, [p.status, p.json])
  await resetLimits()
  check('(27b) after the window: saves again', (await crave(code, T, b)).status === 200)
}


// ── § 28 A tile pin from a matured blind save stays live (review r2) ────────
async function tilePin() {
  section('§ 28 a Cravings tile photo picked from a blind save whose bottle was revealed: pickable, and the pin stays')
  const tiles = await import('../../lib/profileTiles.ts')
  const { H, T, code } = await moment({ blind: true })
  const b = await addBottle(code, as(H), await entry('Tile pin'))
  const url = `https://s3.example/wines/${TAG}-tile.jpg`
  await prisma.$executeRaw`UPDATE wines SET image_url = ${url} WHERE id = ${b}`
  await crave(code, T, b)
  check('(28a) while hidden: not pickable', (await tiles.isPickable('cravings', T.id, url)) === false)
  await reveal(code, as(H), b)
  check('(28a) revealed: pickable', (await tiles.isPickable('cravings', T.id, url)) === true)
  await prisma.$executeRaw`UPDATE users SET tile_cravings_url = ${url} WHERE id = ${T.id}`
  const got = await tiles.resolveTilePhotos(T.id, ['cravings'], T.id)
  check('(28b) the pin is read as live (not cleared)', got.cravings?.imageUrl === url && got.cravings?.pinned === true
    && (await prisma.$queryRaw<{ u: string | null }[]>`SELECT tile_cravings_url AS u FROM users WHERE id = ${T.id}`)[0].u === url, got)
}

// ── § 29 A wipe takes the save of an orphaned, unrated bottle (review r2) ───
async function wipeOrphan() {
  section('§ 29 a ban takes the removed person\'s blind saves from the moment, an orphaned unrated bottle\'s too')
  const { H, T, code } = await moment({ blind: true })
  const Pv = await mkUser('Pia Provider')
  await enter(code, Pv, 'Pia')
  await setRole(code, as(H), Pv, 'provider')
  const d = await addBottle(code, as(Pv), await entry('Wipe orphan'))
  await crave(code, T, d)
  await ban(code, as(H), Pv, true)
  check('(29) setup: the bottle is orphaned and unrated, the save stays', ((await markersOf(T)) ?? []).length === 1
    && (await prisma.$queryRaw<{ s: number | null }[]>`SELECT session_id AS s FROM wines WHERE id = ${d}`)[0].s === null)
  await ban(code, as(H), T)
  check('(29a) banning the saver takes that save', ((await markersOf(T)) ?? []).length === 0)
}

// ── § 30 Lock order: a post save waits for the moment's row (review r2) ─────
async function lockOrder() {
  section('§ 30 a save from a post takes the moment\'s row before the saver\'s craving lock (no deadlock against the moment)')
  const { H, T, code } = await moment()
  await follow(T, H)
  const b = await addBottle(code, as(H), await entry('Lock order'))
  await rate(code, as(H), b)
  const post = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM feed_items WHERE user_id = ${H.id} AND kind = 'session' ORDER BY id DESC LIMIT 1`)[0].id
  const sid = await sessionIdOf(code)
  const pg = (await import('pg')).default
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    // A moment contract's shape: the moment row FOR UPDATE, then the craving lock.
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sid])
    const pending = cravePost(T, post, b)
    // Wait until the post save is blocked on a lock (never a fixed sleep).
    let waited = false
    for (let i = 0; i < 100 && !waited; i++) {
      const w = await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      waited = w.rows[0].n > 0
      if (!waited) await pause(20)
    }
    let deadlock = false
    try { await holder.query(`SET LOCAL statement_timeout = '5s'`); await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cravings:${T.id}`]) }
    catch (e) { deadlock = /deadlock/i.test(String((e as Error).message)) }
    await holder.query(deadlock ? 'ROLLBACK' : 'COMMIT')
    const r = await pending
    check('(30a) the post save waited for the moment\'s row', waited)
    check('(30a) no deadlock: the moment\'s side took the craving lock, then the save went through', !deadlock && r.status === 200 && JSON.stringify(r.json) === SAVED, [deadlock, r.status, r.json])
    // (30b) review r3: a contract that holds the moment row and THEN locks the
    // bottle (a host edit, delete or save) must not deadlock with a post save
    // that took the bottle first.
    await cravePost(T, post, b, 'DELETE')
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sid])
    const pending2 = cravePost(T, post, b)
    let waited2 = false
    for (let i = 0; i < 100 && !waited2; i++) {
      const w = await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      waited2 = w.rows[0].n > 0
      if (!waited2) await pause(20)
    }
    let deadlock2 = false
    try { await holder.query(`SET LOCAL statement_timeout = '5s'`); await holder.query('SELECT id FROM wines WHERE id = $1 FOR UPDATE', [b]); await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cravings:${T.id}`]) }
    catch (e) { deadlock2 = /deadlock/i.test(String((e as Error).message)) }
    await holder.query(deadlock2 ? 'ROLLBACK' : 'COMMIT')
    const r2 = await pending2
    check('(30b) the contract got the bottle and the craving lock, then the post save went through (no deadlock either side)', waited2 && !deadlock2 && r2.status === 200, [waited2, deadlock2, r2.status, r2.json])
  } finally { await holder.end() }
}

// ── § 31 The post rule on the saver's own view (ruled 2026-11-20) ───────────
async function ownView() {
  section('§ 31 a bottle saved from a post, then the author blocks the saver: the saver keeps the wine, not its photo, id or purchase link')
  const { H, code } = await moment()
  const U = await mkUser('Ugo Saver')
  await follow(U, H)
  const e = await entry('Own view')
  const b = await addBottle(code, as(H), e)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${`https://s3.example/wines/${TAG}-ov.jpg`}, purchase_url = 'https://shop.example/ov' WHERE id = ${b}`
  await rate(code, as(H), b)
  const post = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM feed_items WHERE user_id = ${H.id} AND kind = 'session' ORDER BY id DESC LIMIT 1`)[0].id
  await cravePost(U, post, b)
  const before = (await cravingsOf(U, U))[0]
  const sBefore = ((await saved(U)).json as unknown as { image_url: string | null; purchase_url: string | null }[])[0]
  check('(31a) before: the saver sees photo, bottle and purchase link', before?.wineId === b && !!before?.imageUrl && sBefore?.purchase_url === 'https://shop.example/ov', [before, sBefore])
  await call(blocksRoute.POST, 'POST', `/api/me/blocks/${U.pid}`, as(H), {}, { id: U.pid })
  const after = (await cravingsOf(U, U))[0]
  const sAfter = ((await saved(U)).json as unknown as { name: string; image_url: string | null; purchase_url: string | null }[])[0]
  check('(31b) after the block: the wine stays, without its photo or bottle id', after?.name === e.name && after.imageUrl === null && !('wineId' in after), after)
  check('(31b) …and Saved without photo or purchase link', sAfter?.name === e.name && sAfter.image_url === null && sAfter.purchase_url === null, sAfter)
  check('(31c) the moment\'s name goes with them (review r3): shown before, absent after, and not searchable', !!before?.momentName && !('momentName' in after)
    && (await cravingsOf(U, U, '?q=moment')).length === 0, [before?.momentName, after, await cravingsOf(U, U, '?q=moment')])
}

// ── § 34 A deleted moment: a member's save keeps its bottle (review r3) ─────
async function deletedMoment() {
  section('§ 34 a member saved a revealed bottle and never rated; the host deletes the moment: the bottle, photo and moment label stay')
  const { H, T, code } = await moment()
  const V = await mkUser('Vee Viewer')
  const e = await entry('Deleted moment')
  const b = await addBottle(code, as(H), e)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${`https://s3.example/wines/${TAG}-dm.jpg`} WHERE id = ${b}`
  await crave(code, T, b)
  const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, as(H), undefined, { code })
  const own = (await cravingsOf(T, T))[0]
  const other = (await cravingsOf(T, V))[0]
  const sv = ((await saved(T)).json as unknown as { image_url: string | null; vintages: { session_deleted: boolean }[] }[])[0]
  check('(34a) the delete went through; the saver still sees the bottle and its photo', del.status === 200 && own?.wineId === b && own.imageUrl?.includes(`${TAG}-dm`) === true, [del.status, own])
  check('(34a) …so do others', other?.wineId === b && other.imageUrl?.includes(`${TAG}-dm`) === true, other)
  check('(34b) Saved keeps the photo and says "[deleted session]"', sv?.image_url?.includes(`${TAG}-dm`) === true && sv.vintages[0]?.session_deleted === true, sv)
}

// ── § 35 An old instance's save of a linked bottle groups with its wine ─────
async function oldInstanceRow() {
  section('§ 35 an old instance\'s save (no link) of a LINKED bottle counts as that wine: one row, one count (review r3)')
  const { H, T, code } = await moment()
  const e = await entry('Old instance')
  const b1 = await addBottle(code, as(H), e)
  await crave(code, T, b1)
  const code2 = await createSession(as(H))
  await visit(code2, as(H))
  await enter(code2, T, 'Tess')
  const b2 = await addBottle(code2, as(H), e)
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, source_session_id) VALUES (${T.id}, ${b2}, ${await sessionIdOf(code2)})`
  check('(35a) one row and a count of one', (await cravingsOf(T, T)).length === 1 && (await countFor(T, T)) === 1 && (await badges(T)) === 1, await cravingsOf(T, T))
  check('(35a) …and the old row\'s bottle reads saved', (await rowIn(code2, T, b2))?.saved === true)
  // Review r4: every matcher reads the old row as the wine, not only the list.
  await uncrave(code, T, b1)
  const again = await crave(code, T, b1)
  check('(35b) unsave then save on another bottle of the wine: answered saved AND reads saved', JSON.stringify(again.json) === SAVED && (await rowIn(code, T, b1))?.saved === true, [again.json, await rowIn(code, T, b1)])
  check('(35b) …the unsave took the old row too (the wine, as the button shows it)', !(await rowsOf(T)).some(x => x.wine_id === b2))
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, source_session_id) VALUES (${T.id}, ${b2}, ${await sessionIdOf(code2)})`
  const b3 = await addBottle(code, as(H), e)
  await prisma.$executeRaw`INSERT INTO blind_saves (user_id, wine_id, session_id) VALUES (${T.id}, ${b3}, ${await sessionIdOf(code)})`
  const oldKey = String((await rowsOf(T)).find(x => x.wine_id === b2 && x.product_id === null)?.id)
  const rm = await removeById(T, oldKey)
  check('(35c) removing the wine by the old row\'s key takes every shown row of it (the matured blind save too)', rm.status === 200 && (await cravingsOf(T, T)).length === 0 && (await countFor(T, T)) === 0, [rm.status, await cravingsOf(T, T)])
  await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, source_session_id) VALUES (${T.id}, ${b2}, ${await sessionIdOf(code2)})`
  check('(35d) with only the old row, ANOTHER bottle of the wine reads saved (the flag reads it as the wine)', (await rowIn(code, T, b1))?.saved === true, await rowIn(code, T, b1))
}

// ── § 36 A merged product's year: the bottle matches its own save (Codex r1) ─
async function mergedYear() {
  section('§ 36 a bottle of a merged-away product whose year exists only there: saved reads saved, unsave takes it, the list shows the survivor')
  const { H, T, code } = await moment()
  const a = await entry('Merged year old')
  const survivor = await entry('Merged year new', { year: undefined })
  const b = await addBottle(code, as(H), a)
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${survivor.productId} WHERE id = ${a.productId}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE code = ${code} AND deleted_at IS NULL`
  const r = await crave(code, T, b)
  check('(36a) the save answers saved, and the bottle then READS saved', JSON.stringify(r.json) === SAVED && (await rowIn(code, T, b))?.saved === true, [r.json, await rowIn(code, T, b)])
  const list = await cravingsOf(T, T)
  check('(36b) the list shows one row, under the survivor\'s name', list.length === 1 && list[0].name === survivor.name, list)
  await uncrave(code, T, b)
  check('(36c) the unsave on that bottle takes the craving', (await rowsOf(T)).length === 0 && (await countFor(T, T)) === 0, await rowsOf(T))
  await prisma.$executeRaw`UPDATE wine_products SET status = 'provisional', links_to = NULL WHERE id = ${a.productId}`
}

// ── § 37 A product purge keeps a matured blind save (Codex r1) ──────────────
async function purgeSaves() {
  section('§ 37 a product purge: a blind save that already counts as a craving stays one; a still-hidden one stays a save of its bottle')
  const pp = catalogWrite.purgeProduct as (tx: unknown, id: string) => Promise<void>
  const { H, T, code } = await moment({ blind: true })
  const e = await entry('Purge matured')
  const bm = await addBottle(code, as(H), e)
  const bh = await addBottle(code, as(H), e)
  await crave(code, T, bm)
  await crave(code, T, bh)
  await reveal(code, as(H), bm)
  check('(37a) before: the revealed bottle\'s save counts (one row, one count)', (await cravingsOf(T, T)).length === 1 && (await countFor(T, T)) === 1)
  await prisma.$transaction(tx => pp(tx, e.productId))
  const list = await cravingsOf(T, T)
  check('(37b) after the purge: still one row, its name, one count, one badge', list.length === 1 && list[0].name === e.name && (await countFor(T, T)) === 1 && (await badges(T)) === 1, list)
  const s = (await saved(T)).json as unknown as { name: string }[]
  check('(37b) …and in Saved', Array.isArray(s) && s.length === 1 && s[0]?.name === e.name, s)
  check('(37b) …and the bottle reads saved in the moment', (await rowIn(code, T, bm))?.saved === true, await rowIn(code, T, bm))
  const real = (await rowsOf(T)).filter(x => x.wine_id === bm)
  check('(37c) the still-hidden bottle\'s save stayed a save of that bottle (no craving of it)', ((await markersOf(T)) ?? []).some(m => m.wine_id === bh) && !(await rowsOf(T)).some(x => x.wine_id === bh) && real.length === 1, await rowsOf(T))
  await uncrave(code, T, bm)
  check('(37d) the unsave on the revealed bottle takes it', (await countFor(T, T)) === 0 && (await cravingsOf(T, T)).length === 0)
}

// ── § 38 The purge's lock order (Codex r1) ──────────────────────────────────
async function purgeLocks() {
  section('§ 38 a purge takes the moment (advisory lock, row) before its bottles: no deadlock against a moment contract')
  const pv = catalogWrite.purgeVintage as (tx: unknown, id: string) => Promise<void>
  const pp = catalogWrite.purgeProduct as (tx: unknown, id: string) => Promise<void>
  const pg = (await import('pg')).default
  for (const [label, run] of [['vintage', pv], ['product', pp]] as const) {
    const { H, T, code } = await moment()
    const e = await entry(`Purge lock ${label}`)
    const b = await addBottle(code, as(H), e)
    await crave(code, T, b)
    const sid = await sessionIdOf(code)
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      // A moment contract's shape: the advisory lock, the moment row, THEN the
      // bottle, then the craving lock.
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`session:${code}`])
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sid])
      let purgeErr = ''
      const pending = prisma.$transaction(tx => run(tx, label === 'vintage' ? e.vintageId! : e.productId)).catch(err => { purgeErr = String((err as Error).message) })
      let waited = false
      for (let i = 0; i < 100 && !waited; i++) {
        const w = await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
        waited = w.rows[0].n > 0
        if (!waited) await pause(20)
      }
      let holderErr = ''
      try {
        await holder.query(`SET LOCAL statement_timeout = '5s'`)
        await holder.query('SELECT id FROM wines WHERE id = $1 FOR UPDATE', [b])
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cravings:${T.id}`])
      } catch (err) { holderErr = String((err as Error).message) }
      await holder.query(holderErr ? 'ROLLBACK' : 'COMMIT')
      await pending
      check(`(38${label === 'vintage' ? 'a' : 'b'}) ${label} purge: it waited for the moment, the contract got the bottle and the craving lock, then the purge went through`,
        waited && !holderErr && !purgeErr && (label === 'vintage' ? (await prisma.wineVintage.count({ where: { id: e.vintageId! } })) === 0 : (await prisma.wineProduct.count({ where: { id: e.productId } })) === 0),
        { waited, holderErr, purgeErr })
    } finally { await holder.end() }
  }
  // Waits until another backend is blocked on a lock, or `done()` (never a fixed sleep).
  const blocked = async (holder: InstanceType<typeof pg.Client>, done: () => boolean) => {
    for (let i = 0; i < 150; i++) {
      if (done()) return false
      const w = await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      if (w.rows[0].n > 0) return true
      await pause(20)
    }
    return false
  }
  // (38c) Codex r2: a matured save of an ORPHANED bottle (no wines.session_id;
  // its moment only on the save) becomes a craving carrying that moment, so the
  // purge must hold that moment before the saver's craving lock.
  {
    const { H, T, code } = await moment({ blind: true })
    const e = await entry('Purge orphan save')
    const b = await addBottle(code, as(H), e)
    await crave(code, T, b)
    await reveal(code, as(H), b)
    await prisma.$executeRaw`UPDATE wines SET session_id = NULL WHERE id = ${b}`
    const sid = await sessionIdOf(code)
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`session:${code}`])
      await holder.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sid])
      let purgeErr = ''
      let finished = false
      const pending = prisma.$transaction(tx => pp(tx, e.productId)).catch(err => { purgeErr = String((err as Error).message) }).finally(() => { finished = true })
      const waited = await blocked(holder, () => finished)
      let holderErr = ''
      try { await holder.query(`SET LOCAL statement_timeout = '5s'`); await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cravings:${T.id}`]) }
      catch (err) { holderErr = String((err as Error).message) }
      await holder.query(holderErr ? 'ROLLBACK' : 'COMMIT')
      await pending
      const kept = await prisma.$queryRaw<{ source_session_id: number | null }[]>`SELECT source_session_id FROM bookmarks WHERE user_id = ${T.id} AND wine_id = ${b}`
      check('(38c) an orphaned bottle\'s matured save: the purge waited for its moment, no deadlock, the craving keeps that moment',
        waited && !holderErr && !purgeErr && kept.length === 1 && kept[0].source_session_id === sid, { waited, holderErr, purgeErr, kept })
    } finally { await holder.end() }
  }
  // (38d) Codex r2: an old instance's craving (no stored link) of a target
  // bottle: its owner is serialised with the purge too.
  {
    const { H, T, code } = await moment()
    const e = await entry('Purge old row')
    const b = await addBottle(code, as(H), e)
    await prisma.$executeRaw`INSERT INTO bookmarks (user_id, wine_id, source_session_id) VALUES (${T.id}, ${b}, ${await sessionIdOf(code)})`
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cravings:${T.id}`])
      let purgeErr = ''
      let finished = false
      const pending = prisma.$transaction(tx => pp(tx, e.productId)).catch(err => { purgeErr = String((err as Error).message) }).finally(() => { finished = true })
      const waited = await blocked(holder, () => finished)
      await holder.query('COMMIT')
      await pending
      check('(38d) the owner of an old instance\'s craving of a target bottle: the purge waits for their craving lock, then goes through', waited && !purgeErr, { waited, purgeErr })
    } finally { await holder.end() }
  }
  // (38e) a matured save whose live moment the purge does not hold: refused,
  // nothing written (the purge throws PurgeRaced and rolls back).
  {
    const { H, T, code } = await moment({ blind: true })
    const e = await entry('Purge raced')
    const b = await addBottle(code, as(H), e)
    await crave(code, T, b)
    await reveal(code, as(H), b)
    const cr = await import('../../lib/cravings.ts') as Record<string, unknown>
    const convert = cr.maturedSavesToCravings as (tx: unknown, w: string[], m: number[]) => Promise<boolean>
    const out = await prisma.$transaction(tx => convert(tx, [b], []))
    check('(38e) a save in a moment the purge does not hold: refused, nothing written', out === false && (await rowsOf(T)).length === 0 && ((await markersOf(T)) ?? []).length === 1, { out, rows: await rowsOf(T) })
    check('(38e) …and the purge itself exports the refusal (PurgeRaced)', typeof catalogWrite.PurgeRaced === 'function')
  }
}

// ── § 32 A blind save from a redacted post follows the post rule too ────────
async function blindFromPost() {
  section('§ 32 a blind save made from a redacted post: once revealed, its photo reaches only viewers who may see that post')
  const { H, code } = await moment({ blind: true })
  const U = await mkUser('Una Blind')
  const V = await mkUser('Val Sees')
  const X = await mkUser('Xan Shut')
  await follow(U, H)
  const e = await entry('Blind from post')
  const b = await addBottle(code, as(H), e)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${`https://s3.example/wines/${TAG}-bp.jpg`} WHERE id = ${b}`
  await rate(code, as(H), b)
  const post = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM feed_items WHERE user_id = ${H.id} AND kind = 'session' ORDER BY id DESC LIMIT 1`)[0].id
  const r = await cravePost(U, post, b)
  check('(32a) a blind save (the post\'s bottle is "Wine N" for U), remembering the post', JSON.stringify(r.json) === SAVED && ((await markersOf(U)) ?? [])[0]?.item_id === post)
  await reveal(code, as(H), b)
  await call(blocksRoute.POST, 'POST', `/api/me/blocks/${X.pid}`, as(H), {}, { id: X.pid })
  const seen = (await cravingsOf(U, V))[0]
  const shut = (await cravingsOf(U, X))[0]
  check('(32b) revealed: a viewer who may see the post gets the photo and bottle', seen?.wineId === b && seen?.imageUrl?.includes(`${TAG}-bp`) === true, seen)
  check('(32b) …one the author blocks gets neither', shut?.name === e.name && shut.imageUrl === null && !('wineId' in shut), shut)
}

// ── § 33 Paging over cravings and blind saves at one instant ────────────────
async function paging() {
  section('§ 33 the Cravings cursor pages over real cravings and matured blind saves sharing one saved_at, none lost or repeated')
  const { H, T, code } = await moment()
  const ids: string[] = []
  for (let i = 0; i < 35; i++) ids.push(await addBottle(code, as(H), await entry(`Page ${i}`)))
  for (const [i, b] of ids.entries()) {
    if (i % 2) await prisma.$executeRaw`INSERT INTO blind_saves (user_id, wine_id, session_id) VALUES (${T.id}, ${b}, ${await sessionIdOf(code)})`
    else await crave(code, T, b)
  }
  const at = new Date(Date.now() - 60_000)
  await prisma.$executeRaw`UPDATE bookmarks SET saved_at = ${at} WHERE user_id = ${T.id}`
  await prisma.$executeRaw`UPDATE blind_saves SET saved_at = ${at} WHERE user_id = ${T.id}`
  const first = await call(cravingsRoute.GET, 'GET', `/api/users/${T.pid}/cravings`, as(T), undefined, { id: T.pid })
  const p1 = (first.json?.items as CravingRow[]) ?? []
  const cursor = first.json?.nextCursor as string | null
  const second = cursor ? await call(cravingsRoute.GET, 'GET', `/api/users/${T.pid}/cravings?cursor=${encodeURIComponent(cursor)}`, as(T), undefined, { id: T.pid }) : null
  const p2 = (second?.json?.items as CravingRow[]) ?? []
  const keys = [...p1, ...p2].map(x => x.key)
  check('(33a) 30 + 5 rows, every key once, both kinds present', p1.length === 30 && p2.length === 5 && new Set(keys).size === 35
    && keys.some(k => k?.startsWith('m')) && keys.some(k => /^\d+$/.test(String(k))), [p1.length, p2.length, new Set(keys).size])
  check('(33a) …and the count agrees', (await countFor(T, T)) === 35)
}

const SECTIONS: [string, () => Promise<void>][] = [
  ['basics', basics], ['unlinked', unlinked], ['blind', blindSave], ['second', secondBottle], ['repoint', repoint],
  ['delete', deletes], ['orphan', orphaned], ['sourceless', sourceless], ['old-delete', oldDelete], ['feed', feedSection], ['craving-post-link', cravingPostLink],
  ['removal', removal], ['relink', relink], ['modes', modes], ['cohost', cohost], ['nonalc', nonalc], ['d8', d8],
  ['purge', purge], ['merges', merges], ['saved', savedShape], ['row', rowShape],
  ['two-bottles', twoBottles], ['no-id', noId], ['no-code', noCode], ['post-photo', postPhoto], ['legacy', legacy],
  ['matured-delete', maturedDelete], ['budget', budget], ['tile-pin', tilePin], ['wipe-orphan', wipeOrphan],
  ['lock-order', lockOrder], ['own-view', ownView], ['blind-from-post', blindFromPost], ['paging', paging],
  ['deleted-moment', deletedMoment], ['old-instance', oldInstanceRow],
  ['merged-year', mergedYear], ['purge-saves', purgeSaves], ['purge-locks', purgeLocks],
]
for (const [name, fn] of SECTIONS) {
  if (ONLY && name !== ONLY) continue
  try { await fn() } catch (err) { failed++; console.log(`  ❌ § ${name} threw — ${(err as Error).stack?.split('\n').slice(0, 3).join(' | ')}`) }
}
console.log(`\n${pass} passed, ${failed} failed`)
await prisma.$disconnect()
await redis.quit()
process.exit(failed ? 1 : 0)
