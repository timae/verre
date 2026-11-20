// Catalogue model change, build step 4: the catalogue on every write
// (docs/dev/proposals/wine-catalog-model-change.md § 2, § 8b, § 9; build plan
// step 4). Every new bottle links (pick an entry, or create one: signed in
// only), the snapshot comes from the entry, the line-up wire carries ONE
// `entry` key that a blind row loses, merges resolve on every catalogue read,
// guests search inside their moment, the gate defaults open, and the
// interleaved concurrent PATCH (two real overlapping requests through
// `mutationHooks`, never a sleep).
//
// Drives the REAL route handlers and lib/ functions (tsx) against a real
// Postgres + Redis. Throwaway stores only (refuses the dev db `verre`).
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/catalog-every-write.mts [--only <section>]
import { toWire, fromWire, wireParams } from './lib/wireIds.mts'
import { fixtureUsername } from './lib/fixtureUsername.mjs'
import { mintEntry, pick } from './lib/catalogFixture.mts'
import { registerHooks } from 'node:module'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { prisma } from '../../lib/prisma.ts'
import { redis, k, scanKeys } from '../../lib/redis.ts'
import type { WineMeta } from '../../lib/session.ts'

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
type Res = { status: number; json: Record<string, unknown>; text: string; headers: Headers }
async function call(handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params: Record<string, string> = {}): Promise<Res> {
  if (typeof handler !== 'function') return { status: -1, json: { error: 'no such handler (not built yet)' }, text: '', headers: new Headers() }
  const res = await (handler as Handler)(request(method, path, actor, await toWire(body)), { params: Promise.resolve(await wireParams(params)) })
  const text = await res.text()
  let json: unknown = null
  try { json = await fromWire(JSON.parse(text)) } catch {}
  return { status: res.status, json: json as Record<string, unknown>, text, headers: res.headers }
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
// The gate's default is under test (§ 1): every other section runs with it unset.
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
const checkinsRoute = await import('../../app/api/checkins/route.ts')
const checkinRoute = await import('../../app/api/checkins/[id]/route.ts')
const searchRoute = await import('../../app/api/catalog/search/route.ts')
const momentSearch = await optional('../../app/api/session/[code]/catalog/search/route.ts')
const core = await import('../../packages/core/src/index.ts') as Record<string, unknown>
const { mutationHooks } = await import('../../lib/sessionMutation.ts')
const { CODE_MISS } = await import('../../lib/sessionRoute.ts')
const { catalogPublicEnabled, canUseCatalog } = await import('../../lib/catalogGate.ts')
const { createProduct, createProducer } = await import('../../lib/catalogWrite.ts')
const { getUserStats } = await import('../../lib/badgeService.ts')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const section = (t: string) => console.log(`\n${t}`)
const TAG = `cew-${Date.now()}`
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
const as = (u: User): Actor => ({ cookie: u.cookie })
const dateFrom = new Date(Date.now() + 3600_000).toISOString()
async function createSession(actor: Actor) {
  await resetLimits()
  const r = await call(sessionRoute.POST, 'POST', '/api/session', actor, { hostDisplayName: 'Hana Host', sessionName: `${TAG} moment`, dateFrom })
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`)
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
  call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, actor, body, { code })
const editWine = (code: string, actor: Actor, wineId: string, body: Record<string, unknown>) =>
  call(wineRoute.PATCH, 'PATCH', `/api/session/${code}/wines/${wineId}`, actor, body, { code, wineId })
const settings = (code: string, actor: Actor, body: Record<string, unknown>) => call(settingsRoute.PATCH, 'PATCH', `/api/session/${code}/settings`, actor, body, { code })
const state = (code: string, actor: Actor) => call(stateRoute.GET, 'GET', `/api/session/${code}/state`, actor, undefined, { code })
const winesGet = (code: string, actor: Actor) => call(winesRoute.GET, 'GET', `/api/session/${code}/wines`, actor, undefined, { code })
const rate = (code: string, actor: Actor, wineId: string, extra: Record<string, unknown> = {}) =>
  call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, actor, { wineId, score: 4, flavors: {}, notes: 'nice', ...extra }, { code })
const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
const reveal = (code: string, actor: Actor, wineId: string) => call(revealRoute.POST, 'POST', `/api/session/${code}/wines/${wineId}/reveal`, actor, {}, { code, wineId })
const setRole = (code: string, actor: Actor, targetId: string, role: string) =>
  call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, actor, { action: 'set-role', targetId, role }, { code })
const globalSearch = (actor: Actor, qs: string) => call(searchRoute.GET, 'GET', `/api/catalog/search?${qs}`, actor)
const momentSearchGet = (code: string, actor: Actor, qs: string) =>
  call(momentSearch.GET, 'GET', `/api/session/${code}/catalog/search?${qs}`, actor, undefined, { code })
const postCheckin = (actor: Actor, body: Record<string, unknown>) => call(checkinsRoute.POST, 'POST', '/api/checkins', actor, { score: 4, flavors: {}, notes: 'n', ...body })
const patchCheckin = (actor: Actor, id: number, body: Record<string, unknown>) => call(checkinRoute.PATCH, 'PATCH', `/api/checkins/${id}`, actor, body, { id: String(id) })
const liveRow = async (code: string) => (await prisma.$queryRaw<{ id: number; lineup_revision: number | null }[]>`
  SELECT id, lineup_revision FROM sessions WHERE code = ${code} AND deleted_at IS NULL`)[0]
type Row = { id: string; name: string; producer: string | null; vintage: string | null; style: string | null; colour: string | null; sparkling: boolean
  abv: string | null; product_id: string | null; vintage_id: string | null; purchase_url: string | null; description: string | null; grape: string | null; region: string | null }
const rowOf = async (id: string) => (await prisma.$queryRaw<Row[]>`
  SELECT id, name, producer, vintage, style, colour, sparkling, abv::text AS abv, product_id, vintage_id, purchase_url, description, grape, region
    FROM wines WHERE id = ${id}`)[0]
const redisWines = async (code: string) => JSON.parse((await redis.get(k.wines(code))) ?? '[]') as WineMeta[]
const productsNamed = async (name: string) => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wine_products WHERE name = ${name}`)[0].n)
const reviewItems = async (type: string, id: string) => Number((await prisma.$queryRaw<{ n: bigint }[]>`
  SELECT count(*) AS n FROM catalog_review_items WHERE entity_type = ${type} AND entity_id = ${id} AND reason = 'user-mint'`)[0].n)
const countOf = async (q: Promise<{ n: bigint }[]>) => Number((await q)[0].n)
type WireWine = Record<string, unknown> & { id: string; name: string; entry?: Record<string, unknown> | null }
const wiresOf = (r: Res) => ((r.json?.wines as WireWine[] | undefined) ?? (Array.isArray(r.json) ? r.json as unknown as WireWine[] : []))
const noHooks = () => { mutationHooks.at = async () => {} }
let ipSeq = 0
const freshIp = () => { ipSeq++; return `10.77.${(ipSeq >> 8) & 255}.${ipSeq & 255}` }

// ── § 1 The gate defaults OPEN; 'false' is the kill switch ──────────────────
async function gate() {
  section('§ 1 the gate: unset = OPEN, exactly \'false\' closes it (the kill switch)')
  const U = await mkUser('Gate User')
  const prev = process.env.CATALOG_PUBLIC_ENABLED
  try {
    delete process.env.CATALOG_PUBLIC_ENABLED
    check('(1a) unset → open', catalogPublicEnabled() === true)
    check('(1a) …an anonymous caller passes the gate', (await canUseCatalog(null)) === true)
    const s = await globalSearch(as(U), 'kind=producer&q=Gate')
    check('(1a) …and the public search answers (not 404)', s.status === 200, [s.status, s.json])
    for (const v of ['true', '1', 'TRUE', 'False', 'no', '']) {
      process.env.CATALOG_PUBLIC_ENABLED = v
      check(`(1b) CATALOG_PUBLIC_ENABLED=${JSON.stringify(v)} stays OPEN (only exactly 'false' closes)`, catalogPublicEnabled() === true)
    }
    process.env.CATALOG_PUBLIC_ENABLED = 'false'
    check("(1c) 'false' closes it", catalogPublicEnabled() === false && (await canUseCatalog(null)) === false && (await canUseCatalog(U.id)) === false)
    const closed = await globalSearch(as(U), 'kind=producer&q=Gate')
    check("(1c) …the public search then 404s (looks absent)", closed.status === 404, [closed.status])
    const h = await createSession(as(U))
    const ms = await momentSearchGet(h.code, as(U), 'kind=producer&q=Gate')
    check("(1c) …so does the moment's search", ms.status === 404, [ms.status, ms.json])
    const e = await postWine(h.code, as(U), { id: nanoid(), create: { producer: { name: `${TAG} Closed P` }, product: { name: `${TAG} Closed W`, colour: 'red' } } })
    check("(1c) …and creating an entry while closed is refused (403), nothing minted", e.status === 403 && (await productsNamed(`${TAG} Closed W`)) === 0, [e.status, e.json])
  } finally {
    if (prev === undefined) delete process.env.CATALOG_PUBLIC_ENABLED
    else process.env.CATALOG_PUBLIC_ENABLED = prev
  }
}

