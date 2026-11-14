// § 21 usernames (docs/dev/proposals/usernames.md § 12). Imported by
// scripts/tests/you-profile-integration.mts, which owns the throwaway stores,
// the actors and the canary (every response through `call` is scanned for a
// user integer, so the new routes join that walk here).
//   § 21 a schema: the format CHECK against the core validator (both ways),
//          never-NULL-again, the isolation refusal and its other half, a NULL
//          insert untouched, the trigger timing
//   § 21 b holds and quota: rename / switch back / a second rename keeps the
//          earlier name held / deleted account / expiry before and after a
//          prune / 5 changes then `quota` / a refused change spends nothing /
//          the operator path, its moderation block included
//   § 21 c the answer matrix (live, held, free × availability, both sign-ups,
//          the PUT, the logged-out lookup) and the two error shapes
//   § 21 d races on two real connections, each with its own negative control
//   § 21 e sign-up: app (Better Auth) and web, one step, the build checks
//   § 21 f your own session: fresh on every native response
//   § 21 g lookup: by-username equals the id route for every gate state; a
//          spent limiter runs no lookup
//   § 21 h emission: `username` on every person outside a moment; 🔒 never
//          inside one (responses and Redis)
//   § 21 i search
//   § 21 j limits, no-store, the writes census
import { execFileSync } from 'node:child_process'
import { dirname, join as pjoin } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { fixtureUsername, reservedFixtureUsername } from './lib/fixtureUsername.mjs'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a test harness
type Actor = { cookie?: string; anon?: string }
type User = { id: number; pid: string; cookie: string; email: string; password: string }
type Res = { status: number; json: J; wire: J; headers: Headers }
export type UsernamesHarness = {
  call: (handler: unknown, method: string, path: string, actor: Actor, body?: unknown, params?: Record<string, string>, extra?: Record<string, string>) => Promise<Res>
  check: (label: string, ok: boolean, detail?: unknown) => void
  section: (t: string) => void
  mkUser: (name: string) => Promise<User>
  createSession: (u: User, name?: string) => Promise<string>
  resetLimits: () => Promise<void>
  canary: (where: string, text: string, headers: Headers) => Promise<void>
  prisma: any // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  redis: any // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  scanKeys: (pattern: string) => Promise<string[]>
  betterAuthServer: any // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's instance
  TAG: string
  DB: string
}

