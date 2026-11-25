// § 23 Moment Visibility, step 1a: the record and the writes
// (docs/dev/proposals/moment-visibility.md; the step-1 plan § 11 "1a").
// Imported by scripts/tests/you-profile-integration.mts, which owns the
// throwaway stores, the actors and the canary (every response through `call`
// is scanned for a user integer). Nothing can be looked into yet (step 1b).
//   § 23 a schema: sessions.public_id (mint, immutable, format, concurrent),
//          the visibility CHECK, a hostless insert lands closed, the trigger
//          shapes, moment_privacy's foreign keys
//   § 23 b a real create's defaults; a promotion lands as 'members'
//   § 23 c the visibility GET + PATCH: who reads what, who may save, the 400s,
//          the flag (404 AFTER the entrance gate), no record, the limiters
//   § 23 d the look-in link: derive / verify units, share / off / reset, the
//          version only goes up, the secret failing closed, hostless
//   § 23 e the freeze (a moment with no signed-in host only narrows); a host
//          who deletes their account leaves the moment's setting
//   § 23 f the SCRUB GATE: after a moment DELETE and after an account
//          deletion's wipe the tombstone keeps `id`, `deleted_at`, `public_id`
//   § 23 g the migration's two one-off statements, run for real on fixture rows
//   § 23 h guests' `shown`: added only when a join mints the identity
//   § 23 i blind rows: no wine id unless you wrote the rating, `ratingId` on
//          every row
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath } from 'node:url'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Res = { status: number; json: J; wire: J; headers: Headers }
export type MomentVisibilityHarness = {
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
  DB: string
}

const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION = pjoin(ROOT, 'prisma', 'migrations', '20261115120000_moment_visibility', 'migration.sql')
const PIDRE = /^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$/
const SEVEN = ['visibility', 'include_guest_circles', 'show_place', 'show_details', 'link_version', 'link_active', 'link_since'] as const
const SECRET = 'ci-only-moment-link-secret-0123456789-abcdef'
const sqlErr = (p: Promise<unknown>) => p.then(() => null as string | null, (e: Error) => String(e?.message ?? e))

