// Rating saves (tasting feedback 2026-11-25; docs/dev/rating-saves.md, the
// build prompt § 1b, § 2, § 3): merge saves, an emptied merge reaping a stored
// row (else `unchanged`); the version check
// (`rating_versions`, 409 `{ stale, rating, version, lastOpId }`) and every
// writer that bumps or copies it; the 503 for a signed-in save while a moment's
// promotion fails (guests unchanged); `v` on the caller's own rows only; the
// committed answer before the background refresh; counters and the
// rating-action XP ONCE per rating, the take-back on the owner's own clear on
// its three paths; the migration's backfill run verbatim over rows written the
// old way; the save limit.
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only (refuses the dev db `verre`).
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/rating-saves-integration.mts [--only <section>]
import { toWire, fromWire, wireParams } from './lib/wireIds.mts'
import { fixtureUsername } from './lib/fixtureUsername.mjs'
import { mintEntry, pick } from './lib/catalogFixture.mts'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { prisma } from '../../lib/prisma.ts'
import { redis, k, scanKeys, touchHooks, hideCarousel } from '../../lib/redis.ts'
import { mutationHooks } from '../../lib/sessionMutation.ts'
import { settleAfterCommit } from '../../lib/afterCommit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: pathToFileURL(pjoin(HERE, 'stubs', 'nextauth-anonymous.mts')).href, shortCircuit: true }
    return next(specifier, context)
  },
})

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
const resetRoute = await import('../../app/api/session/[code]/rate/[wineId]/route.ts')
const codeRoute = await import('../../app/api/session/[code]/route.ts')
const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
const leaveRoute = await import('../../app/api/session/[code]/leave/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const badgesRoute = await import('../../app/api/me/badges/route.ts') as Record<string, unknown>
const { ensureBadgesSeedOnce } = await import('../../lib/badgeService.ts')
const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
type Actor = { cookie?: string; anon?: string }
const BASE = 'http://localhost:3000'
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
type Res = { status: number; json: Record<string, unknown>; headers: Headers }
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (actor.cookie) headers.cookie = actor.cookie
  if (actor.anon) headers['x-vr-anon-token'] = actor.anon
  const req = new NextRequest(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(await toWire(body)) })
  const res = await (handler as Handler)(req, { params: Promise.resolve(await wireParams(params)) })
  const text = await res.text()
  let json: unknown = null
  try { json = await fromWire(JSON.parse(text)) } catch {}
  return { status: res.status, json: (json ?? {}) as Record<string, unknown>, headers: res.headers }
}
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (name: string, title: string) => { if (ONLY && ONLY !== name) return false; console.log(`\n${title}`); return true }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const TAG = `rsv-${Date.now()}`
const resetLimits = async () => { const ks = await scanKeys('rl:*'); if (ks.length) await redis.del(ks) }
type User = { id: number; cookie: string }
let userSeq = 0
async function mkUser(name: string, opts: { earned?: boolean } = {}): Promise<User> {
  await resetLimits()
  const email = `${TAG}-${++userSeq}@example.test`
  const { headers } = await betterAuthServer.api.signUpEmail({ body: { name, email, password: `pw-${TAG}-${userSeq}`, username: fixtureUsername() } as never, returnHeaders: true })
  const cookie = (headers.get('set-cookie') ?? '').split(';')[0]
  const row = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  // Every badge already EARNED: the background evaluation awards nothing, so
  // the XP deltas below are exactly the rating-action XP.
  if (opts.earned !== false) {
    await ensureBadgesSeedOnce()
    await prisma.$executeRaw`INSERT INTO user_badges (user_id, badge_id, seen) SELECT ${row.id}, id, true FROM badges ON CONFLICT DO NOTHING`
  }
  return { id: row.id, cookie }
}
const as = (u: User): Actor => ({ cookie: u.cookie })
const dateFrom = new Date(Date.now() + 3600_000).toISOString()
async function createSession(actor: Actor): Promise<{ code: string; anon?: string }> {
  await resetLimits()
  const r = await call(sessionRoute.POST, 'POST', '/api/session', actor, { hostDisplayName: 'Hana Host', sessionName: `${TAG} moment`, dateFrom })
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
  return { code: r.json.code as string, anon: r.json.anonToken as string | undefined }
}
const join = async (code: string, actor: Actor, displayName: string) => { await resetLimits(); return call(joinRoute.POST, 'POST', '/api/session/join', actor, { code, displayName }) }
const visit = (code: string, actor: Actor) => call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, actor, {}, { code })
let seq = 0
async function addBottle(code: string, actor: Actor): Promise<string> {
  const e = await mintEntry({ producer: `${TAG} Producer ${++seq}`, name: `${TAG} Wine ${seq}`, colour: 'red', year: 2019 })
  const id = nanoid()
  const r = await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, { id, ...pick(e) }, { code })
  if (r.status !== 200) throw new Error(`add failed ${r.status} ${JSON.stringify(r.json)}`)
  return id
}
const rawRate = (code: string, actor: Actor, body: Record<string, unknown>) => call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, body, { code })
// The app's merge save: the given fields, a fresh op id, the CURRENT version
// unless a base is given.
async function merge(code: string, u: User, wineId: string, fields: Record<string, unknown>, o: { opId?: string; base?: number } = {}) {
  const base = o.base ?? (await versionOf(u, wineId)).version
  return rawRate(code, as(u), { wineId, merge: true, opId: o.opId ?? randomUUID(), baseVersion: base, ...fields })
}
// The web's full save (no op id, no base).
const full = (code: string, u: User, wineId: string, fields: Record<string, unknown>) =>
  rawRate(code, as(u), { wineId, score: 0, flavors: {}, notes: '', ...fields })
const reset = (code: string, actor: Actor, wineId: string) => call(resetRoute.DELETE, 'DELETE', `/api/session/${code}/rate/${wineId}`, actor, {}, { code, wineId })
const state = (code: string, actor: Actor) => call(stateRoute.GET, 'GET', `/api/session/${code}/state`, actor, undefined, { code })
async function versionOf(u: User, wineId: string): Promise<{ version: number; lastOpId: string | null }> {
  const r = await prisma.$queryRaw<{ version: number; last_op_id: string | null }[]>`SELECT version, last_op_id::text AS last_op_id FROM rating_versions WHERE user_id = ${u.id} AND wine_id = ${wineId}`
  return r[0] ? { version: Number(r[0].version), lastOpId: r[0].last_op_id } : { version: 0, lastOpId: null }
}
type Row = { id: number; score: number | null; flavors: Record<string, number>; aromas: unknown[]; notes: string | null; five_star_counted: boolean; one_star_counted: boolean; note_counted: boolean; rating_action_xp: number; at: Date }
async function rowOf(u: User, code: string, wineId: string): Promise<Row | null> {
  const r = await prisma.$queryRaw<Row[]>`
    SELECT r.id, r.score::float AS score, r.flavors, r.aromas, r.notes, r.five_star_counted, r.one_star_counted, r.note_counted, r.rating_action_xp, COALESCE(r.mirror_at, r.rated_at) AS at
      FROM ratings r JOIN sessions s ON s.id = r.session_id WHERE s.code = ${code} AND r.user_id = ${u.id} AND r.wine_id = ${wineId}`
  return r[0] ?? null
}
type Stats = { xp: number; ratings: number; five: number; one: number; notes: number; joined: number }
async function statsOf(u: User): Promise<Stats> {
  const r = await prisma.$queryRaw<Stats[]>`
    SELECT xp, lifetime_ratings AS ratings, lifetime_five_star AS five, lifetime_one_star AS one, lifetime_notes_written AS notes, lifetime_sessions_joined AS joined
      FROM users WHERE id = ${u.id}`
  return r[0]
}
const keyOf = async (code: string, u: User, wineId: string) => {
  const raw = await redis.get(k.rating(code, `u:${u.id}`, wineId))
  return raw ? JSON.parse(raw) as Record<string, unknown> : null
}
const sessionIdOf = async (code: string) => (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0]?.id ?? null
const feedItemOf = async (u: User, code: string) => (await prisma.$queryRaw<{ id: number }[]>`
  SELECT f.id FROM feed_items f JOIN sessions s ON s.id = f.session_id WHERE f.user_id = ${u.id} AND s.code = ${code} AND f.kind = 'session'`)[0]?.id ?? null
