// § 20 the leak fixes (.local/leak-fixes/plan.md § 5). Imported by
// scripts/tests/you-profile-integration.mts, which owns the throwaway stores,
// the fake S3, the actors and the canary (every response through `call` is
// scanned). Sections:
//   § 20 b moment codes can be guessed (F2): the ROUTE SWEEP (every route under
//          app/api/session/[code]/** + the join POST, a spent budget: the same
//          answer for a wrong, a warm right and a cold right code, nothing
//          rebuilt), members still pass, the budgets per surface and per code
//          length, the atomic charge, the guest-join cap, the kicked bounce,
//          the primitive, the gate's admission query (parity with readGrant +
//          the plan shape)
//   § 20 a /api/places (F1): sign-in, origin, input bounds, the per-caller
//          limits on getClientIp, the app-wide Google cap and the Nominatim
//          gate degrading to [] (fetch stubbed: never called past a gate)
//   § 20 d the block-pair lists the app reads (F5) + § F6 the host's write
//          replies under Blind for All, tags of a viewer's block pair (feed +
//          profile), the grape badge through the outside-a-moment rule
//   § 20 c scripts/rekey-session-images.mts (F3 + F4) on the fake S3
import { nanoid } from 'nanoid'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join as pjoin, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Prisma } from '@prisma/client'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Res = { status: number; json: J; wire: J; headers: Headers }
export type Harness = {
  call: (handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params?: Record<string, string>, extra?: Record<string, string>) => Promise<Res>
  check: (label: string, ok: boolean, detail?: unknown) => void
  section: (t: string) => void
  mkUser: (name: string) => Promise<User>
  createSession: (u: User, name?: string) => Promise<string>
  addWine: (code: string, u: User, name: string) => Promise<{ id: string; url: string }>
  resetLimits: () => Promise<void>
  prisma: any // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  redis: any // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  k: any // eslint-disable-line @typescript-eslint/no-explicit-any -- lib/redis key helpers
  scanKeys: (pattern: string) => Promise<string[]>
  TAG: string
  s3: { store: Set<string>; mtimes: Map<string, number>; puts: string[]; deletes: string[]; urlOf: (key: string) => string; keyOf: (url: string | null | undefined) => string; endpoint: string }
  PNG: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = pjoin(HERE, '..', '..')
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const

export async function leakFixes(h: Harness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, scanKeys, TAG } = h
  const route = await import('../../lib/sessionRoute.ts')
  const { CODE_MISS, openSessionCharged } = route
  const { readGrant, readGateGrant, gateGrantSql } = await import('../../lib/sessionGrant.ts')
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
  const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
  const settingsRoute = await import('../../app/api/session/[code]/settings/route.ts')
  const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
  const previewRoute = await import('../../app/api/session/[code]/preview/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const removedStateRoute = await import('../../app/api/session/[code]/removed-state/route.ts')
  const REAL = { ...CODE_MISS }
  const restoreBudgets = () => Object.assign(CODE_MISS, REAL)

  const taken = new Set<string>()
  async function wrongCode(len = 8): Promise<string> {
    for (;;) {
      let c = ''
      for (let i = 0; i < len; i++) c += CROCKFORD[Math.floor(Math.random() * 32)]
      if (taken.has(c)) continue
      taken.add(c)
      const rows = await prisma.$queryRaw`SELECT 1 FROM sessions WHERE code = ${c}` as unknown[]
      if (rows.length === 0 && !(await redis.exists(k.meta(c)))) return c
    }
  }
  let ipSeq = 0
  const freshIp = () => { ipSeq++; return `10.${(ipSeq >> 8) & 255}.${ipSeq & 255}.7` }
  const xff = (ip: string) => ({ 'x-forwarded-for': ip })
  const userKey = (u: User) => `rl:code-miss:u:${u.id}:1h`
  const ipKey = (ip: string, len = 8) => len === 4 ? `rl:code-miss4:ip:${ip}:1h` : `rl:code-miss:ip:${ip}:1h`
  const count = async (key: string) => Number((await redis.get(key)) ?? 0)
  const spendAddress = async (ip: string) => { await redis.set(ipKey(ip), String(CODE_MISS.ip8), { EX: 3600 }); await redis.set(ipKey(ip, 4), String(CODE_MISS.ip4), { EX: 3600 }) }
  const spendAccount = (u: User) => redis.set(userKey(u), String(CODE_MISS.user), { EX: 3600 })
  const coldWipe = async (code: string) => { const ks = await scanKeys(`s:${code}:*`); if (ks.length) await redis.del(ks) }
  const isGate429 = (r: Res) => r.status === 429 && typeof r.wire?.error === 'string' && r.wire.error.startsWith('Too many codes tried')
  const norm = (r: Res) => `${r.status} ${r.headers.get('x-vr-auth') ?? ''} ${r.headers.get('retry-after') ? 'RA' : ''} ${JSON.stringify(r.wire).replace(/\d+/g, 'N')}`

  // ── the route table: every route.ts under app/api/session/[code]/** + join ──
  const codeDir = pjoin(ROOT, 'app', 'api', 'session', '[code]')
  const files: string[] = []
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = pjoin(d, n); if (statSync(p).isDirectory()) walk(p); else if (n === 'route.ts') files.push(p) } }
  walk(codeDir)
  type Site = { rel: string; method: string; handler: unknown; userScoped: boolean; pathOf: (code: string) => string; params: (code: string) => Record<string, string>; body: (code: string) => unknown }
  const sites: Site[] = []
  for (const f of files.sort()) {
    const mod = await import(pathToFileURL(f).href) as Record<string, unknown>
    const rel = relative(codeDir, dirname(f)).split('\\').join('/')
    for (const m of METHODS) {
      if (typeof mod[m] !== 'function') continue
      const userScoped = rel === 'carousel-hidden' || (rel === 'wines/[wineId]/bookmark' && m === 'DELETE')
      sites.push({
        rel: rel || '.', method: m, handler: mod[m], userScoped,
        pathOf: (code) => `/api/session/${code}${rel ? `/${rel}` : ''}`,
        params: (code) => ({ code, wineId: 'probeWine01', identityId: 'a:0f0e0d0c-0b0a-4908-8706-050403020100' }),
        // Bodies that would trigger the conditional route limiters
        // (catalog-link on the wine POST / PATCH, the cover on settings): with
        // those pre-filled past their max, a limiter moved above the gate would
        // answer its own 429, not the gate's.
        body: () => (rel === 'wines' || rel === 'wines/[wineId]' ? { probe: true, name: 'Probe', type: 'red', productId: 'probe' } : rel === 'settings' ? { coverPhoto: h.PNG } : { probe: true }),
      })
    }
  }
  sites.push({ rel: 'join', method: 'POST', handler: joinRoute.POST, userScoped: false, pathOf: () => '/api/session/join', params: () => ({}), body: (code) => ({ code, displayName: 'Probe' }) })
  const fillPath = (s: Site, code: string) => s.pathOf(code).replace('[wineId]', 'probeWine01').replace('[identityId]', 'a:0f0e0d0c-0b0a-4908-8706-050403020100')
  const bodyOf = (s: Site, code: string) => s.method === 'GET' ? undefined : s.body(code)
  const hit = (s: Site, code: string, actor: Actor, ip: string) => call(s.handler, s.method, fillPath(s, code), actor, bodyOf(s, code), s.params(code), xff(ip))
  // Answers that come BEFORE the gate and are the same for every code: a
  // signed-out caller on the routes that need a signed-in one.
  const preGate = (s: Site, actor: Actor) => !actor.cookie && (s.rel === 'visit' || s.rel === 'preview' || (s.rel === 'wines/[wineId]/bookmark' && s.method === 'POST'))

  // ── § 20 b the route sweep ────────────────────────────────────────────────
  section('§ 20 b moment codes (F2): the route sweep, a spent budget')
  check(`the route table: ${sites.length} handlers (${files.length} route files under [code] + the join POST)`, files.length >= 22 && sites.length >= 30, sites.map(s => `${s.method} ${s.rel}`))
  const Hs = await mkUser('Sweep Host'), Us = await mkUser('Sweep Stranger')
  const warm = await createSession(Hs, 'Sweep Host')
  await addWine(warm, Hs, `${TAG} sweep wine`)
  const cold = await createSession(Hs, 'Sweep Host')
  const other = await createSession(Hs, 'Sweep Host')
  await resetLimits()
  const otherGuest = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: other, displayName: 'Elsewhere' })
  const otherTok = otherGuest.wire.anonToken as string
  check('fixture: a guest token from ANOTHER moment', otherGuest.status === 200 && !!otherTok)
  await coldWipe(cold)
  const actors: [string, Actor][] = [
    ['signed out', {}], ['signed out + another moment\'s token', { anon: otherTok }],
    ['signed-in stranger (app bearer)', { cookie: Us.cookie }], ['signed-in stranger + another moment\'s token', { cookie: Us.cookie, anon: otherTok }],
  ]
  const sweep = async (label: string, ip: string, who: [string, Actor][]) => {
    const diffs: string[] = [], not429: string[] = []
    for (const s of sites) {
      for (const [an, actor] of who) {
        const answers = [await hit(s, await wrongCode(), actor, ip), await hit(s, warm, actor, ip), await hit(s, cold, actor, ip)]
        const n = answers.map(norm)
        if (n[0] !== n[1] || n[1] !== n[2]) diffs.push(`${s.method} ${s.rel} as ${an}: ${n.join(' | ')}`)
        if (!s.userScoped && !preGate(s, actor) && !answers.every(isGate429)) not429.push(`${s.method} ${s.rel} as ${an}: ${n[0]}`)
      }
    }
    check(`🔒 ${label}: every handler answers a wrong, a warm right and a cold right code byte-identically (status + body, the wait normalised)`, diffs.length === 0, diffs.slice(0, 6))
    check(`🔒 ${label}: …and that answer is the gate's 429 (user-scoped carousel-hidden + bookmark DELETE, and a signed-out caller's 401 / no-op on visit, preview, bookmark: identical only)`, not429.length === 0, not429.slice(0, 6))
  }
  await resetLimits()
  const ipA = freshIp()
  await spendAddress(ipA)
  // Every route limiter the sweep's actors could reach, pre-filled past its
  // max ("each route called past its own largest limit"): reached BEFORE the
  // gate, it would answer its own 429 for every code class, not the gate's.
  const routeLimits: [string, number][] = [
    [`rl:catalog-link:u:${Us.id}:1h`, 120], [`rl:catalog-link:ip:${ipA}:1h`, 120], [`rl:cover:user:${Us.id}:1h`, 10],
    [`rl:sessban:u:${Us.id}:10m`, 60], [`rl:sessleave:u:${Us.id}:10m`, 20], [`rl:removed-state:u:${Us.id}:1m`, 10],
  ]
  for (const [key, max] of routeLimits) await redis.set(key, String(max), { EX: 600 })
  await sweep('the ADDRESS budget spent (signed out + signed in, with and without a foreign guest token)', ipA, actors)
  const allowed = ['rl:code-miss', 'rl:native-lastseen', 'rl:moment-preview', 'rl:carousel-hidden', ...routeLimits.map(([key]) => key)]
  const untouched = (await Promise.all(routeLimits.map(async ([key, max]) => Number(await redis.get(key)) === max))).every(Boolean)
  check('🔒 …the pre-filled route limiters were never charged (the gate answered first)', untouched)
  let strays = (await scanKeys('rl:*')).filter(x => !allowed.some(p => x.startsWith(p)))
  check('🔒 no route limiter, promotion or contract ran before the gate (no rl: key but the code-miss family, the last-seen bump, the preview\'s own budget, carousel-hidden)', strays.length === 0, strays)
  await resetLimits()
  const ipB = freshIp()
  await spendAccount(Us)
  await sweep('the ACCOUNT budget spent (a fresh address)', ipB, actors.slice(2))
  check('🔒 …and the fresh address was never charged by the refused calls', (await count(ipKey(ipB))) === 0)
  strays = (await scanKeys('rl:*')).filter(x => !allowed.some(p => x.startsWith(p)))
  check('🔒 …no stray limiter either', strays.length === 0, strays)
  // The preview's own budget runs before the gate (it charges every lookup, the
  // same for every code): past it, still the same answer for every code.
  await redis.set(`rl:moment-preview:u:${Us.id}:1h`, '60', { EX: 3600 })
  const pv = await Promise.all([await wrongCode(), warm, cold].map(c => call(previewRoute.GET, 'GET', `/api/session/${c}/preview`, Us, undefined, { code: c }, xff(ipB))))
  check('the preview past its own limit: the same 429 for every code class', pv.every(r => r.status === 429) && new Set(pv.map(norm)).size === 1, pv.map(norm))
  // A parallel burst on the two registering routes, then the cold moment.
  await resetLimits()
  await spendAddress(ipA)
  const visitSite = sites.find(s => s.rel === 'visit')!, joinSite = sites.find(s => s.rel === 'join')!
  for (const s of [visitSite, joinSite]) {
    const burst = await Promise.all([...Array(20)].flatMap(() => [wrongCode().then(c => hit(s, c, { cookie: Us.cookie }, ipA)), hit(s, warm, { cookie: Us.cookie }, ipA), hit(s, cold, { cookie: Us.cookie }, ipA)]))
    check(`🔒 a parallel burst of 20 × 3 classes on ${s.rel}: every answer the same gate 429`, burst.every(isGate429) && new Set(burst.map(norm)).size === 1, [...new Set(burst.map(norm))])
  }
  check('🔒 the cold moment is STILL cold (nothing rebuilt it: no meta, no line-up)', !(await redis.exists(k.meta(cold))) && !(await redis.exists(k.wines(cold))))
  check('🔒 …and nobody was registered in the warm one by the burst', !(await redis.hExists(k.identities(warm), `u:${Us.id}`)))

  // 🔒 A burst on a NOT-yet-spent budget (security review P1): the miss is
  // reserved before the open, so with one slot left a parallel burst of right
  // and wrong codes gets at most one request past the entrance; before, every
  // request read "not spent" and every right code answered its route's 401.
  const rights: string[] = []
  for (let i = 0; i < 8; i++) rights.push(await createSession(Hs, 'Sweep Host'))
  await resetLimits()
  const ipR = freshIp()
  await redis.set(userKey(Us), String(CODE_MISS.user - 1), { EX: 3600 })
  const stateSite = sites.find(s => s.rel === 'state')!
  const mixed = await Promise.all([...rights, ...(await Promise.all([...Array(8)].map(() => wrongCode())))].map(c => hit(stateSite, c, { cookie: Us.cookie }, ipR)))
  const passed = mixed.filter(r => !isGate429(r))
  check('🔒 one slot left, a parallel burst of 8 right + 8 wrong codes: at most ONE answer gets past the gate (every other is the gate 429)', passed.length <= 1, mixed.map(r => r.status))
  check('…and the counter never ends above its max', (await count(userKey(Us))) <= CODE_MISS.user)

  // Members pass on every route with the budget spent (the app bearer, a guest token).
  const Hm = await mkUser('Member Host')
  const mm = await createSession(Hm, 'Member Host')
  const mWine = await addWine(mm, Hm, `${TAG} member wine`)
  await resetLimits()
  const gj = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: mm, displayName: 'Guesty' })
  const gTok = gj.wire.anonToken as string
  await resetLimits()
  const ipM = freshIp()
  await spendAddress(ipM)
  await spendAccount(Hm)
  const blocked: string[] = []
  const memberSites = [...sites].sort((a, b) => Number(a.rel === '.' && a.method === 'DELETE') - Number(b.rel === '.' && b.method === 'DELETE'))
  for (const [an, actor] of [['guest (token)', { anon: gTok }], ['host (app bearer)', { cookie: Hm.cookie }]] as [string, Actor][]) {
    for (const s of memberSites) {
      if (an.startsWith('guest') && s.rel === '.' && s.method === 'DELETE') continue
      const path = s.pathOf(mm).replace('[wineId]', mWine.id).replace('[identityId]', String(gj.wire.id))
      const r = await call(s.handler, s.method, path, actor, bodyOf(s, mm), { code: mm, wineId: mWine.id, identityId: String(gj.wire.id) }, xff(ipM))
      if (isGate429(r)) blocked.push(`${s.method} ${s.rel} as ${an}`)
    }
  }
  check('🔒 members pass the gate on EVERY route with the address AND the account spent (guest token, app bearer)', blocked.length === 0, blocked)

  // ── § 20 b the budgets, per surface ───────────────────────────────────────
  section('§ 20 b the wrong-code budgets: per surface, per code length, atomic, never reset')
  const Hb = await mkUser('Budget Host')
  const right = await createSession(Hb, 'Budget Host')
  await addWine(right, Hb, `${TAG} budget wine`)
  const surfaces: [string, (code: string, u: Actor, ip: string) => Promise<Res>][] = [
    ['state GET', (c, u, ip) => call(stateRoute.GET, 'GET', `/api/session/${c}/state`, u, undefined, { code: c }, xff(ip))],
    ['wines POST (a write)', (c, u, ip) => call(winesRoute.POST, 'POST', `/api/session/${c}/wines`, u, { name: 'x' }, { code: c }, xff(ip))],
    ['settings PATCH (openAsParticipant)', (c, u, ip) => call(settingsRoute.PATCH, 'PATCH', `/api/session/${c}/settings`, u, {}, { code: c }, xff(ip))],
    ['/visit', (c, u, ip) => call(visitRoute.POST, 'POST', `/api/session/${c}/visit`, u, undefined, { code: c }, xff(ip))],
    ['join POST', (c, u, ip) => call(joinRoute.POST, 'POST', '/api/session/join', u, { code: c, displayName: 'Typo' }, {}, xff(ip))],
    ['preview', (c, u, ip) => call(previewRoute.GET, 'GET', `/api/session/${c}/preview`, u, undefined, { code: c }, xff(ip))],
  ]
  CODE_MISS.user = 3
  try {
  for (const [name, go] of surfaces) {
    await resetLimits()
    const u = await mkUser('Typo Person')
    await resetLimits()
    const ip = freshIp()
    const first = await go(await wrongCode(), u, ip)
    const charged = (await count(userKey(u))) === 1 && (await count(ipKey(ip))) === 1
    const r = await go(right, u, ip)
    const rightFree = (await count(userKey(u))) === 1 && (await count(ipKey(ip))) === 1 && !isGate429(r)
    const more = [await go(await wrongCode(), u, ip), await go(await wrongCode(), u, ip), await go(await wrongCode(), u, ip)]
    check(`${name}: a wrong code → 404 and charges the account + the address once; a right code charges nothing; the (max+1)th different wrong code → the gate's 429`,
      first.status === 404 && charged && rightFree && more[0].status === 404 && more[1].status === 404 && isGate429(more[2]) && Number(more[2].headers.get('retry-after')) > 0,
      { first: first.status, charged, rightFree, more: more.map(x => x.status) })
  }
  } finally { restoreBudgets() }

  // Real numbers on one surface: the 61st different wrong code per account.
  const state = surfaces[0][1]
  await resetLimits()
  const U60 = await mkUser('Sixty Typos')
  await resetLimits()
  const ip60 = freshIp()
  const sixty: number[] = []
  for (let i = 0; i < 60; i++) sixty.push((await state(await wrongCode(), U60, ip60)).status)
  const sixtyFirst = await state(await wrongCode(), U60, ip60)
  check('🔒 60 different wrong codes per account → 404, the 61st → 429 (+ Retry-After, the wait in the body)', sixty.every(s => s === 404) && isGate429(sixtyFirst) && sixtyFirst.wire.retryAfter > 0 && /Try again in \d+ minutes?\./.test(sixtyFirst.wire.error), sixtyFirst.wire)
  check('…and the account is spent for a right code too, as a stranger', isGate429(await state(right, U60, ip60)))

  // A parallel burst of 100 different wrong codes: exactly 60 404s.
  await resetLimits()
  const Ub = await mkUser('Burst Typos')
  await resetLimits()
  const ipBurst = freshIp()
  const burst = await Promise.all(await Promise.all([...Array(100)].map(async () => state(await wrongCode(), Ub, ipBurst))))
  check('🔒 a parallel burst of 100 different wrong codes → exactly 60 × 404, 40 × 429, the account AND the address counter at 60 (the refused 40 incremented nothing)', burst.filter(r => r.status === 404).length === 60 && burst.filter(isGate429).length === 40 && (await count(userKey(Ub))) === 60 && (await count(ipKey(ipBurst))) === 60, { n404: burst.filter(r => r.status === 404).length, ip: await count(ipKey(ipBurst)) })
  // The same wrong code, 100 times: one charge.
  await resetLimits()
  const Us1 = await mkUser('Same Typo')
  await resetLimits()
  const ipSame = freshIp()
  const same = await wrongCode()
  const seq = []
  for (let i = 0; i < 50; i++) seq.push(await state(same, Us1, ipSame))
  const par = await Promise.all([...Array(50)].map(() => state(same, Us1, ipSame)))
  check('🔒 the same wrong code asked 100 times (50 sequential, 50 parallel) → 100 × 404, charged ONCE (account and address)', [...seq, ...par].every(r => r.status === 404) && (await count(userKey(Us1))) === 1 && (await count(ipKey(ipSame))) === 1)
  // Duplicate pairs near exhaustion never yield a free 404.
  await resetLimits()
  const Ud = await mkUser('Dup Typos')
  await resetLimits()
  const ipDup = freshIp()
  await redis.set(userKey(Ud), '58', { EX: 3600 })
  const dupCodes = await Promise.all([...Array(12)].map(() => wrongCode()))
  const dup = await Promise.all(dupCodes.flatMap(c => [state(c, Ud, ipDup).then(r => [c, r] as const), state(c, Ud, ipDup).then(r => [c, r] as const)]))
  const answered404 = new Set(dup.filter(([, r]) => r.status === 404).map(([c]) => c))
  const dupCount = await count(userKey(Ud))
  check('🔒 12 different codes × 2 in parallel with 2 left: at most 2 codes answer 404, each charged exactly once (counter = 58 + those codes), every other answer the gate 429',
    answered404.size >= 1 && answered404.size <= 2 && dupCount === 58 + answered404.size && dup.every(([c, r]) => r.status === 404 ? answered404.has(c) : isGate429(r)), { n: answered404.size, c: dupCount })
  // A spent ACCOUNT doesn't push the address counter.
  await resetLimits()
  const ipFresh = freshIp()
  await spendAccount(Ud)
  const spentAcc = await Promise.all([...Array(5)].map(async () => state(await wrongCode(), Ud, ipFresh)))
  check('🔒 a spent account: 5 wrong codes → 429, the address counter untouched', spentAcc.every(isGate429) && (await count(ipKey(ipFresh))) === 0)
  // A code this caller already paid for answers 404 again on a spent budget
  // (a deleted moment's open screen reads "gone", not "too many codes").
  await resetLimits()
  const Usn = await mkUser('Seen Typo')
  await resetLimits()
  const ipSeen = freshIp()
  const seenCode = await wrongCode()
  const s1 = await state(seenCode, Usn, ipSeen)
  await spendAccount(Usn)
  const s2 = await state(seenCode, Usn, ipSeen), s3 = await state(await wrongCode(), Usn, ipSeen)
  check('a code already paid for → 404 again on the spent budget (no second charge); a new wrong code → 429', s1.status === 404 && s2.status === 404 && isGate429(s3) && (await count(userKey(Usn))) === CODE_MISS.user)
  // The Lua steps directly: a spent account never pushes the address counter;
  // one slot left, 20 parallel reservations → exactly one.
  const { reserveMiss, settleMiss } = await import('../../lib/rateLimit.ts')
  await resetLimits()
  const ctr = (a: number, b: number) => [{ key: 'rl:code-miss:ip:unit:1h', max: b }, { key: 'rl:code-miss:u:unit:1h', max: a }]
  await redis.set('rl:code-miss:u:unit:1h', '5', { EX: 3600 })
  const rs = await reserveMiss('rl:code-miss:seen:unit:A', ctr(5, 100), CODE_MISS)
  check('reserveMiss: the account at its max → spent (naming that key), the address counter not incremented', rs?.outcome === 'spent' && rs.key === 'rl:code-miss:u:unit:1h' && (await count('rl:code-miss:ip:unit:1h')) === 0, rs)
  await redis.set('rl:code-miss:u:unit:1h', '4', { EX: 3600 })
  const many = await Promise.all([...Array(20)].map((_, i) => reserveMiss(`rl:code-miss:seen:unit:B${i}`, ctr(5, 100), CODE_MISS)))
  check('reserveMiss: one slot left, 20 parallel reservations → exactly 1 reserved', many.filter(x => x?.outcome === 'reserved').length === 1 && (await count('rl:code-miss:u:unit:1h')) === 5)
  const refunded = await settleMiss('rl:code-miss:seen:unit:B0', ctr(5, 100), false, CODE_MISS)
  check('settleMiss: a right code is refunded (both counters back, never below 0)', refunded === 'refunded' && (await count('rl:code-miss:u:unit:1h')) === 4 && (await count('rl:code-miss:ip:unit:1h')) === 0)
  await redis.del(['rl:code-miss:u:unit:1h', 'rl:code-miss:ip:unit:1h'])
  // A failed open (a rebuild that throws: a Postgres blip) refunds its
  // reservation: a member polling a cold moment must not leak a charge per poll.
  const { mutationHooks } = await import('../../lib/sessionMutation.ts')
  const Hf = await mkUser('Failing Host')
  const failing = await createSession(Hf, 'Failing Host')
  await coldWipe(failing)
  await resetLimits()
  const ipFail = freshIp()
  const prevHook = mutationHooks.at
  mutationHooks.at = async (point, c, label) => { if (point === 'beforeLock' && c === failing && label === 'rebuild') throw new Error('injected rebuild failure') }
  let threw = false
  try { await openSessionCharged(failing, { userId: Hf.id, ip: ipFail, identity: async () => `u:${Hf.id}` }) } catch { threw = true } finally { mutationHooks.at = prevHook }
  check('a failed open refunds its reservation (both counters back at 0, no seen marker)', threw && (await count(userKey(Hf))) === 0 && (await count(ipKey(ipFail))) === 0 && (await scanKeys('rl:code-miss:seen:*')).length === 0)
  // Malformed codes are free (the format is public).
  await resetLimits()
  const mal = await call(stateRoute.GET, 'GET', '/api/session/xx!/state', Ud, undefined, { code: 'xx!' }, xff(ipFresh))
  check('a malformed code → 404, charged nothing', mal.status === 404 && (await scanKeys('rl:code-miss*')).length === 0)
  // A participant's polls never charge; a success no longer resets.
  await resetLimits()
  const ipPoll = freshIp()
  for (let i = 0; i < 5; i++) await state(right, Hb, ipPoll)
  check('a participant\'s polls never charge (each reservation refunded: both counters at 0, no seen marker)',
    (await count(userKey(Hb))) === 0 && (await count(ipKey(ipPoll))) === 0 && (await scanKeys('rl:code-miss:seen:*')).length === 0)
  const Ur = await mkUser('Rejoiner')
  await resetLimits()
  const ipRe = freshIp()
  await state(await wrongCode(), Ur, ipRe); await state(await wrongCode(), Ur, ipRe)
  await redis.set(`rl:join:ip:${ipRe}:1m`, '5', { EX: 60 })
  const ok = await call(joinRoute.POST, 'POST', '/api/session/join', Ur, { code: right, displayName: 'Rejoiner' }, {}, xff(ipRe))
  check('🔒 a successful join resets nothing: the wrong-code counter stays 2, the failed-attempts counter stays 5', ok.status === 200 && (await count(userKey(Ur))) === 2 && (await count(ipKey(ipRe))) === 2 && (await count(`rl:join:ip:${ipRe}:1m`)) === 5)
  // The address budgets split by code length.
  await resetLimits()
  const ip4 = freshIp()
  const fours: number[] = []
  for (let i = 0; i < 300; i++) fours.push((await state(await wrongCode(4), {}, ip4)).status)
  const f301 = await state(await wrongCode(4), {}, ip4)
  const eightStill = await state(await wrongCode(8), {}, ip4)
  check('🔒 300 different wrong 4-character codes from one address → 404, the 301st → 429, while an 8-character code from the same address still passes (404)', fours.every(s => s === 404) && isGate429(f301) && eightStill.status === 404)
  CODE_MISS.ip8 = 10
  try {
  await resetLimits()
  const ip8 = freshIp()
  const eights: number[] = []
  for (let i = 0; i < 10; i++) eights.push((await state(await wrongCode(8), {}, ip8)).status)
  const e11 = await state(await wrongCode(8), {}, ip8)
  const fourStill = await state(await wrongCode(4), {}, ip8)
  check('🔒 the 8-character class at its own limit (lowered to 10): the 11th → 429, a 4-character code still passes', eights.every(s => s === 404) && isGate429(e11) && fourStill.status === 404)
  } finally { restoreBudgets() }

  // Joins: logged-in joins are never capped by address; guests per address per moment.
  await resetLimits()
  const crowd: User[] = []
  for (let i = 0; i < 61; i++) crowd.push(await mkUser(`Crowd ${i}`))
  await resetLimits()
  const ipVenue = freshIp()
  const crowdJoins = await Promise.all(crowd.map(u => call(joinRoute.POST, 'POST', '/api/session/join', u, { code: right, displayName: 'Crowd' }, {}, xff(ipVenue))))
  check('61 logged-in joins of one moment from one address all succeed', crowdJoins.every(r => r.status === 200), crowdJoins.map(r => r.status).filter(s => s !== 200))
  await resetLimits()
  const ipG = freshIp()
  const guests: number[] = []
  for (let i = 0; i < 60; i++) guests.push((await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: `G${i}` }, {}, xff(ipG))).status)
  const g61 = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: 'G61' }, {}, xff(ipG))
  const gElse = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: 'Elsewhere' }, {}, xff(freshIp()))
  // In parallel too: the cap is reserved before the join, so a burst can't overshoot it.
  const ipGp = freshIp()
  const gp = await Promise.all([...Array(64)].map((_, i) => call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: `P${i}` }, {}, xff(ipGp))))
  check('a parallel burst of 64 guest joins from one address: at most 60 go through, the rest 429 (or busy), the counter never above 60', gp.filter(r => r.status === 200).length <= 60 && gp.every(r => [200, 429, 503].includes(r.status)) && (await count(`rl:join:anon:${right}:ip:${ipGp}:10m`)) <= 60, { ok: gp.filter(r => r.status === 200).length, statuses: [...new Set(gp.map(r => r.status))], c: await count(`rl:join:anon:${right}:ip:${ipGp}:10m`) })
  const ipGf = freshIp()
  await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: '' }, {}, xff(ipGf))
  const noCharge = !(await redis.exists(`rl:join:anon:${right}:ip:${ipGf}:10m`))
  // A join that doesn't go through (the moment busy: its lock held) is refunded.
  const { acquireSessionLock, releaseSessionLock } = await import('../../lib/sessionLock.ts')
  const held = (await acquireSessionLock(right))!
  const busy = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: 'Busy Guest' }, {}, xff(ipGf))
  await releaseSessionLock(right, held)
  const afterBusy = await count(`rl:join:anon:${right}:ip:${ipGf}:10m`)
  await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: 'Ok Guest' }, {}, xff(ipGf))
  check('the guest-join cap is charged only by a guest join that went through (a bad name costs nothing, a busy 503 is refunded, a real join counts 1)',
    noCharge && busy.status === 503 && afterBusy === 0 && (await count(`rl:join:anon:${right}:ip:${ipGf}:10m`)) === 1, { busy: busy.status, afterBusy })
  check('the 61st guest join of one moment from one address in 10 min → 429, a guest from another address still joins', guests.every(s => s === 200) && g61.status === 429 && /Too many guests/.test(g61.wire.error) && gElse.status === 200, { g61: g61.wire, gElse: gElse.status })
  await resetLimits()
  const ipF = freshIp()
  const fails = []
  for (let i = 0; i < 31; i++) fails.push(await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: right, displayName: '' }, {}, xff(ipF)))
  check('failed joins (a bad name): 30 per minute per address, charged on failures, then 429', fails.slice(0, 30).every(r => r.status === 400) && fails[30].status === 429 && /Too many join attempts/.test(fails[30].wire.error))

  // A kicked member on a spent address reaches RemovedView without a loop.
  await resetLimits()
  const Hk = await mkUser('Kick Host'), Uk = await mkUser('Kicked User')
  const mk = await createSession(Hk, 'Kick Host')
  await resetLimits()
  await call(joinRoute.POST, 'POST', '/api/session/join', Uk, { code: mk, displayName: 'Kicked User' })
  const gk = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: mk, displayName: 'Kicked Guest' })
  const ukWire = `u:${Uk.pid}`
  const kick1 = await call(bansRoute.POST, 'POST', `/api/session/${mk}/bans`, Hk, { identityId: ukWire, mode: 'kick' }, { code: mk })
  const kick2 = await call(bansRoute.POST, 'POST', `/api/session/${mk}/bans`, Hk, { identityId: gk.wire.id, mode: 'kick' }, { code: mk })
  check('fixture: a signed-in member and a guest kicked', kick1.status === 200 && kick2.status === 200, [kick1.wire, kick2.wire])
  await resetLimits()
  const ipK = freshIp()
  await spendAddress(ipK)
  const kGuest: Actor = { anon: gk.wire.anonToken }
  const st1 = await call(stateRoute.GET, 'GET', `/api/session/${mk}/state`, Uk, undefined, { code: mk }, xff(ipK))
  const st2 = await call(stateRoute.GET, 'GET', `/api/session/${mk}/state`, kGuest, undefined, { code: mk }, xff(ipK))
  const rs1 = await call(removedStateRoute.GET, 'GET', `/api/session/${mk}/removed-state`, Uk, undefined, { code: mk }, xff(ipK))
  const rs2 = await call(removedStateRoute.GET, 'GET', `/api/session/${mk}/removed-state`, kGuest, undefined, { code: mk }, xff(ipK))
  check('🔒 kicked on a spent address: the moment answers `removed` (signed in + guest), removed-state answers kicked for both (the gate admits a former member)',
    st1.status === 401 && st1.headers.get('x-vr-auth') === 'removed' && st2.status === 401 && st2.headers.get('x-vr-auth') === 'removed' && rs1.wire.state === 'kicked' && rs2.wire.state === 'kicked', [st1.status, st2.status, rs1.wire, rs2.wire])
  // Banned (signed in + guest): admitted too, so they get the `removed` bounce and RemovedView says banned.
  await resetLimits()
  const Ub2 = await mkUser('Banned User')
  await resetLimits()
  await call(joinRoute.POST, 'POST', '/api/session/join', Ub2, { code: mk, displayName: 'Banned User' })
  const gb = await call(joinRoute.POST, 'POST', '/api/session/join', {}, { code: mk, displayName: 'Banned Guest' })
  await call(bansRoute.POST, 'POST', `/api/session/${mk}/bans`, Hk, { identityId: `u:${Ub2.pid}`, mode: 'ban' }, { code: mk })
  await call(bansRoute.POST, 'POST', `/api/session/${mk}/bans`, Hk, { identityId: gb.wire.id, mode: 'ban' }, { code: mk })
  await spendAddress(ipK)
  const bGuest: Actor = { anon: gb.wire.anonToken }
  const bs = await Promise.all([Ub2 as Actor, bGuest].map(a => call(stateRoute.GET, 'GET', `/api/session/${mk}/state`, a, undefined, { code: mk }, xff(ipK))))
  const br = await Promise.all([Ub2 as Actor, bGuest].map(a => call(removedStateRoute.GET, 'GET', `/api/session/${mk}/removed-state`, a, undefined, { code: mk }, xff(ipK))))
  check('🔒 banned on a spent address (signed in + guest): the moment answers `removed`, removed-state says banned (the gate admits a banned former member)',
    bs.every(r => r.status === 401 && r.headers.get('x-vr-auth') === 'removed') && br.every(r => r.wire.state === 'banned'), [bs.map(r => r.status), br.map(r => r.wire)])
  // The cache's 'host' branch: a guest-hosted moment's strict host whose roster entry was evicted.
  await resetLimits()
  const anonHosted = await call((await import('../../app/api/session/route.ts')).POST, 'POST', '/api/session', {}, { hostDisplayName: 'Anon Host', sessionName: `${TAG} anon-hosted`, dateFrom: new Date(Date.now() + 3600_000).toISOString() })
  await redis.del(k.identities(anonHosted.wire.code))
  await spendAddress(ipK)
  const hostOpen = await openSessionCharged(anonHosted.wire.code, { userId: null, ip: ipK, identity: async () => String(anonHosted.wire.id) })
  const strangerOpen = await openSessionCharged(anonHosted.wire.code, { userId: null, ip: ipK, identity: async () => null })
  check('the cache\'s meta-proven host (roster evicted) is admitted on a spent address, a stranger is not', hostOpen.status === 'live' && strangerOpen.status === 'limited', [hostOpen.status, strangerOpen.status])
  const pageUser = await openSessionCharged(mk, { userId: Uk.id, ip: ipK, identity: async () => `u:${Uk.id}` })
  const pageGuest = await openSessionCharged(mk, { userId: null, ip: ipK, identity: async () => null })
  check('the join page\'s primitive: the kicked user is admitted (live → RemovedView); a guest is unknown there → limited (RemovedView on ?removed=1, its own call decides with the token)', pageUser.status === 'live' && pageGuest.status === 'limited')

  // The primitive directly.
  await resetLimits()
  const Up = await mkUser('Primitive Stranger')
  await resetLimits()
  const ipP = freshIp()
  const p1 = await openSessionCharged(await wrongCode(), { userId: Up.id, ip: ipP, identity: async () => `u:${Up.id}` })
  const p1charged = (await count(userKey(Up))) === 1 && (await count(ipKey(ipP))) === 1
  const p2 = await openSessionCharged(right, { userId: Up.id, ip: ipP, identity: async () => `u:${Up.id}` })
  await spendAccount(Up)
  const p3 = await openSessionCharged(right, { userId: Up.id, ip: ipP, identity: async () => `u:${Up.id}` })
  await spendAccount(Hb)
  const p4 = await openSessionCharged(right, { userId: Hb.id, ip: ipP, identity: async () => `u:${Hb.id}` })
  await spendAddress(ipP)
  const p5 = await openSessionCharged(right, { userId: Hb.id, ip: ipP, identity: async () => `u:${Hb.id}` })
  const p6 = await openSessionCharged(await wrongCode(), { userId: null, ip: ipP, identity: async () => null })
  check('openSessionCharged: a wrong code → absent (charged once, account + address), a right code → live; spent: a stranger → limited, the host → live (its account spent, then the address too), a signed-out wrong code → limited',
    p1.status === 'absent' && p1charged && p2.status === 'live' && p3.status === 'limited' && p4.status === 'live' && p5.status === 'live' && p6.status === 'limited', [p1.status, p1charged, p2.status, p3.status, p4.status, p5.status, p6.status])

  // ── the gate's admission query: parity with readGrant + the plan shape ──
  section('§ 20 b the gate\'s admission query (lib/sessionGrant.ts readGateGrant)')
  const Hq = await mkUser('Parity Host'), Mq = await mkUser('Parity Member'), Aq = await mkUser('Parity Author'), Kq = await mkUser('Parity Kicked'), Bq = await mkUser('Parity Banned'), Sq = await mkUser('Parity Stranger')
  const pq = await createSession(Hq, 'Parity Host')
  const pqWine = await addWine(pq, Hq, `${TAG} parity`)
  const [prow] = await prisma.$queryRaw`SELECT id FROM sessions WHERE code = ${pq}` as { id: number }[]
  await prisma.$executeRaw`INSERT INTO session_members (session_code, user_id, role) VALUES (${pq}, ${Mq.id}, 'taster'), (${pq}, ${Kq.id}, 'taster')`
  await prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE session_code = ${pq} AND user_id = ${Kq.id}`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${pqWine.id}, ${Aq.id}, ${prow.id}, 'session', 'Author', 3, now())`
  await prisma.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${pq}, ${`u:${Bq.id}`})`
  await resetLimits()
  const anonOnly = await call((await import('../../app/api/session/route.ts')).POST, 'POST', '/api/session', {}, { hostDisplayName: 'Anon', sessionName: `${TAG} guest-only`, dateFrom: new Date(Date.now() + 3600_000).toISOString() })
  const gone = await createSession(Hq, 'Parity Host')
  await prisma.$executeRaw`UPDATE sessions SET deleted_at = now(), code = NULL WHERE code = ${gone}`
  const fixtures: [string, string, number | null][] = [
    ['strict host', pq, Hq.id], ['member', pq, Mq.id], ['rating author', pq, Aq.id], ['kicked', pq, Kq.id], ['banned', pq, Bq.id], ['stranger', pq, Sq.id],
    ['guest-only moment (no row)', anonOnly.wire.code, Mq.id], ['deleted moment', gone, Hq.id], ['a wrong code', await wrongCode(), Mq.id],
  ]
  const parity: string[] = []
  for (const [label, code, uid] of fixtures) {
    const a = await readGrant(prisma, code, uid as number)
    const b = await readGateGrant(prisma, code, uid)
    if (JSON.stringify(a) !== JSON.stringify(b)) parity.push(`${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
  check('🔒 readGateGrant == readGrant on every fixture (strict host, member, rating author, kicked, banned, stranger, no row: guest-only / deleted / wrong)', parity.length === 0, parity)
  const nullUser = await readGateGrant(prisma, pq, null)
  check('a NULL user (guest / signed out) matches nothing: the row, no member / author / ban / host', !!nullUser && !nullUser.member && !nullUser.author && !nullUser.banned && !nullUser.strictHost && !nullUser.kicked)
  const shape = async (code: string, uid: number | null) => {
    const [row] = await prisma.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${gateGrantSql(code, uid)}`) as { 'QUERY PLAN': unknown }[]
    const tree = (n: J): string => `${n['Node Type']}${n['Index Name'] ? `[${n['Index Name']}]` : ''}(${((n.Plans as J[]) ?? []).map(tree).join(',')})`
    return tree(((row['QUERY PLAN'] as J[])[0]).Plan as J)
  }
  const shapes = [await shape(pq, Mq.id), await shape(await wrongCode(), Mq.id), await shape(pq, null), await shape(await wrongCode(), null)]
  // Executed, not just planned: a wrong code still returns its ONE row and runs
  // both EXISTS sub-plans (readGrant's shape returns no row for a wrong code
  // and skips them; that difference is the timing tell this shape removes).
  const ran = async (code: string, uid: number | null) => {
    const [row] = await prisma.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${gateGrantSql(code, uid)}`) as { 'QUERY PLAN': unknown }[]
    const plan = ((row['QUERY PLAN'] as J[])[0]).Plan as J
    const subs: J[] = []
    const walk = (n: J) => { if (n['Parent Relationship'] === 'SubPlan') subs.push(n); for (const c of (n.Plans as J[]) ?? []) walk(c) }
    walk(plan)
    return { rows: plan['Actual Rows'], subs: subs.length, subsRan: subs.every(n => Number(n['Actual Loops']) >= 1) }
  }
  const execs = [await ran(pq, Mq.id), await ran(await wrongCode(), Mq.id), await ran(pq, null), await ran(await wrongCode(), null)]
  check('🔒 …executed: with a user, a right and a wrong code each return one row and run both EXISTS sub-plans; without one, right and wrong run alike (the NULL folds the sub-plans away)',
    execs.slice(0, 2).every(e => e.rows === 1 && e.subs === 2 && e.subsRan) && execs[2].rows === 1 && JSON.stringify(execs[2]) === JSON.stringify(execs[3]), execs)
  // Per caller class: a signed-out caller's NULL user folds away, which tells
  // the caller nothing about the code (they know they are signed out).
  check('🔒 the admission query plans the same node tree for a right and a wrong code (with a user; and without one)', shapes[0] === shapes[1] && shapes[2] === shapes[3], shapes)

  // ── § 20 a /api/places ────────────────────────────────────────────────────
  section('§ 20 a POST /api/places (F1)')
  const placesRoute = await import('../../app/api/places/route.ts')
  const Pu = await mkUser('Places User')
  const realFetch = globalThis.fetch
  const upstream: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    upstream.push(String(url))
    return new Response(JSON.stringify([{ place_id: 1, display_name: 'Bar Uno, Zurich', lat: '47.37', lon: '8.54', address: { amenity: 'Bar Uno', city: 'Zurich', country_code: 'ch' } }]), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const places = (actor: Actor, body: unknown, extra: Record<string, string> = {}) => call(placesRoute.POST, 'POST', '/api/places', actor, body, {}, extra)
  try {
    delete process.env.GOOGLE_PLACES_API_KEY
    await resetLimits()
    check('signed out → 401, nothing charged', (await places({}, { type: 'autocomplete', query: 'bar' })).status === 401 && (await scanKeys('rl:places:*')).length === 0)
    check('cross-origin → 403', (await places(Pu, { type: 'autocomplete', query: 'bar' }, { origin: 'https://evil.example', host: 'localhost:3000' })).status === 403)
    const bad = await Promise.all([
      places(Pu, { type: 'autocomplete', query: 'x'.repeat(101) }),
      places(Pu, { type: 'nearby', lat: 91, lng: 8 }),
      places(Pu, { type: 'nearby', lat: 47, lng: -181 }),
      places(Pu, { type: 'nearby', lat: null, lng: 8 }),
      places(Pu, { type: 'autocomplete', query: 'bar', lat: 'x' }),
    ])
    bad.push(await places(Pu, null))
    check('400 on an over-long query, out-of-range or non-numeric coordinates, a JSON null body', bad.every(r => r.status === 400), bad.map(r => r.status))
    check('…and no upstream call for any of them', upstream.length === 0)
    await resetLimits()
    await places(Pu, { type: 'autocomplete', query: 'bar' }, xff('203.0.113.5, 198.51.100.9'))
    const pk = await scanKeys('rl:places:*')
    check('the address key uses getClientIp (a multi-entry X-Forwarded-For buckets into unknown); the account keys by user', pk.includes('rl:places:ip:unknown:1m') && pk.includes('rl:places:ip:unknown:1d') && pk.includes(`rl:places:u:${Pu.id}:1m`) && pk.includes(`rl:places:u:${Pu.id}:1d`), pk)
    await redis.set(`rl:places:u:${Pu.id}:1m`, '30', { EX: 60 })
    const lim = await places(Pu, { type: 'autocomplete', query: 'bar' })
    check('429 past the per-account minute budget (30)', lim.status === 429 && /Too many place lookups/.test(lim.wire.error))
    // The Nominatim gate (the OSM path): 1 request a second for the whole app.
    await resetLimits()
    upstream.length = 0
    const first = await places(Pu, { type: 'autocomplete', query: 'bar uno' })
    const t0 = Date.now()
    const second = await places(Pu, { type: 'autocomplete', query: 'bar uno' })
    check('🔒 Nominatim: a second lookup within the second WAITS for the next free second, then reaches it (one request a second for the app)', first.wire.results.length === 1 && second.wire.results.length === 1 && upstream.length === 2 && Date.now() - t0 >= 500, { upstream: upstream.length, waited: Date.now() - t0 })
    await redis.set('rl:places:nominatim:1s', '1', { PX: 5000 })
    const held = await places(Pu, { type: 'autocomplete', query: 'bar uno' })
    check('…a slot held past the wait (about 1.2 s) degrades to [] (no 429) without an upstream call', held.status === 200 && held.wire.results.length === 0 && upstream.length === 2, { held: held.wire, upstream: upstream.length })
    await redis.del('rl:places:nominatim:1s')
    // The Google path's app-wide daily cap.
    process.env.GOOGLE_PLACES_API_KEY = 'test-only-key'
    await resetLimits()
    upstream.length = 0
    await places(Pu, { type: 'autocomplete', query: '' })
    await redis.set(`rl:places:u:${Pu.id}:1m`, '30', { EX: 60 })
    await places(Pu, { type: 'autocomplete', query: 'bar' })
    check('🔒 the app-wide Google cap is not drained by an invalid or a refused request', !(await redis.exists('rl:places:global:1d')))
    await resetLimits()
    await redis.set('rl:places:global:1d', '2000', { EX: 86400 })
    const capped = await places(Pu, { type: 'autocomplete', query: 'bar' })
    check('🔒 past the app-wide 2,000/day: [] (no 429), no Google call', capped.status === 200 && capped.wire.results.length === 0 && upstream.length === 0, { capped: capped.wire, upstream })
  } finally {
    globalThis.fetch = realFetch
    delete process.env.GOOGLE_PLACES_API_KEY
  }

  // ── § 20 d the block-pair lists the app reads ─────────────────────────────
  section('§ 20 d the block-pair lists (F5: the app draws them like the web)')
  await resetLimits()
  const Vd = await mkUser('Dana Viewer'), Ad = await mkUser('Abe BlockedMe'), Bd = await mkUser('Ben IBlocked'), Cd = await mkUser('Cy Mutual'), Dd = await mkUser('Dot Neutral')
  const md = await createSession(Vd, 'Dana Viewer')
  for (const u of [Ad, Bd, Cd, Dd]) { await resetLimits(); await call(joinRoute.POST, 'POST', '/api/session/join', u, { code: md, displayName: 'Joiner' }) }
  for (const u of [Ad, Bd, Cd, Dd]) await prisma.$executeRaw`UPDATE users SET image_url = ${h.s3.urlOf(`avatars/avatar_${u.pid.toLowerCase()}fixture.png`)} WHERE id = ${u.id}`
  await prisma.userBlock.createMany({ data: [{ blockerId: Ad.id, blockedId: Vd.id }, { blockerId: Vd.id, blockedId: Bd.id }, { blockerId: Cd.id, blockedId: Vd.id }, { blockerId: Vd.id, blockedId: Cd.id }] })
  await resetLimits()
  const sd = await call(stateRoute.GET, 'GET', `/api/session/${md}/state`, Vd, undefined, { code: md })
  const wireOf = (u: User) => `u:${u.pid}`
  const sorted = (a: string[]) => [...a].sort().join(',')
  const partOf = (u: User) => (sd.wire.meta.participants as J[]).find(p => p.id === wireOf(u))
  check('🔒 viewerBlocksIn = exactly the participants who blocked the viewer (one way + mutual)', sorted(sd.wire.meta.viewerBlocksIn) === sorted([wireOf(Ad), wireOf(Cd)]), sd.wire.meta.viewerBlocksIn)
  check('viewerBlocksOut = the viewer\'s own blocks (one way + mutual)', sorted(sd.wire.meta.viewerBlocksOut) === sorted([wireOf(Bd), wireOf(Cd)]), sd.wire.meta.viewerBlocksOut)
  check('🔒 a blocker\'s photo is never sent (imageUrl null), so the app\'s guest look carries no photo', partOf(Ad)?.imageUrl === null && partOf(Cd)?.imageUrl === null, [partOf(Ad), partOf(Cd)])

  // ── F6 the host's write replies under Blind for All ───────────────────────
  section('§ 20 F6 the host\'s write replies, tags of a block pair, the grape badge')
  await resetLimits()
  const He = await mkUser('Echo Host'), Je = await mkUser('Echo Joiner')
  const me = await createSession(He, 'Echo Host')
  const e1 = await addWine(me, He, `${TAG} Secret One`), e2 = await addWine(me, He, `${TAG} Secret Two`)
  await resetLimits()
  await call(joinRoute.POST, 'POST', '/api/session/join', Je, { code: me, displayName: 'Echo Joiner' })
  await prisma.$executeRaw`UPDATE sessions SET blind = true, blind_for_everyone = true WHERE code = ${me}`
  const metaRaw = JSON.parse(await redis.get(k.meta(me)))
  await redis.set(k.meta(me), JSON.stringify({ ...metaRaw, blind: true, blindForEveryone: true }), { XX: true, KEEPTTL: true })
  const isStub = (w: J | undefined) => !!w && w._blind === true && /^Wine \d+$/.test(w.name) && !String(w.name).includes('Secret')
  await resetLimits()
  const reorderRoute = await import('../../app/api/session/[code]/wines/reorder/route.ts')
  const revealRoute = await import('../../app/api/session/[code]/wines/[wineId]/reveal/route.ts')
  const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
  const ro = await call(reorderRoute.POST, 'POST', `/api/session/${me}/wines/reorder`, He, { orderedIds: [e2.id, e1.id] }, { code: me })
  const hd = await call(revealRoute.DELETE, 'DELETE', `/api/session/${me}/wines/${e1.id}/reveal`, He, undefined, { code: me, wineId: e1.id })
  const pe = await call(wineRoute.PATCH, 'PATCH', `/api/session/${me}/wines/${e1.id}`, He, { name: `${TAG} Secret One`, type: 'red' }, { code: me, wineId: e1.id })
  const ra = await call(wineRoute.PATCH, 'PATCH', `/api/session/${me}/wines/${e2.id}`, He, { broughtByIdentityId: wireOf(Je) }, { code: me, wineId: e2.id })
  check('🔒 under Blind for All every host echo of an unrevealed bottle is the "Wine N" stub: reorder, hide, a no-op edit, the brought-by reassign',
    ro.status === 200 && (ro.wire as unknown as J[]).every(isStub) && hd.status === 200 && isStub(hd.wire.wine) && pe.status === 200 && isStub(pe.wire) && ra.status === 200 && isStub(ra.wire),
    { ro: ro.wire, hd: hd.wire, pe: pe.wire, ra: ra.wire })
  const rv = await call(revealRoute.POST, 'POST', `/api/session/${me}/wines/${e1.id}/reveal`, He, undefined, { code: me, wineId: e1.id })
  check('…a revealed bottle\'s echo is the bottle itself (same shape)', rv.status === 200 && rv.wire.wine?.name === `${TAG} Secret One` && !rv.wire.wine._blind, rv.wire)
  check('…the edit and the reassign still happened (record)', (await prisma.wine.findUniqueOrThrow({ where: { id: e2.id }, select: { addedByIdentityId: true } })).addedByIdentityId === `u:${Je.id}`)

  // Tags of someone in a block pair with the VIEWER, either way (feed + profile).
  await resetLimits()
  const Pt = await mkUser('Pat Poster'), Tt = await mkUser('Tia Tagged'), Vt = await mkUser('Val Viewer')
  await prisma.follow.createMany({ data: [{ followerId: Pt.id, followingId: Tt.id }, { followerId: Tt.id, followingId: Pt.id }, { followerId: Vt.id, followingId: Pt.id }] })
  const checkinsRoute = await import('../../app/api/checkins/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const usersRoute = await import('../../app/api/users/[id]/route.ts')
  const ci = await call(checkinsRoute.POST, 'POST', '/api/checkins', Pt, { occurrenceId: nanoid(), wineName: `${TAG} Tagged Bottle`, score: 4, taggedUserIds: [Tt.pid] })
  check('fixture: a check-in tagging a mutual follow', (ci.status === 200 || ci.status === 201) && (await prisma.feedItemTag.count({ where: { userId: Tt.id } })) === 1, ci.wire)
  const tagsSeen = async () => {
    await resetLimits()
    const feed = await call(feedRoute.GET, 'GET', '/api/feed', Vt)
    const item = (feed.wire.items as J[]).find(i => i.checkin?.wineName === `${TAG} Tagged Bottle` || i.checkin?.wine?.name === `${TAG} Tagged Bottle` || JSON.stringify(i).includes(`${TAG} Tagged Bottle`))
    const prof = await call(usersRoute.GET, 'GET', `/api/users/${Pt.pid}`, Vt, undefined, { id: Pt.pid })
    const pc = ((prof.wire.recentCheckins ?? []) as J[]).find(c => JSON.stringify(c).includes(`${TAG} Tagged Bottle`))
    return { feed: !!item && JSON.stringify(item).includes(Tt.pid), profile: !!pc && JSON.stringify(pc).includes(Tt.pid), found: !!item && !!pc }
  }
  const t0 = await tagsSeen()
  await prisma.userBlock.create({ data: { blockerId: Vt.id, blockedId: Tt.id } })
  const t1 = await tagsSeen()
  await prisma.userBlock.deleteMany({ where: { blockerId: Vt.id, blockedId: Tt.id } })
  await prisma.userBlock.create({ data: { blockerId: Tt.id, blockedId: Vt.id } })
  const t2 = await tagsSeen()
  await prisma.userBlock.deleteMany({ where: { blockerId: Tt.id, blockedId: Vt.id } })
  check('no block pair: the tag shows on the feed and the profile post list', t0.found && t0.feed && t0.profile, t0)
  check('🔒 the viewer blocked the tagged person: the tag is dropped on both (the post stays)', t1.found && !t1.feed && !t1.profile, t1)
  check('🔒 the tagged person blocked the viewer: dropped on both too', t2.found && !t2.feed && !t2.profile, t2)

  // The grape badge counts a bottle only once it is visible outside its moment.
  const { getUserStats } = await import('../../lib/badgeService.ts')
  const Hg = await mkUser('Grape Host'), Rg = await mkUser('Grape Rater')
  const gcode = `G${TAG.slice(-9)}`.toUpperCase()
  const [gs] = await prisma.$queryRaw`INSERT INTO sessions (code, name, host_user_id, created_at, date_from, blind) VALUES (${gcode}, 'Grapes', ${Hg.id}, now(), now() + interval '1 day', true) RETURNING id` as { id: number }[]
  const gw = (n: string) => `gw${TAG.slice(-8)}${n}`
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, grape, style) VALUES (${gw('a')}, ${gs.id}, 'Open', 'Merlot', 'white'), (${gw('b')}, ${gs.id}, 'Masked', 'Syrah', 'red')`
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, grape) VALUES (${gw('d')}, NULL, 'Standalone', 'Gamay')`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${gw('d')}, ${Rg.id}, NULL, 'standalone', 'Rae', 3, now())`
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, grape) VALUES (${gw('c')}, NULL, 'Orphaned', 'Nebbiolo')`
  await prisma.$executeRaw`UPDATE wines SET revealed_at = now() WHERE id = ${gw('a')}`
  for (const w of ['a', 'b', 'c']) await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, rated_at) VALUES (${gw(w)}, ${Rg.id}, ${gs.id}, 'session', 'Rae', 4, now())`
  const gst = await getUserStats(Rg.id)
  const g1 = gst.uniqueGrapes
  await prisma.$executeRaw`UPDATE wines SET revealed_at = now() WHERE id IN (${gw('b')}, ${gw('c')})`
  const g2 = (await getUserStats(Rg.id)).uniqueGrapes
  check('🔒 Grape Explorer: an unrevealed blind bottle\'s grape is not counted (incl. a bottle whose wines.session_id is NULL: the moment found through the RATING), a standalone check-in\'s is; after the reveal all are', g1 === 2 && g2 === 4, { g1, g2 })
  check('…style counts are unaffected (the masked bottle\'s red counts before the reveal)', gst.redCount === 1 && gst.whiteCount === 1, { red: gst.redCount, white: gst.whiteCount })

  // ── § 20 c the session-image re-key script ────────────────────────────────
  await rekeySection(h)
}

async function rekeySection(h: Harness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, scanKeys, TAG, PNG } = h
  const { store, mtimes, urlOf, keyOf } = h.s3
  section('§ 20 c scripts/rekey-session-images.mts (F3 + F4)')
  const rk = await import('../rekey-session-images.mts')
  const { classifyKey, LEGACY_CUTOFF } = rk
  const classes: [string, string][] = [
    ['wines/V1StGXR8_Z5jdHi6B-myT.png', 'legacy-wine'],
    ['wines/abcdefghijkl_mnopqrst.png', 'legacy-wine'],
    ['wines/123456789012_abcdefgh.jpeg', 'legacy-wine'],
    ['wines/1731000000037.png', 'legacy-wine'],
    ['wines/V1StGXR8_Z5jdHi6B-myT_a1B2c3D4.png', 'current-wine'],
    ['wines/1731000000037_a1B2c3D4.webp', 'current-wine'],
    ['wines/ci_0123456789abcdef0123456789abcdef.png', 'checkin'],
    ['sessions/ABCD1234_1731000000000.png', 'legacy-cover'],
    ['sessions/BEEF_1731000000000.jpeg', 'legacy-cover'],
    ['sessions/abcd_efghijklmno.png', 'current-cover'],
    ['sessions/abcdefgh_ijklmno.png', 'current-cover'],
    ['sessions/new_1731000000000_k3j4h5g6.png', 'new-cover'],
    ['sessions/readme.txt', 'unclassified'],
    ['wines/x.png', 'unclassified'],
  ]
  const wrong = classes.filter(([key, want]) => classifyKey(key) !== want)
  check('discovery classes: a 21-character legacy id with `_` at index 12, a 13-digit id, current shapes, a nanoid16 cover with `_` at position 4 / 8 (NOT legacy), `sessions/new_`, unclassified', wrong.length === 0, wrong.map(([key]) => `${key} → ${classifyKey(key)}`))

  const { S3Client } = await import('@aws-sdk/client-s3')
  const s3 = new S3Client({ endpoint: h.s3.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } })
  const { mkdtempSync, existsSync, readFileSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const manifest = pjoin(mkdtempSync(pjoin(tmpdir(), 'rekey-s-')), 'manifest.jsonl')
  const logs: Record<string, unknown>[] = []
  const runRk = (mode: 'dry' | 'apply' | 'reclaim', now?: number) => rk.run({ mode, manifest, s3, bucket: 'verre', log: o => logs.push(o), now }) as Promise<J>
  const legacyUrl = (key: string) => { store.add(key); mtimes.set(key, Date.UTC(2026, 5, 1)); return urlOf(key) }
  const setLineupUrl = async (code: string, wineId: string, url: string) => {
    const arr = JSON.parse(await redis.get(k.wines(code))) as J[]
    for (const w of arr) if (w.id === wineId) w.imageUrl = url
    await redis.set(k.wines(code), JSON.stringify(arr), { XX: true, KEEPTTL: true })
  }

  // A WARM moment: two line-up bottles (one keyed off by milliseconds), a
  // durable row the cached line-up doesn't list, a legacy cover in row + meta.
  await resetLimits()
  const Hr = await mkUser('Rekey Host')
  const warm = await createSession(Hr, 'Rekey Host')
  const [wrow] = await prisma.$queryRaw`SELECT id FROM sessions WHERE code = ${warm}` as { id: number }[]
  const w1 = await addWine(warm, Hr, `${TAG} rk one`), w2 = await addWine(warm, Hr, `${TAG} rk two`)
  const L1 = legacyUrl(`wines/${w1.id}.png`)
  const offId = '1731000000000'
  const L2 = legacyUrl(`wines/${String(Number(offId) + 37)}.png`)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${L1} WHERE id = ${w1.id}`
  await prisma.$executeRaw`UPDATE wines SET image_url = ${L2} WHERE id = ${w2.id}`
  await setLineupUrl(warm, w1.id, L1); await setLineupUrl(warm, w2.id, L2)
  const ghostId = `gh${TAG.slice(-8)}x1`.padEnd(21, 'q')
  const L3 = legacyUrl(`wines/${ghostId}.png`)
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, image_url, position) VALUES (${ghostId}, ${wrow.id}, 'Ghost row', ${L3}, 99)`
  const Lc = legacyUrl(`sessions/${warm}_1731000000000.png`)
  await prisma.$executeRaw`UPDATE sessions SET cover_photo_url = ${Lc} WHERE id = ${wrow.id}`
  const wm = JSON.parse(await redis.get(k.meta(warm)))
  await redis.set(k.meta(warm), JSON.stringify({ ...wm, coverPhotoUrl: Lc }), { XX: true, KEEPTTL: true })
  const ttlBefore = await redis.ttl(k.wines(warm)), metaTtlBefore = await redis.ttl(k.meta(warm))
  // A pinned impressions tile holding an old wine URL.
  await prisma.$executeRaw`UPDATE users SET tile_impressions_url = ${L1} WHERE id = ${Hr.id}`
  // A COLD moment.
  const cold = await createSession(Hr, 'Rekey Host')
  const c1 = await addWine(cold, Hr, `${TAG} rk cold`)
  const Lk = legacyUrl(`wines/${c1.id}.png`)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${Lk} WHERE id = ${c1.id}`
  // An id of an unexpected length (12): `<id>_<8>` would read as a legacy stem.
  const shortId = `sh${TAG.slice(-8)}x3`
  const Lsh = legacyUrl(`wines/${shortId.padEnd(21, 'q')}.png`)
  const [crow] = await prisma.$queryRaw`SELECT id FROM sessions WHERE code = ${cold}` as { id: number }[]
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, image_url, position) VALUES (${shortId}, ${crow.id}, 'Short id', ${Lsh}, 50)`
  for (const key of await scanKeys(`s:${cold}:*`)) await redis.del(key)
  // A deleted moment's surviving bottle (session_id NULL), rated (D8).
  const survivor = `sv${TAG.slice(-8)}x2`.padEnd(21, 'q')
  const Ls = legacyUrl(`wines/${survivor}.png`)
  await prisma.$executeRaw`INSERT INTO wines (id, session_id, name, image_url) VALUES (${survivor}, NULL, 'Survivor', ${Ls})`
  await prisma.$executeRaw`INSERT INTO ratings (wine_id, user_id, origin, rater_name, score, rated_at) VALUES (${survivor}, ${Hr.id}, 'standalone', 'Rex', 4, now())`
  // A guest-only (Redis-only) moment whose line-up still holds an old key.
  await resetLimits()
  const anonM = await call((await import('../../app/api/session/route.ts')).POST, 'POST', '/api/session', {}, { hostDisplayName: 'Anon', sessionName: `${TAG} guest-only`, dateFrom: new Date(Date.now() + 3600_000).toISOString() })
  const gcode = anonM.wire.code as string
  await resetLimits()
  const gw1 = await call((await import('../../app/api/session/[code]/wines/route.ts')).POST, 'POST', `/api/session/${gcode}/wines`, { anon: anonM.wire.anonToken }, { id: nanoid(), name: 'Guest bottle', type: 'red' }, { code: gcode })
  const Lg = legacyUrl(`wines/${String(gw1.wire.id)}.png`)
  await setLineupUrl(gcode, gw1.wire.id, Lg)
  // Legacy orphans: one older than the cutoff (D3 deletes it), one newer (kept).
  const orphanOld = `wines/${'o'.repeat(21)}.png`, orphanNew = `wines/${'n'.repeat(21)}.png`
  store.add(orphanOld); mtimes.set(orphanOld, LEGACY_CUTOFF.wine - 86400_000)
  store.add(orphanNew); mtimes.set(orphanNew, LEGACY_CUTOFF.wine + 86400_000)
  // A fresh current-shape upload nothing references yet (mid-contract).
  const freshKey = `wines/${'f'.repeat(21)}_a1B2c3D4.png`
  store.add(freshKey); mtimes.set(freshKey, Date.now())

  const putsBefore = h.s3.puts.length
  const dry = await runRk('dry')
  check('dry run: legacy counts per class, the Redis-only reference without a row, orphans; nothing written (no manifest, no copy)',
    dry.byClass['legacy-wine'] >= 6 && dry.byClass['legacy-cover'] >= 1 && dry.redisOnlyNoRow >= 1 && dry.orphans >= 2 && !existsSync(manifest) && h.s3.puts.length === putsBefore, dry)

  // Apply, racing a wine-photo replace in a third moment.
  const race = await createSession(Hr, 'Rekey Host')
  const rw = await addWine(race, Hr, `${TAG} rk race`)
  const Lr = legacyUrl(`wines/${rw.id}.png`)
  await prisma.$executeRaw`UPDATE wines SET image_url = ${Lr} WHERE id = ${rw.id}`
  await setLineupUrl(race, rw.id, Lr)
  const wineRoute = await import('../../app/api/session/[code]/wines/[wineId]/route.ts')
  const imageRoute = await import('../../app/api/session/[code]/wines/[wineId]/image/route.ts')
  await resetLimits()
  const [ap, replaced] = await Promise.all([
    runRk('apply'),
    call(imageRoute.PUT, 'PUT', `/api/session/${race}/wines/${rw.id}/image`, Hr, { image: PNG }, { code: race, wineId: rw.id }),
  ])
  const rowUrl = async (id: string) => (await prisma.wine.findUniqueOrThrow({ where: { id }, select: { imageUrl: true } })).imageUrl
  const lineupUrl = async (code: string, id: string) => (JSON.parse(await redis.get(k.wines(code))) as J[]).find(w => w.id === id)?.imageUrl
  const isCurrent = (url: string | null | undefined, cls: string) => !!url && classifyKey(keyOf(url)) === cls && store.has(keyOf(url))
  check('apply: the warm moment\'s line-up AND rows serve the new URLs (the off-by-ms bottle matched by reference)',
    isCurrent(await rowUrl(w1.id), 'current-wine') && (await lineupUrl(warm, w1.id)) === (await rowUrl(w1.id)) && isCurrent(await rowUrl(w2.id), 'current-wine') && (await lineupUrl(warm, w2.id)) === (await rowUrl(w2.id)), ap)
  check('…the durable row the cached line-up doesn\'t list moved too', isCurrent(await rowUrl(ghostId), 'current-wine'))
  const cov = (await prisma.$queryRaw`SELECT cover_photo_url AS u FROM sessions WHERE id = ${wrow.id}` as { u: string }[])[0].u
  const metaAfter = JSON.parse(await redis.get(k.meta(warm)))
  check('🔒 the cover: row + meta (rewritten from the record) on a `sessions/<nanoid16>` key, no code in it', isCurrent(cov, 'current-cover') && metaAfter.coverPhotoUrl === cov && !cov.includes(warm), { cov, meta: metaAfter.coverPhotoUrl })
  check('…the lifespan TTL kept on the line-up AND the rewritten meta (KEEPTTL)', Math.abs((await redis.ttl(k.wines(warm))) - ttlBefore) <= 30 && Math.abs((await redis.ttl(k.meta(warm))) - metaTtlBefore) <= 30, { before: [ttlBefore, metaTtlBefore], after: [await redis.ttl(k.wines(warm)), await redis.ttl(k.meta(warm))] })
  check('…the warm line-up swap counts as moved, not as a lost race (the summary an operator reads)', ap.warmLineups >= 1 && ap.updatedRows >= 6 && ap.lostRaces <= 1, ap)
  check('the pinned impressions tile holding the old wine URL moved with it', (await prisma.user.findUniqueOrThrow({ where: { id: Hr.id }, select: { tileImpressionsUrl: true } })).tileImpressionsUrl === (await rowUrl(w1.id)))
  check('🔒 the cold moment: its row moved, and the script rebuilt nothing (still cold)', isCurrent(await rowUrl(c1.id), 'current-wine') && !(await redis.exists(k.meta(cold))) && !(await redis.exists(k.wines(cold))))
  check('the deleted moment\'s surviving bottle moved (the plain row CAS)', isCurrent(await rowUrl(survivor), 'current-wine'))
  check('an id of an unexpected length still gets a CURRENT-shape key (never a legacy-shaped one)', isCurrent(await rowUrl(shortId), 'current-wine'), await rowUrl(shortId))
  check('the guest-only moment is skipped and listed, its line-up untouched', (ap.skippedRedisOnlyKeys as string[]).includes(keyOf(Lg)) && (await lineupUrl(gcode, gw1.wire.id)) === Lg, ap.skippedRedisOnlyKeys)
  const raceFinal = await rowUrl(rw.id)
  check('🔒 a concurrent wine-photo replace wins (whichever ran first, the edit\'s fresh photo is what row + line-up serve)', replaced.status === 200 && raceFinal === replaced.wire.wine.imageUrl && (await lineupUrl(race, rw.id)) === raceFinal && raceFinal !== Lr, { raceFinal, echo: replaced.wire.wine?.imageUrl })
  await resetLimits()
  const ed = await call(wineRoute.PATCH, 'PATCH', `/api/session/${warm}/wines/${w1.id}`, Hr, { name: `${TAG} rk one renamed`, type: 'red' }, { code: warm, wineId: w1.id })
  check('🔒 a wine edit AFTER the apply keeps the new URL (the cache was swapped, not only the row)', ed.status === 200 && isCurrent(await rowUrl(w1.id), 'current-wine'), await rowUrl(w1.id))
  check('the old objects stay until --reclaim (the way back)', store.has(keyOf(L1)) && store.has(keyOf(Lc)))
  check('🔒 the manifest is owner-only (0600) and its lock is gone', (statSync(manifest).mode & 0o777) === 0o600 && !existsSync(`${manifest}.lock`))
  const lines = readFileSync(manifest, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { old: string; new: string })
  const again = await runRk('apply')
  check('a second apply is a no-op (nothing copied, nothing written, no new manifest line)', again.copied === 0 && again.updatedRows === 0 && readFileSync(manifest, 'utf8').trim().split('\n').length === lines.length, again)

  // A run that died between a cover's COMMIT and its meta projection: the
  // cached meta still names the old cover; the next apply repairs it from the
  // record although its row CAS finds nothing to change (Codex r1).
  const mNow = JSON.parse(await redis.get(k.meta(warm)))
  await redis.set(k.meta(warm), JSON.stringify({ ...mNow, coverPhotoUrl: Lc }), { XX: true, KEEPTTL: true })
  await runRk('apply')
  check('🔒 a stale cached cover (a run that died before its projection) is repaired from the record by the next apply', JSON.parse(await redis.get(k.meta(warm))).coverPhotoUrl === cov)

  // A losing copy: an old pair whose new key a later edit left unreferenced.
  const lostPair = lines.find(l => l.old === keyOf(L2))!
  await prisma.$executeRaw`UPDATE wines SET image_url = ${urlOf(`wines/${w2.id}_zzzzzzzz.png`)} WHERE id = ${w2.id}`
  store.add(`wines/${w2.id}_zzzzzzzz.png`)
  await setLineupUrl(warm, w2.id, urlOf(`wines/${w2.id}_zzzzzzzz.png`))
  const rc1 = await runRk('reclaim')
  check('--reclaim: the old keys go (manifest pairs, unreferenced), the referenced new ones stay',
    !store.has(keyOf(L1)) && !store.has(keyOf(Lc)) && !store.has(keyOf(Lk)) && !store.has(keyOf(Ls)) && isCurrent(await rowUrl(w1.id), 'current-wine') && isCurrent(cov, 'current-cover'), rc1)
  check('🔒 D3: a legacy orphan older than the cutoff is deleted, a newer one kept', !store.has(orphanOld) && store.has(orphanNew))
  check('🔒 never a Redis-referenced key (the guest-only moment\'s line-up)', store.has(keyOf(Lg)))
  check('🔒 never a fresh current-shape upload, nor a losing copy younger than 24 h', store.has(freshKey) && store.has(lostPair.new))
  const rc2 = await runRk('reclaim', Date.now() + 25 * 3600_000)
  check('…a losing copy older than 24 h goes on a later reclaim; a fresh upload outside the manifest never does', !store.has(lostPair.new) && store.has(freshKey), rc2)
  check('🔒 D8: the rated survivor\'s photo was moved, never removed', isCurrent(await rowUrl(survivor), 'current-wine'))
  // An existing manifest that isn't owner-only is made 0600 before anything
  // is written to it (it lists join codes).
  const { writeFileSync, chmodSync } = await import('node:fs')
  const loose = pjoin(mkdtempSync(pjoin(tmpdir(), 'rekey-s2-')), 'manifest.jsonl')
  writeFileSync(loose, ''); chmodSync(loose, 0o644)
  await rk.run({ mode: 'apply', manifest: loose, s3, bucket: 'verre', log: () => {} })
  check('🔒 an existing 0644 manifest is made owner-only (0600) by the run', (statSync(loose).mode & 0o777) === 0o600, (statSync(loose).mode & 0o777).toString(8))
}