// ── § 2 Every new bottle links ──────────────────────────────────────────────
async function linkRequired() {
  section('§ 2 every new bottle links: no link → 400; free text never becomes the snapshot')
  const H = await mkUser('Host Link')
  const s = await createSession(as(H))
  const bare = await postWine(s.code, as(H), { id: nanoid(), name: 'Typed Only', type: 'red' })
  check('(2a) a session bottle with no link → 400, nothing written', bare.status === 400 && !(await redisWines(s.code)).some(w => w.name === 'Typed Only'), [bare.status, bare.json])
  const cin = await postCheckin(as(H), { occurrenceId: nanoid(), wineName: 'Typed Check-in', type: 'red' })
  check('(2a) a check-in with no link → 400', cin.status === 400, [cin.status, cin.json])
  const e = await mintEntry({ producer: `${TAG} Weingut A`, name: `${TAG} Riesling A`, colour: 'white', year: 2019, vintageAbv: 11.5, grapes: ['Riesling'], region: 'Mosel' })
  const id = nanoid()
  const r = await postWine(s.code, as(H), { id, ...pick(e), name: 'IGNORED NAME', producer: 'IGNORED', vintage: '1999', type: 'red', description: 'our notes', purchaseUrl: 'https://shop.example/a' })
  const row = await rowOf(id)
  check('(2b) a pick → 200', r.status === 200, [r.status, r.json])
  check('(2b) the snapshot comes from the ENTRY, never the body\'s free text',
    row?.name === `${TAG} Riesling A` && row?.producer === `${TAG} Weingut A` && row?.vintage === '2019' && row?.style === 'white' && row?.colour === 'white' && row?.sparkling === false, row)
  check('(2b) …abv copied at link time (the vintage\'s), grape and region from the entry', row?.abv === '11.50' && row?.grape === 'Riesling' && row?.region === 'Mosel', row)
  check('(2b) …"About" and the purchase link stay on the bottle (ruled 2026-11-20)', row?.description === 'our notes' && row?.purchase_url === 'https://shop.example/a', row)
  const cached = (await redisWines(s.code)).find(w => w.id === id) as Record<string, unknown> | undefined
  check('(2b) the cached line-up keeps the OLD shape: no colour / sparkling / abv / entry keys, `type` the derived token',
    !!cached && !('colour' in cached) && !('sparkling' in cached) && !('abv' in cached) && !('entry' in cached) && cached.type === 'white' && cached.productId === e.productId, cached)
}

// ── § 3 The wire: one `entry` key, no legacy `type`, no flat ids ────────────
async function wire() {
  section('§ 3 the line-up wire: occurrence fields + ONE `entry` key')
  const H = await mkUser('Host Wire')
  const s = await createSession(as(H))
  const e = await mintEntry({ producer: `${TAG} Maison B`, name: `${TAG} Brut B`, sparkling: true, colour: 'rose', abv: 12, year: null, grapes: ['Pinot Noir', 'Chardonnay'] })
  const id = nanoid()
  const add = await postWine(s.code, as(H), { id, ...pick(e) })
  const echo = add.json as WireWine
  const got = wiresOf(await winesGet(s.code, as(H))).find(w => w.id === id)
  for (const [label, w] of [['the POST echo', echo], ['the line-up GET', got]] as const) {
    const en = w?.entry as Record<string, unknown> | undefined
    check(`(3a) ${label}: entry carries the catalogue identity`,
      !!en && en.productId === e.productId && en.vintageId === e.vintageId && en.name === `${TAG} Brut B` && en.producer === `${TAG} Maison B`
        && en.producerId === e.producerId && en.year === null && en.sparkling === true && en.colour === 'rose' && Number(en.abv) === 12
        && Array.isArray(en.grapes) && (en.grapes as string[]).join() === 'Pinot Noir,Chardonnay', en)
    check(`(3a) ${label}: top-level colour / sparkling are the bottle's SNAPSHOT (a sparkling rosé keeps colour rosé), no legacy \`type\`, no flat productId / vintageId`,
      !!w && w.sparkling === true && w.colour === 'rose' && !('type' in w) && !('productId' in w) && !('vintageId' in w), w)
    check(`(3a) ${label}: the abv is a number (the Decimal trap)`, typeof (w?.entry as Record<string, unknown> | undefined)?.abv === 'number', w?.entry)
  }
}

// ── § 4 Create (signed in): the add flow, review items, idempotent retry ─────
async function create() {
  section('§ 4 create through the add flow: signed in, required fields, review items, a retry mints nothing')
  const H = await mkUser('Host Create')
  const s = await createSession(as(H))
  const id = nanoid()
  const body = { id, create: { producer: { name: `${TAG} New Producer` }, product: { name: `${TAG} New Wine`, colour: 'white', grapes: ['Grüner Veltliner'] }, year: 2021, abv: 12.5 }, purchaseUrl: 'https://shop.example/n' }
  const a = await postWine(s.code, as(H), body)
  const row = await rowOf(id)
  check('(4a) a create → 200, the bottle linked to the minted entry', a.status === 200 && !!row?.product_id && !!row?.vintage_id, [a.status, a.json, row])
  const prod = row?.product_id ? (await prisma.$queryRaw<{ status: string; abv: string | null; colour: string | null; added_by: number | null }[]>`
    SELECT status, abv::text AS abv, colour, added_by FROM wine_products WHERE id = ${row.product_id}`)[0] : null
  const vin = row?.vintage_id ? (await prisma.$queryRaw<{ year: number | null; abv: string | null }[]>`SELECT year, abv::text AS abv FROM wine_vintages WHERE id = ${row.vintage_id}`)[0] : null
  check('(4a) …minted provisional, by this user', prod?.status === 'provisional' && prod?.added_by === H.id && prod?.colour === 'white', prod)
  check('(4a) 🔒 a typed abv with a year lands on THAT VINTAGE, not the wine (ruled 2026-11-20)', vin?.year === 2021 && vin?.abv === '12.50' && prod?.abv === null, { vin, prod })
  check('(4a) the snapshot from the new entry (and its abv)', row?.name === `${TAG} New Wine` && row?.producer === `${TAG} New Producer` && row?.vintage === '2021' && row?.abv === '12.50', row)
  const producerId = row?.product_id ? (await prisma.$queryRaw<{ producer_id: string }[]>`SELECT producer_id FROM product_producers WHERE product_id = ${row.product_id} AND role = 'lead'`)[0]?.producer_id : null
  check('(4b) every user mint writes its review item (producer, product, vintage)',
    !!producerId && (await reviewItems('producer', producerId!)) === 1 && (await reviewItems('product', row!.product_id!)) === 1 && (await reviewItems('vintage', row!.vintage_id!)) === 1)
  const again = await postWine(s.code, as(H), body)
  check('(4c) a retry after a lost response: the acknowledgement, and NO second entry minted',
    again.status === 200 && again.json?.alreadyAdded === true && (await productsNamed(`${TAG} New Wine`)) === 1, [again.status, again.json, await productsNamed(`${TAG} New Wine`)])
  // Branch 3 (existing producer, a new wine under it), year unknown: the abv on the wine.
  const id3 = nanoid()
  const b3 = await postWine(s.code, as(H), { id: id3, create: { producerId, product: { name: `${TAG} Under Producer`, sparkling: true }, abv: 0.4 } })
  const r3 = await rowOf(id3)
  const p3 = r3?.product_id ? (await prisma.$queryRaw<{ abv: string | null }[]>`SELECT abv::text AS abv FROM wine_products WHERE id = ${r3.product_id}`)[0] : null
  check('(4d) branch 3 (producer first): the wine under the chosen producer, product grain', b3.status === 200 && !!r3?.product_id && r3?.vintage_id === null && r3?.sparkling === true, [b3.status, b3.json, r3])
  check('(4d) 🔒 year unknown: the abv lands on the WINE', p3?.abv === '0.40' && r3?.abv === '0.40', { p3, r3 })
  check('(4d) …and no new producer minted (no producer review item beyond the first)',
    (await countOf(prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM producers WHERE name = ${`${TAG} New Producer`}`)) === 1)
  // Branch 2 (add a missing vintage to an existing wine).
  const id2 = nanoid()
  const b2 = await postWine(s.code, as(H), { id: id2, create: { productId: row!.product_id, year: 2019, abv: 13 } })
  const r2 = await rowOf(id2)
  check('(4e) branch 2 (a missing vintage): same wine, a new 2019 row, its own abv', b2.status === 200 && r2?.product_id === row?.product_id && r2?.vintage === '2019' && r2?.abv === '13.00' && r2?.vintage_id !== row?.vintage_id, [b2.status, b2.json, r2])
  // Required fields.
  for (const [label, c] of [
    ['no type', { producer: { name: `${TAG} Req P` }, product: { name: `${TAG} Req W1` } }],
    ['no product name', { producer: { name: `${TAG} Req P` }, product: { colour: 'red' } }],
    ['no producer', { product: { name: `${TAG} Req W3`, colour: 'red' } }],
  ] as const) {
    const r = await postWine(s.code, as(H), { id: nanoid(), create: c })
    check(`(4f) required on create: ${label} → 400, nothing minted`, r.status === 400 && (await productsNamed(String((c as { product: { name?: string } }).product.name ?? `${TAG} Req`))) === 0
      && (await countOf(prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM producers WHERE name = ${`${TAG} Req P`}`)) === 0, [r.status, r.json])
  }
  // A failed add rolls the mint (and its review items) back.
  const other = await createSession(as(H))
  const taken = nanoid()
  await postWine(other.code, as(H), { id: taken, ...pick(await mintEntry({ producer: `${TAG} X`, name: `${TAG} X1`, colour: 'red' })) })
  const lost = await postWine(s.code, as(H), { id: taken, create: { producer: { name: `${TAG} Rollback P` }, product: { name: `${TAG} Rollback W`, colour: 'red' } } })
  const strays = await countOf(prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM producers WHERE name = ${`${TAG} Rollback P`}`)
  check('(4g) a create whose bottle id is taken → 409, and the mint rolled back with it (no producer, no wine, no review item)',
    lost.status === 409 && strays === 0 && (await productsNamed(`${TAG} Rollback W`)) === 0, [lost.status, lost.json, strays])
  // The mint and its review item in one transaction, at the chokepoint.
  let pid = ''
  try {
    await prisma.$transaction(async (tx) => {
      const p = await createProducer({ name: `${TAG} Tx Producer` }, H.id, tx)
      pid = p.id
      throw new Error('roll back')
    })
  } catch {}
  check('(4h) a mint rolled back takes its review item with it', !!pid && (await reviewItems('producer', pid)) === 0
    && (await countOf(prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM producers WHERE id = ${pid}`)) === 0)
  const imp = await prisma.$transaction(async (tx) => createProducer({ name: `${TAG} Import Producer` }, null, tx))
  check('(4h) an import-like mint (no user) writes no review item', (await reviewItems('producer', imp.id)) === 0)
  void createProduct
}