export async function momentVisibility(h: MomentVisibilityHarness) {
  const { call, check, section, mkUser, createSession, addWine, resetLimits, prisma, redis, k, scanKeys, TAG, DB } = h
  const sessionRoute = await import('../../app/api/session/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const meNameRoute = await import('../../app/api/session/[code]/me/name/route.ts')
  const visibilityRoute = await import('../../app/api/session/[code]/visibility/route.ts')
  const linkRoute = await import('../../app/api/session/[code]/look-in-link/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const link = await import('../../lib/momentLink.ts')
  const { mutationHooks } = await import('../../lib/sessionMutation.ts')
  const { momentSettingsSeams } = await import('../../lib/momentSettingsRoute.ts')
  const { loadSessionFeedWines, pairKey } = await import('../../lib/sessionFeedWines.ts')
  const { deleteAccountDurable } = await import('../../lib/accountDelete.ts')

  const saved = { flag: process.env.MOMENT_LOOKIN_ENABLED, secret: process.env.MOMENT_LINK_SECRET }
  const flag = (on: boolean) => { if (on) process.env.MOMENT_LOOKIN_ENABLED = 'true'; else delete process.env.MOMENT_LOOKIN_ENABLED }
  const secret = (v: string | null) => { if (v === null) delete process.env.MOMENT_LINK_SECRET; else process.env.MOMENT_LINK_SECRET = v }

  const rowOf = async (where: { code?: string; id?: number }): Promise<J> => (where.id !== undefined
    ? await prisma.$queryRaw`SELECT to_jsonb(s) AS j FROM sessions s WHERE id = ${where.id}`
    : await prisma.$queryRaw`SELECT to_jsonb(s) AS j FROM sessions s WHERE code = ${where.code}`)[0]?.j
  const getV = async (code: string, a: Actor, extra?: Record<string, string>) => { await resetLimits(); return call(visibilityRoute.GET, 'GET', `/api/session/${code}/visibility`, a, undefined, { code }, extra) }
  const patchV = async (code: string, a: Actor, body: unknown) => { await resetLimits(); return call(visibilityRoute.PATCH, 'PATCH', `/api/session/${code}/visibility`, a, body, { code }) }
  const postL = async (code: string, a: Actor, action: unknown) => { await resetLimits(); return call(linkRoute.POST, 'POST', `/api/session/${code}/look-in-link`, a, { action }, { code }) }
  const join = async (code: string, a: Actor, name = 'Joiner') => {
    await resetLimits()
    const r = await call(joinRoute.POST, 'POST', '/api/session/join', a, { code, displayName: name })
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`)
    return r
  }
  const visit = async (code: string, u: User) => { await resetLimits(); return call(visitRoute.POST, 'POST', `/api/session/${code}/visit`, u, {}, { code }) }
  const setRole = async (code: string, by: Actor, targetId: string, role: string) => {
    await resetLimits()
    const r = await call(codeRoute.PATCH, 'PATCH', `/api/session/${code}`, by, { action: 'set-role', targetId, role }, { code })
    if (r.status !== 200) throw new Error(`set-role failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const rate = async (code: string, a: Actor, wineId: string, score = 4) => {
    await resetLimits()
    const r = await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, a, { wineId, score, flavors: {}, notes: 'n' }, { code })
    if (r.status !== 200) throw new Error(`rate failed ${r.status} ${JSON.stringify(r.json)}`)
  }
  const dateFrom = new Date(Date.now() + 3600_000).toISOString()
  const anonCreate = async (name: string) => {
    await resetLimits()
    const r = await call(sessionRoute.POST, 'POST', '/api/session', {}, { hostDisplayName: 'Gus Guesthost', sessionName: `${TAG} ${name}`, dateFrom })
    if (r.status !== 200) throw new Error(`anonymous create failed ${r.status} ${JSON.stringify(r.json)}`)
    return { code: r.json.code as string, host: { anon: r.wire.anonToken as string } as Actor }
  }
  // Step 3: every answer of this shape carries the caller's own choice (`me`), null without a record.
  const CLOSED = { visibility: 'members', includeGuestCircles: false, showPlace: false, showDetails: false, frozen: true, canEdit: false, me: null }
  const four = (r: Res) => ({ visibility: r.wire?.visibility, includeGuestCircles: r.wire?.includeGuestCircles, showPlace: r.wire?.showPlace, showDetails: r.wire?.showDetails })
  const noStore = (r: Res) => r.headers.get('cache-control') === 'private, no-store'

  try {
    flag(false)
    secret(SECRET)

    // ── § 23 a schema ───────────────────────────────────────────────────────
    section('§ 23 a Moment Visibility schema: public_id, the CHECKs, the triggers')
    const Hs = await mkUser('Mona Schema')
    const rawCode = () => `MV${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    const ins = (await prisma.$queryRaw`
      INSERT INTO sessions (code, host_user_id, host_name, name, created_at, public_id, visibility)
      VALUES (${rawCode()}, ${Hs.id}, 'Mona', 'raw', now(), 'AAAAAAAAAAAA', 'verre') RETURNING id, public_id, visibility`)[0] as J
    check('🔒 a supplied public_id is overridden by the mint trigger (well-formed, not the supplied one)', PIDRE.test(ins.public_id) && ins.public_id !== 'AAAAAAAAAAAA', ins)
    check('a signed-in-hosted insert keeps the visibility it supplies', ins.visibility === 'verre', ins)
    const imm = await sqlErr(prisma.$executeRaw`UPDATE sessions SET public_id = 'BBBBBBBBBBBB' WHERE id = ${ins.id}`)
    check('🔒 sessions.public_id is immutable', /sessions\.public_id is immutable/.test(imm ?? ''), imm)
    check('…an update that does not name the column still works', (await prisma.$executeRaw`UPDATE sessions SET name = 'raw 2' WHERE id = ${ins.id}`) === 1)
    const fmt = await sqlErr(prisma.$transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
      await tx.$executeRaw`ALTER TABLE sessions DISABLE TRIGGER sessions_public_id_mint`
      await tx.$executeRaw`INSERT INTO sessions (code, host_user_id, name, created_at, public_id) VALUES (${rawCode()}, ${Hs.id}, 'bad', now(), '1AAAAAAAAAAA')`
    }))
    check('🔒 the format CHECK refuses a digit-first id (mint trigger off, rolled back)', /sessions_public_id_format_chk/.test(fmt ?? ''), fmt)
    const conc = await Promise.all(Array.from({ length: 25 }, () => prisma.$queryRaw`
      INSERT INTO sessions (code, host_user_id, name, created_at) VALUES (${rawCode()}, ${Hs.id}, 'conc', now()) RETURNING public_id`)) as J[][]
    check('25 concurrent inserts: distinct, well-formed public ids', new Set(conc.map(r => r[0].public_id)).size === 25 && conc.every(r => PIDRE.test(r[0].public_id)))
    const hostless = (await prisma.$queryRaw`
      INSERT INTO sessions (code, host_name, name, created_at, visibility) VALUES (${rawCode()}, 'Guest', 'hostless', now(), 'verre') RETURNING id, visibility, include_guest_circles`)[0] as J
    check('🔒 a row inserted WITHOUT a host lands as members, whatever the insert supplied', hostless.visibility === 'members', hostless)
    const fifth = await sqlErr(prisma.$executeRaw`UPDATE sessions SET visibility = 'everyone' WHERE id = ${ins.id}`)
    check('🔒 the visibility CHECK refuses a fifth value', /sessions_visibility_chk/.test(fifth ?? ''), fifth)
    check('…and allows NULL (a tombstone)', (await sqlErr(prisma.$executeRaw`UPDATE sessions SET visibility = NULL WHERE id = ${ins.id}`)) === null)
    const trg = new Map((await prisma.$queryRaw`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
       WHERE t.tgrelid = 'sessions'::regclass AND NOT t.tgisinternal` as J[]).map(t => [t.tgname as string, t.def as string]))
    check('trigger shape: the mint is BEFORE INSERT, every row, unconditional',
      /BEFORE INSERT ON public\.sessions FOR EACH ROW EXECUTE FUNCTION sessions_public_id_mint\(\)/.test(trg.get('sessions_public_id_mint') ?? ''), trg.get('sessions_public_id_mint'))
    check('trigger shape: immutability is BEFORE UPDATE OF public_id (a scrub never fires it)',
      /BEFORE UPDATE OF public_id ON public\.sessions FOR EACH ROW EXECUTE FUNCTION sessions_public_id_immutable\(\)/.test(trg.get('sessions_public_id_immutable') ?? ''), trg.get('sessions_public_id_immutable'))
    check('trigger shape: guest-hosted is BEFORE INSERT WHEN host_user_id IS NULL',
      /BEFORE INSERT ON public\.sessions FOR EACH ROW WHEN \(\(new\.host_user_id IS NULL\)\) EXECUTE FUNCTION sessions_guest_hosted_closed\(\)/.test(trg.get('sessions_guest_hosted_closed') ?? ''), trg.get('sessions_guest_hosted_closed'))
    const fks = new Map((await prisma.$queryRaw`
      SELECT conname, confdeltype::text AS del FROM pg_constraint WHERE conrelid = 'moment_privacy'::regclass AND contype = 'f'` as J[]).map(c => [c.conname as string, c.del as string]))
    check('moment_privacy: RESTRICT on the session (rows survive the soft delete), CASCADE on the user',
      fks.get('moment_privacy_session_id_fkey') === 'r' && fks.get('moment_privacy_user_id_fkey') === 'c', [...fks])

    // ── § 23 b defaults ─────────────────────────────────────────────────────
    section('§ 23 b a real create\'s defaults; a promotion lands closed')
    const H = await mkUser('Hana Host'), C = await mkUser('Cora Cohost'), T = await mkUser('Timo Taster'), X = await mkUser('Xaver Stranger')
    const M = await createSession(H, 'Hana Host')
    const m0 = await rowOf({ code: M })
    check('a signed-in create (the route names none of the new columns): Friends, guests\' circles on, place off, details off, no active link',
      m0.visibility === 'friends' && m0.include_guest_circles === true && m0.show_place === false && m0.show_details === false
      && m0.link_version === 0 && m0.link_active === false && m0.link_since === null && PIDRE.test(m0.public_id), m0)
    const G1 = await anonCreate('guest hosted')
    const Pv = await mkUser('Paul Promoter')
    await join(G1.code, Pv)
    const vr = await visit(G1.code, Pv)
    const g1 = await rowOf({ code: G1.code })
    check('🔒 a guest-hosted moment promoted through the real /visit lands as members (the trigger, not the route)',
      vr.status === 200 && !!g1 && g1.host_user_id === null && g1.visibility === 'members', { visit: vr.status, g1 })

    // ── § 23 c the visibility GET + PATCH ───────────────────────────────────
    section('§ 23 c GET / PATCH /api/session/:code/visibility')
    await join(M, C); await join(M, T)
    await setRole(M, H, `u:${C.pid}`, 'co_host')
    const guest = await join(M, {}, 'Gina Guest')
    const G: Actor = { anon: guest.wire.anonToken }
    const guestCo = await join(M, {}, 'Gero Guestcohost')
    const GC: Actor = { anon: guestCo.wire.anonToken }
    await setRole(M, H, String(guestCo.wire.id), 'co_host')

    const off = [await getV(M, H), await patchV(M, H, { visibility: 'verre' }), await postL(M, H, 'share')]
    check('🔒 flag off: all three handlers answer 404 { error: "not found" }, no-store, for the host', off.every(r => r.status === 404 && r.wire?.error === 'not found' && noStore(r)), off.map(r => [r.status, r.wire]))
    check('🔒 …nothing was written', (await rowOf({ code: M })).visibility === 'friends' && (await rowOf({ code: M })).link_active === false)
    const offX = [await getV(M, X), await patchV(M, X, { visibility: 'verre' }), await postL(M, X, 'share')]
    check('🔒 flag off, a non-participant: the entrance gate answers first (401, not the flag\'s 404)', offX.every(r => r.status === 401), offX.map(r => r.status))
    // Called WITHOUT the helpers (they clear the limiter keys before each call).
    await resetLimits()
    const offRaw = [
      await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, H, undefined, { code: M }),
      await call(visibilityRoute.PATCH, 'PATCH', `/api/session/${M}/visibility`, H, { visibility: 'verre' }, { code: M }),
      await call(linkRoute.POST, 'POST', `/api/session/${M}/look-in-link`, H, { action: 'share' }, { code: M }),
    ]
    check('🔒 flag off: no limiter was charged by the three handlers (the flag sits in front of each limiter)',
      offRaw.every(r => r.status === 404) && (await scanKeys('rl:moment-visibility*')).length === 0, { status: offRaw.map(r => r.status), keys: await scanKeys('rl:moment-visibility*') })

    flag(true)
    const tg = await getV(M, T)
    const mid = (await rowOf({ code: M })).id
    check('a taster reads the four settings, canEdit false, no link part; me carries the moment\'s id (signed in)',
      tg.status === 200 && JSON.stringify(tg.wire) === JSON.stringify({ visibility: 'friends', includeGuestCircles: true, showPlace: false, showDetails: false, frozen: false, canEdit: false, me: { onlyInside: false, sessionId: mid } }) && noStore(tg), tg.wire)
    const hg = await getV(M, H), cg = await getV(M, C)
    check('host and cohost: canEdit, and the link part (available, not active, no url)',
      [hg, cg].every(r => r.status === 200 && r.wire.canEdit === true && r.wire.frozen === false && JSON.stringify(r.wire.link) === JSON.stringify({ available: true, active: false, url: null, since: null })), [hg.wire, cg.wire])
    const gg = await getV(M, G), gcg = await getV(M, GC)
    check('a guest reads the four; 🔒 a GUEST cohost too, with canEdit false and no link part (its role lives only in the cache)',
      [gg, gcg].every(r => r.status === 200 && r.wire.canEdit === false && !('link' in r.wire) && r.wire.visibility === 'friends'), [gg.wire, gcg.wire])
    check('a stranger: the participant gate\'s 401', (await getV(M, X)).status === 401)

    const hp = await patchV(M, H, { visibility: 'followers', showPlace: true })
    const afterH = await rowOf({ code: M })
    check('the host saves: the reply is the GET\'s shape, the record holds it',
      hp.status === 200 && hp.wire.visibility === 'followers' && hp.wire.showPlace === true && hp.wire.includeGuestCircles === true && hp.wire.canEdit === true && 'link' in hp.wire && noStore(hp)
      && afterH.visibility === 'followers' && afterH.show_place === true && afterH.show_details === false, { wire: hp.wire, afterH })
    const cp = await patchV(M, C, { includeGuestCircles: false, showDetails: true, visibility: 'verre' })
    check('a cohost saves too (every tier, not pro-gated)', cp.status === 200 && JSON.stringify(four(cp)) === JSON.stringify({ visibility: 'verre', includeGuestCircles: false, showPlace: true, showDetails: true }), cp.wire)
    check('the settings never enter the cached meta', !/visibility|includeGuestCircles|showPlace|showDetails|link/i.test(String(await redis.get(k.meta(M)))))
    const tp = await patchV(M, T, { visibility: 'members' })
    check('🔒 a taster: 403 "only the host can change who can look in", nothing written', tp.status === 403 && tp.wire.error === 'only the host can change who can look in' && (await rowOf({ code: M })).visibility === 'verre', tp.wire)
    const gcp = await patchV(M, GC, { visibility: 'members' }), gcl = await postL(M, GC, 'share')
    check('🔒 a GUEST cohost: 403 on both writes, nothing written', gcp.status === 403 && gcl.status === 403 && (await rowOf({ code: M })).visibility === 'verre' && (await rowOf({ code: M })).link_active === false, [gcp.wire, gcl.wire])
    await resetLimits()
    const writeKey = `rl:moment-visibility:u:${T.id}:1h`
    await call(visibilityRoute.PATCH, 'PATCH', `/api/session/${M}/visibility`, T, { visibility: 'members' }, { code: M })
    await call(linkRoute.POST, 'POST', `/api/session/${M}/look-in-link`, T, { action: 'share' }, { code: M })
    check('a taster\'s refused PATCH and link POST are both charged, to the ONE shared counter', Number(await redis.get(writeKey)) === 2, await redis.get(writeKey))
    await call(visibilityRoute.PATCH, 'PATCH', `/api/session/${M}/visibility`, GC, { visibility: 'members' }, { code: M })
    await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, T, undefined, { code: M })
    const keysNow = await scanKeys('rl:moment-visibility*')
    check('a guest\'s refused write charges nothing (no account to key on); the GET has its own counter',
      keysNow.length === 2 && keysNow.includes(writeKey) && keysNow.includes(`rl:moment-visibility-read:u:${T.id}:1m`) && Number(await redis.get(writeKey)) === 2, keysNow)
    const bads = [{ visibility: 'everyone' }, { visibility: null }, { showPlace: 'yes' }, { includeGuestCircles: 1 }, {}, { other: true }, [], 'x']
    const badAnswers = []
    for (const b of bads) badAnswers.push((await patchV(M, H, b)).status)
    check('a value outside its set, or none of the four fields → 400', badAnswers.every(s => s === 400), badAnswers)
    const badBody = await patchV(M, H, { visibility: 'everyone' })
    check('…and a bad link action → 400', (await postL(M, H, 'revive')).status === 400 && (await postL(M, H, undefined)).status === 400)

    // No record: a guest-only moment.
    const R0 = await anonCreate('redis only')
    const r0g = await getV(R0.code, R0.host)
    check('no record (guest-only): the closed, frozen shape', r0g.status === 200 && JSON.stringify(r0g.wire) === JSON.stringify(CLOSED), r0g.wire)
    check('🔒 …and both writes are a 403', (await patchV(R0.code, R0.host, { visibility: 'friends' })).status === 403 && (await postL(R0.code, R0.host, 'share')).status === 403)

    // The limiters.
    await resetLimits()
    await redis.set(`rl:moment-visibility:u:${H.id}:1h`, '30', { EX: 3600 })
    const lim = [await call(visibilityRoute.PATCH, 'PATCH', `/api/session/${M}/visibility`, H, { showPlace: false }, { code: M }), await call(linkRoute.POST, 'POST', `/api/session/${M}/look-in-link`, H, { action: 'share' }, { code: M })]
    check('🔒 the PATCH and the link POST share ONE budget (30/h/user): both 429 once it is spent, nothing written',
      lim.every(r => r.status === 429 && !!r.headers.get('retry-after') && noStore(r)) && (await rowOf({ code: M })).show_place === true && (await rowOf({ code: M })).link_active === false, lim.map(r => [r.status, r.wire]))
    await resetLimits()
    await redis.set(`rl:moment-visibility-read:u:${T.id}:1m`, '60', { EX: 60 })
    check('the GET: 60/min per user', (await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, T, undefined, { code: M })).status === 429)
    await resetLimits()
    await redis.set('rl:moment-visibility-read:ip:10.99.0.7:1m', '60', { EX: 60 })
    const gLim = await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, G, undefined, { code: M }, { 'x-forwarded-for': '10.99.0.7' })
    const gOk = await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, G, undefined, { code: M }, { 'x-forwarded-for': '10.99.0.8' })
    check('🔒 …and per ADDRESS for a guest (an identity can be re-minted)', gLim.status === 429 && gOk.status === 200, [gLim.status, gOk.status])
    await resetLimits()

    // ── § 23 d the look-in link ─────────────────────────────────────────────
    section('§ 23 d the look-in link')
    const pid = (await rowOf({ code: M })).public_id as string
    const t1 = link.momentLinkToken(pid, 1)!
    check('derive: 32 hex, stable, case-insensitive on the id, different per version and per moment',
      /^[0-9a-f]{32}$/.test(t1) && t1 === link.momentLinkToken(pid.toLowerCase(), 1) && t1 !== link.momentLinkToken(pid, 2) && t1 !== link.momentLinkToken(ins.public_id, 1))
    check('verify: the right token only; a wrong, short, long, upper-case or non-hex one fails',
      link.verifyMomentLinkToken(pid, 1, t1) && !link.verifyMomentLinkToken(pid, 2, t1) && !link.verifyMomentLinkToken(pid, 1, t1.slice(1) + (t1[0] === '0' ? '1' : '0'))
      && !link.verifyMomentLinkToken(pid, 1, t1.slice(0, 31)) && !link.verifyMomentLinkToken(pid, 1, t1 + '0') && !link.verifyMomentLinkToken(pid, 1, t1.toUpperCase().replace(/[0-9]/g, 'A')) && !link.verifyMomentLinkToken(pid, 1, 'z'.repeat(32)) && !link.verifyMomentLinkToken(pid, 1, ''))
    // An INDEPENDENT vector (the plan's formula, computed here): the checks
    // above would also pass for an unkeyed hash of the id and the version.
    const vector = (key: string, id: string, version: number) => createHmac('sha256', key)
      .update(Buffer.concat([Buffer.from('verre-moment-link-v1'), Buffer.from([0]), Buffer.from(id), Buffer.from([0]), Buffer.from(String(version))])).digest().subarray(0, 16).toString('hex')
    check('🔒 the token IS the first 16 bytes of HMAC-SHA256(secret, "verre-moment-link-v1" ‖ 0x00 ‖ PUBLICID ‖ 0x00 ‖ version)', t1 === vector(SECRET, pid, 1) && link.momentLinkToken(pid, 7) === vector(SECRET, pid, 7))
    const OTHER = 'another-valid-moment-link-secret-9876543210'
    secret(OTHER)
    const tOther = link.momentLinkToken(pid, 1)
    check('🔒 …and depends on the secret: another valid secret gives another token, and the old one no longer verifies', tOther === vector(OTHER, pid, 1) && tOther !== t1 && !link.verifyMomentLinkToken(pid, 1, t1) && link.verifyMomentLinkToken(pid, 1, tOther!))
    secret(SECRET)
    check('🔒 derive refuses what is not a public id or not a version from 1 up (so the framing cannot be confused, and a NULL version read as 0 never verifies)',
      [link.momentLinkToken('1AAAAAAAAAAA', 1), link.momentLinkToken(`${pid}\0`, 1), link.momentLinkToken(pid.slice(0, 11), 1), link.momentLinkToken(pid, 0), link.momentLinkToken(pid, -1), link.momentLinkToken(pid, 1.5), link.momentLinkToken(pid, Number.NaN)].every(t => t === null)
      && !link.verifyMomentLinkToken(pid, 0, '0'.repeat(32)) && link.momentLinkUrl(pid, 0) === null)
    const s1 = await postL(M, H, 'share')
    const url1 = s1.wire?.link?.url as string
    check('share: the link is active, its URL is <base>/l/<public id, lowercase>.<token of version 1>, with a since',
      s1.status === 200 && s1.wire.link.available === true && s1.wire.link.active === true && url1.endsWith(`/l/${pid.toLowerCase()}.${t1}`) && /^https?:\/\//.test(url1)
      && !Number.isNaN(Date.parse(s1.wire.link.since)) && (await rowOf({ code: M })).link_version === 1, s1.wire)
    check('🔒 the link carries no code', !url1.includes(M) && !url1.toUpperCase().includes(M))
    const s2 = await postL(M, C, 'share')
    check('a second share (a cohost, another device): the SAME link, nothing changes', s2.status === 200 && s2.wire.link.url === url1 && s2.wire.link.since === s1.wire.link.since && (await rowOf({ code: M })).link_version === 1, s2.wire)
    check('the GET shows host and cohost the current link; a taster none', (await getV(M, C)).wire.link.url === url1 && !('link' in (await getV(M, T)).wire))
    const o1 = await postL(M, H, 'off')
    check('off: not active, no url, no since; the version untouched', o1.status === 200 && JSON.stringify(o1.wire.link) === JSON.stringify({ available: true, active: false, url: null, since: null }) && (await rowOf({ code: M })).link_version === 1, o1.wire)
    const s3 = await postL(M, H, 'share')
    const url3 = s3.wire.link.url as string
    check('🔒 off then share: a NEW link (version 2); the old token no longer verifies',
      s3.wire.link.active === true && url3 !== url1 && url3.endsWith(`.${link.momentLinkToken(pid, 2)}`) && !link.verifyMomentLinkToken(pid, (await rowOf({ code: M })).link_version, t1), s3.wire)
    await new Promise(r => setTimeout(r, 15))
    const rs = await postL(M, C, 'reset')
    check('reset: version 3, a new link, still active, a later since', rs.status === 200 && rs.wire.link.active === true && rs.wire.link.url.endsWith(`.${link.momentLinkToken(pid, 3)}`) && Date.parse(rs.wire.link.since) > Date.parse(s3.wire.link.since), rs.wire)
    await postL(M, H, 'off')
    const rs2 = await postL(M, H, 'reset')
    check('reset on a link that is off: the version goes up, it stays off', rs2.status === 200 && rs2.wire.link.active === false && (await rowOf({ code: M })).link_version === 4, rs2.wire)
    check('🔒 a taster cannot manage the link (403)', (await postL(M, T, 'reset')).status === 403 && (await rowOf({ code: M })).link_version === 4)
    await postL(M, H, 'share')
    const live = (await getV(M, H)).wire.link.url as string
    const liveToken = live.slice(live.lastIndexOf('.') + 1)
    const cached: string[] = []
    for (const key of await scanKeys('*')) {
      const t = await redis.type(key)
      const vals = t === 'string' ? [await redis.get(key)] : t === 'hash' ? Object.entries(await redis.hGetAll(key)).flat() : t === 'set' ? await redis.sMembers(key)
        : t === 'list' ? await redis.lRange(key, 0, -1) : t === 'zset' ? await redis.zRange(key, 0, -1) : []
      if ([key, ...vals].some(v => v && String(v).includes(liveToken))) cached.push(key)
    }
    check('🔒 the token is in no Redis key or value at all (the moment\'s keys, the limiters, the auth store)', cached.length === 0 && (await scanKeys(`s:${M}:*`)).length > 0, cached)
    for (const [label, v] of [['absent', null], ['shorter than 32 characters', 'x'.repeat(31)]] as const) {
      secret(v)
      const g = await getV(M, H), p = await postL(M, H, 'reset')
      check(`🔒 the secret ${label}: link.available false (not active, no url), the POST a 403 "This moment can't have a link", the four settings still served`,
        g.status === 200 && JSON.stringify(g.wire.link) === JSON.stringify({ available: false, active: false, url: null, since: null }) && g.wire.visibility === 'verre'
        && p.status === 403 && p.wire.error === 'This moment can\'t have a link' && link.momentLinkToken(pid, 1) === null && !link.verifyMomentLinkToken(pid, 1, t1), { g: g.wire, p: p.wire })
    }
    secret(SECRET)
    check('…and with the secret back the same link is there again (nothing was stored)', (await getV(M, H)).wire.link.url === live)

    // The power is decided UNDER the locks: a cohost who passes the early
    // checks and loses the role (or is kicked) before the lock is refused.
    const Dc = await mkUser('Dana Demoted'), Kc = await mkUser('Kai Kicked'), Bc = await mkUser('Bea Banned')
    for (const u of [Dc, Kc, Bc]) { await join(M, u); await setRole(M, H, `u:${u.pid}`, 'co_host') }
    const sevenNow = async () => { const r = await rowOf({ code: M }); return JSON.stringify(SEVEN.map(col => r[col])) }
    const base = await sevenNow()
    const prevHook = mutationHooks.at
    const midRequest = async (label: string, sql: () => Promise<unknown>, send: () => Promise<Res>) => {
      let fired = 0
      mutationHooks.at = async (point, code, l) => { if (point === 'beforeLock' && code === M && l === label && fired++ === 0) await sql() }
      try { return { res: await send(), fired } } finally { mutationHooks.at = prevHook }
    }
    const demote = () => prisma.$executeRaw`UPDATE session_members SET role = 'taster' WHERE session_code = ${M} AND user_id = ${Dc.id}`
    const promote = () => prisma.$executeRaw`UPDATE session_members SET role = 'co_host' WHERE session_code = ${M} AND user_id = ${Dc.id}`
    const d1p = await midRequest('moment-visibility', demote, () => patchV(M, Dc, { visibility: 'members' }))
    await promote()
    const d1l = await midRequest('look-in-link', demote, () => postL(M, Dc, 'reset'))
    check('🔒 a cohost demoted between the early check and the lock: 403 on the PATCH and on the link POST, nothing written (the decision is made under the locks)',
      d1p.fired === 1 && d1l.fired === 1 && d1p.res.status === 403 && d1l.res.status === 403 && d1p.res.wire.error === 'only the host can change who can look in' && (await sevenNow()) === base,
      { p: [d1p.fired, d1p.res.status, d1p.res.wire], l: [d1l.fired, d1l.res.status, d1l.res.wire] })
    // The GET: demoted, THEN the link reset, both between the gate and the
    // record reads (Codex r1): the replacement link must not reach them.
    await promote()
    const linkBefore = (await getV(M, Dc)).wire.link?.url as string
    let seamFired = 0
    momentSettingsSeams.afterGate = async (code) => {
      if (code !== M || seamFired++ > 0) return
      await demote()
      await prisma.$executeRaw`UPDATE sessions SET link_version = link_version + 1 WHERE code = ${M}`
    }
    let raced: Res
    try { await resetLimits(); raced = await call(visibilityRoute.GET, 'GET', `/api/session/${M}/visibility`, Dc, undefined, { code: M }) } finally { momentSettingsSeams.afterGate = async () => {} }
    const linkAfter = (await getV(M, H)).wire.link.url as string
    check('🔒 a cohost demoted and the link then reset, between the GET\'s gate and its reads: no link part, canEdit false (the replacement link never reaches them)',
      seamFired === 1 && !!linkBefore && linkAfter !== linkBefore && raced.status === 200 && raced.wire.canEdit === false && !('link' in raced.wire) && !JSON.stringify(raced.wire).includes(linkAfter.slice(linkAfter.lastIndexOf('.') + 1)), { seamFired, raced: raced.wire })
    await prisma.$executeRaw`UPDATE sessions SET link_version = link_version - 1 WHERE code = ${M}`
    const kickSql = () => prisma.$executeRaw`UPDATE session_members SET removed_state = 'kicked' WHERE session_code = ${M} AND user_id = ${Kc.id}`
    const k1 = await midRequest('moment-visibility', kickSql, () => patchV(M, Kc, { visibility: 'members' }))
    check('🔒 a cohost kicked between the early check and the lock: the "removed" bounce, nothing written',
      k1.fired === 1 && k1.res.status === 401 && k1.res.headers.get('x-vr-auth') === 'removed' && (await sevenNow()) === base, [k1.fired, k1.res.status, k1.res.wire])
    await prisma.$executeRaw`UPDATE session_members SET removed_state = NULL WHERE session_code = ${M} AND user_id = ${Kc.id}`
    for (const [u, mode] of [[Kc, 'kick'], [Bc, 'ban']] as const) {
      await resetLimits()
      const b = await call(bansRoute.POST, 'POST', `/api/session/${M}/bans`, H, { identityId: `u:${u.pid}`, mode }, { code: M })
      const answers = [await getV(M, u), await patchV(M, u, { visibility: 'members' }), await postL(M, u, 'reset')]
      check(`🔒 a cohost removed by a real ${mode}: every handler answers the "removed" bounce (no settings, no link), nothing written`,
        b.status === 200 && answers.every(r => r.status === 401 && r.headers.get('x-vr-auth') === 'removed' && !('link' in (r.wire ?? {})) && !('visibility' in (r.wire ?? {}))) && (await sevenNow()) === base,
        { ban: b.status, answers: answers.map(r => [r.status, r.headers.get('x-vr-auth')]) })
    }

    // ── § 23 e the freeze ───────────────────────────────────────────────────
    section('§ 23 e no signed-in host: the setting only narrows, no link')
    // A guest-hosted, promoted moment with a signed-in cohost.
    await setRole(G1.code, G1.host, `u:${Pv.pid}`, 'co_host')
    const fz = await getV(G1.code, Pv)
    check('guest-hosted: members, frozen, the cohost may edit (narrow), no link available',
      fz.status === 200 && fz.wire.visibility === 'members' && fz.wire.frozen === true && fz.wire.canEdit === true && fz.wire.link?.available === false, fz.wire)
    const w1 = await patchV(G1.code, Pv, { visibility: 'friends' }), w2 = await patchV(G1.code, Pv, { showPlace: true }), w3 = await patchV(G1.code, Pv, { visibility: 'members', showDetails: true })
    check('🔒 widening any of the four → 403 "This moment\'s visibility can\'t be widened" (also beside a no-op), nothing written',
      [w1, w2, w3].every(r => r.status === 403 && r.wire.error === 'This moment\'s visibility can\'t be widened') && (await rowOf({ code: G1.code })).visibility === 'members' && (await rowOf({ code: G1.code })).show_place === false, [w1.wire, w2.wire, w3.wire])
    check('re-sending the current values on a frozen moment is not refused', (await patchV(G1.code, Pv, { visibility: 'members', showPlace: false, showDetails: false })).status === 200)
    check('narrowing a switch on a frozen moment is allowed', (await patchV(G1.code, Pv, { includeGuestCircles: false })).status === 200 && (await rowOf({ code: G1.code })).include_guest_circles === false)
    check('🔒 a guest-hosted moment never gets a link (403), for its anonymous host and its cohost',
      (await postL(G1.code, Pv, 'share')).wire.error === 'This moment can\'t have a link' && (await postL(G1.code, G1.host, 'share')).status === 403 && (await rowOf({ code: G1.code })).link_active === false)
    check('…and its anonymous host cannot change the setting either', (await patchV(G1.code, G1.host, { visibility: 'members' })).status === 403)

    // A host who deletes their account: the moment keeps what it had.
    const Hd = await mkUser('Dora Deleter'), Cd = await mkUser('Cleo Cohost')
    const D = await createSession(Hd, 'Dora Deleter')
    const dw = await addWine(D, Hd, `${TAG} kept bottle`)
    await join(D, Cd)
    await setRole(D, Hd, `u:${Cd.pid}`, 'co_host')
    await rate(D, Cd, dw.id)
    await patchV(D, Hd, { visibility: 'followers', showPlace: true })
    await postL(D, Hd, 'share')
    const dBefore = await rowOf({ code: D })
    await deleteAccountDurable(Hd.id, {})
    const d1 = await rowOf({ code: D })
    check('🔒 …and its look-in link ended with its host, in the record itself: off, and a new version (the shared token no longer verifies)',
      dBefore.link_active === true && dBefore.link_version === 1 && d1.link_active === false && d1.link_version === 2
      && !link.verifyMomentLinkToken(d1.public_id, d1.link_version, link.momentLinkToken(d1.public_id, 1)!), { before: [dBefore.link_active, dBefore.link_version], after: [d1.link_active, d1.link_version] })
    check('a host deletes their account: the moment keeps its setting (the row is hostless, named [deleted])',
      !!d1 && d1.host_user_id === null && d1.host_name === '[deleted]' && d1.visibility === 'followers' && d1.show_place === true && d1.include_guest_circles === true, d1)
    const dg = await getV(D, Cd)
    check('…frozen from then on, and its link is gone for good (not available, not active)',
      dg.status === 200 && dg.wire.visibility === 'followers' && dg.wire.frozen === true && dg.wire.canEdit === true && JSON.stringify(dg.wire.link) === JSON.stringify({ available: false, active: false, url: null, since: null }), dg.wire)
    check('🔒 freeze both ways: narrowing passes, widening back is refused',
      (await patchV(D, Cd, { visibility: 'friends', showPlace: false })).status === 200 && (await patchV(D, Cd, { visibility: 'followers' })).status === 403 && (await patchV(D, Cd, { showPlace: true })).status === 403
      && (await rowOf({ code: D })).visibility === 'friends', await rowOf({ code: D }))
    const hostlessOff = await postL(D, Cd, 'off')
    check('🔒 no link action on a hostless moment (403), not even off', hostlessOff.status === 403 && (await postL(D, Cd, 'reset')).status === 403)
    const errors = [tp, gcp, gcl, w1, hostlessOff, lim[0], lim[1], gLim, badBody].map(r => String(r.wire?.error ?? ''))
    check('🔒 no em dash in any error string of the three handlers (host-only, freeze, no link, both 429s, invalid body)',
      errors.every(e => e.length > 0 && !e.includes('—')) && new Set(errors).size >= 5, errors)

    // ── § 23 f the scrub gate ───────────────────────────────────────────────
    section('§ 23 f both delete scrubs: a tombstone keeps id, deleted_at, public_id')
    // Every column non-NULL before the delete, so a column either scrub forgets
    // fails here. 🔒 A NEW sessions column must be filled in `fill` (and
    // scrubbed in both paths): the pre-check below fails until it is.
    const fill = (id: number) => prisma.$executeRaw`
      UPDATE sessions SET address = COALESCE(address, 'Rue 1'), date_to = COALESCE(date_to, now() + interval '2 days'), timezone = COALESCE(timezone, 'Europe/Zurich'),
             description = COALESCE(description, 'd'), link = COALESCE(link, 'https://example.test'), cover_photo_url = COALESCE(cover_photo_url, 'https://example.test/c.jpg'),
             blind = COALESCE(blind, false), blind_for_everyone = COALESCE(blind_for_everyone, false), hide_lineup = COALESCE(hide_lineup, false),
             hide_lineup_minutes_before = COALESCE(hide_lineup_minutes_before, 30), show_provenance = COALESCE(show_provenance, true), lifespan = COALESCE(lifespan, 'unlimited'),
             lineup_revision = COALESCE(lineup_revision, 1)
       WHERE id = ${id}`
    const nonNull = (j: J) => Object.entries(j).filter(([, v]) => v !== null).map(([key]) => key).sort()
    const KEPT = JSON.stringify(['deleted_at', 'id', 'public_id'])
    const scrubCase = async (label: string, host: User, kill: (code: string) => Promise<unknown>) => {
      const code = await createSession(host, 'Scrub Host')
      await patchV(code, host, { visibility: 'verre', showPlace: true, showDetails: true })
      await postL(code, host, 'share')
      const before = await rowOf({ code })
      await fill(before.id)
      const full = await rowOf({ id: before.id })
      const empty = Object.entries(full).filter(([key, v]) => v === null && key !== 'deleted_at').map(([key]) => key)
      check(`${label}: fixture has EVERY column set before the delete (a new column must be filled in this test)`, empty.length === 0, empty)
      await kill(code)
      const after = await rowOf({ id: before.id })
      check(`🔒 ${label}: the tombstone holds nothing but id, deleted_at, public_id (the seven Moment Visibility columns included)`, JSON.stringify(nonNull(after)) === KEPT, nonNull(after))
      check(`…and its public_id is the one it had`, after.public_id === before.public_id && PIDRE.test(after.public_id))
      return before.id as number
    }
    const Sd = await mkUser('Sven Scrub')
    const tombId = await scrubCase('DELETE /api/session/:code', Sd, async (code) => {
      await resetLimits()
      const r = await call(codeRoute.DELETE, 'DELETE', `/api/session/${code}`, Sd, undefined, { code })
      if (r.status !== 200) throw new Error(`delete failed ${r.status} ${JSON.stringify(r.json)}`)
    })
    const Wd = await mkUser('Wim Wiped')
    await scrubCase('account deletion\'s wipe of an empty moment', Wd, () => deleteAccountDurable(Wd.id, {}))

    // ── § 23 g the migration's one-off statements ───────────────────────────
    section('§ 23 g the migration\'s two marked blocks, run on fixture rows')
    const sql = readFileSync(MIGRATION, 'utf8')
    const block = (name: string) => {
      const m = sql.match(new RegExp(`-- @backfill:${name}\\n([\\s\\S]*?)-- @endbackfill`))
      if (!m) throw new Error(`block '${name}' not found in the migration (marker removed?)`)
      return m[1]
    }
    const blocks = `${block('tombstones')}\n${block('guest-hosted')}`
    // The four rows, put into the state ADD COLUMN … DEFAULT leaves them in.
    const fixtures = { hosted: m0.id as number, guestHosted: g1.id as number, hostDeleted: d1.id as number, tombstone: tombId }
    await prisma.$executeRaw`
      UPDATE sessions SET visibility = 'friends', include_guest_circles = true, show_place = false, show_details = false, link_version = 0, link_active = false, link_since = NULL
       WHERE id = ANY(${Object.values(fixtures)}::int[])`
    const pre = await rowOf({ id: fixtures.tombstone })
    check('fixture: the tombstone carries the column defaults, the guest-hosted row reads friends', pre.deleted_at !== null && pre.visibility === 'friends' && pre.link_version === 0 && (await rowOf({ id: fixtures.guestHosted })).visibility === 'friends')
    const run = spawnSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-f', '-'], { input: blocks, encoding: 'utf8' })
    if (run.error) throw run.error
    check('the two blocks run in one transaction (psql, verbatim from the migration file)', run.status === 0, run.stderr)
    const notice = /(\d+) live hostless moment\(s\) named \[deleted\]/.exec(run.stderr ?? '')
    check('the NOTICE counts the live hostless rows named [deleted] (at least this fixture\'s)', !!notice && Number(notice[1]) >= 1, run.stderr)
    const [a, b, c, d] = [await rowOf({ id: fixtures.hosted }), await rowOf({ id: fixtures.guestHosted }), await rowOf({ id: fixtures.hostDeleted }), await rowOf({ id: fixtures.tombstone })]
    check('🔒 a live moment with a signed-in host: Friends', a.visibility === 'friends' && a.include_guest_circles === true, a)
    check('🔒 a guest-hosted, promoted moment: members', b.visibility === 'members', b)
    check('🔒 a moment whose host deleted their account ([deleted]): keeps Friends', c.visibility === 'friends' && c.host_user_id === null, c)
    check('🔒 a tombstone: the seven columns NULL again, public_id set', SEVEN.every(col => d[col] === null) && PIDRE.test(d.public_id) && JSON.stringify(nonNull(d)) === KEPT, d)

    // ── § 23 h guests' `shown` ──────────────────────────────────────────────
    section('§ 23 h s:{CODE}:shown: added only when a join mints a guest')
    const Hh = await mkUser('Hedda Host'), Uh = await mkUser('Udo User')
    const S = await createSession(Hh, 'Hedda Host')
    flag(false)
    const gj = await join(S, {}, 'Gabi Guest')
    const gid = String(gj.wire.id)
    const ga: Actor = { anon: gj.wire.anonToken }
    const ttl = Number(await redis.pTTL(k.shown(S))), idTtl = Number(await redis.pTTL(k.identities(S)))
    check('an anonymous join adds the new identity to shown (flag off too), with the TTL of the roster',
      gid.startsWith('a:') && (await redis.sIsMember(k.shown(S), gid)) && ttl > 0 && Math.abs(ttl - idTtl) < 5000, { gid, ttl, idTtl })
    flag(true)
    await join(S, Uh)
    check('a signed-in join adds nobody', JSON.stringify(await redis.sMembers(k.shown(S))) === JSON.stringify([gid]))
    await redis.sRem(k.shown(S), gid)
    await resetLimits()
    const rn = await call(meNameRoute.PATCH, 'PATCH', `/api/session/${S}/me/name`, ga, { name: 'Gabi Renamed' }, { code: S })
    await join(S, Uh)
    check('🔒 a guest who hid stays hidden: a rename, and a signed-in rejoin, add nobody', rn.status === 200 && (await redis.sCard(k.shown(S))) === 0, { rename: rn.status, shown: await redis.sMembers(k.shown(S)) })
    const gj2 = await join(S, {}, 'Gabi Guest')
    check('a new anonymous join mints a NEW identity, and only that one is shown', gj2.wire.id !== gj.wire.id && JSON.stringify(await redis.sMembers(k.shown(S))) === JSON.stringify([String(gj2.wire.id)]))

    // The GET binds a guest's read to the incarnation it opened (a signed-in
    // caller's grant already does): a row of another incarnation → 503.
    const ga2: Actor = { anon: gj2.wire.anonToken }
    const sRow = await rowOf({ code: S })
    check('fixture: the guest reads the settings', (await getV(S, ga2)).status === 200)
    await prisma.$executeRaw`UPDATE sessions SET created_at = created_at + interval '1 second' WHERE id = ${sRow.id}`
    const other = await getV(S, ga2)
    check('🔒 the row under the code is another incarnation than the one opened → 503 + Retry-After, no settings', other.status === 503 && !!other.headers.get('retry-after') && !('visibility' in (other.wire ?? {})), [other.status, other.wire])
    await prisma.$executeRaw`UPDATE sessions SET created_at = NULL WHERE id = ${sRow.id}`
    check('…a live row with NO created_at cannot be compared and is served (as every other incarnation check does)', (await getV(S, ga2)).status === 200)
    await prisma.$executeRaw`UPDATE sessions SET created_at = ${new Date(sRow.created_at)} WHERE id = ${sRow.id}`

    // ── § 23 i blind rows ───────────────────────────────────────────────────
    section('§ 23 i blind rows carry no wine id unless you wrote the rating; ratingId on every row')
    const Hb = await mkUser('Hugo Blindhost'), Ab = await mkUser('Ada Author'), Vb = await mkUser('Vito Viewer')
    await prisma.follow.createMany({ data: [{ followerId: Vb.id, followingId: Ab.id }, { followerId: Ab.id, followingId: Vb.id }] })
    const B = await createSession(Hb, 'Hugo Blindhost')
    const bw = await addWine(B, Hb, `${TAG} Blind Label`)
    const sw = await addWine(B, Hb, `${TAG} Second Label`)
    await join(B, Ab); await join(B, Vb)
    await rate(B, Ab, bw.id); await rate(B, Ab, sw.id); await rate(B, Vb, bw.id)
    const bRow = await rowOf({ code: B })
    await prisma.$executeRaw`UPDATE sessions SET blind = true WHERE id = ${bRow.id}`
    await prisma.$executeRaw`UPDATE wines SET revealed_at = now() WHERE id = ${sw.id}`
    const rid = new Map((await prisma.$queryRaw`SELECT id, wine_id FROM ratings WHERE user_id = ${Ab.id} AND session_id = ${bRow.id}` as J[]).map(r => [r.wine_id as string, r.id as number]))
    const post = async (viewer: User) => {
      await resetLimits()
      const r = await call(feedRoute.GET, 'GET', `/api/feed?user=${Ab.pid}`, viewer)
      return ((r.wire?.items ?? []) as J[]).find(i => i.type === 'session' && i.session?.sessionId === bRow.id)?.session?.wines as J[] | undefined
    }
    const theirs = await post(Vb), mine = await post(Ab)
    const blindOf = (ws: J[] | undefined) => ws?.find(w => w.ratingId === rid.get(bw.id))
    const shownOf = (ws: J[] | undefined) => ws?.find(w => w.ratingId === rid.get(sw.id))
    check('fixture: Ada\'s post has both rows for Vito and for herself, one blind, one revealed',
      theirs?.length === 2 && mine?.length === 2 && blindOf(theirs)?._blind === true && !shownOf(theirs)?._blind && blindOf(mine)?._blind === true, { theirs, mine })
    check('🔒 someone else\'s post: the blind row has NO wine id (and the id is nowhere in the row, Vito rated that bottle too)',
      !!blindOf(theirs) && !('id' in blindOf(theirs)!) && !JSON.stringify(blindOf(theirs)).includes(bw.id), blindOf(theirs))
    check('…the revealed row keeps its id', shownOf(theirs)?.id === sw.id)
    check('🔒 your own post: the blind row keeps its wine id (Edit / Delete Rating)', blindOf(mine)?.id === bw.id && shownOf(mine)?.id === sw.id, mine)
    check('ratingId on every row, for both viewers', [...(theirs ?? []), ...(mine ?? [])].every(w => typeof w.ratingId === 'number' && [...rid.values()].includes(w.ratingId)))
    const web = (await loadSessionFeedWines([{ authorId: Ab.id, sessionId: bRow.id }], null)).get(pairKey(Ab.id, bRow.id)) ?? []
    check('🔒 the web profile\'s loader, signed out: the same (no id on the blind row, ratingId on both)',
      web.length === 2 && web.every(w => typeof w.ratingId === 'number') && web.some(w => w._blind && !('id' in w)) && web.some(w => !w._blind && w.id === sw.id), web)
  } finally {
    if (saved.flag === undefined) delete process.env.MOMENT_LOOKIN_ENABLED; else process.env.MOMENT_LOOKIN_ENABLED = saved.flag
    if (saved.secret === undefined) delete process.env.MOMENT_LINK_SECRET; else process.env.MOMENT_LINK_SECRET = saved.secret
  }
}