const memberOf = async (u: User, code: string) => (await prisma.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM session_members WHERE user_id = ${u.id} AND session_code = ${code}`).length > 0
const postEdit = (u: User, itemId: number, body: Record<string, unknown>) =>
  call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${itemId}`, as(u), body, { id: String(itemId) })
// A Postgres-backed moment: host H, taster T, one bottle each call of `bottle()`.
async function moment() {
  const H = await mkUser('Hana Host')
  const { code } = await createSession(as(H))
  await visit(code, as(H))
  const T = await mkUser('Tess Taster')
  await join(code, as(T), 'Tess')
  await visit(code, as(T))
  return { H, T, code, bottle: () => addBottle(code, as(H)) }
}
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' && !(v instanceof Date)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v
// Key order does not matter (jsonb stores its own order).
const deepEq = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const STRUCT = { sweet: 0, acid: 0, aroma: 0, flavour: 0, funk: 0, tannin: 3, body: 0, finish: 0 }

try {
  // ── § 1 merge saves ───────────────────────────────────────────────────────
  if (section('merge', '§ 1 merge saves: omitted fields kept, an emptied merge reaps a row (else `unchanged`), the canonical answer')) {
    const { T, code, bottle } = await moment()
    const w = await bottle()
    const r1 = await merge(code, T, w, { score: 4, flavors: { tannin: 3 }, aromas: [{ a: 'fruity', m: null }], notes: 'dark cherry' })
    check('a merge on a wine with no rating inserts (defaults for the rest) and answers { ok, rating } with v', r1.status === 200 && r1.json.ok === true && (r1.json.rating as Record<string, unknown>)?.v === 1, r1.json)
    const r2 = await merge(code, T, w, { notes: 'dark cherry, long' })
    const row = await rowOf(T, code, w)
    check('a merge of `notes` keeps the stored score, structure and aromas', row?.score === 4 && deepEq(row.flavors, STRUCT) && deepEq(row.aromas, [{ a: 'fruity', m: null }]) && row.notes === 'dark cherry, long', row)
    const rating = r2.json.rating as Record<string, unknown>
    check('the answer\'s canonical rating equals the stored row (score, flavors, aromas, notes, at) and v = 2', rating && rating.score === 4 && deepEq(rating.flavors, STRUCT) && deepEq(rating.aromas, row!.aromas) && rating.notes === 'dark cherry, long'
      && rating.at === row!.at.getTime() && rating.v === 2, { rating, row })
    check('…and equals the rating key (with `v`)', deepEq(await keyOf(code, T, w), rating), await keyOf(code, T, w))
    const w2 = await bottle()
    const r3 = await merge(code, T, w2, { flavors: { tannin: 2 } })
    const row3 = await rowOf(T, code, w2)
    check('a structure-only merge on a new wine inserts score 0, no aromas, no note', r3.status === 200 && row3?.score === 0 && deepEq(row3.aromas, []) && row3.notes === null && row3.flavors.tannin === 2, row3)
    check('a note is scrubbed (trimmed) before it is stored and answered', (await merge(code, T, w2, { notes: '  dry ' })).json.rating && (await rowOf(T, code, w2))?.notes === 'dry')

    // 🔒 An EMPTIED merge over a stored row REAPS it like the full empty save
    // (Simon, 2026-11-26: "0 should store 0, so that means delete rating"; the
    // server decides): the cascade, the take-back of its own XP, the version
    // bump, the key DEL; answered { ok, cleared, version }.
    const w3 = await bottle()
    await merge(code, T, w3, { score: 3 })
    const s0 = await statsOf(T)
    const v0 = await versionOf(T, w3)
    const reapOp = randomUUID()
    // The Redis lease is decided before the row is read (every SUPPLIED field
    // empty-valued): ONE attempt; without it the key DEL re-runs the contract.
    let attempts = 0
    mutationHooks.at = async (point, c, label) => { if (point === 'beforeLock' && c === code && label === 'rate') attempts++ }
    const reaped = await merge(code, T, w3, { score: 0 }, { opId: reapOp })
    mutationHooks.at = async () => {}
    check('an emptied merge on an existing row reaps: { ok: true, cleared: true, version }', reaped.status === 200 && deepEq(reaped.json, { ok: true, cleared: true, version: v0.version + 1 }), reaped.json)
    check('…in ONE attempt: the lease was taken up front (no re-run for the key DEL)', attempts === 1, attempts)
    check('…the row and the rating key gone, the version bumped once with the op as lastOpId', !(await rowOf(T, code, w3)) && !(await keyOf(code, T, w3)) && deepEq(await versionOf(T, w3), { version: v0.version + 1, lastOpId: reapOp }), await versionOf(T, w3))
    const s1 = await statsOf(T)
    check('…its own rating XP taken back (+10 → 0), counters kept', s1.xp === s0.xp - 10 && s1.ratings === s0.ratings, { s0, s1 })
    const resent = await merge(code, T, w3, { score: 0 }, { opId: reapOp, base: v0.version })
    check('…the same op re-sent (its answer lost): 409 stale, rating null, lastOpId = the op (the app\'s success)', resent.status === 409 && resent.json.rating === null && resent.json.lastOpId === reapOp && resent.json.version === v0.version + 1, resent.json)
    // The version check holds for an emptied merge.
    await merge(code, T, w3, { score: 2 })
    const vS = await versionOf(T, w3)
    const sS = await statsOf(T)
    const stale = await merge(code, T, w3, { score: 0 }, { base: vS.version - 1 })
    check('an emptied merge on a stale base: 409 stale with the current rating, nothing deleted', stale.status === 409 && stale.json.stale === true && (stale.json.rating as Record<string, unknown>)?.score === 2
      && (await rowOf(T, code, w3))?.score === 2 && (await versionOf(T, w3)).version === vS.version && deepEq(await statsOf(T), sS), [stale.status, stale.json])
    // Emptying only the score keeps a stored note: the merged result is not empty.
    const w7 = await bottle()
    await merge(code, T, w7, { score: 4, notes: 'keep me' })
    const kept = await merge(code, T, w7, { score: 0 })
    check('a merge that empties only the score: score 0 stored, the note kept, answered { ok, rating }', kept.status === 200 && (kept.json.rating as Record<string, unknown>)?.score === 0
      && (await rowOf(T, code, w7))?.score === 0 && (await rowOf(T, code, w7))?.notes === 'keep me', [kept.json, await rowOf(T, code, w7)])

    // An emptied merge with NO row writes nothing: no counters, no XP, no member
    // row, no carousel unhide, no last-seen bump, no badges, no version row.
    // T stays admitted as a rating author without a member row from here on.
    await prisma.$executeRaw`DELETE FROM session_members WHERE user_id = ${T.id} AND session_code = ${code}`
    await hideCarousel(T.id, code)
    await redis.hDel(k.lastSeen(code), String(T.id))
    const before = await statsOf(T)
    const badgesBefore = await prisma.userBadge.count({ where: { userId: T.id } })
    const w4 = await bottle()
    const empty = await merge(code, T, w4, { score: 0 })
    await pause(300)
    check('an emptied merge with no row answers { ok: true, unchanged: true }', empty.status === 200 && deepEq(empty.json, { ok: true, unchanged: true }), empty.json)
    check('…nothing inserted, no version row', !(await rowOf(T, code, w4)) && (await versionOf(T, w4)).version === 0)
    check('…no counters, no XP, no member row (lifetime_sessions_joined untouched)', deepEq(await statsOf(T), before) && !(await memberOf(T, code)), { before, after: await statsOf(T) })
    check('…the carousel stays hidden, no last-seen bump, no badge rows', await redis.sIsMember(k.carouselHidden(T.id), code) && !(await redis.hExists(k.lastSeen(code), String(T.id)))
      && (await prisma.userBadge.count({ where: { userId: T.id } })) === badgesBefore)
    const empty2 = await merge(code, T, w4, { notes: '   ' })
    check('a merge of a blank note on a wine with no rating: unchanged, nothing inserted, no version row', deepEq(empty2.json, { ok: true, unchanged: true }) && !(await rowOf(T, code, w4)) && (await versionOf(T, w4)).version === 0)
    await merge(code, T, w3, { notes: 'back' })
    check('a full EMPTY save still reaps (the web and the app\'s Clear), answered { ok: true } as before', deepEq((await full(code, T, w3, {})).json, { ok: true }) && !(await rowOf(T, code, w3)))
    // A FULL save's note is scrubbed too (ruled 2026-11-26): a whitespace-only
    // note is no note, so score 0 with only spaces reaps. And the rating key
    // never seeds a signed-in rater's NEW row.
    const w5 = await bottle()
    const wd = await full(code, T, w5, { score: 3, notes: ' dry \u0000' })
    check('a full save scrubs its note (trimmed, a NUL byte stripped, no 500)', wd.status === 200 && (await rowOf(T, code, w5))?.notes === 'dry', [wd.status, await rowOf(T, code, w5)])
    const ws = await full(code, T, w5, { notes: '  ' })
    check('a full save of score 0 with a whitespace-only note reaps the rating', ws.status === 200 && !(await rowOf(T, code, w5)), [ws.status, await rowOf(T, code, w5)])
    const w6 = await bottle()
    await redis.set(k.rating(code, `u:${T.id}`, w6), JSON.stringify({ score: 3, flavors: {}, aromas: [{ a: 'fruity', m: null }], notes: '', at: Date.now() }), { EX: 3600 })
    await full(code, T, w6, { score: 2 })
    check('a signed-in full save, aromas omitted, on a NEW row: no aromas (a key without a row is not read)', deepEq((await rowOf(T, code, w6))?.aromas, []), await rowOf(T, code, w6))
    // Malformed merges.
    const bad = await Promise.all([
      rawRate(code, as(T), { wineId: w, merge: true, notes: 'x', baseVersion: 0 }),
      rawRate(code, as(T), { wineId: w, merge: true, notes: 'x', opId: randomUUID() }),
      rawRate(code, as(T), { wineId: w, merge: true, notes: 'x', opId: nanoid(), baseVersion: 0 }),
      rawRate(code, as(T), { wineId: w, merge: true, opId: randomUUID(), baseVersion: 0 }),
      rawRate(code, as(T), { wineId: w, merge: true, notes: 'x', opId: randomUUID(), baseVersion: -1 }),
      rawRate(code, as(T), { wineId: w, merge: 'yes', notes: 'x' }),
    ])
    check('400: a merge without opId / baseVersion, a 21-character client id as opId, no field, a negative base, a non-boolean merge', bad.every(r => r.status === 400), bad.map(r => r.status))
  }

  // ── § 1b the wrong-account guard ──────────────────────────────────────────
  if (section('viewer', '§ 1b the wrong-account guard: `viewer` not the caller → 409, nothing written')) {
    const { H, T, code, bottle } = await moment()
    const w = await bottle()
    await merge(code, T, w, { score: 3, notes: 'mine' })
    const snap = async () => ({ row: await rowOf(T, code, w), v: await versionOf(T, w), key: await keyOf(code, T, w), stats: await statsOf(T) })
    const before = await snap()
    // call() sends `u:<int>` as the wire form `u:<publicId>`: H is another account.
    const wrong = await merge(code, T, w, { score: 5, viewer: `u:${H.id}` })
    const wrongClear = await full(code, T, w, { viewer: `u:${H.id}` })
    const unknown = await merge(code, T, w, { score: 5, viewer: 'u:ZZZZZZZZZZZZ' })
    check('a merge, a Clear and an unknown account as `viewer` → 409 { wrongViewer: true }, private, no-store',
      [wrong, wrongClear, unknown].every(r => r.status === 409 && deepEq(r.json, { wrongViewer: true }) && r.headers.get('cache-control') === 'private, no-store'), [wrong, wrongClear, unknown].map(r => [r.status, r.json]))
    check('…nothing written: the row, the version, the key and the counters unchanged', deepEq(await snap(), before), { before, after: await snap() })
    const right = await merge(code, T, w, { score: 4, viewer: `u:${T.id}` })
    check('the caller\'s own `viewer` → saves', right.status === 200 && (await rowOf(T, code, w))?.score === 4, right.json)
    const pid = (await prisma.$queryRaw<{ public_id: string }[]>`SELECT public_id FROM users WHERE id = ${T.id}`)[0].public_id
    const lower = await merge(code, T, w, { score: 4.5, viewer: `u:${pid.toLowerCase()}` })
    check('…also in lower case (a public id is case-insensitive)', lower.status === 200 && (await rowOf(T, code, w))?.score === 4.5, lower.json)
    const absent = await full(code, T, w, { score: 2 })
    check('absent (the web, old binaries): no check, saves', absent.status === 200 && (await rowOf(T, code, w))?.score === 2, absent.json)
    const malformed = await Promise.all(['not-an-identity', 'u:', `u:${pid}X`, 42, null, {}].map(viewer => merge(code, T, w, { score: 1, viewer })))
    check('a malformed `viewer` → 400, nothing written', malformed.every(r => r.status === 400) && (await rowOf(T, code, w))?.score === 2, malformed.map(r => r.status))
    const g = await join(code, {}, 'Gus Guest')
    const gTok = g.json.anonToken as string
    const gOwn = await rawRate(code, { anon: gTok }, { wineId: w, score: 3, flavors: {}, notes: '', viewer: g.json.id })
    const gWrong = await rawRate(code, { anon: gTok }, { wineId: w, score: 1, flavors: {}, notes: '', viewer: `u:${T.id}` })
    check('a guest: its own `a:` id saves, an account → 409', gOwn.status === 200 && gWrong.status === 409 && deepEq(gWrong.json, { wrongViewer: true }), [gOwn.status, gWrong.status, g.json.id])
  }

  // ── § 2 the version check ─────────────────────────────────────────────────
  if (section('version', '§ 2 the version check: 409 stale, lastOpId, the held op, the writers')) {
    const { H, T, code, bottle } = await moment()
    const w = await bottle()
    await merge(code, T, w, { score: 3 })
    const v1 = await versionOf(T, w)
    const ok = await merge(code, T, w, { score: 3.5 }, { base: v1.version })
    check('a merge on the current version commits and bumps it (+1)', ok.status === 200 && (await versionOf(T, w)).version === v1.version + 1)
    // A stale base: nothing written.
    const wS = await bottle()
    await prisma.$executeRaw`DELETE FROM session_members WHERE user_id = ${T.id} AND session_code = ${code}`
    const before = await statsOf(T)
    const stale = await merge(code, T, wS, { score: 5, notes: 'a long enough note' }, { base: 4 })
    check('a stale base → 409 { stale: true, rating: null, version: 0, lastOpId: null }', stale.status === 409 && deepEq(stale.json, { stale: true, rating: null, version: 0, lastOpId: null }), stale.json)
    check('…nothing written: no row, no counters, no XP, no feed item change, no member row, no key, no version row',
      !(await rowOf(T, code, wS)) && deepEq(await statsOf(T), before) && !(await memberOf(T, code)) && !(await keyOf(code, T, wS)) && (await versionOf(T, wS)).version === 0)
    // A re-sent op that had committed: 409 with its OWN lastOpId.
    const opA = randomUUID()
    const vA = (await versionOf(T, w)).version
    const a1 = await merge(code, T, w, { notes: 'resent' }, { opId: opA, base: vA })
    const a2 = await merge(code, T, w, { notes: 'resent' }, { opId: opA, base: vA })
    check('a re-sent committed op → 409 carrying its own lastOpId, the current version and the canonical rating',
      a1.status === 200 && a2.status === 409 && a2.json.lastOpId === opA && a2.json.version === vA + 1 && (a2.json.rating as Record<string, unknown>)?.notes === 'resent' && (a2.json.rating as Record<string, unknown>)?.v === vA + 1, a2.json)
    // Hold A before the lock, re-send A and commit, commit B, release A.
    const vH = (await versionOf(T, w)).version
    const opH = randomUUID()
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inHold = new Promise<void>(r => { entered = r })
    let armed = true
    mutationHooks.at = async (point, c, label) => {
      if (armed && point === 'beforeLock' && c === code && label === 'rate') { armed = false; entered(); await held }
    }
    const pA = merge(code, T, w, { score: 1 }, { opId: opH, base: vH })
    await inHold
    const reA = await merge(code, T, w, { score: 1 }, { opId: opH, base: vH })
    const opB = randomUUID()
    const B = await merge(code, T, w, { score: 4.5 }, { opId: opB, base: vH + 1 })
    release()
    const lateA = await pA
    mutationHooks.at = async () => {}
    check('hold A before the lock; A re-sent commits; B commits on it; A released → 409 (lastOpId = B\'s), B remains',
      reA.status === 200 && B.status === 200 && lateA.status === 409 && lateA.json.lastOpId === opB && (await rowOf(T, code, w))?.score === 4.5, { reA: reA.status, B: B.status, lateA: lateA.json })
    // rate → Clear → the stalled first save (base 0) is refused.
    const wC = await bottle()
    const op1 = randomUUID()
    const xp0 = (await statsOf(T)).xp
    await merge(code, T, wC, { score: 4 }, { opId: op1, base: 0 })
    const clearOp = randomUUID()
    const cl = await rawRate(code, as(T), { wineId: wC, score: 0, flavors: {}, notes: '', opId: clearOp, baseVersion: 1 })
    const stalled = await merge(code, T, wC, { score: 4 }, { opId: op1, base: 0 })
    check('rate → Clear → the stalled first save with base 0 → 409 (lastOpId = the Clear\'s, rating null): no resurrection, no XP',
      cl.status === 200 && stalled.status === 409 && stalled.json.lastOpId === clearOp && stalled.json.rating === null && stalled.json.version === 2
      && !(await rowOf(T, code, wC)) && (await statsOf(T)).xp === xp0, { cl: cl.json, stalled: stalled.json })
    const reClear = await rawRate(code, as(T), { wineId: wC, score: 0, flavors: {}, notes: '', opId: clearOp, baseVersion: 1 })
    check('…the Clear re-sent with its own op → 409 with its own lastOpId (the app\'s Clear success)', reClear.status === 409 && reClear.json.lastOpId === clearOp && reClear.json.rating === null)
    const reRate = await merge(code, T, wC, { score: 2 }, { base: 2 })
    check('a re-rate after the Clear on the 409\'s version commits (v 3)', reRate.status === 200 && (reRate.json.rating as Record<string, unknown>)?.v === 3)
    // A web save bumps; a phone save on the old version → 409.
    const vW = (await versionOf(T, w)).version
    await full(code, T, w, { score: 2, notes: 'web' })
    const phone = await merge(code, T, w, { notes: 'phone' }, { base: vW })
    check('a web save (no base) bumps; a phone save on the old version → 409 with the web\'s rating, lastOpId null',
      (await versionOf(T, w)).version === vW + 1 && phone.status === 409 && phone.json.lastOpId === null && (phone.json.rating as Record<string, unknown>)?.notes === 'web', phone.json)
    // The Reset bumps.
    const vR = (await versionOf(T, w)).version
    const rr = await reset(code, as(T), w)
    check('the web Reset bumps (and deletes the row and key)', rr.status === 200 && (await versionOf(T, w)).version === vR + 1 && !(await rowOf(T, code, w)) && !(await keyOf(code, T, w)))
    const rrNone = await reset(code, as(T), 'NoSuchBottle123')
    check('…a Reset of an id with no rating mints no version row', rrNone.status === 200 && (await versionOf(T, 'NoSuchBottle123')).version === 0)
    // A Reset that finds no row in THIS moment is version-neutral: the version
    // row is per (user, bottle id), and the id may name another moment's bottle.
    const wX = await bottle()
    await merge(code, T, wX, { score: 4 })
    const vX = (await versionOf(T, wX)).version
    const H2 = await mkUser('Olga Other')
    const { code: other } = await createSession(as(H2))
    await visit(other, as(H2))
    await join(other, as(T), 'Tess')
    await visit(other, as(T))
    const rx = await reset(other, as(T), wX)
    check('…a Reset of this bottle\'s id from ANOTHER moment: version unchanged, the rating here kept', rx.status === 200 && (await versionOf(T, wX)).version === vX && (await rowOf(T, code, wX))?.score === 4, [rx.status, vX, await versionOf(T, wX)])
    // A save rolled back AFTER its key write (the key is written inside the
    // transaction): the contract drops the key and invalidates, so the cache
    // never advertises a version SQL lacks (a phone would take it as its base).
    const wRb = await bottle()
    await merge(code, T, wRb, { score: 3 })
    const vRb = (await versionOf(T, wRb)).version
    mutationHooks.at = async (point, c, label) => { if (point === 'beforeCommit' && c === code && label === 'rate') throw new Error('injected: COMMIT fails') }
    const failed = await merge(code, T, wRb, { score: 4 }, { base: vRb })
    mutationHooks.at = async () => {}
    let stRb = await state(code, as(T))
    if (stRb.status === 503) { await pause(300); stRb = await state(code, as(T)) }
    const ownRb = (stRb.json.ratings as Record<string, { ratings: Record<string, Record<string, unknown>> }>)?.[`u:${T.id}`]?.ratings?.[wRb]
    check('a save rolled back after its key write: 500, and /state shows SQL\'s version and score, not v+1', failed.status === 500 && stRb.status === 200
      && (await versionOf(T, wRb)).version === vRb && ownRb?.v === vRb && ownRb?.score === 3, [failed.status, stRb.status, vRb, ownRb])
    const nextRb = await merge(code, T, wRb, { score: 4 }, { base: vRb })
    check('…and the next save on SQL\'s version commits', nextRb.status === 200 && (nextRb.json.rating as Record<string, unknown>)?.v === vRb + 1, nextRb.json)
    // The post edit bumps (live moment).
    const wP = await bottle()
    await merge(code, T, wP, { score: 3 })
    const item = await feedItemOf(T, code)
    const vP = (await versionOf(T, wP)).version
    const pe = await postEdit(T, item!, { wineId: wP, notes: 'from the feed' })
    check('the post edit bumps; the live key carries the new v', pe.status === 200 && (await versionOf(T, wP)).version === vP + 1 && (await keyOf(code, T, wP))?.v === vP + 1, pe.json)
    // A pre-release rating (a row, no version row) accepts base 0.
    const wL = await bottle()
    const sid = (await sessionIdOf(code))!
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at) VALUES (${wL}, ${T.id}, ${sid}, 'session', 'Tess', 3, '{}'::jsonb, '[]'::jsonb, 'old', NOW())`
    const legacy = await merge(code, T, wL, { notes: 'old, edited' }, { base: 0 })
    check('a pre-release rating (no version row) accepts base 0 and keeps its score', legacy.status === 200 && (legacy.json.rating as Record<string, unknown>)?.v === 1 && (await rowOf(T, code, wL))?.score === 3)
    // The bottle DELETE bumps every version row of the bottle.
    const wD = await bottle()
    await merge(code, T, wD, { score: 4 })
    await merge(code, H, wD, { score: 2 })
    const [vT, vHo] = [(await versionOf(T, wD)).version, (await versionOf(H, wD)).version]
    const del = await call(wineRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wD}`, as(H), undefined, { code, wineId: wD })
    check('the bottle DELETE bumps every rater\'s version (the rows outlive the bottle)', del.status === 200 && (await versionOf(T, wD)).version === vT + 1 && (await versionOf(H, wD)).version === vHo + 1)
    // A kick with delete bumps: a waited edit after the kick + rejoin → 409.
    const wK = await bottle()
    await merge(code, T, wK, { score: 4 })
    const vK = (await versionOf(T, wK)).version
    await resetLimits()
    const kick = await call(bansRoute.POST, 'POST', `/api/session/${code}/bans`, as(H), { identityId: `u:${T.id}`, mode: 'kick' }, { code })
    const leave = await call(leaveRoute.POST, 'POST', `/api/session/${code}/leave?cleanup=full`, as(T), {}, { code })
    await join(code, as(T), 'Tess')
    const waited = await merge(code, T, wK, { notes: 'waited offline' }, { base: vK })
    check('a kick + "delete my ratings" bumps the rater\'s versions; a waited edit after the rejoin → 409 rating null (no resurrection)',
      kick.status === 200 && leave.status === 200 && (await versionOf(T, wK)).version === vK + 1 && waited.status === 409 && waited.json.rating === null && !(await rowOf(T, code, wK)), { kick: kick.status, leave: leave.json, waited: waited.json })
    // `v` on the wire: the caller's own rows only.
    const wV = await bottle()
    await merge(code, T, wV, { score: 4 })
    await merge(code, H, wV, { score: 3 })
    const st = await state(code, as(T))
    const ratings = st.json.ratings as Record<string, { ratings: Record<string, Record<string, unknown>> }>
    check('🔒 /state: the caller\'s own row carries `v`, another participant\'s carries none',
      typeof ratings?.[`u:${T.id}`]?.ratings?.[wV]?.v === 'number' && ratings?.[`u:${H.id}`]?.ratings?.[wV] !== undefined && !('v' in ratings[`u:${H.id}`].ratings[wV]), ratings?.[`u:${H.id}`])
    // The rebuild restores `v` from rating_versions.
    await redis.del(k.rating(code, `u:${T.id}`, wV))
    await redis.del(k.meta(code))
    await state(code, as(T))
    check('the rebuild restores the key with `v` from rating_versions (LEFT JOIN)', (await keyOf(code, T, wV))?.v === (await versionOf(T, wV)).version)
  }

  // ── § 3 the bottle re-mint copies the versions ────────────────────────────
  if (section('remint', '§ 3 the re-mint (copyCachedLineup) copies the moved raters\' versions')) {
    const { H, T, code, bottle } = await moment()
    const w = await bottle()
    const other = await createSession(as(H))
    await visit(other.code, as(H))
    const foreign = await addBottle(other.code, as(H))
    const sid = (await sessionIdOf(code))!
    // An old rating of the foreign row under this moment (a skipped mirror of an
    // old release), with a version and a key; the cache lists the foreign id.
    await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at) VALUES (${foreign}, ${T.id}, ${sid}, 'session', 'Tess', 4, '{}'::jsonb, '[]'::jsonb, NULL, NOW())`
    await prisma.$executeRaw`INSERT INTO rating_versions (user_id, wine_id, version, last_op_id) VALUES (${T.id}, ${foreign}, 3, NULL)`
    await redis.set(k.rating(code, `u:${T.id}`, foreign), JSON.stringify({ score: 4, flavors: {}, aromas: [], notes: '', at: Date.now(), v: 3 }), { EX: 3600 })
    const cached = JSON.parse((await redis.get(k.wines(code)))!) as { id: string }[]
    const fw = JSON.parse((await redis.get(k.wines(other.code)))!) as { id: string }[]
    await redis.set(k.wines(code), JSON.stringify([...cached, fw.find(x => x.id === foreign)]), { KEEPTTL: true })
    await prisma.$executeRaw`UPDATE sessions SET lineup_revision = NULL WHERE id = ${sid}`
    const r = await merge(code, T, w, { score: 2 })
    const moved = await prisma.$queryRaw<{ wine_id: string }[]>`SELECT wine_id FROM ratings WHERE session_id = ${sid} AND user_id = ${T.id} AND score = 4`
    const newId = moved[0]?.wine_id
    check('a reconciling save re-mints the foreign id (its rating moves to a new id)', r.status === 200 && !!newId && newId !== foreign, { status: r.status, newId })
    check('…the version row is COPIED to the new id; the old id keeps its own (the fence)', !!newId && (await versionOf(T, newId)).version === 3 && (await versionOf(T, foreign)).version === 3)
    check('…and the copied key\'s `v` still matches', !!newId && (await keyOf(code, T, newId))?.v === 3)
  }

  // ── § 4 the 503 while the promotion fails ─────────────────────────────────
  if (section('promotion', '§ 4 a signed-in save or Reset with no record → 503, nothing written; guests unchanged')) {
    const guestHost = await createSession({})
    const code = guestHost.code
    const w = await addBottle(code, { anon: guestHost.anon })
    const U = await mkUser('Una Signed')
    await join(code, as(U), 'Una')
    const g = await join(code, {}, 'Gus Guest')
    const gTok = g.json.anonToken as string
    mutationHooks.at = async (_p, c, label) => { if (c === code && label === 'promote') throw new Error('injected: promotion fails') }
    const s1 = await merge(code, U, w, { score: 4 })
    const s2 = await full(code, U, w, { score: 4 })
    const s3 = await reset(code, as(U), w)
    check('the app\'s merge, the web\'s full save and the web\'s Reset → 503 + Retry-After: 5',
      [s1, s2, s3].every(r => r.status === 503 && r.headers.get('retry-after') === '5'), [s1, s2, s3].map(r => [r.status, r.headers.get('retry-after')]))
    check('…nothing written: no record, no key, no version row, no member row', (await sessionIdOf(code)) === null && !(await keyOf(code, U, w)) && (await versionOf(U, w)).version === 0 && !(await memberOf(U, code)))
    const gr = await rawRate(code, { anon: gTok }, { wineId: w, score: 3, flavors: {}, notes: 'guest' })
    const gKey = await redis.get(k.rating(code, g.json.id as string, w))
    check('a guest save in the same state → today\'s Redis-only write (no v)', gr.status === 200 && !!gKey && JSON.parse(gKey).score === 3 && !('v' in JSON.parse(gKey)), { status: gr.status, gKey })
    check('a guest merge → 400 (a merge needs a signed-in rater)', (await rawRate(code, { anon: gTok }, { wineId: w, merge: true, notes: 'x', opId: randomUUID(), baseVersion: 0 })).status === 400)
    mutationHooks.at = async () => {}
    const s4 = await merge(code, U, w, { score: 4 }, { base: 0 })
    check('once the promotion succeeds the same save commits (v 1)', s4.status === 200 && (s4.json.rating as Record<string, unknown>)?.v === 1 && (await sessionIdOf(code)) !== null)
    const cl = await rawRate(code, as(U), { wineId: w, score: 0, flavors: {}, notes: '', opId: randomUUID(), baseVersion: 1 })
    check('…a confirmed clear then leaves no key and no row', cl.status === 200 && !(await keyOf(code, U, w)) && !(await rowOf(U, code, w)))
    // A post-edit clear whose Redis delete failed + a note-only merge.
    const w2 = await addBottle(code, { anon: guestHost.anon })
    await merge(code, U, w2, { score: 4, notes: 'a lovely long note' })
    const staleKey = await redis.get(k.rating(code, `u:${U.id}`, w2))
    const item = await feedItemOf(U, code)
    await postEdit(U, item!, { wineId: w2, score: 0, notes: '' })
    await redis.set(k.rating(code, `u:${U.id}`, w2), staleKey!, { EX: 3600 })   // the delete "failed"
    const nm = await merge(code, U, w2, { notes: 'dry' }, { base: (await versionOf(U, w2)).version })
    const row = await rowOf(U, code, w2)
    check('a post-edit clear whose key survived + a note-only merge → a note-only rating, nothing resurrected', nm.status === 200 && row?.score === 0 && row.notes === 'dry' && (await keyOf(code, U, w2))?.score === 0, row)
  }

  // ── § 5 the committed answer before the background refresh ───────────────
  if (section('background', '§ 5 after COMMIT: the answer does not wait for the refresh')) {
    const { T, code, bottle } = await moment()
    const w = await bottle()
    touchHooks.afterRead = async (c) => { if (c === code) throw new Error('injected: refresh throws') }
    const m = await merge(code, T, w, { score: 4 })
    const cl = await rawRate(code, as(T), { wineId: w, score: 0, flavors: {}, notes: '', opId: randomUUID(), baseVersion: 1 })
    touchHooks.afterRead = async () => {}
    check('the refresh THROWS: a committed merge still answers { ok, rating }, a committed Clear { ok: true }', m.status === 200 && !!m.json.rating && cl.status === 200 && deepEq(cl.json, { ok: true }), [m.status, cl.status, cl.json])
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let reached = false, calls = 0
    touchHooks.afterRead = async (c) => { if (c === code) { reached = true; calls++; await held } }
    const t = Date.now()
    const m2 = await Promise.race([merge(code, T, w, { score: 3 }, { base: 2 }), pause(4000).then(() => null)])
    check('the refresh held PENDING: the committed answer arrives before it is released', !!m2 && m2.status === 200 && Date.now() - t < 4000, m2?.status)
    await pause(100)
    check('…(the refresh really was running and waiting)', reached)
    // Coalesced (lib/afterCommit.ts): a burst of saves while the moment's
    // refresh is in flight starts no second refresh, only ONE trailing run.
    const burst: number[] = []
    for (let i = 0; i < 4; i++) burst.push((await merge(code, T, w, { score: 1 + i }, { base: 3 + i })).status)
    await pause(100)
    check('a burst of 4 saves while the refresh runs: every save answered, no second refresh started', burst.every(st => st === 200) && calls === 1, [burst, calls])
    release()
    await settleAfterCommit()
    check('…and ONE trailing refresh after it, not four', calls === 2, calls)
    touchHooks.afterRead = async () => {}
  }

  // ── § 6 counters and XP once per rating ───────────────────────────────────
  if (section('xp', '§ 6 counters and XP ONCE per rating (badges already earned: exact deltas)')) {
    const { H, T, code, bottle } = await moment()
    const s0 = await statsOf(T)
    const w = await bottle()
    await merge(code, T, w, { score: 5 })
    await merge(code, T, w, { score: 4.75 })
    await merge(code, T, w, { score: 5 })
    const s = await statsOf(T)
    check('5 → 4.75 → 5: lifetime_ratings +1, five-star +1, XP +15 (10 + 5) once', s.ratings === s0.ratings + 1 && s.five === s0.five + 1 && s.xp === s0.xp + 15, { s0, s })
    check('…the row carries five_star_counted and rating_action_xp 15', (await rowOf(T, code, w))?.five_star_counted === true && (await rowOf(T, code, w))?.rating_action_xp === 15)
    const w1 = await bottle()
    await merge(code, T, w1, { score: 1 })
    await merge(code, T, w1, { score: 2 })
    await full(code, T, w1, { score: 1 })
    const s1 = await statsOf(T)
    check('1 → 2 → 1 (the last a web full save): one-star +1, XP +10 once', s1.one === s.one + 1 && s1.xp === s.xp + 10 && s1.ratings === s.ratings + 1, { s, s1 })
    const w2 = await bottle()
    await merge(code, T, w2, { score: 3, notes: 'abcdefg' })
    await merge(code, T, w2, { notes: 'abc' })
    await merge(code, T, w2, { notes: 'abcdefgh' })
    const s2 = await statsOf(T)
    check('note → shorten → lengthen: notes_written +1, XP +15 (10 + 5) once', s2.notes === s1.notes + 1 && s2.xp === s1.xp + 15, { s1, s2 })
    const w3 = await bottle()
    await merge(code, T, w3, { score: 3, notes: '🍷🍷🍷' })
    check('the note rule is char_length (code points): three emoji (6 UTF-16 units) do not count', (await rowOf(T, code, w3))?.note_counted === false && (await statsOf(T)).notes === s2.notes)
    const s3 = await statsOf(T)
    const wE = await bottle()
    await full(code, T, wE, {})
    check('a reaped save (a first empty POST: insert + reap) awards and debits nothing', deepEq(await statsOf(T), s3) && !(await rowOf(T, code, wE)))
    await pause(300)   // background badge evaluations
    check('no background award added XP (every badge already earned)', (await statsOf(T)).xp === s3.xp)

    // The take-back on each own-clear path.
    const wa = await bottle()
    await merge(code, T, wa, { score: 5, notes: 'a long enough note' })
    const sa = await statsOf(T)
    await full(code, T, wa, {})
    const sa2 = await statsOf(T)
    check('own clear #1 (the empty full save): XP back by exactly 20, counters and badges kept', sa2.xp === sa.xp - 20 && sa2.ratings === sa.ratings && sa2.five === sa.five && sa2.notes === sa.notes, { sa, sa2 })
    await full(code, T, wa, {})
    check('…a repeat after the committed clear debits 0', (await statsOf(T)).xp === sa2.xp)
    await merge(code, T, wa, { score: 3 }, { base: (await versionOf(T, wa)).version })
    check('…a re-rate earns +10 again (counters count again: named residual)', (await statsOf(T)).xp === sa2.xp + 10 && (await statsOf(T)).ratings === sa2.ratings + 1)
    const wb = await bottle()
    await merge(code, T, wb, { score: 5 })
    const sb = await statsOf(T)
    await reset(code, as(T), wb)
    check('own clear #2 (the web Reset): XP back by exactly 15', (await statsOf(T)).xp === sb.xp - 15)
    const wc = await bottle()
    await merge(code, T, wc, { score: 4, notes: 'feed note long' })
    const sc = await statsOf(T)
    const pe = await postEdit(T, (await feedItemOf(T, code))!, { wineId: wc, score: 0, notes: '' })
    check('own clear #3 (a moment rating emptied in the post edit): reaped, XP back by exactly 15', pe.status === 200 && pe.json.reaped === true && (await statsOf(T)).xp === sc.xp - 15, pe.json)
    const wf = await bottle()
    await merge(code, T, wf, { score: 5, notes: 'floor test note' })
    await prisma.$executeRaw`UPDATE users SET xp = 5 WHERE id = ${T.id}`
    await full(code, T, wf, {})
    check('the take-back never goes below 0 (xp 5, refund 20 → 0)', (await statsOf(T)).xp === 0)
    // A rolled-back attempt debits nothing.
    const wr = await bottle()
    await merge(code, T, wr, { score: 4 })
    const sr = await statsOf(T)
    mutationHooks.at = async (point, c, label) => { if (point === 'beforeCommit' && c === code && label === 'rate') throw new Error('injected: COMMIT fails') }
    const rb = await full(code, T, wr, {})
    mutationHooks.at = async () => {}
    check('a rolled-back clear debits nothing and keeps the row', rb.status === 500 && (await statsOf(T)).xp === sr.xp && !!(await rowOf(T, code, wr)), rb.status)
    // A host's bottle delete takes nothing.
    const wh = await bottle()
    await merge(code, T, wh, { score: 5 })
    const sh = await statsOf(T)
    await call(wineRoute.DELETE, 'DELETE', `/api/session/${code}/wines/${wh}`, as(H), undefined, { code, wineId: wh })
    check('a host\'s bottle DELETE takes no XP', (await statsOf(T)).xp === sh.xp && !(await rowOf(T, code, wh)))
    check('earned badges survive every clear', (await prisma.userBadge.count({ where: { userId: T.id } })) === (await prisma.badge.count()))
    // A removed person's own "Delete my ratings" (/leave?cleanup=full, the
    // wipe with its caller as the target) takes the rating XP back (ruled
    // 2026-11-26); a host's ban, which deletes the ratings too, does not.
    {
      const r = await moment()
      const wa = await r.bottle(), wb = await r.bottle()
      await merge(r.code, r.T, wa, { score: 5, notes: 'a long enough note' })
      await merge(r.code, r.T, wb, { score: 3 })
      const sum = (await prisma.$queryRaw<{ xp: number }[]>`SELECT COALESCE(SUM(rating_action_xp), 0)::int AS xp FROM ratings WHERE user_id = ${r.T.id}`)[0].xp
      const before = await statsOf(r.T)
      await resetLimits()
      const kick = await call(bansRoute.POST, 'POST', `/api/session/${r.code}/bans`, as(r.H), { identityId: `u:${r.T.id}`, mode: 'kick' }, { code: r.code })
      const kept = await statsOf(r.T)
      const leave = await call(leaveRoute.POST, 'POST', `/api/session/${r.code}/leave?cleanup=full`, as(r.T), {}, { code: r.code })
      const after = await statsOf(r.T)
      check('a host\'s kick (ratings kept) takes nothing; the person\'s own "Delete my ratings" then takes back exactly the sum (20 + 10)',
        kick.status === 200 && deepEq(kept, before) && leave.status === 200 && sum === 30 && after.xp === before.xp - 30 && !(await rowOf(r.T, r.code, wa)), { kick: kick.status, leave: [leave.status, leave.json], sum, before, after })
      check('…counters and badges never go down', after.ratings === before.ratings && after.five === before.five && after.notes === before.notes
        && (await prisma.userBadge.count({ where: { userId: r.T.id } })) === (await prisma.badge.count()), { before, after })
      const V = await mkUser('Vera Floor')
      await join(r.code, as(V), 'Vera')
      await visit(r.code, as(V))
      await merge(r.code, V, wa, { score: 5 })
      await prisma.$executeRaw`UPDATE users SET xp = 4 WHERE id = ${V.id}`
      await call(bansRoute.POST, 'POST', `/api/session/${r.code}/bans`, as(r.H), { identityId: `u:${V.id}`, mode: 'kick' }, { code: r.code })
      const vl = await call(leaveRoute.POST, 'POST', `/api/session/${r.code}/leave?cleanup=full`, as(V), {}, { code: r.code })
      check('…floored at 0 (xp 4, refund 15 → 0)', vl.status === 200 && (await statsOf(V)).xp === 0, [vl.status, await statsOf(V)])
      const U = await mkUser('Ulla Banned')
      await join(r.code, as(U), 'Ulla')
      await visit(r.code, as(U))
      await merge(r.code, U, wa, { score: 4, notes: 'another long note' })
      const ub = await statsOf(U)
      const ban = await call(bansRoute.POST, 'POST', `/api/session/${r.code}/bans`, as(r.H), { identityId: `u:${U.id}`, mode: 'ban' }, { code: r.code })
      check('a host\'s BAN (it deletes the ratings) takes no XP back', ban.status === 200 && !(await rowOf(U, r.code, wa)) && deepEq(await statsOf(U), ub), { ban: ban.status, ub, after: await statsOf(U) })
    }
  }

  // ── § 7 the soft-deleted moment's clear vs account deletion ───────────────
  if (section('deadlock', '§ 7 a clear in a soft-deleted moment racing account deletion (no deadlock)')) {
    // deleteAccountDurable: the deletion's durable part (its native-session
    // revoke runs BEFORE, so a request already past its sign-in check is the race).
    for (const order of ['clear first', 'interleaved', 'deletion first', 'concurrent'] as const) {
      const { H, T, code, bottle } = await moment()
      const w = await bottle()
      await merge(code, T, w, { score: 4, notes: 'soft deleted note' })
      const item = (await feedItemOf(T, code))!
      const del = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, as(H), undefined, { code })
      if (del.status !== 200) throw new Error(`soft delete failed ${del.status}`)
      const vBefore = (await versionOf(T, w)).version
      if (order === 'clear first') {
        // The deletion holds INSIDE its transaction before it locks the user
        // row; the clear runs to its end meanwhile.
        let release!: () => void
        const held = new Promise<void>(r => { release = r })
        let entered!: () => void
        const inHold = new Promise<void>(r => { entered = r })
        const pd = deleteAccountDurable(T.id, { hooks: { afterLocks: async () => { entered(); await held } } })
        await inHold
        const pe = await postEdit(T, item, { wineId: w, score: 0, notes: '' })
        const vAfter = (await versionOf(T, w)).version
        release()
        const d = await pd.then(() => 'ok', (e: Error) => e.message)
        check(`${order}: the post edit clears in the soft-deleted moment (its version bumped without the session lock), the deletion then completes`,
          pe.status === 200 && pe.json.reaped === true && vAfter === vBefore + 1 && d === 'ok', { pe: pe.json, vBefore, vAfter, d })
      } else if (order === 'interleaved') {
        // The interleaving that deadlocked with rating-then-user: the clear
        // holds the rating (blocked on its photo row, locked by a third
        // connection) while the deletion runs. With the user row locked FIRST
        // the deletion waits on the clear's user lock; with the old order it
        // would take the user row, wait on the rating, and the clear's debit
        // would then wait on the user row: 40P01.
        // (By user and bottle: the soft delete scrubbed the moment's code.)
        const ratingId = (await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM ratings WHERE user_id = ${T.id} AND wine_id = ${w}`)[0].id
        await prisma.$executeRaw`INSERT INTO rating_images (rating_id, image_url) VALUES (${ratingId}, ${`https://example.test/${TAG}.jpg`})`
        const { Client } = await import('pg')
        const locker = new Client({ connectionString: DB })
        await locker.connect()
        // Account deletion RETRIES a 40P01 by itself, so "both complete" is not
        // enough: Postgres's own deadlock counter and the deletion's retry
        // warning must both stay silent.
        const deadlocks = async () => { await locker.query('SELECT pg_stat_clear_snapshot()'); return Number((await locker.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks) }
        const retries: string[] = []
        const warn = console.warn
        try {
          const d0 = await deadlocks()
          console.warn = (...a: unknown[]) => { if (String(a[0]).includes('retrying after')) retries.push(JSON.stringify(a[1])); warn(...a) }
          await locker.query('BEGIN')
          await locker.query('SELECT id FROM rating_images WHERE rating_id = $1 FOR UPDATE', [ratingId])
          const pe = postEdit(T, item, { wineId: w, score: 0, notes: '' })
          await pause(400)
          const pd = deleteAccountDurable(T.id).then(() => 'ok', (e: Error) => e.message)
          await pause(600)
          await locker.query('ROLLBACK')
          const [r, d] = await Promise.all([pe, pd])
          await pause(1200)   // the cumulative statistics are flushed at most once a second
          const d1 = await deadlocks()
          check(`${order}: the clear holds the rating while the deletion runs: both complete, NO deadlock (none counted, no deletion retry)`,
            r.status === 200 && r.json.reaped === true && d === 'ok' && d1 === d0 && retries.length === 0, { r: r.status, body: r.json, d, deadlocks: [d0, d1], retries })
        } finally { console.warn = warn; await locker.query('ROLLBACK').catch(() => {}); await locker.end() }
      } else if (order === 'concurrent') {
        const [d, r] = await Promise.all([deleteAccountDurable(T.id).then(() => 'ok', (e: Error) => e.message), postEdit(T, item, { wineId: w, score: 0, notes: '' })])
        check(`${order}: both finish (the deletion ok, the edit 200 or 404), never a deadlock`, d === 'ok' && (r.status === 200 || r.status === 404), { d, r: r.status, body: r.json })
      } else {
        // The deletion holds AFTER it locked the user row and re-labelled the
        // rating; the clear waits on the user row, never the other way round.
        let release!: () => void
        const held = new Promise<void>(r => { release = r })
        let entered!: () => void
        const inHold = new Promise<void>(r => { entered = r })
        const pd = deleteAccountDurable(T.id, { hooks: { beforeUserDelete: async () => { entered(); await held } } })
        await inHold
        const pe = postEdit(T, item, { wineId: w, score: 0, notes: '' })
        await pause(300)
        release()
        const [d, r] = await Promise.all([pd.then(() => 'ok', (e: Error) => e.message), pe])
        check(`${order}: the deletion completes, the post edit then answers 404 (the user is gone); no deadlock`, d === 'ok' && r.status === 404, { d, r: r.status })
      }
    }
  }

  // ── § 8 the backfill, verbatim, over rows written the old way ─────────────
  if (section('backfill', '§ 8 the migration\'s backfill over rows written the old way')) {
    const sql = readFileSync(pjoin(HERE, '..', '..', 'prisma', 'migrations', '20261125234900_rating_flags_backfill', 'migration.sql'), 'utf8')
    const m = /-- @backfill:rating-flags\n([\s\S]*?)-- @endbackfill/.exec(sql)
    check('the backfill block is found between its markers', !!m)
    const { T, code, bottle } = await moment()
    const sid = (await sessionIdOf(code))!
    const cases: [string, number | null, string | null, [boolean, boolean, boolean]][] = [
      ['score 5', 5, null, [true, false, false]], ['score 1', 1, 'short', [false, true, false]], ['score 4.75 + a long note', 4.75, 'abcdef', [false, false, true]],
      ['a 5-character note', 3, 'abcde', [false, false, false]], ['three emoji', 2, '🍷🍷🍷', [false, false, false]], ['six emoji', 2, '🍷🍷🍷🍷🍷🍷', [false, false, true]],
      ['score NULL (a notes-only row)', null, 'notes only here', [false, false, true]],
      ['score 0, no note (not rewritten)', 0, null, [false, false, false]],
    ]
    const ids: [string, string, [boolean, boolean, boolean]][] = []
    for (const [label, score, notes, want] of cases) {
      const w = await bottle()
      // Written the old way: the old server never names the new columns.
      await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at) VALUES (${w}, ${T.id}, ${sid}, 'session', 'Tess', ${score}::numeric, '{}'::jsonb, '[]'::jsonb, ${notes}, NOW())`
      ids.push([label, w, want])
    }
    // The block rewrites only the rows that set a flag (its WHERE); the same
    // SET over EVERY row (the form without the WHERE) must give the same flags.
    const unfiltered = m![1].replace(/\nWHERE [^\n]*;/, ';')
    check('the block carries its WHERE (the unfiltered form differs)', unfiltered !== m![1] && !/\bWHERE\b/.test(unfiltered))
    type Flags = { id: number; wine_id: string; five_star_counted: boolean; one_star_counted: boolean; note_counted: boolean; rating_action_xp: number }
    let filtered: Flags[] = [], whole: Flags[] = [], rewritten = -1, flaggedRows = -1
    await prisma.$transaction(async (tx) => {
      const allFlags = () => tx.$queryRaw<Flags[]>`
        SELECT id, wine_id, five_star_counted, one_star_counted, note_counted, rating_action_xp FROM ratings ORDER BY id`
      // As the migration finds them: every flag at its column default.
      const reset = () => tx.$executeRaw`UPDATE ratings SET five_star_counted = false, one_star_counted = false, note_counted = false`
      await reset()
      rewritten = await tx.$executeRawUnsafe(m![1])
      filtered = await allFlags()
      flaggedRows = filtered.filter(r => r.five_star_counted || r.one_star_counted || r.note_counted).length
      await reset()
      await tx.$executeRawUnsafe(unfiltered)
      whole = await allFlags()
      // Never leave the whole-table UPDATEs behind on a shared test database.
      throw new Error('rollback')
    }).catch(() => {})
    check('with and without the WHERE: the same flags on every row of the table', filtered.length > ids.length && deepEq(filtered, whole), { filtered: filtered.length, whole: whole.length })
    check('…and only the rows that set a flag are rewritten', rewritten === flaggedRows && rewritten < filtered.length, { rewritten, flaggedRows, rows: filtered.length })
    const rows = filtered.filter(r => ids.some(([, w]) => w === r.wine_id))
    for (const [label, w, want] of ids) {
      const r = rows.find(x => x.wine_id === w)
      check(`backfill: ${label} → five ${want[0]}, one ${want[1]}, note ${want[2]}, action XP 0`, !!r && r.five_star_counted === want[0] && r.one_star_counted === want[1] && r.note_counted === want[2] && r.rating_action_xp === 0, r)
    }
    // After the backfill a legacy 5 re-saved as 5 counts nothing more.
    const [, w5] = ids[0]
    await prisma.$executeRaw`UPDATE ratings SET five_star_counted = true WHERE wine_id = ${w5} AND user_id = ${T.id}`
    const s0 = await statsOf(T)
    await merge(code, T, w5, { score: 5 }, { base: 0 })
    check('a backfilled five-star re-saved as 5: no counter, no XP (not new, flag already set)', deepEq(await statsOf(T), s0), { s0, s: await statsOf(T) })
    check('POST /api/me/badges has no handler any more (Next answers 405 in the built server: usernames-web.mts § 5)', badgesRoute.POST === undefined && typeof badgesRoute.GET === 'function' && typeof badgesRoute.PATCH === 'function')
  }

  // ── § 9 the save limit ────────────────────────────────────────────────────
  if (section('limit', '§ 9 the save limit: 600 per 10 minutes per signed-in user, across moments; guests unlimited')) {
    const { T, code, bottle } = await moment()
    const w = await bottle()
    const key = `rl:rate:u:${T.id}:10m`
    const other = await createSession(as(T))
    await visit(other.code, as(T))
    const w2 = await addBottle(other.code, as(T))
    await resetLimits()
    await redis.set(key, '599', { EX: 600 })
    const r600 = await merge(code, T, w, { score: 3 })
    const r601 = await merge(code, T, w, { score: 3.25 })
    check('the 600th save passes, the 601st → 429 with Retry-After and a wait', r600.status === 200 && r601.status === 429 && Number(r601.headers.get('retry-after')) > 0 && /Too many saves\. Try again in /.test(String(r601.json.error)), [r600.status, r601.status, r601.json])
    check('…the refused save wrote nothing', (await rowOf(T, code, w))?.score === 3)
    const elsewhere = await merge(other.code, T, w2, { score: 4 })
    check('…one budget across moments: the next save in ANOTHER moment → 429', elsewhere.status === 429)
    const web = await full(code, T, w, { score: 2 })
    check('…the web full save shares it (the same route)', web.status === 429)
    const g = await join(code, {}, 'Gina Guest')
    await resetLimits()
    await redis.set(key, '600', { EX: 600 })
    let guestOk = 0
    for (let i = 0; i < 5; i++) if ((await rawRate(code, { anon: g.json.anonToken as string }, { wineId: w, score: 1 + i * 0.25, flavors: {}, notes: '' })).status === 200) guestOk++
    check('a guest is not limited (5 saves while the signed-in budget is spent, no guest rl:rate key minted)', guestOk === 5 && deepEq(await scanKeys('rl:rate:*'), [key]), { guestOk, keys: await scanKeys('rl:rate:*') })
  }
} catch (err) {
  failed++
  console.log(`  ❌ the suite crashed: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  mutationHooks.at = async () => {}
  touchHooks.afterRead = async () => {}
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
  process.exit(failed > 0 ? 1 : 0)
}