// ── § 5 Guests: pick yes, create never; search inside the moment ───────────
async function guests() {
  section('§ 5 guests pick, never create; they search inside their moment')
  const g = await createSession({})
  const e = await mintEntry({ producer: `${TAG} Guest Producer`, name: `${TAG} Guest Wine`, colour: 'red', year: 2018 })
  const gid = nanoid()
  const p = await postWine(g.code, { anon: g.anon }, { id: gid, ...pick(e) })
  check('(5a) a guest host picks an existing entry (Redis-only moment)', p.status === 200 && (await redisWines(g.code)).find(w => w.id === gid)?.name === `${TAG} Guest Wine`, [p.status, p.json])
  const answers: string[] = []
  for (const c of [
    { producer: { name: `${TAG} Guest Mint P` }, product: { name: `${TAG} Guest Mint W`, colour: 'red' } },
    { productId: e.productId, year: 2020 },
    { productId: 'unknownProductId0001x', year: 2020 },
    { productId: 42, year: 2020 },
  ]) {
    const r = await postWine(g.code, { anon: g.anon }, { id: nanoid(), create: c })
    answers.push(`${r.status} ${r.text}`)
  }
  check('(5b) 🔒 a guest create → ONE fixed refusal, identical whatever ids it names (no classifier)',
    answers[0].startsWith('403') && answers.every(a => a === answers[0]), answers)
  check('(5b) …and nothing minted', (await productsNamed(`${TAG} Guest Mint W`)) === 0
    && (await countOf(prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wine_vintages WHERE product_id = ${e.productId} AND year = 2020`)) === 0)
  const gs = await momentSearchGet(g.code, { anon: g.anon }, `kind=producer&q=${encodeURIComponent(`${TAG} Guest Producer`)}`)
  check('(5c) the guest host searches producers inside the moment', gs.status === 200 && ((gs.json?.results as { id: string }[] | undefined) ?? []).some(x => x.id === e.producerId), [gs.status, gs.json])
  const gp = await momentSearchGet(g.code, { anon: g.anon }, `kind=product&producerId=${e.producerId}&q=${encodeURIComponent(`${TAG} Guest`)}`)
  check('(5c) …products under it (same shape as the public search: no status)', gp.status === 200 && ((gp.json?.results as Record<string, unknown>[] | undefined) ?? []).some(x => x.id === e.productId && !('status' in x)), [gp.status, gp.json])
  const gv = await momentSearchGet(g.code, { anon: g.anon }, `kind=vintages&productId=${e.productId}`)
  check('(5c) …and its vintages (ids + years only)', gv.status === 200 && JSON.stringify(gv.json?.results) === JSON.stringify([{ id: e.vintageId, year: 2018 }]), [gv.status, gv.json])
  // A plain taster may not search (the wine POST's power test).
  const t = await join(g.code, {}, 'Plain Taster')
  const ts = await momentSearchGet(g.code, { anon: t.anon }, `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5d) a taster who may not add bottles → 403', ts.status === 403, [ts.status, ts.json])
  await setRole(g.code, { anon: g.anon }, t.id, 'provider')
  const tp = await momentSearchGet(g.code, { anon: t.anon }, `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5d) …a provider may', tp.status === 200, [tp.status, tp.json])
  // The guest budget: per ADDRESS (a guest identity is re-minted per join).
  await resetLimits()
  const ip = freshIp()
  let last: Res | null = null
  for (let i = 0; i < 61; i++) last = await momentSearchGet(g.code, { anon: g.anon, headers: { 'x-forwarded-for': ip } }, `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5e) guest searches: 60 a minute per address, the 61st → 429', last?.status === 429 && Number(await redis.get(`rl:catalog-search:ip:${ip}:1m`)) >= 60, [last?.status, last?.json])
  const other = await momentSearchGet(g.code, { anon: t.anon, headers: { 'x-forwarded-for': ip } }, `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5e) …another guest identity from that address shares the budget (rejoining buys nothing)', other.status === 429, [other.status])
  // A signed-in caller shares the global route's key.
  await resetLimits()
  const H = await mkUser('Host Search')
  const s = await createSession(as(H))
  await globalSearch(as(H), `kind=producer&q=${encodeURIComponent(TAG)}`)
  await momentSearchGet(s.code, as(H), `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5f) signed in: the moment\'s search and the global one charge the SAME key (they don\'t stack)', Number(await redis.get(`rl:catalog-search:u:${H.id}:1m`)) === 2)
  // A spent wrong-code budget: the moment's search answers like every moment route.
  const S = await mkUser('Stranger Search')
  await redis.set(`rl:code-miss:u:${S.id}:1h`, String(CODE_MISS.user), { EX: 3600 })
  const wrongCode = 'ZZZZZZZZ'
  const a1 = await momentSearchGet(wrongCode, as(S), 'kind=producer&q=abc')
  const a2 = await momentSearchGet(s.code, as(S), 'kind=producer&q=abc')
  const a3 = await winesGet(s.code, as(S))
  check('(5g) 🔒 a spent wrong-code budget: the search answers a wrong and a right code identically, the gate\'s 429 (as GET /wines does)',
    a1.status === 429 && a1.text === a2.text && a2.status === a3.status && a2.text === a3.text, [a1.status, a1.text, a2.text, a3.text])
  await redis.set(`rl:code-miss:u:${H.id}:1h`, String(CODE_MISS.user), { EX: 3600 })
  const m = await momentSearchGet(s.code, as(H), `kind=producer&q=${encodeURIComponent(TAG)}`)
  check('(5g) …the moment\'s own host still gets through on a spent budget (members pass the gate)', m.status === 200, [m.status, m.json])
}

// ── § 6 The vintage lookup (both routes) ────────────────────────────────────
async function vintages() {
  section('§ 6 the vintage lookup: ids + years (NV included), the same gate and generic denials')
  const U = await mkUser('Vintage User')
  const e = await mintEntry({ producer: `${TAG} V Producer`, name: `${TAG} V Wine`, colour: 'red', year: 2015 })
  const nv = await prisma.$transaction(async tx => (await import('../../lib/catalogWrite.ts')).createVintage(e.productId, null, null, null, tx))
  const r = await globalSearch(as(U), `kind=vintages&productId=${e.productId}`)
  const years = ((r.json?.results as { id: string; year: number | null }[] | undefined) ?? [])
  check('(6a) the global route lists the product\'s vintages, NV included, nothing else', r.status === 200 && years.length === 2
    && years.some(v => v.id === e.vintageId && v.year === 2015) && years.some(v => v.id === nv.id && v.year === null)
    && years.every(v => Object.keys(v).sort().join() === 'id,year'), [r.status, r.json])
  const bad = await globalSearch(as(U), 'kind=vintages&productId=noSuchProduct000001')
  const rej = await mintEntry({ producer: `${TAG} V Producer 2`, name: `${TAG} V Rejected`, colour: 'red', year: 2016 })
  await prisma.$executeRaw`UPDATE wine_products SET status = 'rejected' WHERE id = ${rej.productId}`
  const bad2 = await globalSearch(as(U), `kind=vintages&productId=${rej.productId}`)
  check('(6b) 🔒 an unknown and a rejected product answer the SAME generic denial', bad.status === bad2.status && bad.text === bad2.text && bad.status === 400, [bad.status, bad.text, bad2.text])
  const anon = await globalSearch({}, `kind=vintages&productId=${e.productId}`)
  check('(6c) the global route stays signed-in only (401)', anon.status === 401, [anon.status])
}

// ── § 7 A blind row carries no entry, no abv, keeps colour / sparkling ──────
async function blind() {
  section('§ 7 a blind row: no `entry`, no abv, no catalogue id; colour and sparkling stay')
  const H = await mkUser('Host Blind', { pro: true })
  const T = await mkUser('Taster Blind')
  const s = await createSession(as(H))
  const bl = await settings(s.code, as(H), { blind: true })
  await enter(s.code, as(T), 'Taster Blind')
  const e = await mintEntry({ producer: `${TAG} Secret Producer`, name: `${TAG} Secret Sparkle`, sparkling: true, abv: 0.3, year: 2020, grapes: ['Glera'], region: 'Veneto' })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(e) })
  const g = await winesGet(s.code, as(T))
  const w = wiresOf(g).find(x => x.id === id)
  check('(7a) fixture: blind on, the taster sees the row', bl.status === 200 && !!w, [bl.status, g.status])
  check('(7a) 🔒 the blind row: "Wine N", entry null, abv null', w?.name === 'Wine 1' && w?.entry === null && w?.abv === null && w?._blind === true, w)
  check('(7a) 🔒 colour and sparkling STAY (the axes need them)', w?.sparkling === true && 'colour' in (w ?? {}), w)
  check('(7a) 🔒 no catalogue id, name, producer, grape or region anywhere in the payload',
    !g.text.includes(e.productId) && !g.text.includes(e.vintageId!) && !g.text.includes(e.producerId) && !g.text.includes('Secret') && !g.text.includes('Glera') && !g.text.includes('Veneto'), g.text.slice(0, 400))
  const st = await state(s.code, as(T))
  check('(7b) the same through /state', st.status === 200 && !st.text.includes(e.productId) && !st.text.includes('Secret') && wiresOf(st).find(x => x.id === id)?.entry === null, st.status)
  const host = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === id)
  check('(7c) the host (no Blind for Everyone) sees the entry', (host?.entry as Record<string, unknown> | null | undefined)?.productId === e.productId, host)
  const red = await mintEntry({ producer: `${TAG} Secret Red P`, name: `${TAG} Secret Red`, colour: 'red', abv: 0.2 })
  const rid = nanoid()
  await postWine(s.code, as(H), { id: rid, ...pick(red) })
  const rw = wiresOf(await winesGet(s.code, as(T))).find(x => x.id === rid)
  check('(7d) a blind RED bottle keeps colour red (and sparkling false), abv null', rw?.colour === 'red' && rw?.sparkling === false && rw?.abv === null && rw?.entry === null, rw)
  check('(7d) 🔒 the blind row is an ALLOW-LIST: exactly the keys a taster may know',
    !!rw && Object.keys(rw).sort().join() === ['_blind', 'abv', 'addedByDisplayName', 'addedByUserId', 'colour', 'country', 'description', 'entry', 'grape', 'id', 'image', 'imageUrl', 'isMine', 'name', 'producer', 'purchaseUrl', 'region', 'revealedAt', 'sparkling', 'vintage', 'vinification'].sort().join(), rw && Object.keys(rw))
  const { redactWine } = await import('../../lib/wineRedaction.ts')
  const extra = redactWine({ id: 'x', name: 'n', producer: 'p', vintage: '', grape: '', type: 'red', image: '', imageUrl: '', futureLabelField: 'LEAK' } as unknown as WineMeta, { revealed: false, isHost: false, ownsWine: false, index: 0 })
  check('(7d) 🔒 a field added to WineMeta later stays OFF a blind row (no spread)', !!extra && !JSON.stringify(extra).includes('LEAK'), extra)
  // The alcohol-free badge counts a blind bottle only after the reveal (its
  // abv is hidden until then: ruled 2026-11-20).
  await rate(s.code, as(T), rid)
  const before = (await getUserStats(T.id) as unknown as Record<string, number>).nonalcCount
  await reveal(s.code, as(H), rid)
  const after = (await getUserStats(T.id) as unknown as Record<string, number>).nonalcCount
  check('(7e) 🔒 rating an unrevealed blind alcohol-free bottle does not count it as alcohol-free; after the reveal it does', before === 0 && after === 1, { before, after })
}