const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY = 86400_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function usernames(h: UsernamesHarness) {
  const { call, check, section, mkUser, createSession, resetLimits, canary, prisma, redis, scanKeys, betterAuthServer, TAG, DB } = h
  const core = await import('../../packages/core/src/username.ts')
  const lib = await import('../../lib/username.ts')
  const { changeUsername, usernameTaken, usernameState, isUsernameConflict, usernameChangeSeams, USERNAME_CHANGE_LIMIT } = lib
  const { syncCredential } = await import('../../lib/identityStore.ts')
  const { pruneLocked } = await import('../../lib/nativeSessionPrune.ts')
  const { signRegisterToken } = await import('../../lib/registerToken.ts')
  const { resolveUser } = await import('../../lib/resolveUser.ts')
  const operator = await import('../set-username.mts')
  const usernameRoute = await import('../../app/api/me/username/route.ts')
  const availableRoute = await import('../../app/api/me/username/available/route.ts')
  const byUsernameRoute = await import('../../app/api/users/by-username/[username]/route.ts')
  const usersRoute = await import('../../app/api/users/[id]/route.ts')
  const registerRoute = await import('../../app/api/auth/register/route.ts')
  const nativeAuthRoute = await import('../../app/api/auth/native/[...all]/route.ts')
  const accountRoute = await import('../../app/api/me/account/route.ts')
  const devicesRoute = await import('../../app/api/me/devices/route.ts')
  const deviceRoute = await import('../../app/api/me/devices/[id]/route.ts')
  const searchRoute = await import('../../app/api/users/search/route.ts')
  const followersRoute = await import('../../app/api/users/[id]/followers/route.ts')
  const friendsRoute = await import('../../app/api/me/friends/route.ts')
  const tastedWithRoute = await import('../../app/api/me/tasted-with/route.ts')
  const blocksListRoute = await import('../../app/api/me/blocks/route.ts')
  const mutesRoute = await import('../../app/api/me/mutes/route.ts')
  const feedRoute = await import('../../app/api/feed/route.ts')
  const checkinsRoute = await import('../../app/api/checkins/route.ts')
  const joinRoute = await import('../../app/api/session/join/route.ts')
  const stateRoute = await import('../../app/api/session/[code]/state/route.ts')
  const codeRoute = await import('../../app/api/session/[code]/route.ts')
  const visitRoute = await import('../../app/api/session/[code]/visit/route.ts')
  const previewRoute = await import('../../app/api/session/[code]/preview/route.ts')
  const bansRoute = await import('../../app/api/session/[code]/bans/route.ts')
  const winesRoute = await import('../../app/api/session/[code]/wines/route.ts')
  const rateRoute = await import('../../app/api/session/[code]/rate/route.ts')
  const meSessionsRoute = await import('../../app/api/me/sessions/route.ts')
  const { Client } = await import('pg')

  // ── helpers ────────────────────────────────────────────────────────────────
  let bareSeq = 0
  type Bare = { id: number; pid: string; username: string | null }
  // A user row with no credential; `username` set through the app's writer
  // (a first choice: free, no change row).
  async function bare(name: string, username: string | null = fixtureUsername(), data: Record<string, unknown> = {}): Promise<Bare> {
    const row = await prisma.user.create({ data: { name, email: `${TAG}-un-${++bareSeq}@example.test`, ...data }, select: { id: true, publicId: true } })
    if (username !== null) { const r = await changeUsername(row.id, username); if (r.status !== 'ok') throw new Error(`fixture username refused: ${username} ${r.status}`) }
    return { id: row.id, pid: row.publicId, username }
  }
  const nameOf = async (id: number): Promise<string | null> => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { username: true } })).username
  const holds = (name: string) => prisma.$queryRaw`
    SELECT user_id, username, held_until, held_until > now() AS live FROM username_holds WHERE name_hash = username_hash(${name})` as Promise<{ user_id: number | null; username: string | null; held_until: Date; live: boolean }[]>
  const changes = async (id: number) => Number((await prisma.usernameChange.count({ where: { userId: id } })))
  const sqlErr = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; message?: string; meta?: J })
  const noStore = (r: Res) => r.headers.get('cache-control') === 'private, no-store'
  const put = async (u: Actor, username: unknown, reset = true) => { if (reset) await resetLimits(); return call(usernameRoute.PUT, 'PUT', '/api/me/username', u, { username }) }
  const getState = async (u: Actor) => { await resetLimits(); return call(usernameRoute.GET, 'GET', '/api/me/username', u) }
  const available = async (u: Actor, name: string) => { await resetLimits(); return call(availableRoute.GET, 'GET', `/api/me/username/available?username=${encodeURIComponent(name)}`, u) }
  const byName = async (v: Actor, name: string, qs = '') => { await resetLimits(); return call(byUsernameRoute.GET, 'GET', `/api/users/by-username/${name}${qs}`, v, undefined, { username: name }) }
  const byId = async (v: Actor, pid: string, qs = '') => { await resetLimits(); return call(usersRoute.GET, 'GET', `/api/users/${pid}${qs}`, v, undefined, { id: pid }) }
  // The native auth route MODULE (the wrapper rewrites the body), like § 18 (6).
  const baBase = (await betterAuthServer.$context).baseURL
  const baOrigin = new URL(baBase).origin
  const APP_UA = 'Verre/0.1.5 (iPhone 15 Pro; iOS 19.0)'
  const ba = async (method: 'GET' | 'POST', path: string, body?: unknown, cookie?: string) => {
    await resetLimits()
    const baLimits = await scanKeys('*|/*')
    if (baLimits.length) await redis.del(baLimits)
    const res = await (method === 'GET' ? nativeAuthRoute.GET : nativeAuthRoute.POST)(new NextRequest(`${baBase}${path}`, { method, headers: { 'content-type': 'application/json', origin: baOrigin, 'user-agent': APP_UA, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }))
    const text = await res.text()
    await canary(`BA ${path}`, text, res.headers)
    let json: J | null = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
    return { status: res.status, headers: res.headers, json: json as J }
  }
  const cookieOf = (hdrs: Headers) => (hdrs.get('set-cookie') ?? '').split(';')[0]
  const authenticatesAs = async (cookie: string, id: number) => (await resolveUser(new NextRequest('http://localhost:3000/api/me/devices', { headers: { cookie } })))?.user?.id === String(id)
  const appSignUp = (over: J = {}) => ba('POST', '/sign-up/email', { name: 'Ada App', email: `${TAG}-un-app-${++bareSeq}@example.test`, password: 'pw-app-12345', username: fixtureUsername('app'), ...over })
  // The web form token: signed, and at least 800 ms old at submit.
  const formToken = signRegisterToken()
  await sleep(900)
  const webRegister = async (over: J = {}) => { await resetLimits(); return call(registerRoute.POST, 'POST', '/api/auth/register', {}, { name: 'Wes Web', email: `${TAG}-un-web-${++bareSeq}@example.test`, password: 'pw-web-12345', username: fixtureUsername('web'), formToken, ...over }) }
  const stillPending = (p: Promise<unknown>) => Promise.race([p.then(() => false, () => false), sleep(150).then(() => true)])
  async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (!(await stillPending(p))) return false
      const [{ n }] = await prisma.$queryRaw`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'` as { n: bigint }[]
      if (Number(n) > 0) return stillPending(p)
    }
    return false
  }
  const conn = async () => { const c = new Client({ connectionString: DB }); await c.connect(); return c }

  // ── § 21 a schema ───────────────────────────────────────────────────────────
  section('§ 21 a usernames: schema invariants Prisma can\'t see')
  const [chk] = await prisma.$queryRaw`
    SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = 'users_username_format_chk' AND c.conrelid = 'users'::regclass` as { def: string }[]
  check('the format CHECK exists on users', typeof chk?.def === 'string' && chk.def.startsWith('CHECK ('), chk)
  // A generated table of names: every string of 1 to 4 characters over a small
  // alphabet (each class, an uppercase letter, a hyphen, a space, a non-ASCII
  // letter), the length edges, and dots in every position.
  const ALPHA = ['a', 'z', '0', '9', '.', '_', 'A', '-', ' ', 'é']
  const names = new Set<string>(['', 'ab', 'abc', 'a'.repeat(29), 'a'.repeat(30), 'a'.repeat(31), '.' + 'a'.repeat(29), 'a'.repeat(29) + '.', 'a'.repeat(14) + '..' + 'a'.repeat(14), 'simon.f_1', 'ſimon', 'straße', 'a\nb', 'abc\n', 'a\u0000b'.replace('\u0000', '\t')])
  const grow = (prefix: string, depth: number) => { if (prefix) names.add(prefix); if (depth === 0) return; for (const ch of ALPHA) grow(prefix + ch, depth - 1) }
  grow('', 4)
  const table = [...names]
  // The DATABASE's own predicate (read from the catalog, never retyped here)
  // over the whole table in one statement.
  const verdicts = await prisma.$queryRawUnsafe(
    `SELECT username, COALESCE(${chk.def.replace(/^CHECK /, '')}, FALSE) AS ok FROM unnest($1::text[]) AS t(username)`, table) as { username: string; ok: boolean }[]
  const disagree = verdicts.filter(v => v.ok !== core.isUsernameFormat(v.username)).map(v => JSON.stringify(v.username))
  check(`🔒 the CHECK agrees with the core validator over ${table.length} generated names, both ways`, verdicts.length === table.length && disagree.length === 0, disagree.slice(0, 10))
  check('…and the table holds both verdicts (it can fail either way)', verdicts.some(v => v.ok) && verdicts.filter(v => !v.ok).length > 1000, { ok: verdicts.filter(v => v.ok).length })
  const S = await bare('Sam Schema', null)
  const badWrite = await sqlErr(prisma.$executeRaw`UPDATE users SET username = 'Bad-Name' WHERE id = ${S.id}`)
  check('a malformed name written past the app is refused by the CHECK (23514)', JSON.stringify(badWrite?.meta ?? badWrite?.message ?? '').includes('users_username_format_chk'), badWrite?.message)
  const trig = await prisma.$queryRaw`
    SELECT tgname, (tgtype & 2) <> 0 AS before, (tgtype & 4) <> 0 AS ins, (tgtype & 16) <> 0 AS upd, (tgtype & 8) <> 0 AS del
      FROM pg_trigger WHERE tgrelid = 'users'::regclass AND tgname LIKE 'users_username_%' ORDER BY tgname` as { tgname: string; before: boolean; ins: boolean; upd: boolean; del: boolean }[]
  const shape = trig.map(t => `${t.tgname}:${t.before ? 'BEFORE' : 'AFTER'}:${t.ins ? 'I' : ''}${t.upd ? 'U' : ''}${t.del ? 'D' : ''}`).join()
  check('🔒 the claim triggers are AFTER insert / update, the hold BEFORE delete, the keep BEFORE update', shape === 'users_username_claim_insert:AFTER:I,users_username_claim_update:AFTER:U,users_username_hold_delete:BEFORE:D,users_username_keep:BEFORE:U', shape)
  const holdsBefore = Number((await prisma.usernameHold.count()))
  const N = await bare('Nul Insert', null)
  check('an insert with a NULL username passes untouched (an old instance\'s register), no hold written', (await nameOf(N.id)) === null && Number(await prisma.usernameHold.count()) === holdsBefore)
  const sName = fixtureUsername()
  check('a first choice is set', (await changeUsername(S.id, sName)).status === 'ok' && (await nameOf(S.id)) === sName)
  const cleared = await sqlErr(prisma.$executeRaw`UPDATE users SET username = NULL WHERE id = ${S.id}`)
  check('🔒 set once, never cleared: username → NULL is refused', !!cleared && (await nameOf(S.id)) === sName, cleared?.message)
  const rr = await sqlErr(prisma.$transaction(async (tx: any) => { await tx.user.update({ where: { id: S.id }, data: { username: fixtureUsername() } }) }, { isolationLevel: 'RepeatableRead' })) // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  check('🔒 a username write under REPEATABLE READ is refused', !!rr && /READ COMMITTED/.test(String(rr.message ?? '') + JSON.stringify(rr.meta ?? '')) && (await nameOf(S.id)) === sName, rr?.message)
  const rrOther = await sqlErr(prisma.$transaction(async (tx: any) => { await tx.user.update({ where: { id: S.id }, data: { bio: 'still fine' } }) }, { isolationLevel: 'RepeatableRead' })) // eslint-disable-line @typescript-eslint/no-explicit-any -- the suite's client
  check('…its other half: an update that does NOT name username passes under REPEATABLE READ', rrOther === null, rrOther?.message)
  const dup = await sqlErr(prisma.user.update({ where: { id: N.id }, data: { username: sName } }))
  check('the unique index refuses a second owner', dup?.code === 'P2002')

  // ── § 21 b holds and quota ──────────────────────────────────────────────────
  section('§ 21 b usernames: holds and the rename quota')
  const H = await bare('Hol Holder')
  const O = await bare('Oth Other')
  const h1 = H.username!, h2 = fixtureUsername(), h3 = fixtureUsername()
  check('a first choice is free: no change row, no hold', (await changes(H.id)) === 0 && (await holds(h1)).length === 0)
  check('a rename goes through', (await changeUsername(H.id, h2)).status === 'ok' && (await nameOf(H.id)) === h2)
  const hold1 = await holds(h1)
  check('🔒 the old name is held 14 days for its owner, in clear text', hold1.length === 1 && hold1[0].user_id === H.id && hold1[0].username === h1 && Math.abs(hold1[0].held_until.getTime() - (Date.now() + 14 * DAY)) < 120_000, hold1)
  check('…it counts as one change', (await changes(H.id)) === 1)
  check('🔒 the pre-check and the trigger agree: taken for anyone else (and a sign-up), not for the owner', (await usernameTaken(h1, O.id)) && (await usernameTaken(h1)) && !(await usernameTaken(h1, H.id)))
  check('…someone else is refused like a taken name', (await changeUsername(O.id, h1)).status === 'taken' && (await nameOf(O.id)) === O.username)
  const st1 = await usernameState(H.id)
  check('the state names the held old name ("switch back")', st1?.previous?.username === h1 && st1.changesLeft === USERNAME_CHANGE_LIMIT - 1 && st1.nextChangeAt === null, st1)
  check('the owner switches back', (await changeUsername(H.id, h1)).status === 'ok' && (await nameOf(H.id)) === h1)
  check('…which counts as a change, and now holds the OTHER name', (await changes(H.id)) === 2 && (await holds(h1)).length === 0 && (await holds(h2))[0]?.user_id === H.id)
  const [h2Before] = await holds(h2)
  check('a second rename goes through; the newest old name is held for its owner', (await changeUsername(H.id, h3)).status === 'ok' && (await holds(h1))[0]?.username === h1 && (await holds(h1))[0]?.user_id === H.id)
  const [h2After] = await holds(h2)
  check('🔒 …and the EARLIER old name is not freed: still held until its own date, with no owner and no clear text', h2After?.live === true && h2After.user_id === null && h2After.username === null && h2After.held_until.getTime() === h2Before.held_until.getTime(), h2After)
  check('…so nobody can take it early, and its former owner can only switch back to the most recent one', (await changeUsername(O.id, h2)).status === 'taken' && (await changeUsername(H.id, h2)).status === 'taken' && (await usernameState(H.id))?.previous?.username === h1)
  const oOld = O.username!, o2 = fixtureUsername()
  check('fixture: the other user renames once', (await changeUsername(O.id, o2)).status === 'ok')
  // A deleted account: its current name AND its own rename hold.
  await prisma.$executeRaw`DELETE FROM users WHERE id = ${O.id}`
  const [dCur] = await holds(o2), [dOld] = await holds(oOld)
  check('🔒 a deleted account\'s name is held 14 days with no user and no clear text', dCur?.user_id === null && dCur.username === null && Math.abs(dCur.held_until.getTime() - (Date.now() + 14 * DAY)) < 120_000, dCur)
  check('🔒 …its own rename hold loses the user and the clear text, keeps its date', dOld?.user_id === null && dOld.username === null && dOld.live, dOld)
  check('…both refuse everyone', (await usernameTaken(o2, H.id)) && (await usernameTaken(oOld)) && (await changeUsername(H.id, o2)).status === 'taken')
  check('no hold row carries the deleted user anywhere', Number((await prisma.usernameHold.count({ where: { userId: O.id } }))) === 0 && Number((await prisma.usernameChange.count({ where: { userId: O.id } }))) === 0)
  // Expiry: the claim tests the date itself, before any prune ran.
  await prisma.$executeRaw`UPDATE username_holds SET held_until = now() - interval '1 second' WHERE name_hash = username_hash(${o2})`
  check('🔒 an expired hold no longer refuses, though its row is still there', (await holds(o2)).length === 1 && !(await usernameTaken(o2, H.id)))
  const E = await bare('Exp Expiry', null)
  check('…the name can be claimed', (await changeUsername(E.id, o2)).status === 'ok' && (await nameOf(E.id)) === o2)
  check('…and the trigger\'s own prune removed the expired row', (await holds(o2)).length === 0)
  await prisma.$executeRaw`UPDATE username_holds SET held_until = now() - interval '1 second' WHERE name_hash = username_hash(${oOld})`
  await pruneLocked()
  check('the daily job removes an expired hold with no username write at all', (await holds(oOld)).length === 0 && (await holds(h1)).length === 1)

  // The quota, through the route.
  const Q = await mkUser('Quin Quota')
  const used: string[] = []
  let lastOk: Res | null = null
  for (let i = 0; i < USERNAME_CHANGE_LIMIT; i++) { used.push(fixtureUsername('q')); lastOk = await put(Q, used[i]) }
  check('5 changes pass; the PUT answers the GET\'s shape', lastOk?.status === 200 && lastOk.wire.username === used[4] && lastOk.wire.changesLeft === 0 && lastOk.wire.previous?.username === used[3] && noStore(lastOk), lastOk?.wire)
  const oldest = (await prisma.usernameChange.findFirstOrThrow({ where: { userId: Q.id }, orderBy: { changedAt: 'asc' } })).changedAt as Date
  // + 1 ms: the stored time has microseconds, and the date handed out must never be early.
  const nextAt = new Date(oldest.getTime() + 90 * DAY + 1).toISOString()
  check('…and names when the next one is possible (the oldest change + 90 days)', lastOk?.wire.nextChangeAt === nextAt, { got: lastOk?.wire.nextChangeAt, nextAt })
  const got = await getState(Q)
  check('GET /api/me/username answers the same state, no-store; 401 signed out', got.status === 200 && JSON.stringify(got.wire) === JSON.stringify(lastOk?.wire) && noStore(got) && (await getState({})).status === 401, got.wire)
  const sixth = await put(Q, fixtureUsername('q'))
  check('🔒 the 6th answers 409 quota with that date, nothing written', sixth.status === 409 && sixth.wire.code === 'quota' && sixth.wire.nextChangeAt === nextAt && (await nameOf(Q.id)) === used[4] && (await changes(Q.id)) === 5 && noStore(sixth), sixth.wire)
  const backAtQuota = await put(Q, used[3])
  check('…switching back counts too (D5): quota, not taken', backAtQuota.status === 409 && backAtQuota.wire.code === 'quota', backAtQuota.wire)
  const opAtQuota = await operator.run([Q.email, fixtureUsername('op'), '--apply'])
  check('🔒 the operator path skips the quota and adds no change row', opAtQuota.exit === 0 && opAtQuota.out.result === 'set' && (await changes(Q.id)) === 5, opAtQuota)
  await prisma.$executeRaw`UPDATE username_changes SET changed_at = now() - interval '91 days' WHERE user_id = ${Q.id} AND changed_at = ${oldest}`
  const rolled = await put(Q, fixtureUsername('q'))
  check('the window rolls: 90 days after the oldest change one more passes, and the old row is dropped', rolled.status === 200 && (await changes(Q.id)) === 5, rolled.wire)
  const R = await mkUser('Ref Refused')
  const rBefore = await nameOf(R.id)
  const refused = await put(R, used[4] === (await nameOf(Q.id)) ? used[4] : (await nameOf(Q.id)))
  check('🔒 a refused change (taken) spends no quota and leaves no change row', refused.status === 409 && refused.wire.code === 'taken' && (await changes(R.id)) === 0 && (await nameOf(R.id)) === rBefore && noStore(refused), refused.wire)
  const same = await put(R, rBefore)
  check('the same name again → 200, unchanged, no change row', same.status === 200 && same.wire.username === rBefore && (await changes(R.id)) === 0)
  const typed = await put(R, `  @${fixtureUsername('r').toUpperCase()} `)
  check('a typed name is stored and echoed in the canonical form', typed.status === 200 && typed.wire.username === (await nameOf(R.id)) && /^[a-z0-9._]+$/.test(typed.wire.username), typed.wire)
  const invalid = await put(R, 'a..b'), reserved = await put(R, 'verre_official'), missing = await put(R, undefined)
  check('a name with no letter or digit, and a staff-only name, are refused', (await put(R, '_._')).wire.code === 'invalid' && (await put(R, '___')).wire.error === 'username must contain a letter or a number' && (await put(R, 'official_support')).wire.code === 'reserved')
  const glass = await available(R, `verremodern_${Date.now().toString(36)}`)
  check('a name with the brand and a staff word inside ANOTHER word is not reserved (the narrowed brand rule)', glass.wire.available === true, glass.wire)
  check('invalid / reserved / missing → 400 with the validator\'s message and reason', invalid.status === 400 && invalid.wire.code === 'invalid' && reserved.status === 400 && reserved.wire.code === 'reserved' && missing.status === 400 && missing.wire.error === 'username is required', { invalid: invalid.wire, reserved: reserved.wire, missing: missing.wire })
  check('the PUT needs a session (401) and the same origin (403), both no-store',
    (await put({}, fixtureUsername())).status === 401 && (await call(usernameRoute.PUT, 'PUT', '/api/me/username', R, { username: fixtureUsername() }, {}, { origin: 'https://evil.example' })).status === 403)

  // The operator script.
  const opDry = await operator.run([R.email, fixtureUsername('op')])
  check('operator: a dry run by default writes nothing', opDry.exit === 0 && opDry.out.mode === 'dry-run' && opDry.out.result === 'would be set' && (await nameOf(R.id)) === typed.wire.username, opDry)
  const opReserved = await operator.run([R.email, 'verre_hq', '--apply'])
  check('operator: a reserved name needs --allow-reserved', opReserved.exit === 2 && (await nameOf(R.id)) === typed.wire.username, opReserved)
  const opTaken = await operator.run([R.email, (await nameOf(Q.id))!, '--apply'])
  const opHeld = await operator.run([R.email, h1, '--apply'])
  check('🔒 operator: a taken or a held name is refused by the database', opTaken.exit === 1 && opHeld.exit === 1 && (await nameOf(R.id)) === typed.wire.username, { opTaken, opHeld })
  check('operator: an invalid name / an unknown email / a bad flag', (await operator.run([R.email, 'a..b', '--apply'])).exit === 2 && (await operator.run([`${TAG}-nobody@example.test`, fixtureUsername(), '--apply'])).exit === 1 && (await operator.run([R.email, fixtureUsername(), '--force'])).exit === 2)
  // A moderation rename: without --block-old the renamed person switches straight back.
  const Mod = await mkUser('Mod Target'), modOld = (await nameOf(Mod.id))!
  const plain = await operator.run([Mod.email, fixtureUsername('op'), '--apply'])
  const undone = await put(Mod, modOld)
  check('operator: a plain rename can be undone by the user (the old name is held FOR them)', plain.exit === 0 && undone.status === 200 && (await nameOf(Mod.id)) === modOld, undone.wire)
  const blocked = await operator.run([Mod.email, fixtureUsername('op'), '--apply', '--block-old'])
  const [blk] = await holds(modOld)
  check('🔒 operator: --block-old blocks the old name for everyone: no owner, no clear text, no end date', blocked.exit === 0 && blk?.user_id === null && blk.username === null && blk.held_until.getUTCFullYear() === 9999, { blocked, blk })
  // 🔒 The person renames between the script's read and its write: the block
  // must not land on another name, nor be reported while the offending one
  // stays held FOR them (Codex review).
  const Sly = await mkUser('Sly Racer'), slyOld = (await nameOf(Sly.id))!, slyDest = fixtureUsername('op')
  const slyMoved = fixtureUsername('sly')
  const racedBlock = await operator.run([Sly.email, slyDest, '--apply', '--block-old'], { beforeWrite: async () => { await put(Sly, slyMoved) } })
  const [slyHold] = await holds(slyOld)
  check('🔒 operator: a rename that lands between its read and its write → refused, nothing written, nothing reported blocked', racedBlock.exit === 1 && racedBlock.out.now === slyMoved && !('oldName' in racedBlock.out) && (await nameOf(Sly.id)) === slyMoved && slyHold?.user_id === Sly.id && slyHold.held_until.getUTCFullYear() < 9999 && (await holds(slyMoved)).length === 0, { racedBlock, slyHold })
  const racedSame = await operator.run([Sly.email, slyDest, '--apply', '--block-old'], { beforeWrite: async () => { await put(Sly, slyDest) } })
  check('🔒 …also when they take the destination themselves (no false "set", no false block)', racedSame.exit === 1 && racedSame.out.now === slyDest && (await holds(slyMoved))[0]?.user_id === Sly.id, racedSame)
  const rerun = await operator.run([Sly.email, fixtureUsername('op'), '--apply', '--block-old'])
  check('…running it again blocks the name they hold now', rerun.exit === 0 && (await holds(slyDest))[0]?.held_until.getUTCFullYear() === 9999 && (await holds(slyDest))[0]?.user_id === null, rerun)
  // "blocked" is claimed only for a written (or, dry, a would-be-written) change.
  const modNow = (await nameOf(Mod.id))!
  const sameBlk = await operator.run([Mod.email, modNow, '--apply', '--block-old'])
  const takenBlk = await operator.run([Mod.email, (await nameOf(Q.id))!, '--apply', '--block-old'])
  const takenDry = await operator.run([Mod.email, (await nameOf(Q.id))!, '--block-old'])
  const okDry = await operator.run([Mod.email, fixtureUsername('op'), '--block-old'])
  check('🔒 operator: no "blocked" claim on an unchanged or a refused outcome, dry or applied', sameBlk.out.result === 'unchanged' && !('oldName' in sameBlk.out) && takenBlk.exit === 1 && !('oldName' in takenBlk.out) && takenDry.exit === 1 && !('oldName' in takenDry.out), { sameBlk, takenBlk, takenDry })
  check('…a dry run that would go through says "would be blocked"; the applied one says "blocked"', /^would be blocked/.test(String(okDry.out.oldName)) && /^blocked/.test(String(blocked.out.oldName)) && (await holds(modNow)).length === 0, { okDry: okDry.out, blocked: blocked.out })
  const modState = await getState(Mod)
  check('🔒 …the renamed person cannot switch back, and is not offered it', (await put(Mod, modOld)).wire.code === 'taken' && modState.wire.previous === null && (await available(Mod, modOld)).wire.reason === 'taken')
  check('…a later rename by them does not touch the block', (await put(Mod, fixtureUsername('m'))).status === 200 && (await holds(modOld))[0]?.held_until.getUTCFullYear() === 9999)
  await pruneLocked()
  check('…no prune removes it', (await holds(modOld)).length === 1)
  const unblock = await operator.run(['--release-hold', modOld, '--apply'])
  check('…only --release-hold frees it', unblock.out.released === 1 && !(await usernameTaken(modOld)))
  // An account holding an operator-assigned reserved name can re-submit it.
  const Rsv = await mkUser('Res Erved'), rsvName = reservedFixtureUsername()
  await operator.run(['--release-hold', rsvName, '--apply'])
  const rsvSet = await operator.run([Rsv.email, rsvName, '--apply', '--allow-reserved'])
  const rsvSame = await put(Rsv, rsvName, false)
  check('the same RESERVED name again → 200 (answered as a read, before the reserved list and the change budget)', rsvSet.exit === 0 && rsvSame.status === 200 && rsvSame.wire.username === rsvName && (await redis.get(`rl:username-set:user:${Rsv.id}:1h`)) === null, { rsvSet, rsvSame: rsvSame.wire })
  await operator.run([Rsv.email, fixtureUsername('op'), '--apply', '--block-old'])
  await operator.run(['--release-hold', rsvName, '--apply'])

  const relDry = await operator.run(['--release-hold', h1])
  const rel = await operator.run(['--release-hold', h1, '--apply'])
  check('operator: --release-hold frees a held name at once (dry run first)', relDry.out.held === true && (await holds(h1)).length === 0 && rel.out.released === 1 && !(await usernameTaken(h1)), { relDry, rel })

  // ── § 21 c the answer matrix and the error shapes ───────────────────────────
  section('§ 21 c usernames: one answer per surface for a live, a held and a free name')
  const V = await mkUser('Vera Viewer')
  const L = await bare('Liv Live', fixtureUsername('live'), { profileVisibility: 'public-internet' })
  const RH = await bare('Ren Hold')
  const renamedAway = RH.username!
  await changeUsername(RH.id, fixtureUsername())                 // a rename hold (someone else's)
  const DH = await bare('Del Hold')
  const deletedName = DH.username!
  await prisma.$executeRaw`DELETE FROM users WHERE id = ${DH.id}`  // a deleted account's hold
  const freeName = fixtureUsername('free')
  const rows: Record<string, string> = {}
  for (const [kind, name] of [['live', L.username!], ['rename-hold', renamedAway], ['deleted-hold', deletedName], ['free', freeName]] as const) {
    const av = await available(V, name)
    const app = await appSignUp({ username: name })
    const web = kind === 'free' ? null : await webRegister({ username: name })
    const P = await mkUser(`Put ${kind}`)
    const p = await put(P, name)
    const look = await byName({}, name)
    rows[kind] = [
      av.wire.available ? 'available' : av.wire.reason,
      app.status === 200 ? 'created' : app.json.code,
      web === null ? '-' : web.status === 409 ? `409:${Object.keys(web.wire.fields ?? {}).join()}` : String(web.status),
      p.status === 200 ? 'set' : p.wire.code,
      String(look.status),
    ].join(' | ')
  }
  // availability | app sign-up | web register | PUT | logged-out lookup
  check('a LIVE name: taken everywhere, and the profile opens', rows.live === 'taken | USERNAME_TAKEN | 409:username | taken | 200', rows.live)
  check('🔒 a HELD name (a rename): "taken" on every write surface, never a generic failure; the lookup is 404', rows['rename-hold'] === 'taken | USERNAME_TAKEN | 409:username | taken | 404', rows['rename-hold'])
  check('🔒 a HELD name (a deleted account): the same', rows['deleted-hold'] === 'taken | USERNAME_TAKEN | 409:username | taken | 404', rows['deleted-hold'])
  // The free row's app sign-up took the name first, so its PUT is refused by design.
  check('a FREE name: available, and the first writer gets it', rows.free === 'available | created | - | taken | 200', rows.free)
  const own = await mkUser('Own Name')
  const ownOld = (await nameOf(own.id))!
  await put(own, fixtureUsername())
  const ownAv = await available(own, ownOld)
  check('your own held name is available to you (and only to you)', ownAv.wire.available === true && (await available(V, ownOld)).wire.reason === 'taken' && noStore(ownAv), ownAv.wire)
  check('availability names invalid and reserved, and needs a session', (await available(V, 'a..b')).wire.reason === 'invalid' && (await available(V, 'teamverre')).wire.reason === 'reserved' && (await available({}, freeName)).status === 401)

  const shapeUser = await bare('Sha Shape')
  const modelTaken = await sqlErr(prisma.user.update({ where: { id: shapeUser.id }, data: { username: L.username } }))
  const rawTaken = await sqlErr(prisma.$executeRaw`UPDATE users SET username = ${L.username} WHERE id = ${shapeUser.id}`)
  const modelHeld = await sqlErr(prisma.user.update({ where: { id: shapeUser.id }, data: { username: renamedAway } }))
  const rawHeld = await sqlErr(prisma.$executeRaw`UPDATE users SET username = ${renamedAway} WHERE id = ${shapeUser.id}`)
  check('🔒 a taken AND a held name are P2002 through a model call', modelTaken?.code === 'P2002' && modelHeld?.code === 'P2002', { modelTaken: modelTaken?.code, modelHeld: modelHeld?.code })
  check('🔒 …and P2010 carrying 23505 through a raw statement (why every app write is a model call)', rawTaken?.code === 'P2010' && rawHeld?.code === 'P2010' && JSON.stringify(rawHeld?.meta).includes('23505'), { rawTaken: rawTaken?.code, rawHeld: rawHeld?.code })
  const emailDup = await sqlErr(prisma.user.create({ data: { name: 'Dup Email', email: V.email } }))
  check('isUsernameConflict takes all four; it is ANY unique violation (an email collision too), never another error', [modelTaken, rawTaken, modelHeld, rawHeld, emailDup].every(isUsernameConflict) && !isUsernameConflict(badWrite) && !isUsernameConflict(new Error('x')) && !isUsernameConflict(null))

  // ── § 21 d races ────────────────────────────────────────────────────────────
  section('§ 21 d usernames: races on two real connections')
  // (1) A claim against an UNCOMMITTED rename, then against an uncommitted deletion.
  // The claim is an UPDATE (a rename) or an INSERT (both sign-ups).
  const claimRace = async (release: 'rename' | 'delete', claimBy: 'update' | 'insert' = 'update') => {
    const A = await bare('Race Releaser'), B = await bare('Race Claimer')
    const name = A.username!
    const insertEmail = `${TAG}-un-race-${++bareSeq}@example.test`
    const holder = await conn()
    try {
      await holder.query('BEGIN')
      if (release === 'rename') await holder.query('UPDATE users SET username = $1 WHERE id = $2', [fixtureUsername(), A.id])
      else await holder.query('DELETE FROM users WHERE id = $1', [A.id])
      const write = claimBy === 'update'
        ? prisma.user.update({ where: { id: B.id }, data: { username: name }, select: { id: true } })
        : prisma.user.create({ data: { name: 'Race Insert', email: insertEmail, username: name }, select: { id: true } })
      const claim = write.then(() => 'claimed', (e: { code?: string }) => e.code ?? 'error') as Promise<string>
      const waited = await blockedOnLock(claim)
      await holder.query('COMMIT')
      const outcome = await claim
      const owner = claimBy === 'update' ? await nameOf(B.id) : ((await prisma.user.findUnique({ where: { email: insertEmail }, select: { username: true } }))?.username ?? null)
      return { waited, outcome, owner, name }
    } finally { await holder.end() }
  }
  const r1 = await claimRace('rename')
  check('🔒 a claim against an uncommitted RENAME waits, then is refused once the hold commits', r1.waited && r1.outcome === 'P2002' && r1.owner !== r1.name, r1)
  const r2 = await claimRace('delete')
  check('🔒 a claim against an uncommitted DELETION: the same', r2.waited && r2.outcome === 'P2002' && r2.owner !== r2.name, r2)
  const r3 = await claimRace('rename', 'insert'), r4 = await claimRace('delete', 'insert')
  check('🔒 an INSERT claim (the sign-up path) against either: waits, refused, no row created', [r3, r4].every(r => r.waited && r.outcome === 'P2002' && r.owner === null), { r3, r4 })
  // Control: the same race with the trigger switched to BEFORE must let the
  // claim through (it looks before the wait on the unique index).
  const [{ def: fn }] = await prisma.$queryRaw`SELECT pg_get_functiondef('public.users_username_hold()'::regprocedure) AS def` as { def: string }[]
  await prisma.$executeRawUnsafe(fn.replace('public.users_username_hold()', 'public.users_username_hold_ctl()').replaceAll('RETURN NULL;', 'RETURN NEW;'))
  await prisma.$executeRawUnsafe('ALTER TABLE users DISABLE TRIGGER users_username_claim_update')
  await prisma.$executeRawUnsafe('CREATE TRIGGER users_username_claim_ctl BEFORE UPDATE OF username ON users FOR EACH ROW WHEN (NEW.username IS DISTINCT FROM OLD.username) EXECUTE FUNCTION public.users_username_hold_ctl()')
  let ctl: Awaited<ReturnType<typeof claimRace>>
  try { ctl = await claimRace('rename') } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER users_username_claim_ctl ON users')
    await prisma.$executeRawUnsafe('DROP FUNCTION public.users_username_hold_ctl()')
    await prisma.$executeRawUnsafe('ALTER TABLE users ENABLE TRIGGER users_username_claim_update')
  }
  check('…negative control: with a BEFORE trigger the same claim slips through (so AFTER is what refuses it)', ctl.waited && ctl.outcome === 'claimed' && ctl.owner === ctl.name, ctl)
  const back = await claimRace('rename')
  check('…and the real trigger is back', back.outcome === 'P2002')

  // (2) Two renames by ONE account that has 4 changes on record.
  const quotaRace = async (lockRow: boolean) => {
    const A = await bare('Race Quota')
    await prisma.usernameChange.createMany({ data: Array.from({ length: USERNAME_CHANGE_LIMIT - 1 }, () => ({ userId: A.id })) })
    let reached = 0
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    let first!: () => void
    const firstReached = new Promise<void>(r => { first = r })
    usernameChangeSeams.lockRow = lockRow
    usernameChangeSeams.afterQuotaRead = async () => { reached++; first(); await gate }
    try {
      const p1 = changeUsername(A.id, fixtureUsername())
      await firstReached
      const p2 = changeUsername(A.id, fixtureUsername())
      // With the row lock the second waits on it and never reads the quota;
      // without it, it reads the same 4 prior changes.
      const secondWaited = lockRow ? await blockedOnLock(p2) : (await sleep(400), false)
      const readBoth = reached === 2
      open()
      const out = [await p1, await p2].map(r => r.status).sort().join()
      return { out, secondWaited, readBoth, rows: await changes(A.id), holdsNow: Number(await prisma.usernameHold.count({ where: { userId: A.id } })) }
    } finally { usernameChangeSeams.lockRow = true; usernameChangeSeams.afterQuotaRead = async () => {} }
  }
  const qr = await quotaRace(true)
  check('🔒 two renames at 4 changes: exactly one succeeds, the other answers quota', qr.out === 'ok,quota' && qr.secondWaited && !qr.readBoth, qr)
  check('…one change row and one hold transition commit', qr.rows === USERNAME_CHANGE_LIMIT && qr.holdsNow === 1, qr)
  const qc = await quotaRace(false)
  check('…negative control: without the row lock both read 4 prior changes and both succeed (6 on record)', qc.readBoth && qc.out === 'ok,ok' && qc.rows === USERNAME_CHANGE_LIMIT + 1, qc)

  // (3) Two claims of one free name: the unique index decides.
  const [T1, T2] = [await bare('Two One', null), await bare('Two Two', null)]
  const prize = fixtureUsername()
  const both = (await Promise.all([changeUsername(T1.id, prize), changeUsername(T2.id, prize)])).map(r => r.status).sort().join()
  check('two claims of one free name: one wins, one is taken', both === 'ok,taken' && [await nameOf(T1.id), await nameOf(T2.id)].filter(n => n === prize).length === 1, both)

  // ── § 21 e sign-up ──────────────────────────────────────────────────────────
  section('§ 21 e usernames: sign-up, app and web')
  const takenEmail = V.email, takenName = L.username!
  const a1 = await appSignUp({ email: takenEmail })
  const a2 = await appSignUp({ username: takenName })
  const a3 = await appSignUp({ email: takenEmail, username: takenName })
  check('app: email taken, username taken, both, each named honestly (422)', [a1, a2, a3].every(r => r.status === 422 && !r.headers.get('set-cookie')) && a1.json.code === 'EMAIL_TAKEN' && a2.json.code === 'USERNAME_TAKEN' && a3.json.code === 'EMAIL_AND_USERNAME_TAKEN', [a1.json, a2.json, a3.json])
  const aInv = await appSignUp({ username: 'a..b' }), aRes = await appSignUp({ username: 'verre.support' }), aMis = await appSignUp({ username: undefined })
  check('app: an invalid, a reserved or a missing username → 400 INVALID_USERNAME', [aInv, aRes, aMis].every(r => r.status === 400 && r.json.code === 'INVALID_USERNAME') && aMis.json.message === 'username is required', [aInv.json, aRes.json, aMis.json])
  const aPid = await appSignUp({ publicId: 'AAAAAAAAAAAA' })
  check('app: a body carrying publicId is still 400 for a free email', aPid.status === 400, aPid.json)
  const upd = await ba('POST', '/update-user', { username: fixtureUsername() }, V.cookie)
  check('🔒 /update-user is still a 404 (it would change a username past the quota)', upd.status === 404, upd.json)
  const vName = await nameOf(V.id)
  const adapterUpdate = await sqlErr((await betterAuthServer.$context).internalAdapter.updateUser(String(V.id), { username: fixtureUsername() }))
  check('🔒 user.update.before refuses a username: nothing changes through Better Auth', (await nameOf(V.id)) === vName, adapterUpdate?.message)
  const stillRenames = await sqlErr((await betterAuthServer.$context).internalAdapter.updateUser(String(V.id), { name: 'Vera Viewer' }))
  check('…while a name update still passes', stillRenames === null)

  const appEmail = `${TAG}-un-one@example.test`, appName = fixtureUsername('one')
  const ok = await appSignUp({ email: appEmail, username: ` @${appName.toUpperCase()}` })
  const okRow = await prisma.user.findUnique({ where: { email: appEmail }, select: { id: true, publicId: true, username: true, passwordHash: true } })
  const okCookie = cookieOf(ok.headers)
  check('app: one step, the canonical name stored and returned', ok.status === 200 && okRow?.username === appName && ok.json.user.username === appName && ok.json.user.id === okRow.publicId, ok.json)
  check('🔒 …the returned cookie is a working session', okCookie.startsWith('better-auth.session_token=') && (await authenticatesAs(okCookie, okRow!.id)))
  const okSessions = await prisma.authSession.findMany({ where: { userId: okRow!.id }, select: { id: true, userAgent: true, ipAddress: true } })
  check('…with ONE device row, labelled by the same hook as a sign-in (no raw UA, no raw IP)', okSessions.length === 1 && okSessions[0].userAgent === 'iPhone 15 Pro · Verre App' && okSessions[0].ipAddress === '', okSessions)
  check('a web login works right after an app sign-up (the password mirror ran)', !!okRow?.passwordHash && (await bcrypt.compare('pw-app-12345', okRow.passwordHash)))
  await resetLimits()
  const dev = await call(devicesRoute.GET, 'GET', '/api/me/devices', { cookie: okCookie })
  check('Connected devices lists it as This Device', dev.status === 200 && dev.wire.devices.length === 1 && dev.wire.devices[0].id === `ba:${okSessions[0].id}` && dev.wire.devices[0].isCurrent === true, dev.wire)
  await resetLimits()
  const revoke = await call(deviceRoute.DELETE, 'DELETE', `/api/me/devices/ba:${okSessions[0].id}`, { cookie: okCookie }, undefined, { id: `ba:${okSessions[0].id}` })
  check('🔒 a sign-up session revokes like any other (own row, both stores)', revoke.status === 200 && !(await authenticatesAs(okCookie, okRow!.id)) && (await prisma.authSession.count({ where: { userId: okRow!.id } })) === 0, revoke.wire)

  // Build check: the password mirror throws at one-step sign-up (the session
  // row is committed before account.create.after runs).
  const mirrorEmail = `${TAG}-un-mirror@example.test`
  await prisma.$executeRawUnsafe(`CREATE FUNCTION public.test_mirror_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: mirror refused'; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER test_mirror_fail BEFORE UPDATE OF password_hash ON users FOR EACH ROW WHEN (NEW.email = '${mirrorEmail}') EXECUTE FUNCTION public.test_mirror_fail()`)
  let stranded: Awaited<ReturnType<typeof ba>>
  try { stranded = await appSignUp({ email: mirrorEmail }) } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER test_mirror_fail ON users')
    await prisma.$executeRawUnsafe('DROP FUNCTION public.test_mirror_fail()')
  }
  const mRow = await prisma.user.findUnique({ where: { email: mirrorEmail }, select: { id: true, username: true, passwordHash: true } })
  const mSessions = () => prisma.authSession.count({ where: { userId: mRow!.id } }) as Promise<number>
  check('a mirror that throws: an error with no cookie; the account, its username and one session row stay (named residual)', stranded.status >= 500 && !stranded.headers.get('set-cookie') && !!mRow?.username && mRow.passwordHash === null && (await mSessions()) === 1, { status: stranded.status, body: stranded.json })
  const heal = await ba('POST', '/sign-in/email', { email: mirrorEmail, password: 'pw-app-12345' })
  const healed = await prisma.user.findUnique({ where: { email: mirrorEmail }, select: { passwordHash: true } })
  check('…the next sign-in works and completes the mirror', heal.status === 200 && !!healed?.passwordHash && (await bcrypt.compare('pw-app-12345', healed.passwordHash)), heal.json)
  await resetLimits()
  const mDev = await call(devicesRoute.GET, 'GET', '/api/me/devices', { cookie: cookieOf(heal.headers) })
  check('…Connected devices shows the stranded session as another device (removable like any)', mDev.wire.devices?.length === 2 && mDev.wire.devices.filter((d: J) => d.isCurrent).length === 1, mDev.wire)

  const w1 = await webRegister({ email: takenEmail }), w2 = await webRegister({ username: takenName }), w3 = await webRegister({ email: takenEmail, username: takenName })
  check('web: email taken, username taken, both → 409 with the fields', [w1, w2, w3].every(r => r.status === 409) && JSON.stringify([w1.wire.fields, w2.wire.fields, w3.wire.fields]) === JSON.stringify([{ email: 'taken' }, { username: 'taken' }, { email: 'taken', username: 'taken' }]), [w1.wire, w2.wire, w3.wire])
  check('…`error` keeps today\'s text when only the email is taken', w1.wire.error === 'email already registered')
  const wInv = await webRegister({ username: 'a..b' }), wRes = await webRegister({ username: 'administrator' }), wMis = await webRegister({ username: undefined })
  check('web: an invalid, a reserved or a missing username → 400 with the validator\'s message', wInv.status === 400 && wInv.wire.error === 'username cannot have two dots in a row' && wRes.status === 400 && wRes.wire.error === 'username is reserved' && wMis.status === 400 && wMis.wire.error === 'username is required', [wInv.wire, wRes.wire, wMis.wire])
  // The lost race after the pre-check: someone's uncommitted insert holds the
  // name, so the pre-check sees it free and the insert waits on the unique index.
  const lostName = fixtureUsername('lost'), lostEmail = `${TAG}-un-lost@example.test`
  const racer = await conn()
  let lost: Res
  try {
    await racer.query('BEGIN')
    await racer.query('INSERT INTO users (name, email, username) VALUES ($1, $2, $3)', ['Race Winner', `${TAG}-un-winner@example.test`, lostName])
    const pending = webRegister({ email: lostEmail, username: lostName })
    const waited = await blockedOnLock(pending)
    await racer.query('COMMIT')
    lost = await pending
    check('🔒 web: a register that loses a same-instant race for the name waits, then names the field (the re-run pre-check), nothing created', waited && lost.status === 409 && JSON.stringify(lost.wire.fields) === JSON.stringify({ username: 'taken' }) && !(await prisma.user.findUnique({ where: { email: lostEmail } })), lost.wire)
  } finally { await racer.query('ROLLBACK').catch(() => {}); await racer.end() }
  const webEmail = `${TAG}-un-webok@example.test`, webName = fixtureUsername('web')
  const wOk = await webRegister({ email: webEmail, username: webName.toUpperCase() })
  check('web: the canonical name rides the user insert', wOk.status === 200 && wOk.wire.user.username === webName && (await prisma.user.findUnique({ where: { email: webEmail }, select: { username: true } }))?.username === webName, wOk.wire)

  // ── § 21 f your own session ─────────────────────────────────────────────────
  section('§ 21 f usernames: your own session carries the fresh name')
  const Me = await mkUser('Mia Me')
  const meOld = (await nameOf(Me.id))!
  const meNew = fixtureUsername('me')
  const tokenOf = (cookie: string) => decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0]
  const gsBefore = await ba('GET', '/get-session', undefined, Me.cookie)
  check('get-session carries user.username', gsBefore.status === 200 && gsBefore.json.user.username === meOld, gsBefore.json?.user)
  await put(Me, meNew)
  const copy = JSON.parse((await redis.get(tokenOf(Me.cookie))) ?? '{}')
  const gsAfter = await ba('GET', '/get-session', undefined, Me.cookie)
  check('🔒 after a PUT get-session answers the NEW name although the Redis session copy still holds the old one', gsAfter.json.user.username === meNew && copy?.user?.username === meOld, { wire: gsAfter.json?.user?.username, copy: copy?.user?.username })
  await resetLimits()
  const acct = await call(accountRoute.GET, 'GET', '/api/me/account', Me)
  check('GET /api/me/account carries it too', acct.wire.username === meNew, acct.wire)
  // An account from before usernames: a credential, no username. The cue for
  // the blocking screen is `user.username === null` on its own auth responses.
  const NoName = await bare('Nia NoName', null)
  const noNameEmail = (await prisma.user.findUniqueOrThrow({ where: { id: NoName.id }, select: { email: true } })).email as string
  await syncCredential(NoName.id, await bcrypt.hash('pw-noname-12345', 4))
  const nnIn = await ba('POST', '/sign-in/email', { email: noNameEmail, password: 'pw-noname-12345' })
  const nnGs = await ba('GET', '/get-session', undefined, cookieOf(nnIn.headers))
  check('🔒 an account that has not chosen yet: user.username is null (the key present) on sign-in and get-session', nnIn.status === 200 && 'username' in nnIn.json.user && nnIn.json.user.username === null && 'username' in nnGs.json.user && nnGs.json.user.username === null, { signIn: nnIn.json?.user, getSession: nnGs.json?.user })
  await resetLimits()
  const nnAcct = await call(accountRoute.GET, 'GET', '/api/me/account', { cookie: cookieOf(nnIn.headers) })
  check('…and on /api/me/account and its own state', nnAcct.wire.username === null && (await usernameState(NoName.id))?.username === null, nnAcct.wire)
  const first = await put({ cookie: cookieOf(nnIn.headers) }, fixtureUsername('first'))
  check('…its first choice is free and shows on the next get-session', first.status === 200 && first.wire.changesLeft === USERNAME_CHANGE_LIMIT && (await ba('GET', '/get-session', undefined, cookieOf(nnIn.headers))).json.user.username === first.wire.username, first.wire)

  // ── § 21 g lookup ───────────────────────────────────────────────────────────
  section('§ 21 g usernames: GET /api/users/by-username equals the id route')
  const Full = await bare('Fay Full', fixtureUsername('full'), { profileVisibility: 'public-internet', bio: 'hello' })
  const Shell = await bare('Shay Shell', fixtureUsername('shell'), { profileVisibility: 'public-mutual' })
  const Blk = await bare('Bea Blocked', fixtureUsername('blk'), { profileVisibility: 'public-internet' })
  const Blocker = await bare('Bo Blocker', fixtureUsername('bkr'), { profileVisibility: 'public-internet' })
  await prisma.userBlock.createMany({ data: [{ blockerId: V.id, blockedId: Blk.id }, { blockerId: Blocker.id, blockedId: V.id }] })
  const same2 = (a: Res, b: Res) => a.status === b.status && JSON.stringify(a.wire) === JSON.stringify(b.wire) && noStore(a) && noStore(b)
  for (const [label, target, viewer, qs, want] of [
    ['ok, full', Full, V, '', (w: J) => w.id === Full.pid && w.username === Full.username && w.bio === 'hello' && Array.isArray(w.recentCheckins)],
    ['ok, ?view=header', Full, V, '?view=header', (w: J) => w.username === Full.username && !('recentCheckins' in w)],
    ['ok, logged out', Full, {}, '', (w: J) => w.username === Full.username],
    ['shell', Shell, V, '', (w: J) => w.gated === true && w.username === Shell.username && !('imageUrl' in w)],
    ['blocked by me', Blk, V, '', (w: J) => w.blocked === true && w.username === Blk.username],
  ] as const) {
    const a = await byName(viewer, target.username!, qs), b = await byId(viewer, target.pid, qs)
    check(`${label}: the same status and body as /api/users/<id>, with id + username`, a.status === 200 && same2(a, b) && want(a.wire), { byName: a.wire, byId: b.wire })
  }
  const gone1 = await byName(V, Blocker.username!), gone1b = await byId(V, Blocker.pid)
  const unknown = await byName(V, fixtureUsername('nope')), held = await byName(V, renamedAway), heldDeleted = await byName(V, deletedName)
  check('🔒 blocked by them → the same 404 as an unknown name, a renamed-away one and a held one', [gone1, unknown, held, heldDeleted].every(r => r.status === 404 && JSON.stringify(r.wire) === JSON.stringify(gone1b.wire) && noStore(r)), [gone1.status, unknown.status, held.status, heldDeleted.status])
  const upper = await byName(V, Full.username!.toUpperCase())
  check('the name is case-folded', upper.status === 200 && upper.wire.id === Full.pid)
  check('malformed → 400 before any lookup (a public id is not a username slot, `@` and a short name neither)', (await byName(V, 'ab')).status === 400 && (await byName(V, 'a..b')).status === 400 && (await byName(V, '@simon')).status === 400 && (await byName(V, 'x'.repeat(31))).status === 400)
  // An operator-assigned RESERVED name opens: reads are format-only.
  const brand = reservedFixtureUsername()
  await operator.run(['--release-hold', brand, '--apply'])   // a leftover hold from an earlier run on a persistent database
  const Brand = await bare('Verre Brand', null, { profileVisibility: 'public-internet', email: `${TAG}-un-brand@example.test` })
  const opBrand = await operator.run([`${TAG}-un-brand@example.test`, brand, '--apply', '--allow-reserved'])
  const brandLook = await byName({}, brand)
  check('🔒 an account holding an operator-assigned RESERVED name opens by it', core.isReservedUsername(brand) && opBrand.exit === 0 && brandLook.status === 200 && brandLook.wire.id === Brand.pid && brandLook.wire.username === brand, { opBrand, status: brandLook.status })
  check('…and its share link is /@name', core.profileSharePath(brandLook.wire as { id: string; username: string }) === `/@${brand}`)
  // A spent limiter runs NO lookup: `users` is locked exclusively meanwhile, so
  // any read of it would block. Logged out, so resolving the caller reads nothing.
  const spendProfile = async () => { await resetLimits(); await redis.set('rl:profile:unknown:1m', '60', { EX: 60 }) }
  const locker = await conn()
  try {
    await spendProfile()
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')
    // The handlers directly: the harness's canary reads `users` after every call.
    const direct = (handler: unknown, path: string, params: Record<string, string>) =>
      (handler as (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>)(new NextRequest(`http://localhost:3000${path}`), { params: Promise.resolve(params) })
    const spentName = direct(byUsernameRoute.GET, `/api/users/by-username/${Full.username}`, { username: Full.username! })
    const spentId = direct(usersRoute.GET, `/api/users/${Full.pid}`, { id: Full.pid })
    const answered = await Promise.race([Promise.all([spentName, spentId]), sleep(3000).then(() => null)])
    check('🔒 with the limiter spent both routes answer 429 without touching `users`', !!answered && answered.every(r => r.status === 429 && r.headers.get('cache-control') === 'private, no-store'), answered?.map(r => r.status))
    // Control: with budget left the same request has to wait for the table.
    await redis.del('rl:profile:unknown:1m')
    const waiting = call(byUsernameRoute.GET, 'GET', `/api/users/by-username/${Full.username}`, {}, undefined, { username: Full.username! })
    check('…control: with budget left the lookup runs (it waits on the locked table)', await blockedOnLock(waiting))
    await locker.query('ROLLBACK')
    check('…and answers once the lock is gone', (await waiting).status === 200)
  } finally { await locker.query('ROLLBACK').catch(() => {}); await locker.end() }
  await spendProfile()
  const shared = [await call(byUsernameRoute.GET, 'GET', `/api/users/by-username/${Full.username}`, {}, undefined, { username: Full.username! }), await call(usersRoute.GET, 'GET', `/api/users/${Full.pid}`, {}, undefined, { id: Full.pid })]
  check('the two routes share ONE budget (the same rl:profile key)', shared.every(r => r.status === 429) && Number(await redis.get('rl:profile:unknown:1m')) === 62)

  // ── § 21 h emission ─────────────────────────────────────────────────────────
  section('§ 21 h usernames: on every person outside a moment, never inside one')
  const A = await mkUser('Ann Alpha'), B = await mkUser('Ben Beta')
  const [aName, bName] = [(await nameOf(A.id))!, (await nameOf(B.id))!]
  const Fc = await bare('Cy Common', fixtureUsername('cy'))
  await prisma.user.updateMany({ where: { id: { in: [A.id, B.id] } }, data: { profileVisibility: 'public-internet' } })
  // A ↔ B friends; B ↔ Cy friends and A follows Cy (in common); A mutes and blocks two others.
  await prisma.follow.createMany({ data: [{ followerId: A.id, followingId: B.id }, { followerId: B.id, followingId: A.id }, { followerId: B.id, followingId: Fc.id }, { followerId: Fc.id, followingId: B.id }, { followerId: A.id, followingId: Fc.id }] })
  const Mu = await bare('Mo Muted', fixtureUsername('mu')), Bl = await bare('Bix Blocked', fixtureUsername('bl'))
  await prisma.userMute.create({ data: { muterId: A.id, mutedId: Mu.id } })
  await prisma.userBlock.create({ data: { blockerId: A.id, blockedId: Bl.id } })
  await resetLimits()
  const post = await call(checkinsRoute.POST, 'POST', '/api/checkins', B, { wineName: `${TAG} un post`, score: 4, flavors: {}, taggedUserIds: [A.pid] })
  check('fixture: B posts and tags A', post.status < 300 && typeof post.wire.id === 'number', post.wire)
  const get = async (handler: unknown, path: string, v: Actor, params: Record<string, string> = {}) => { await resetLimits(); return call(handler, 'GET', path, v, undefined, params) }
  const prof = await byId(A, B.pid)
  check('profile (full): username, in-common faces, recent posts\' tags', prof.wire.username === bName && prof.wire.inCommon?.faces?.[0]?.username === Fc.username && prof.wire.recentCheckins?.[0]?.tags?.[0]?.username === aName, { u: prof.wire.username, faces: prof.wire.inCommon?.faces, tags: prof.wire.recentCheckins?.[0]?.tags })
  const ppl = await get(followersRoute.GET, `/api/users/${B.pid}/followers`, A, { id: B.pid })
  check('people rows', (ppl.wire.users as J[]).length === 2 && (ppl.wire.users as J[]).every(u => typeof u.username === 'string') && (ppl.wire.users as J[]).some(u => u.username === Fc.username), ppl.wire.users)
  const fr = await get(friendsRoute.GET, '/api/me/friends', A)
  check('/api/me/friends (the Invite sheet searches it on the phone)', (fr.wire as unknown as J[]).length === 1 && (fr.wire as unknown as J[])[0].username === bName, fr.wire)
  const [mu, bl] = [await get(mutesRoute.GET, '/api/me/mutes', A), await get(blocksListRoute.GET, '/api/me/blocks', A)]
  check('the Muted and Blocked lists', mu.wire.mutes?.[0]?.username === Mu.username && (bl.wire.blocks ?? bl.wire)?.[0]?.username === Bl.username, { mu: mu.wire, bl: bl.wire })
  const feed = await get(feedRoute.GET, '/api/feed', A)
  const item = (feed.wire.items as J[]).find(i => i.type === 'checkin' && i.author.id === B.pid)
  check('feed: the author and the tags (network feed)', item?.author.username === bName && item.checkin.tags[0].username === aName, item)
  const ufeed = await get(feedRoute.GET, `/api/feed?user=${B.pid}`, A)
  check('feed: ?user=', (ufeed.wire.items as J[])[0]?.author.username === bName && (ufeed.wire.items as J[])[0]?.checkin.tags[0].username === aName)
  // Tasted-with: a started moment both are in, written as records (lists never rebuild).
  const Tw = await bare('Tay Tasted', fixtureUsername('tw'))
  const twCode = `UN${Date.now().toString(36).slice(-6)}`.toUpperCase()
  await prisma.$executeRaw`INSERT INTO sessions (code, name, created_at, date_from) VALUES (${twCode}, 'Tasted', now() - interval '1 day', now() - interval '1 day')`
  await prisma.sessionMember.createMany({ data: [{ userId: A.id, sessionCode: twCode }, { userId: Tw.id, sessionCode: twCode }] })
  const tw = await get(tastedWithRoute.GET, '/api/me/tasted-with', A)
  check('tasted-with', (tw.wire.people as J[]).find(p => p.id === Tw.pid)?.username === Tw.username, tw.wire.people)
  const StillNone = await bare('Sten StillNone', null)
  const none = await byId(A, StillNone.pid)
  check('a person who has not chosen yet carries username: null (never absent)', none.status === 200 && 'username' in none.wire && none.wire.username === null, none.wire)

  // 🔒 The reverse canary: a moment both are in. No moment response and no
  // moment key or value in Redis may carry a fixture username.
  const code = await createSession(A, 'Ann Alpha')
  const inMoment: string[] = []
  const keep = (r: Res) => { inMoment.push(JSON.stringify(r.wire) + [...r.headers.entries()].join()); return r }
  await resetLimits()
  keep(await call(joinRoute.POST, 'POST', '/api/session/join', B, { code, displayName: 'Ben Beta' }))
  await resetLimits()
  const wine = keep(await call(winesRoute.POST, 'POST', `/api/session/${code}/wines`, A, { name: `${TAG} un wine`, type: 'red' }, { code }))
  await resetLimits()
  keep(await call(rateRoute.POST, 'POST', `/api/session/${code}/rate`, B, { wineId: wine.wire.id, score: 4, flavors: {}, notes: 'fine' }, { code }))
  for (const [handler, path, method] of [[visitRoute.POST, `/api/session/${code}/visit`, 'POST'], [stateRoute.GET, `/api/session/${code}/state`, 'GET'], [codeRoute.GET, `/api/session/${code}`, 'GET'], [bansRoute.GET, `/api/session/${code}/bans`, 'GET']] as const) {
    await resetLimits()
    keep(await call(handler, method, path, A, method === 'POST' ? {} : undefined, { code }))
    await resetLimits()
    keep(await call(handler, method, path, B, method === 'POST' ? {} : undefined, { code }))
  }
  keep(await get(meSessionsRoute.GET, '/api/me/sessions', B))
  const leaked = inMoment.filter(t => t.includes(aName) || t.includes(bName))
  check(`🔒 no moment response carries a username (${inMoment.length} responses: join, wines, rate, visit, state, meta, bans, my moments)`, inMoment.length >= 12 && leaked.length === 0, leaked.map(t => t.slice(0, 200)))
  // The ONE exception (ruled 2026-11-14): the pre-join preview names its HOST,
  // from the users row, under the same condition as the host's id.
  const previewAs = async (u: Actor, c = code) => { await resetLimits(); return call(previewRoute.GET, 'GET', `/api/session/${c}/preview`, u, undefined, { code: c }) }
  const pvB = await previewAs(B), pvA = await previewAs(A)
  check('the preview carries the host\'s username beside their id (a guest, and the host)', pvB.wire.hostUserId === A.pid && pvB.wire.hostUsername === aName && pvA.wire.hostUsername === aName, { b: pvB.wire, a: pvA.wire })
  check('…and nobody else\'s (the viewer\'s own, a participant\'s)', !JSON.stringify(pvB.wire).includes(bName) && !JSON.stringify(pvA.wire).includes(bName))
  await prisma.userBlock.create({ data: { blockerId: A.id, blockedId: B.id } })
  const pvBlocked = await previewAs(B)
  check('🔒 a block pair: no host id and no username (the host stays a plain name)', pvBlocked.status === 200 && pvBlocked.wire.hostUserId === null && pvBlocked.wire.hostUsername === null && typeof pvBlocked.wire.host === 'string' && !JSON.stringify(pvBlocked.wire).includes(aName), pvBlocked.wire)
  await prisma.userBlock.delete({ where: { blockerId_blockedId: { blockerId: A.id, blockedId: B.id } } })
  await prisma.userBlock.create({ data: { blockerId: B.id, blockedId: A.id } })
  const pvBlocks = await previewAs(B)
  check('🔒 …in the other direction too (the viewer blocked the host)', pvBlocks.status === 200 && pvBlocks.wire.hostUserId === null && pvBlocks.wire.hostUsername === null && !JSON.stringify(pvBlocks.wire).includes(aName), pvBlocks.wire)
  await prisma.userBlock.delete({ where: { blockerId_blockedId: { blockerId: B.id, blockedId: A.id } } })
  const momentKeys = [...await scanKeys(`s:${code}:*`), ...await scanKeys('lock:session:*')]
  const dump: string[] = []
  for (const key of momentKeys) {
    const type = await redis.type(key)
    const value = type === 'string' ? await redis.get(key) : type === 'hash' ? JSON.stringify(await redis.hGetAll(key)) : type === 'set' ? JSON.stringify(await redis.sMembers(key)) : `<${type}>`
    dump.push(`${key} ${value}`)
  }
  check(`🔒 no moment key or value in Redis carries a username (${momentKeys.length} keys under s:${code}:*)`, momentKeys.length >= 3 && dump.every(d => !d.includes(aName) && !d.includes(bName)), dump.filter(d => d.includes(aName) || d.includes(bName)).map(d => d.slice(0, 160)))

  // ── § 21 i search ───────────────────────────────────────────────────────────
  section('§ 21 i usernames: search by name and by username')
  const sq = `zq${Date.now().toString(36).slice(-5)}`
  const viewer = await mkUser('Sia Searcher')
  const X1 = await bare(`Plain ${TAG}`, `${sq}_one`)        // found by username only
  const X2 = await bare(`${sq} Named`, fixtureUsername())    // found by name only
  const X3 = await bare(`Zed ${TAG}`, `${sq}`)               // the exact username
  const X4 = await bare(`Alf ${TAG}`, `a${sq}x`)             // contains it
  const X5 = await bare(`Under ${TAG}`, `${sq}xone`)         // the same as X1 but for the underscore
  const search = async (q: string, v: Actor = viewer) => { await resetLimits(); return call(searchRoute.GET, 'GET', `/api/users/search?q=${encodeURIComponent(q)}`, v) }
  const ids = (r: Res) => (r.wire as unknown as J[]).map(u => u.id)
  const byBoth = await search(sq)
  check('a plain query matches the name OR the username', new Set(ids(byBoth)).size === 5 && [X1, X2, X3, X4, X5].every(x => ids(byBoth).includes(x.pid)), ids(byBoth))
  check('…ordered: the exact username, then username prefixes, then by name', ids(byBoth)[0] === X3.pid && ids(byBoth).slice(1, 3).sort().join() === [X1.pid, X5.pid].sort().join() && ids(byBoth).slice(3).join() === [X4.pid, X2.pid].join(), ids(byBoth))
  check('…every row carries its username', (byBoth.wire as unknown as J[]).every(u => typeof u.username === 'string'))
  const at = await search(`@${sq}`)
  check('`@` matches the username only (the person found by name is out)', ids(at).length === 4 && !ids(at).includes(X2.pid), ids(at))
  check('…uppercase folds', ids(await search(`@${sq.toUpperCase()}`)).length === 4)
  const under = await search(`${sq}_`)
  check('🔒 `_` is escaped, not a wildcard', ids(under).join() === X1.pid, ids(under))
  const spaced = await search(`${sq} named`)
  check('a query with a space can only match names', ids(spaced).join() === X2.pid, ids(spaced))
  check('`@` with an impossible remainder answers [] (never a fallback to names)', ids(await search(`@${sq} named`)).length === 0 && ids(await search('@é' + sq)).length === 0)
  check('at least 2 characters after the `@`', ids(await search(`@${sq[0]}`)).length === 0)
  await prisma.userBlock.create({ data: { blockerId: X3.id, blockedId: viewer.id } })
  const scrubbed = await search(sq)
  check('🔒 a block pair is scrubbed before the limit, username match or not', !ids(scrubbed).includes(X3.pid) && ids(scrubbed).length === 4, ids(scrubbed))
  const stubName = `${sq}_gated`
  const Gated = await bare(`Gia ${TAG}`, stubName, { profileVisibility: 'public-mutual' })
  const stub = (await search(stubName)).wire as unknown as J[]
  check('a gated stub carries the username too', stub.length === 1 && stub[0].id === Gated.pid && stub[0].gated === true && stub[0].username === stubName, stub)
  // The People lists' q: the same clause.
  await prisma.follow.createMany({ data: [X1, X2, X4].map(x => ({ followerId: x.id, followingId: Full.id })) })
  const listQ = async (q: string) => { await resetLimits(); return call(followersRoute.GET, 'GET', `/api/users/${Full.pid}/followers?q=${encodeURIComponent(q)}`, viewer, undefined, { id: Full.pid }) }
  const lq = (await listQ(sq)).wire.users as J[], lat = (await listQ(`@${sq}`)).wire.users as J[], lno = (await listQ(`@${sq} x`)).wire.users as J[]
  check('People lists: q matches the username too; `@` = the username only; an impossible `@` query matches no one', lq.length === 3 && lat.length === 2 && !lat.some(u => u.id === X2.pid) && lno.length === 0, { lq: lq.length, lat: lat.length, lno: lno.length })

  // ── § 21 j limits, no-store, the census ─────────────────────────────────────
  section('§ 21 j usernames: limits and the writes census')
  const Lim = await mkUser('Lee Limits')
  const spent = async (key: string, max: number, run: () => Promise<Res>) => {
    await resetLimits()
    await redis.set(key, String(max), { EX: 60 })
    const r = await run()
    return r.status === 429 && noStore(r) && !!r.headers.get('retry-after')
  }
  const limName = await nameOf(Lim.id)
  check('GET /api/me/username: 60/min/user', await spent(`rl:username-read:user:${Lim.id}:1m`, 60, () => call(usernameRoute.GET, 'GET', '/api/me/username', Lim)))
  check('PUT: rl:username-set 20/h/user, nothing written', (await spent(`rl:username-set:user:${Lim.id}:1h`, 20, () => call(usernameRoute.PUT, 'PUT', '/api/me/username', Lim, { username: fixtureUsername() }))) && (await nameOf(Lim.id)) === limName)
  await resetLimits()
  await call(usernameRoute.PUT, 'PUT', '/api/me/username', Lim, { username: limName })
  await call(usernameRoute.PUT, 'PUT', '/api/me/username', Lim, { username: 'a..b' })
  check('…the same name and an invalid one are not charged', (await redis.get(`rl:username-set:user:${Lim.id}:1h`)) === null)
  await call(usernameRoute.PUT, 'PUT', '/api/me/username', Lim, { username: takenName })
  check('…a refused (taken) attempt is', (await redis.get(`rl:username-set:user:${Lim.id}:1h`)) === '1')
  const avPath = `/api/me/username/available?username=${fixtureUsername()}`
  check('availability: 60/min/user', await spent(`rl:username-check:user:${Lim.id}:1m`, 60, () => call(availableRoute.GET, 'GET', avPath, Lim)))
  check('…plus the 300/min per-address backstop (getClientIp)', await spent('rl:username-check:ip:203.0.113.7:1m', 300, () => call(availableRoute.GET, 'GET', avPath, Lim, undefined, {}, { 'x-forwarded-for': '203.0.113.7' })))
  await resetLimits()
  await call(availableRoute.GET, 'GET', avPath, {})
  check('…both charged only after the 401', (await scanKeys('rl:username-check:*')).length === 0)
  const selfTest = execFileSync('node', ['scripts/check-username-writes.mjs', '--self-test'], { cwd: ROOT, encoding: 'utf8' })
  const census = execFileSync('node', ['scripts/check-username-writes.mjs'], { cwd: ROOT, encoding: 'utf8' })
  check('the writes census passes on the tree, after its own negative control (each write idiom caught, each read idiom passed)', /self-test OK/.test(selfTest) && /OK — users\.username is written only in lib\/username\.ts/.test(census), census)
}