// ── § 8 Merges resolve on every catalogue read ──────────────────────────────
async function merges() {
  section('§ 8 merge resolution: a tombstoned entry reads as its survivor (one resolver)')
  const H = await mkUser('Host Merge')
  const s = await createSession(as(H))
  const loser = await mintEntry({ producer: `${TAG} Loser Producer`, name: `${TAG} Loser Wine`, colour: 'red' })
  const survivor = await mintEntry({ producer: `${TAG} Survivor Producer`, name: `${TAG} Survivor Wine`, colour: 'red' })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(loser) })
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${survivor.productId} WHERE id = ${loser.productId}`
  const w = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === id)
  const en = w?.entry as Record<string, unknown> | undefined
  check('(8a) a product merged away: the line-up\'s entry is the SURVIVOR (id, name, its producer)',
    en?.productId === survivor.productId && en?.name === `${TAG} Survivor Wine` && en?.producer === `${TAG} Survivor Producer`, en)
  check('(8a) …the stored link is untouched (merges never rewrite)', (await rowOf(id))?.product_id === loser.productId)
  // A producer merged away: the product keeps its stored lead; the read names the survivor producer.
  const p2 = await mintEntry({ producer: `${TAG} Old Name Producer`, name: `${TAG} Producer Merge Wine`, colour: 'white' })
  const ps = await prisma.$transaction(tx => createProducer({ name: `${TAG} New Name Producer` }, null, tx))
  const id2 = nanoid()
  await postWine(s.code, as(H), { id: id2, ...pick(p2) })
  await prisma.$executeRaw`UPDATE producers SET status = 'linked', links_to = ${ps.id} WHERE id = ${p2.producerId}`
  const w2 = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === id2)
  check('(8b) a producer merged away: the entry names the survivor producer', (w2?.entry as Record<string, unknown> | undefined)?.producer === `${TAG} New Name Producer`
    && (w2?.entry as Record<string, unknown> | undefined)?.producerId === ps.id, w2?.entry)
  // A pick of a tombstone is refused (link to the survivor instead).
  const r = await postWine(s.code, as(H), { id: nanoid(), ...pick(loser) })
  check('(8c) picking a tombstone → the generic denial', r.status === 400 && r.json?.error === 'invalid catalog reference', [r.status, r.json])
}

// ── § 9 The snapshot follows a re-link; an unrelated edit keeps it ──────────
async function relink() {
  section('§ 9 the snapshot follows a re-link; a cosmetic edit never rewrites it')
  const H = await mkUser('Host Relink')
  const s = await createSession(as(H))
  const red = await mintEntry({ producer: `${TAG} Red Producer`, name: `${TAG} Red One`, colour: 'red', year: 2017 })
  const white = await mintEntry({ producer: `${TAG} White Producer`, name: `${TAG} White One`, colour: 'white', year: 2022, vintageAbv: 12 })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(red) })
  const e1 = await editWine(s.code, as(H), id, { ...pick(white) })
  const row = await rowOf(id)
  check('(9a) a red bottle re-linked to a white entry: link, name, producer, year, style, colour, abv all move',
    e1.status === 200 && row?.product_id === white.productId && row?.name === `${TAG} White One` && row?.producer === `${TAG} White Producer`
      && row?.vintage === '2022' && row?.style === 'white' && row?.colour === 'white' && row?.abv === '12.00', [e1.status, e1.json, row])
  const e2 = await editWine(s.code, as(H), id, { purchaseUrl: 'https://shop.example/w', description: 'note', name: 'Typed Over', type: 'red' })
  const row2 = await rowOf(id)
  check('(9b) a cosmetic edit (purchase link, About) keeps the link and the snapshot; typed identity text is ignored',
    e2.status === 200 && row2?.product_id === white.productId && row2?.name === `${TAG} White One` && row2?.style === 'white' && row2?.purchase_url === 'https://shop.example/w' && row2?.description === 'note', [e2.status, e2.json, row2])
  // A legacy nonalc row (no link) edited for an unrelated field keeps `nonalc`.
  const legacy = nanoid()
  const live = await liveRow(s.code)
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, origin, name, style, colour, sparkling, abv, position) VALUES (${legacy}, ${live.id}, 'session', 'Legacy Free', 'nonalc', NULL, false, 0, 9)`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${live.id}`
  const e3 = await editWine(s.code, as(H), legacy, { purchaseUrl: 'https://shop.example/l' })
  const row3 = await rowOf(legacy)
  check('(9c) a legacy `nonalc` bottle edited for an unrelated field keeps `nonalc` and its abv 0', e3.status === 200 && row3?.style === 'nonalc' && row3?.abv === '0.00' && row3?.purchase_url === 'https://shop.example/l', [e3.status, e3.json, row3])
  const lw = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === legacy)
  check('(9c) …and reads as abv 0 on the wire (the derived alcohol-free mark), no entry', lw?.abv === 0 && lw?.entry === null, lw)
  const clear = await editWine(s.code, as(H), id, { productId: null })
  check('(9d) a linked bottle cannot be unlinked (400; pick another wine instead)', clear.status === 400 && (await rowOf(id))?.product_id === white.productId, [clear.status, clear.json])
}

// ── § 10 The interleaved concurrent PATCH (release condition 6) ─────────────
async function interleaved() {
  section('§ 10 🔒 the interleaved concurrent PATCH: two real overlapping requests (mutationHooks), never a sleep')
  const H = await mkUser('Host Interleave')
  const s = await createSession(as(H))
  const p1 = await mintEntry({ producer: `${TAG} P1 Producer`, name: `${TAG} P1 Wine`, colour: 'red', year: 2016 })
  const p2 = await mintEntry({ producer: `${TAG} P2 Producer`, name: `${TAG} P2 Wine`, colour: 'white', year: 2020 })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(p1), name: `${TAG} P1 Wine`, producer: `${TAG} P1 Producer`, vintage: '2016', type: 'red' })
  // A: the re-link (paused under its locks); B: a cosmetic edit prepared from
  // the state BEFORE A, the whole form as the web sends it, queued behind A.
  let aLocked!: () => void, bQueued!: () => void, releaseA!: () => void
  const aLockedP = new Promise<void>(r => { aLocked = r })
  const bQueuedP = new Promise<void>(r => { bQueued = r })
  const aGo = new Promise<void>(r => { releaseA = r })
  let aSeen = false, bSeen = false
  mutationHooks.at = async (point, code, label) => {
    if (code !== s.code || label !== 'wine-edit') return
    if (point === 'locked' && !aSeen) { aSeen = true; aLocked(); await aGo; return }
    if (point === 'beforeLock' && aSeen && !bSeen) { bSeen = true; bQueued() }
  }
  try {
    const pa = editWine(s.code, as(H), id, { ...pick(p2), name: `${TAG} P2 Wine`, producer: `${TAG} P2 Producer`, vintage: '2020', type: 'white' })
    await aLockedP
    const pb = editWine(s.code, as(H), id, { name: `${TAG} P1 Wine`, producer: `${TAG} P1 Producer`, vintage: '2016', type: 'red', purchaseUrl: 'https://shop.example/b' })
    await bQueuedP
    releaseA()
    const [ra, rb] = await Promise.all([pa, pb])
    const row = await rowOf(id)
    check('(10a) fixture: A paused under its locks, B queued behind it with a pre-A read, both answered 200', aSeen && bSeen && ra.status === 200 && rb.status === 200, [ra.status, ra.json, rb.status, rb.json])
    check('(10a) 🔒 the final bottle is consistent: A\'s link AND A\'s snapshot (name, producer, year, colour), B\'s purchase link',
      row?.product_id === p2.productId && row?.vintage_id === p2.vintageId && row?.name === `${TAG} P2 Wine` && row?.producer === `${TAG} P2 Producer`
        && row?.vintage === '2020' && row?.style === 'white' && row?.colour === 'white' && row?.purchase_url === 'https://shop.example/b', row)
    const served = wiresOf(await state(s.code, as(H))).find(x => x.id === id)
    check('(10a) …and the line-up served afterwards says the same', served?.name === `${TAG} P2 Wine` && (served?.entry as Record<string, unknown> | undefined)?.productId === p2.productId, served)
  } finally { noHooks() }
  // Both re-link, B prepared before A: the later COMMIT wins, link and snapshot together.
  const p3 = await mintEntry({ producer: `${TAG} P3 Producer`, name: `${TAG} P3 Wine`, sparkling: true })
  let a2Locked!: () => void, b2Queued!: () => void, release2!: () => void
  const a2P = new Promise<void>(r => { a2Locked = r }), b2P = new Promise<void>(r => { b2Queued = r }), go2 = new Promise<void>(r => { release2 = r })
  let a2 = false, b2 = false
  mutationHooks.at = async (point, code, label) => {
    if (code !== s.code || label !== 'wine-edit') return
    if (point === 'locked' && !a2) { a2 = true; a2Locked(); await go2; return }
    if (point === 'beforeLock' && a2 && !b2) { b2 = true; b2Queued() }
  }
  try {
    const pa = editWine(s.code, as(H), id, { ...pick(p1), name: `${TAG} P1 Wine`, producer: `${TAG} P1 Producer`, vintage: '2016', type: 'red' })
    await a2P
    const pb = editWine(s.code, as(H), id, { ...pick(p3), name: `${TAG} P3 Wine`, producer: `${TAG} P3 Producer`, vintage: '', type: 'spark' })
    await b2P
    release2()
    await Promise.all([pa, pb])
    const row = await rowOf(id)
    check('(10b) two re-links overlapping: the later one wins with ITS snapshot (never one link with the other\'s names)',
      row?.product_id === p3.productId && row?.name === `${TAG} P3 Wine` && row?.sparkling === true && row?.style === 'spark', row)
  } finally { noHooks() }
}

// ── § 11 Check-ins: pick, create, re-link; had a sip copies the source's link ─
async function checkins() {
  section('§ 11 check-ins link too; "had a sip" copies the source\'s link server-side')
  const A = await mkUser('Checkin Author')
  const B = await mkUser('Checkin Sipper')
  const e = await mintEntry({ producer: `${TAG} Ck Producer`, name: `${TAG} Ck Wine`, sparkling: true, year: 2019 })
  const oid = nanoid()
  const c = await postCheckin(as(A), { occurrenceId: oid, ...pick(e), flavors: { bubbles: 3, sweet: 2 } })
  const row = await rowOf(oid)
  check('(11a) a check-in pick: linked, the snapshot from the entry', c.status === 201 && row?.product_id === e.productId && row?.name === `${TAG} Ck Wine` && row?.sparkling === true, [c.status, c.json, row])
  const fl = (await prisma.$queryRaw<{ flavors: Record<string, number> }[]>`SELECT flavors FROM ratings WHERE wine_id = ${oid}`)[0]?.flavors
  check('(11a) …flavours gated against the ENTRY\'s sparkling (Bubbles kept)', fl?.bubbles === 3, fl)
  check('(11a) the answer carries colour / sparkling, not `type`', c.json?.sparkling === true && !('type' in (c.json ?? {})), c.json)
  const cid = nanoid()
  const cr = await postCheckin(as(A), { occurrenceId: cid, create: { producer: { name: `${TAG} Ck New P` }, product: { name: `${TAG} Ck New W`, colour: 'rose' }, year: 2023 } })
  check('(11b) a check-in create: minted and linked', cr.status === 201 && !!(await rowOf(cid))?.product_id && (await productsNamed(`${TAG} Ck New W`)) === 1, [cr.status, cr.json])
  const red = await mintEntry({ producer: `${TAG} Ck Red P`, name: `${TAG} Ck Red W`, colour: 'red' })
  const re = await patchCheckin(as(A), c.json.id as number, { ...pick(red) })
  const row2 = await rowOf(oid)
  const fl2 = (await prisma.$queryRaw<{ flavors: Record<string, number> }[]>`SELECT flavors FROM ratings WHERE wine_id = ${oid}`)[0]?.flavors
  check('(11c) a check-in re-link: link + snapshot move', re.status === 200 && row2?.product_id === red.productId && row2?.name === `${TAG} Ck Red W` && row2?.sparkling === false && row2?.colour === 'red', [re.status, re.json, row2])
  check('(11c) …and the stored flavours are re-gated (Bubbles dropped on a still wine)', !!fl2 && !('bubbles' in fl2) && fl2.sweet === 2, fl2)
  // Had a sip.
  await prisma.follow.createMany({ data: [{ followerId: B.id, followingId: A.id }, { followerId: A.id, followingId: B.id }], skipDuplicates: true })
  const sip = nanoid()
  const hs = await postCheckin(as(B), { occurrenceId: sip, copyFromCheckinId: cr.json.id })
  const sr = await rowOf(sip)
  const src = await rowOf(cid)
  check('(11d) had a sip: the copy takes the SOURCE\'s link (no link in the body)', hs.status === 201 && !!sr?.product_id && sr?.product_id === src?.product_id && sr?.vintage_id === src?.vintage_id && sr?.name === `${TAG} Ck New W`, [hs.status, hs.json, sr])
}

// ── § 12 Badges count from the snapshot ─────────────────────────────────────
async function badges() {
  section('§ 12 badges count from the snapshot: sparkling, colour, abv ≤ 0.5')
  const U = await mkUser('Badge User')
  const spark = await mintEntry({ producer: `${TAG} B1`, name: `${TAG} Bubbly`, sparkling: true })
  const free = await mintEntry({ producer: `${TAG} B2`, name: `${TAG} Free Red`, colour: 'red', abv: 0.5 })
  const strong = await mintEntry({ producer: `${TAG} B3`, name: `${TAG} Not Free`, colour: 'white', abv: 0.6 })
  for (const e of [spark, free, strong]) await postCheckin(as(U), { occurrenceId: nanoid(), ...pick(e) })
  const st = await getUserStats(U.id) as unknown as Record<string, number>
  check('(12a) sparkling counts from `sparkling`', st.sparkCount === 1, st)
  check('(12a) 🔒 alcohol-free = abv ≤ 0.5 (0.5 counts, 0.6 does not)', st.nonalcCount === 1, st)
  check('(12a) …an alcohol-free red is still a red', st.redCount === 1 && st.whiteCount === 1, st)
}

// ── § 13 The shared rules in @verre/core ────────────────────────────────────
async function coreRules() {
  section('§ 13 @verre/core: the derived alcohol-free rule, axes from sparkling')
  const isNA = core.isNonAlcoholic as ((abv: number | null | undefined) => boolean) | undefined
  check('(13a) isNonAlcoholic: 0 / 0.5 yes, 0.51 / 13 / null / undefined no',
    !!isNA && isNA(0) && isNA(0.5) && !isNA(0.51) && !isNA(13) && !isNA(null) && !isNA(undefined))
  const resolveAxes = core.resolveAxes as (c: string, k: unknown) => { k: string }[]
  const keys = (x: unknown) => resolveAxes('wine', x).map(a => a.k)
  check('(13b) resolveAxes takes the bottle\'s kind: { sparkling: true } → Bubbles', keys({ sparkling: true }).includes('bubbles') && !keys({ sparkling: false }).includes('bubbles'))
  check('(13b) …and still the legacy token (the app until step 7)', keys('spark').includes('bubbles') && !keys('red').includes('bubbles'))
}

// ── § 14 Review r1 fixes ────────────────────────────────────────────────────
async function reviewFixes() {
  section('§ 14 review r1: picks resolved under the locks, retried creates, retries first, browse, archived, guests, promotion\'s pair')
  // (a) security: a provider's partial pick on someone else's blind bottle.
  const H = await mkUser('Host Oracle', { pro: true })
  const B = await mkUser('Provider Oracle')
  const s = await createSession(as(H))
  await settings(s.code, as(H), { blind: true })
  await enter(s.code, as(B), 'Provider Oracle')
  await setRole(s.code, as(H), `u:${B.id}`, 'provider')
  const e = await mintEntry({ producer: `${TAG} Oracle P`, name: `${TAG} Oracle W`, colour: 'red', year: 2018 })
  const v2 = await prisma.$transaction(async tx => (await import('../../lib/catalogWrite.ts')).createVintage(e.productId, 2019, null, null, tx))
  const other = await mintEntry({ producer: `${TAG} Oracle Q`, name: `${TAG} Oracle X`, colour: 'white', year: 2020 })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(e) })
  await resetLimits()
  const right = await editWine(s.code, as(B), id, { vintageId: v2.id })
  const wrong = await editWine(s.code, as(B), id, { vintageId: other.vintageId })
  check('(14a) 🔒 a provider\'s partial pick on the host\'s blind bottle: the same 403 whether the guessed vintage is its wine\'s or not',
    right.status === 403 && wrong.status === 403 && right.text === wrong.text, [right.status, right.text, wrong.status, wrong.text])
  check('(14a) …and nothing changed', (await rowOf(id))?.vintage_id === e.vintageId)
  // (b) race: a retried re-link that creates mints once.
  const body = { create: { producer: { name: `${TAG} Relink New P` }, product: { name: `${TAG} Relink New W`, colour: 'rose' }, year: 2022 } }
  const r1 = await editWine(s.code, as(H), id, body)
  const link1 = (await rowOf(id))?.product_id
  const r2 = await editWine(s.code, as(H), id, body)
  check('(14b) 🔒 a PATCH create retried after a lost answer: ONE entry minted, the bottle still linked to it',
    r1.status === 200 && r2.status === 200 && (await productsNamed(`${TAG} Relink New W`)) === 1 && (await rowOf(id))?.product_id === link1, [r1.status, r2.status, await productsNamed(`${TAG} Relink New W`)])
  const r3 = await editWine(s.code, as(H), id, { create: { ...body.create, year: 2023 } })
  check('(14b) …a create that differs (another year) is a new mint, deliberately', r3.status === 200 && (await productsNamed(`${TAG} Relink New W`)) === 2, [r3.status, r3.json])
  // (c) a stale partial pick behind a re-link (interleaved).
  const p1 = await mintEntry({ producer: `${TAG} Stale P1`, name: `${TAG} Stale W1`, colour: 'red', year: 2015 })
  const p2 = await mintEntry({ producer: `${TAG} Stale P2`, name: `${TAG} Stale W2`, colour: 'red' })
  const sid = nanoid()
  await postWine(s.code, as(H), { id: sid, ...pick(p1) })
  let aLocked!: () => void, bQueued!: () => void, release!: () => void
  const aP = new Promise<void>(r => { aLocked = r }), bP = new Promise<void>(r => { bQueued = r }), go = new Promise<void>(r => { release = r })
  let a = false, b = false
  mutationHooks.at = async (point, code, label) => {
    if (code !== s.code || label !== 'wine-edit') return
    if (point === 'locked' && !a) { a = true; aLocked(); await go; return }
    if (point === 'beforeLock' && a && !b) { b = true; bQueued() }
  }
  try {
    const pa = editWine(s.code, as(H), sid, { productId: p2.productId })
    await aP
    const pb = editWine(s.code, as(H), sid, { vintageId: null })
    await bP
    release()
    await Promise.all([pa, pb])
  } finally { noHooks() }
  const st = await rowOf(sid)
  check('(14c) 🔒 a partial pick queued behind a re-link keeps the NEW product (resolved under the locks), never the pre-read one',
    st?.product_id === p2.productId && st?.vintage_id === null && st?.name === `${TAG} Stale W2`, st)
  // (c2) review r2: a host under Blind for Everyone is masked like a taster, so
  // a PARTIAL pick on a hidden bottle is refused with one answer (it would be
  // resolved against the hidden wine); a whole pick still re-links.
  const HB = await mkUser('Host BFE', { pro: true })
  const bs = await createSession(as(HB))
  const hidden = await mintEntry({ producer: `${TAG} BFE P`, name: `${TAG} BFE W`, colour: 'red', year: 2014 })
  const hv2 = await prisma.$transaction(async tx => (await import('../../lib/catalogWrite.ts')).createVintage(hidden.productId, 2016, null, null, tx))
  const decoy = await mintEntry({ producer: `${TAG} BFE Q`, name: `${TAG} BFE X`, colour: 'red', year: 2017 })
  const hid = nanoid()
  await postWine(bs.code, as(HB), { id: hid, ...pick(hidden) })
  await settings(bs.code, as(HB), { blind: true, blindForEveryone: true })
  await resetLimits()
  const hit = await editWine(bs.code, as(HB), hid, { vintageId: hv2.id })
  const miss = await editWine(bs.code, as(HB), hid, { vintageId: decoy.vintageId })
  check('(14c2) 🔒 Blind for Everyone: a host\'s partial pick on a hidden bottle answers ONE 400 whatever the guess, and changes nothing',
    hit.status === 400 && miss.status === 400 && hit.text === miss.text && (await rowOf(hid))?.vintage_id === hidden.vintageId, [hit.status, hit.text, miss.text])
  const prodOnly = await editWine(bs.code, as(HB), hid, { productId: hidden.productId })
  check('(14c2) …so does `{productId}` alone (it would keep the hidden stored vintage; review r3)', prodOnly.status === 400 && prodOnly.text === hit.text, [prodOnly.status, prodOnly.text])
  const whole = await editWine(bs.code, as(HB), hid, { ...pick(decoy) })
  check('(14c2) …a whole pick (wine and year) still re-links it', whole.status === 200 && (await rowOf(hid))?.product_id === decoy.productId, [whole.status, whole.json])
  // (b2) review r2: a deliberate correction (the same names, another kind) is a
  // new mint, not a replay.
  const corr = { create: { producer: { name: `${TAG} Corr P` }, product: { name: `${TAG} Corr W`, colour: 'red' } } }
  const cid = nanoid()
  await postWine(s.code, as(H), { id: cid, ...corr })
  const fixed = await editWine(s.code, as(H), cid, { create: { ...corr.create, product: { ...corr.create.product, colour: 'white' } } })
  check('(14b2) a re-created wine that differs in kind (a correction) is minted and linked, not swallowed as a replay',
    fixed.status === 200 && (await productsNamed(`${TAG} Corr W`)) === 2 && (await rowOf(cid))?.colour === 'white', [fixed.status, await productsNamed(`${TAG} Corr W`), await rowOf(cid)])
  const sameAbv = await editWine(s.code, as(H), cid, { create: { ...corr.create, product: { ...corr.create.product, colour: 'white' }, abv: 11 } })
  check('(14b2) …and one that differs in abv too', sameAbv.status === 200 && (await productsNamed(`${TAG} Corr W`)) === 3, [sameAbv.status])
  const withYear = { create: { ...corr.create, product: { ...corr.create.product, colour: 'white' }, year: 2020 } }
  await editWine(s.code, as(H), cid, withYear)
  const before4 = await productsNamed(`${TAG} Corr W`)
  const vg = await editWine(s.code, as(H), cid, { create: { ...withYear.create, vintageGrapes: ['Syrah'] } })
  check('(14b2) …and one carrying a field the replay check does not model (vintageGrapes) is the mint\'s to decide, never a silent replay (review r3)',
    vg.status === 200 && (await productsNamed(`${TAG} Corr W`)) === before4 + 1, [vg.status, before4, await productsNamed(`${TAG} Corr W`)])
  // (d) a retried add is answered before the budgets and the kill switch.
  const did = nanoid()
  const addBody = { id: did, create: { producer: { name: `${TAG} Retry P` }, product: { name: `${TAG} Retry W`, colour: 'white' } } }
  await postWine(s.code, as(H), addBody)
  process.env.CATALOG_PUBLIC_ENABLED = 'false'
  try {
    const again = await postWine(s.code, as(H), addBody)
    check('(14d) a retried add answers the acknowledgement even with the kill switch on (decided first)', again.status === 200 && again.json?.alreadyAdded === true, [again.status, again.json])
  } finally { delete process.env.CATALOG_PUBLIC_ENABLED }
  // (e) browsing a producer's wines (a short name is findable).
  const shortP = await prisma.$transaction(tx => createProducer({ name: `${TAG} Browse P` }, null, tx))
  const zo = await mintEntry({ producer: '', producerId: shortP.id, name: 'Zo', colour: 'red' })
  await mintEntry({ producer: '', producerId: shortP.id, name: 'Alto Something', colour: 'white' })
  const br = await momentSearchGet(s.code, as(H), `kind=product&producerId=${shortP.id}&q=`)
  const names = ((br.json?.results as { id: string; name: string }[] | undefined) ?? []).map(x => x.name)
  check('(14e) a chosen producer with no query: its wines A to Z (a 2-character name is found)', br.status === 200 && names.join('|') === 'Alto Something|Zo' && (br.json?.results as { id: string }[]).some(x => x.id === zo.productId), [br.status, names])
  // Review r2: beyond the first 20, a 1–2 character query filters by prefix.
  for (let i = 0; i < 21; i++) await mintEntry({ producer: '', producerId: shortP.id, name: `Aa ${String(i).padStart(2, '0')}`, colour: 'red' })
  const first = await momentSearchGet(s.code, as(H), `kind=product&producerId=${shortP.id}&q=`)
  const zq = await momentSearchGet(s.code, as(H), `kind=product&producerId=${shortP.id}&q=Zo`)
  const firstIds = ((first.json?.results as { id: string }[] | undefined) ?? []).map(x => x.id)
  check('(14e) …the list says it is cut (`more`), a short one does not', first.json?.more === true && br.json?.more === undefined, [first.json?.more, br.json?.more])
  const nul = await momentSearchGet(s.code, as(H), `kind=product&producerId=${shortP.id}&q=Z%00o`)
  check('(14e) a NUL byte in the query is scrubbed (200, not a 500; review r3)', nul.status === 200, [nul.status, nul.text.slice(0, 200)])
  check('(14e) …a long list shows its first 20 (Zo not among them), and typing "Zo" finds it (prefix)',
    firstIds.length === 20 && !firstIds.includes(zo.productId) && ((zq.json?.results as { id: string }[] | undefined) ?? []).map(x => x.id).join() === zo.productId, [firstIds.length, zq.json])
  // (f) the lookup and a pick agree on an archived product.
  const ar = await mintEntry({ producer: `${TAG} Archived P`, name: `${TAG} Archived W`, colour: 'red', year: 2001 })
  await prisma.$executeRaw`UPDATE wine_products SET status = 'archived' WHERE id = ${ar.productId}`
  const lk = await momentSearchGet(s.code, as(H), `kind=vintages&productId=${ar.productId}`)
  const pk = await postWine(s.code, as(H), { id: nanoid(), ...pick(ar) })
  check('(14f) an archived product: the vintage lookup lists it and a pick links it (no answer tells "archived")', lk.status === 200 && pk.status === 200, [lk.status, lk.json, pk.status])
  // (g) guests re-link and retry in a Redis-only moment.
  const g = await createSession({})
  const g1 = await mintEntry({ producer: `${TAG} Guest RL P`, name: `${TAG} Guest RL 1`, colour: 'red' })
  const g2 = await mintEntry({ producer: `${TAG} Guest RL Q`, name: `${TAG} Guest RL 2`, colour: 'white' })
  const gid = nanoid()
  await postWine(g.code, { anon: g.anon }, { id: gid, ...pick(g1) })
  const gre = await editWine(g.code, { anon: g.anon }, gid, { ...pick(g2) })
  const cached = (await redisWines(g.code)).find(w => w.id === gid)
  check('(14g) a guest re-links a bottle in a Redis-only moment (the cached bottle carries the new snapshot)', gre.status === 200 && cached?.name === `${TAG} Guest RL 2` && cached?.type === 'white' && cached?.productId === g2.productId, [gre.status, cached])
  const gretry = await postWine(g.code, { anon: g.anon }, { id: gid, ...pick(g1) })
  check('(14g) …and a guest\'s retried add is acknowledged', gretry.status === 200 && gretry.json?.alreadyAdded === true, [gretry.status, gretry.json])
  // (h) promotion keeps the token and its pair consistent.
  const W = await mintEntry({ producer: `${TAG} Promo P`, name: `${TAG} Promo W`, colour: 'white' })
  const pg = await createSession({})
  const pid = nanoid()
  await postWine(pg.code, { anon: pg.anon }, { id: pid, ...pick(W) })
  await prisma.$executeRaw`UPDATE wine_products SET sparkling = true WHERE id = ${W.productId}`
  const U = await mkUser('Promoter')
  await enter(pg.code, as(U), 'Promoter')
  const pr = await rowOf(pid)
  check('(14h) promotion: an entry changed since the pick keeps the bottle\'s token and its derived pair together (white, not sparkling)', pr?.style === 'white' && pr?.colour === 'white' && pr?.sparkling === false, pr)
}

// ── § 15 Merges on every read, "had a sip" edges ────────────────────────────
async function mergesMore() {
  section('§ 15 merges: vintages, the check-in envelope, "had a sip"; the sip without a linkable source, copyPhoto')
  const H = await mkUser('Host Merge2')
  const s = await createSession(as(H))
  const e = await mintEntry({ producer: `${TAG} VM P`, name: `${TAG} VM W`, colour: 'red', year: 2010 })
  const twin = await prisma.$transaction(async tx => (await import('../../lib/catalogWrite.ts')).createVintage(e.productId, 2011, null, null, tx))
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(e) })
  await prisma.$executeRaw`UPDATE wine_vintages SET status = 'linked', links_to = ${twin.id} WHERE id = ${e.vintageId}`
  const w = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === id)
  const en = w?.entry as Record<string, unknown> | undefined
  check('(15a) a vintage merged away: the entry names the survivor vintage (id and year)', en?.vintageId === twin.id && en?.year === 2011, en)
  const A = await mkUser('Sip Author'), V = await mkUser('Sip Viewer')
  await prisma.follow.createMany({ data: [{ followerId: V.id, followingId: A.id }, { followerId: A.id, followingId: V.id }], skipDuplicates: true })
  const loser = await mintEntry({ producer: `${TAG} SM P`, name: `${TAG} SM Loser`, colour: 'white', year: 2019 })
  const survivor = await mintEntry({ producer: `${TAG} SM Q`, name: `${TAG} SM Survivor`, colour: 'white', year: 2019 })
  const oid = nanoid()
  const c = await postCheckin(as(A), { occurrenceId: oid, ...pick(loser) })
  await prisma.$executeRaw`UPDATE wine_products SET status = 'linked', links_to = ${survivor.productId} WHERE id = ${loser.productId}`
  const replay = await postCheckin(as(A), { occurrenceId: oid, ...pick(loser) })
  check('(15b) the check-in envelope (a replay) names the survivor', replay.status === 200 && (replay.json?.entry as Record<string, unknown> | undefined)?.productId === survivor.productId, [replay.status, replay.json?.entry])
  await resetLimits()
  const sip = nanoid()
  const sp = await postCheckin(as(V), { occurrenceId: sip, copyFromCheckinId: c.json.id })
  const sr = await rowOf(sip)
  check('(15c) "had a sip" of a merged source links the SURVIVOR (and its own year)', sp.status === 201 && sr?.product_id === survivor.productId && sr?.vintage_id === survivor.vintageId, [sp.status, sp.json, sr])
  // A source with nothing linkable left (purged): the sip needs its own link.
  const src2 = await postCheckin(as(A), { occurrenceId: nanoid(), ...pick(await mintEntry({ producer: `${TAG} SP P`, name: `${TAG} SP W`, colour: 'red' })) })
  const srcWine = (await prisma.$queryRaw<{ wine_id: string }[]>`SELECT r.wine_id FROM feed_items fi JOIN ratings r ON r.id = fi.rating_id WHERE fi.id = ${src2.json.id as number}`)[0].wine_id
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id = ${srcWine}`
  await resetLimits()
  const bare = await postCheckin(as(V), { occurrenceId: nanoid(), copyFromCheckinId: src2.json.id })
  check('(15d) a sip of a source with nothing linkable: 400 with the machine-readable code (the web then shows its picker)', bare.status === 400 && bare.json?.code === 'link-required', [bare.status, bare.json])
  const own = await mintEntry({ producer: `${TAG} SP Q`, name: `${TAG} SP Own`, colour: 'red' })
  await resetLimits()
  const linked = nanoid()
  const withLink = await postCheckin(as(V), { occurrenceId: linked, copyFromCheckinId: src2.json.id, ...pick(own) })
  check('(15d) …and with its own pick it posts, linked to that pick', withLink.status === 201 && (await rowOf(linked))?.product_id === own.productId, [withLink.status, withLink.json])
  // copyPhoto: the source's photo is copied unless the sipper replaced it.
  const fi = await prisma.feedItem.findUniqueOrThrow({ where: { id: c.json.id as number }, select: { ratingId: true } })
  await prisma.ratingImage.create({ data: { ratingId: fi.ratingId!, imageUrl: 'https://s3.test/verre/wines/source.png', sortOrder: 0 } })
  await resetLimits()
  const noPhoto = nanoid()
  const np = await postCheckin(as(V), { occurrenceId: noPhoto, copyFromCheckinId: c.json.id, copyPhoto: false })
  const npImgs = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM rating_images ri JOIN ratings r ON r.id = ri.rating_id WHERE r.wine_id = ${noPhoto}`
  check('(15e) copyPhoto: false: the sip posts with the source\'s wine and NO copied photo', np.status === 201 && Number(npImgs[0].n) === 0 && (await rowOf(noPhoto))?.product_id === survivor.productId, [np.status, np.json, npImgs])
  // The check-in PATCH re-link that creates, retried, mints once.
  const cbody = { create: { producer: { name: `${TAG} CK Relink P` }, product: { name: `${TAG} CK Relink W`, sparkling: true } } }
  await resetLimits()
  const k1 = await patchCheckin(as(A), c.json.id as number, cbody)
  await resetLimits()
  const k2 = await patchCheckin(as(A), c.json.id as number, cbody)
  check('(15f) 🔒 a check-in re-link that creates, retried: ONE entry', k1.status === 200 && k2.status === 200 && (await productsNamed(`${TAG} CK Relink W`)) === 1, [k1.status, k2.status])
}

// ── § 16 Codex r1 ───────────────────────────────────────────────────────────
async function codexFixes() {
  section('§ 16 Codex r1: no create on a hidden bottle, exact retries of every create shape, the snapshot on the wire')
  const H = await mkUser('Host Codex', { pro: true })
  const s = await createSession(as(H))
  // (a) a create on a bottle hidden from the caller (Blind for Everyone).
  const mine = { producer: { name: `${TAG} Hidden Mint P` }, product: { name: `${TAG} Hidden Mint W`, colour: 'red' } }
  const hid = nanoid()
  await postWine(s.code, as(H), { id: hid, create: mine })
  await settings(s.code, as(H), { blind: true, blindForEveryone: true })
  await resetLimits()
  // Valid bodies: the matching one would be a replay (no mint), the other a mint.
  const same = await editWine(s.code, as(H), hid, { create: mine })
  const other = await editWine(s.code, as(H), hid, { create: { ...mine, product: { ...mine.product, name: `${TAG} Other` } } })
  check('(16a) 🔒 Blind for Everyone: a create on a hidden bottle answers ONE 400 whether or not it matches the hidden wine, and mints nothing',
    same.status === 400 && other.status === 400 && same.text === other.text && (await productsNamed(`${TAG} Hidden Mint W`)) === 1 && (await productsNamed(`${TAG} Other`)) === 0, [same.status, same.text, other.text])
  await settings(s.code, as(H), { blind: false })
  // (b) an identical retry of each create shape mints once.
  const collab = await prisma.$transaction(tx => createProducer({ name: `${TAG} Collab P` }, null, tx))
  for (const [label, create] of [
    ['vintage grapes', { producer: { name: `${TAG} VG P` }, product: { name: `${TAG} VG W`, colour: 'red', grapes: ['Merlot'] }, year: 2020, vintageGrapes: ['Syrah', 'Grenache'], abv: 14 }],
    ['a collaborator', { producer: { name: `${TAG} CO P` }, product: { name: `${TAG} CO W`, colour: 'white' }, collaboratorIds: [collab.id] }],
    ['a producer website and origin', { producer: { name: `${TAG} WS P`, website: 'example.com', country: 'fr', region: 'Loire' }, product: { name: `${TAG} WS W`, sparkling: true, country: 'FR', region: 'Vouvray' } }],
  ] as const) {
    const id = nanoid()
    await postWine(s.code, as(H), { id, ...pick(await mintEntry({ producer: `${TAG} Seed ${label}`, name: `${TAG} Seed ${label} W`, colour: 'red' })) })
    const name = (create.product as { name: string }).name
    const r1 = await editWine(s.code, as(H), id, { create })
    const link1 = (await rowOf(id))?.product_id
    const r2 = await editWine(s.code, as(H), id, { create })
    check(`(16b) 🔒 an identical retried re-link create with ${label}: ONE entry, the same link`,
      r1.status === 200 && r2.status === 200 && (await productsNamed(name)) === 1 && (await rowOf(id))?.product_id === link1, [r1.status, r2.status, await productsNamed(name)])
  }
  // (c) the snapshot on the wire.
  const rosé = await mintEntry({ producer: `${TAG} Rose P`, name: `${TAG} Rose Fizz`, colour: 'rose', sparkling: true })
  const rid = nanoid()
  await postWine(s.code, as(H), { id: rid, ...pick(rosé) })
  const free = await mintEntry({ producer: `${TAG} Free P`, name: `${TAG} Free W`, colour: 'white', abv: 0.3 })
  const fid = nanoid()
  await postWine(s.code, as(H), { id: fid, ...pick(free) })
  // The entry purged from under the bottle (as a hard purge leaves it).
  const live = await liveRow(s.code)
  await prisma.$executeRaw`UPDATE wines SET product_id = NULL, vintage_id = NULL WHERE id = ${fid}`
  await prisma.$executeRaw`UPDATE sessions SET lineup_revision = lineup_revision + 1 WHERE id = ${live.id}`
  const wl = wiresOf(await winesGet(s.code, as(H)))
  const rw = wl.find(x => x.id === rid), fw = wl.find(x => x.id === fid)
  check('(16c) a sparkling rosé reads colour rosé AND sparkling on the wire (the record\'s snapshot, not the cached token)', rw?.colour === 'rose' && rw?.sparkling === true, rw)
  check('(16c) an alcohol-free bottle whose entry is gone keeps its abv (0.3) and so its derived mark', fw?.entry === null && fw?.abv === 0.3 && fw?.colour === 'white', fw)
  const T = await mkUser('Taster Codex')
  await enter(s.code, as(T), 'Taster Codex')
  await settings(s.code, as(H), { blind: true })
  const bw = wiresOf(await winesGet(s.code, as(T))).find(x => x.id === rid)
  check('(16c) …and on a blind row the rosé keeps colour rosé and sparkling (abv null, entry null)', bw?._blind === true && bw?.colour === 'rose' && bw?.sparkling === true && bw?.abv === null && bw?.entry === null, bw)
}

// ── § 17 Codex r2 ───────────────────────────────────────────────────────────
async function codexFixes2() {
  section('§ 17 Codex r2: the snapshot bound to the served row, the bottle\'s own abv, the mint\'s refusals before a replay')
  // (a) a snapshot whose link moved since the served line-up was read is not used.
  const { wineToWire } = await import('../../lib/session.ts')
  const served = { id: 'bottleBound000000001', name: 'Old Wine', producer: 'Old', vintage: '', grape: '', type: '', image: '', imageUrl: '',
    revealedAt: new Date().toISOString(), productId: 'oldProduct0000000001', vintageId: null } as WineMeta
  const moved = new Map([[served.id, { colour: 'red', sparkling: false, abv: 13.5, productId: 'newProduct0000000001', vintageId: null, revealedAt: served.revealedAt ?? null }]])
  const stale = wineToWire(served, 'u:1', {}, undefined, true, new Map(), moved)
  check('(17a) 🔒 a snapshot from a LATER link (a hide + re-link between the reads) never decorates the served row (no new wine\'s abv)', stale.abv === null && stale.colour === null, stale)
  const bound = wineToWire(served, 'u:1', {}, undefined, true, new Map(), new Map([[served.id, { ...moved.get(served.id)!, productId: 'oldProduct0000000001' }]]))
  check('(17a) …the snapshot of the served link is used', bound.abv === 13.5 && bound.colour === 'red', bound)
  // Codex r3: the SAME link re-picked (its snapshot refreshed from the entry)
  // while the bottle was hidden between the reads: a changed reveal state drops it.
  const hiddenSince = wineToWire(served, 'u:1', {}, undefined, true, new Map(), new Map([[served.id, { ...moved.get(served.id)!, productId: 'oldProduct0000000001', revealedAt: null }]]))
  check('(17a) 🔒 a same-link snapshot refreshed after the bottle was hidden (reveal state changed) is not used either', hiddenSince.abv === null && hiddenSince.colour === null, hiddenSince)
  // (b) a linked bottle shows its own recorded abv (what the badges count).
  const H = await mkUser('Host Codex2')
  const s = await createSession(as(H))
  const e = await mintEntry({ producer: `${TAG} Abv P`, name: `${TAG} Abv W`, colour: 'white', abv: 0.3 })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(e) })
  await prisma.$executeRaw`UPDATE wine_products SET abv = 13 WHERE id = ${e.productId}`
  const w = wiresOf(await winesGet(s.code, as(H))).find(x => x.id === id)
  check('(17b) a linked bottle whose entry\'s abv changed later shows its OWN abv (0.3, alcohol-free, as its badges count)', w?.abv === 0.3 && (w?.entry as Record<string, unknown> | undefined)?.abv === 13, w)
  // (c) a body the mint would refuse is never a replay.
  const pg = { create: { producer: { name: `${TAG} Edge P` }, product: { name: `${TAG} Edge W`, colour: 'red' }, abv: 25 } }
  const bid = nanoid()
  await postWine(s.code, as(H), { id: bid, ...pg })
  for (const bad of [25.001, -0.004]) {
    const r = await editWine(s.code, as(H), bid, { create: { ...pg.create, abv: bad } })
    check(`(17c) a re-link create with abv ${bad} (the stored bottle's fields otherwise): the mint's 400, never a replay`, r.status === 400 && (await productsNamed(`${TAG} Edge W`)) === 1, [r.status, r.json])
  }
  // (d) the category is normalised before the type rule.
  for (const category of [' wine ', '']) {
    const r = await postWine(s.code, as(H), { id: nanoid(), create: { producer: { name: `${TAG} Cat P` }, product: { name: `${TAG} Cat W ${JSON.stringify(category)}`, category } } })
    check(`(17d) category ${JSON.stringify(category)} with no type: 400 (type required), nothing minted`, r.status === 400 && (await productsNamed(`${TAG} Cat W ${JSON.stringify(category)}`)) === 0, [r.status, r.json])
  }
}

// ── § 18 Codex r4: the ownership bypass needs the served row AND the record ──
async function codexFixes4() {
  section('§ 18 Codex r4: a re-link + reassign between the line-up read and the ownership read never unmasks the old bottle')
  const { participantOrBanned } = await import('../../lib/identity.ts')
  const { resolveUser } = await import('../../lib/resolveUser.ts')
  const { buildWinesView } = await import('../../lib/sessionState.ts')
  const H = await mkUser('Host Owner', { pro: true })
  const T = await mkUser('Taster Owner')
  const s = await createSession(as(H))
  await enter(s.code, as(T), 'Taster Owner')
  await settings(s.code, as(H), { blind: true })
  const P = await mintEntry({ producer: `${TAG} Own P`, name: `${TAG} Own Old Wine`, colour: 'red' })
  const Q = await mintEntry({ producer: `${TAG} Own Q`, name: `${TAG} Own New Wine`, colour: 'white' })
  const id = nanoid()
  await postWine(s.code, as(H), { id, ...pick(P) })
  const stale = await redisWines(s.code)   // the line-up a GET read before the writes
  const re = await editWine(s.code, as(H), id, { ...pick(Q) })
  const ra = await editWine(s.code, as(H), id, { broughtByIdentityId: `u:${T.id}` })
  check('fixture: re-linked to Q, then reassigned to the taster', re.status === 200 && ra.status === 200 && (await rowOf(id))?.product_id === Q.productId, [re.status, ra.status, ra.json])
  const req = new NextRequest(`${BASE}/api/session/${s.code}/wines`, { headers: { cookie: T.cookie } })
  const sess = await resolveUser(req)
  const meta = JSON.parse((await redis.get(k.meta(s.code)))!)
  const p = await participantOrBanned(s.code, req, sess, meta)
  const identities = await redis.hGetAll(k.identities(s.code))
  const view = p.status === 'ok' ? await buildWinesView(s.code, meta, p.identity, identities, stale) : []
  const row = view.find(w => w.id === id)
  check('(18a) 🔒 the OLD payload (P, captured before the writes) stays masked for the new owner', p.status === 'ok' && row?._blind === true && !JSON.stringify(view).includes('Own Old Wine') && row?.entry === null, [p.status, row])
  const fresh = p.status === 'ok' ? await buildWinesView(s.code, meta, p.identity, identities, await redisWines(s.code)) : []
  const frow = fresh.find(w => w.id === id)
  check('(18a) …and the current line-up (Q, now theirs) shows it to them (the owner bypass still works)', frow?._blind !== true && frow?.name === `${TAG} Own New Wine`, frow)
}

const SECTIONS: [string, () => Promise<void>][] = [
  ['gate', gate], ['link', linkRequired], ['wire', wire], ['create', create], ['guests', guests], ['vintages', vintages],
  ['blind', blind], ['merges', merges], ['relink', relink], ['interleaved', interleaved], ['checkins', checkins],
  ['badges', badges], ['core', coreRules], ['fixes', reviewFixes], ['merges2', mergesMore], ['codex', codexFixes], ['codex2', codexFixes2], ['codex4', codexFixes4],
]
try {
  for (const [name, fn] of SECTIONS) {
    if (ONLY && name !== ONLY) continue
    try { await fn() } catch (err) { failed++; console.log(`  ❌ § ${name} threw: ${(err as Error)?.stack ?? err}`) }
    noHooks()
  }
} finally {
  noHooks()
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect()
  await redis.quit().catch(() => {})
  process.exit(failed ? 1 : 0)
}
