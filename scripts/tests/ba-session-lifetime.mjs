#!/usr/bin/env node
// Integration pins for the NATIVE session lifetime (lib/betterAuth.ts session
// config + hooks, lib/resolveUser.ts, lib/identityStore.ts sweep helpers,
// prisma/maintenance/cleanup-revoked-sessions.sql).
//
// WHY THIS EXISTS: the 7-day-era bug was invisible to every existing check.
// Better Auth's sliding refresh ran on EVERY authenticated request, including
// the server-side `api.getSession` call inside resolveUser — which re-stamped
// both stores but set the new cookie on a throwaway context. @better-auth/expo
// drops its stored cookie at the stamp of the last Set-Cookie it actually
// received, so a device whose daily slides all happened via API calls signed
// itself out at the OLD stamp while the server session was still valid. Nothing
// pinned (a) the window, (b) which path slides, or (c) that the heartbeat's
// slide reaches the client. This suite drives the REAL modules for all three,
// plus the native-revoke sweep the longer window made load-bearing (§ 7).
//
// Testing standard (inherited from the catalog suites): every reject is paired
// with an accept, every assertion names what it expects, and we verify what the
// call DID (store values before/after), never just the state afterwards.
//
//   § 1  sign-in stamps expiresAt = now + 365d in the cookie, Postgres AND Redis
//   § 2  a heartbeat BEFORE the updateAge boundary (fresh, and 10 min short of
//        1 day) does NOT slide and sends no Set-Cookie — boundary-gated, not
//        per-request; pins updateAge from below
//   § 3  resolveUser (every API route's seam) authenticates the cookie (accept)
//        and NEVER slides, even when a refresh is due (reject)
//   § 4  the HTTP get-session heartbeat DOES slide 10 min past 1 day (pins
//        updateAge from above), re-stamps both stores to now + 365d, and
//        carries a Set-Cookie with the new Max-Age home — the only path the
//        device can learn the new expiry from
//   § 5  an expired session is dead on access (fail-closed) — the window is a
//        real ceiling, not just a cookie attribute
//   § 6  the chokepoint prune retires rows past expires_at by > 1 day — through
//        BOTH stores, including a Redis copy that is AHEAD of its row (the case
//        a raw SQL delete strands) — and leaves a live row and a row inside
//        the 1-day margin alone; the web user_sessions SQL still executes
//   § 7  the three native revokes (/revoke-sessions, /revoke-other-sessions,
//        /change-password) kill the other device's Redis copy AND row even when
//        BA's `active-sessions-<uid>` list is gone (the hooks answer from a
//        Postgres snapshot), keep exactly the session the caller should keep,
//        and under INJECTED failures (snapshot throws / one token's Redis
//        delete throws / the password change fails after commit) leave a
//        durable retry target instead of a ghost — then the retry finishes
//
// Run against a DISPOSABLE database + Redis — it writes and deletes rows, and
// it RESETS the Better Auth IP-floor rate-limit counters for the `unknown` IP
// (in-process api calls carry no client IP) so local re-runs don't 429.
//
//   DATABASE_URL=postgres://…/catalog_test REDIS_URL=redis://localhost:6379 \
//     AUTH_SECRET=test npx tsx scripts/tests/ba-session-lifetime.mjs
//
// Run via tsx (not node): it imports the real TypeScript modules under lib/.
import { betterAuthServer } from '../../lib/betterAuth.ts'
import { resolveUser } from '../../lib/resolveUser.ts'
import { deleteAllNativeSessions, pruneExpiredNativeSessions, revokeAllSessions } from '../../lib/identityStore.ts'
import { prisma } from '../../lib/prisma.ts'
import { redis } from '../../lib/redis.ts'
import { NextRequest } from 'next/server'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY_S = 24 * 3600
const YEAR_S = 365 * DAY_S
// Tolerance for "≈ now + 365d": a slow CI box, not a design margin.
const TOL_S = 300
// Distance from the 1-day updateAge boundary on either side. Must exceed TOL_S
// so a slow box can't push the "just short" fixture across the boundary.
const EDGE_S = 600
const TAG = `ba-lifetime-${Date.now()}`
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The same key shapes as the before-hook in lib/betterAuth.ts; in-process api
// calls resolve no client IP, so they all land in the `unknown` bucket.
const AUTH_FLOOR_KEYS = ['rl:ba-signin:ip:unknown:1m', 'rl:ba-signup:ip:unknown:1m', 'rl:ba-chgpw:ip:unknown:1h']

let pass = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const near = (actualS, expectedS, tol = TOL_S) => Math.abs(actualS - expectedS) <= tol
const secondsFromNow = (d) => (new Date(d).getTime() - Date.now()) / 1000
const resetAuthFloors = () => redis.del(AUTH_FLOOR_KEYS)

async function storeExpiry(token) {
  const row = await prisma.authSession.findFirst({ where: { token }, select: { expiresAt: true } })
  const raw = await redis.get(token)
  const cached = raw ? JSON.parse(raw) : null
  return {
    pg: row ? new Date(row.expiresAt).getTime() : null,
    redis: cached?.session?.expiresAt ? new Date(cached.session.expiresAt).getTime() : null,
    redisTtl: await redis.ttl(token),
  }
}

async function signIn(email, password) {
  const { headers, response } = await betterAuthServer.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  })
  const setCookie = headers.get('set-cookie') ?? ''
  return { token: response?.token ?? null, setCookie, cookiePair: setCookie.split(';')[0] }
}
const maxAgeOf = (setCookie) => {
  const m = /max-age=(\d+)/i.exec(setCookie)
  return m ? Number(m[1]) : null
}
// Backdate a session's expiresAt in BOTH stores through BA's own adapter (the
// same both-store path the sliding refresh uses). For a stamp in the PAST, BA
// skips the Redis write (TTL ≤ 0) and leaves the old copy — exactly what the
// real TTL would have reaped — so mimic the reap explicitly.
async function setExpiry(token, expiresAt) {
  const adapter = (await betterAuthServer.$context).internalAdapter
  await adapter.updateSession(token, { expiresAt })
  if (expiresAt.getTime() <= Date.now()) await redis.del(token)
}
// A session last refreshed `ageS` seconds ago has expiresAt = now + 365d − ageS;
// BA slides when (expiresAt − expiresIn + updateAge ≤ now), i.e. ageS ≥ 1 day.
const stampAgedBy = (ageS) => new Date(Date.now() + (YEAR_S - ageS) * 1000)

async function main() {
  const base = (await betterAuthServer.$context).baseURL
  const origin = new URL(base).origin
  const heartbeat = (cookiePair) =>
    betterAuthServer.handler(new Request(`${base}/get-session`, { method: 'GET', headers: { cookie: cookiePair } }))
  const post = (path, cookiePair, body = '{}') =>
    betterAuthServer.handler(new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: cookiePair },
      body,
    }))

  await resetAuthFloors()
  const password = 'lifetime-suite-pw-1'
  const emailA = `${TAG}-a@example.test`
  const emailB = `${TAG}-b@example.test`
  const emailC = `${TAG}-c@example.test`
  const suA = await betterAuthServer.api.signUpEmail({ body: { name: 'Lifetime A', email: emailA, password } })
  const suB = await betterAuthServer.api.signUpEmail({ body: { name: 'Lifetime B', email: emailB, password } })
  const suC = await betterAuthServer.api.signUpEmail({ body: { name: 'Lifetime C', email: emailC, password } })
  const userA = Number(suA?.user?.id)
  const userB = Number(suB?.user?.id)
  const userC = Number(suC?.user?.id)
  check('fixture: three users signed up', [userA, userB, userC].every(Number.isInteger))

  console.log('\n§ 1 sign-in stamps a 365-day window in cookie, Postgres and Redis')
  const a = await signIn(emailA, password)
  check('sign-in issues a session cookie', a.cookiePair.startsWith('better-auth.session_token='), a.cookiePair.split('=')[0])
  const maxAge = maxAgeOf(a.setCookie)
  check('Set-Cookie Max-Age ≈ 365d (the stamp the device stores)', near(maxAge ?? 0, YEAR_S), String(maxAge))
  const s1 = await storeExpiry(a.token)
  check('auth_sessions.expires_at ≈ now + 365d', s1.pg !== null && near((s1.pg - Date.now()) / 1000, YEAR_S), String(s1.pg && secondsFromNow(s1.pg)))
  check('Redis copy expiresAt ≈ now + 365d', s1.redis !== null && near((s1.redis - Date.now()) / 1000, YEAR_S), String(s1.redis && secondsFromNow(s1.redis)))
  check('Redis key TTL ≈ 365d (the copy dies with the row, not before)', near(s1.redisTtl, YEAR_S), String(s1.redisTtl))
  check('Redis and Postgres agree on the stamp', s1.pg !== null && s1.pg === s1.redis, `${s1.pg} vs ${s1.redis}`)

  console.log('\n§ 2 heartbeat BEFORE the 1-day boundary: no slide, no Set-Cookie')
  const hb0 = await heartbeat(a.cookiePair)
  const hb0Body = await hb0.json().catch(() => null)
  check('fresh session: heartbeat 200 with the session', hb0.status === 200 && Number(hb0Body?.user?.id) === userA, `${hb0.status} ${JSON.stringify(hb0Body?.user?.id ?? null)}`)
  check('fresh session: no Set-Cookie', hb0.headers.get('set-cookie') === null, String(hb0.headers.get('set-cookie')))
  const s2 = await storeExpiry(a.token)
  check('fresh session: expiresAt unchanged in both stores', s2.pg === s1.pg && s2.redis === s1.redis, `${s2.pg}/${s2.redis} vs ${s1.pg}`)
  const shortStamp = stampAgedBy(DAY_S - EDGE_S)
  await setExpiry(a.token, shortStamp)
  const hbShort = await heartbeat(a.cookiePair)
  check('10 min short of 1 day: heartbeat 200', hbShort.status === 200, String(hbShort.status))
  check('10 min short of 1 day: no Set-Cookie (updateAge is not shorter than 1d)', hbShort.headers.get('set-cookie') === null, String(hbShort.headers.get('set-cookie')))
  const s2b = await storeExpiry(a.token)
  check('10 min short of 1 day: stamp unchanged in both stores', s2b.pg === shortStamp.getTime() && s2b.redis === shortStamp.getTime(), `${s2b.pg}/${s2b.redis} vs ${shortStamp.getTime()}`)

  console.log('\n§ 3 resolveUser authenticates but NEVER slides, even when a refresh is due')
  const dueStamp = stampAgedBy(DAY_S + EDGE_S)
  await setExpiry(a.token, dueStamp)
  const s3a = await storeExpiry(a.token)
  check('fixture: stamp 10 min past 1 day landed in both stores', s3a.pg === dueStamp.getTime() && s3a.redis === dueStamp.getTime(), `${s3a.pg}/${s3a.redis} vs ${dueStamp.getTime()}`)
  const resolved = await resolveUser(new NextRequest(`${origin}/api/me/devices`, { headers: { cookie: a.cookiePair } }))
  check('resolveUser resolves the cookie to the user (accept half)', Number(resolved?.user?.id) === userA, JSON.stringify(resolved?.user?.id ?? null))
  check('resolveUser marks the caller native', resolved?.authSource === 'native', String(resolved?.authSource))
  check('resolveUser reports the CURRENT stamp, not a re-stamped one', resolved?.expires === dueStamp.toISOString(), `${resolved?.expires} vs ${dueStamp.toISOString()}`)
  const s3b = await storeExpiry(a.token)
  check('🔒 resolveUser did NOT slide Postgres', s3b.pg === dueStamp.getTime(), `${s3b.pg} vs ${dueStamp.getTime()}`)
  check('🔒 resolveUser did NOT slide Redis', s3b.redis === dueStamp.getTime(), `${s3b.redis} vs ${dueStamp.getTime()}`)

  console.log('\n§ 4 the HTTP heartbeat slides 10 min past 1 day and carries the new stamp home')
  const hb1 = await heartbeat(a.cookiePair)
  const hb1Body = await hb1.json().catch(() => null)
  const hb1Cookie = hb1.headers.get('set-cookie') ?? ''
  check('heartbeat 200', hb1.status === 200, String(hb1.status))
  check('Set-Cookie re-issued with the session cookie (updateAge is not longer than 1d)', hb1Cookie.includes('better-auth.session_token='), hb1Cookie.split('=')[0])
  check('re-issued Max-Age ≈ 365d (what @better-auth/expo stores)', near(maxAgeOf(hb1Cookie) ?? 0, YEAR_S), String(maxAgeOf(hb1Cookie)))
  check('body.session.expiresAt ≈ now + 365d', near(secondsFromNow(hb1Body?.session?.expiresAt ?? 0), YEAR_S), String(hb1Body?.session?.expiresAt))
  const s4 = await storeExpiry(a.token)
  check('Postgres re-stamped ≈ now + 365d', s4.pg !== null && near((s4.pg - Date.now()) / 1000, YEAR_S), String(s4.pg && secondsFromNow(s4.pg)))
  check('Redis re-stamped ≈ now + 365d', s4.redis !== null && near((s4.redis - Date.now()) / 1000, YEAR_S), String(s4.redis && secondsFromNow(s4.redis)))
  check('Redis TTL re-extended ≈ 365d', near(s4.redisTtl, YEAR_S), String(s4.redisTtl))
  check('slide actually moved the stamp forward (not a no-op)', s4.pg !== null && s4.pg > dueStamp.getTime() + (DAY_S / 2) * 1000, `${s4.pg} vs ${dueStamp.getTime()}`)

  console.log('\n§ 5 an expired session is dead on access')
  await setExpiry(a.token, new Date(Date.now() - 2 * DAY_S * 1000))
  const dead = await betterAuthServer.api.getSession({
    headers: new Headers({ cookie: a.cookiePair }),
    query: { disableRefresh: true },
  })
  check('getSession returns null for a session past expiresAt', dead === null, JSON.stringify(dead?.user?.id ?? dead))
  const s5 = await storeExpiry(a.token)
  check('BA deleted the expired row on access (the on-access half of cleanup)', s5.pg === null, String(s5.pg))

  console.log('\n§ 6 chokepoint prune: past expires_at by > 1 day → gone in BOTH stores; live + inside-margin → kept')
  const b1 = await signIn(emailB, password)
  const b2 = await signIn(emailB, password)
  const b3 = await signIn(emailB, password)
  const b4 = await signIn(emailB, password)
  check('fixture: four live sessions for user B', [b1, b2, b3, b4].every((s) => !!s.token))
  await setExpiry(b1.token, new Date(Date.now() - 2 * DAY_S * 1000))
  await setExpiry(b2.token, new Date(Date.now() - 3600 * 1000))
  // b4: the Redis-AHEAD-of-Postgres state (BA writes Redis before PG on a
  // refresh; a PG failure mid-heartbeat leaves this). Only the ROW is expired —
  // the Redis copy stays live with ~a year of TTL. A raw SQL prune would drop
  // the row and strand the copy; the chokepoint prune must kill the copy too.
  // (Raw row write is a TEST FIXTURE for exactly that state — app code never does this.)
  await prisma.authSession.updateMany({ where: { token: b4.token }, data: { expiresAt: new Date(Date.now() - 2 * DAY_S * 1000) } })
  const ahead = await storeExpiry(b4.token)
  check('fixture: b4 row expired while its Redis copy is live and a year ahead', ahead.pg !== null && ahead.pg < Date.now() && ahead.redis !== null && ahead.redis > Date.now(), `${ahead.pg}/${ahead.redis}`)
  check('fixture: the Redis-ahead copy still authenticates (the ghost a raw prune would leave)', Number((await betterAuthServer.api.getSession({ headers: new Headers({ cookie: b4.cookiePair }), query: { disableRefresh: true } }))?.user?.id) === userB)
  const before = await prisma.authSession.count({ where: { userId: userB } })
  check('fixture: all four rows present before the prune', before === 4, String(before))
  // The web SQL job still runs as-is (one allow-listed statement) — pin that the
  // file executes, so a gate-driven edit can't silently break the cron.
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', 'prisma/maintenance/cleanup-revoked-sessions.sql'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  check('the maintenance SQL (user_sessions only) does not touch auth_sessions', (await prisma.authSession.count({ where: { userId: userB } })) === 4)
  const pruned = await pruneExpiredNativeSessions()
  check('prune reports the two retired rows', pruned === 2, String(pruned))
  const left = await prisma.authSession.findMany({ where: { userId: userB }, select: { token: true } })
  const leftTokens = new Set(left.map((r) => r.token))
  check('expired 2 days ago → row deleted', !leftTokens.has(b1.token))
  check('expired 2 days ago → Redis copy gone', (await redis.get(b1.token)) === null)
  check('Redis-ahead row → row deleted', !leftTokens.has(b4.token))
  check('Redis-ahead row → Redis copy gone too (no stranded ghost)', (await redis.get(b4.token)) === null)
  check('Redis-ahead cookie no longer authenticates', (await betterAuthServer.api.getSession({ headers: new Headers({ cookie: b4.cookiePair }), query: { disableRefresh: true } })) === null)
  check('expired 1 hour ago (inside the 1-day margin) → kept', leftTokens.has(b2.token))
  check('live session → kept', leftTokens.has(b3.token))
  check('nothing else of user B was touched', left.length === 2, String(left.length))
  const live = await storeExpiry(b3.token)
  check('the live session still resolves in Redis after the prune', live.redis !== null)
  check('prune is idempotent (second run retires nothing)', (await pruneExpiredNativeSessions()) === 0)

  console.log('\n§ 7 native revokes reach both stores even with the active-sessions list gone')
  // Each scenario: the caller holds `cur`, another device holds `other`. With the
  // list PRESENT (accept half) and with it EVICTED (the reason BA's list-driven
  // revokes are not used) the result must be identical. The list key is BA's
  // `active-sessions-<userId>` (lib/CLAUDE.md).
  let pwC = password
  const scenarios = [
    { path: '/revoke-sessions', evict: false }, { path: '/revoke-sessions', evict: true },
    { path: '/revoke-other-sessions', evict: false }, { path: '/revoke-other-sessions', evict: true },
    { path: '/change-password', evict: false }, { path: '/change-password', evict: true },
  ]
  const changePwBody = (from, to) => JSON.stringify({ currentPassword: from, newPassword: to })
  for (const { path, evict } of scenarios) {
    await resetAuthFloors()
    const tag = `${path} (${evict ? 'list evicted' : 'list present'})`
    const cur = await signIn(emailC, pwC)
    const other = await signIn(emailC, pwC)
    check(`${tag}: fixture — two live sessions`, !!cur.token && !!other.token && (await redis.get(other.token)) !== null)
    if (evict) {
      await redis.del(`active-sessions-${userC}`)
      check(`${tag}: fixture — list key gone`, (await redis.get(`active-sessions-${userC}`)) === null)
    }
    const nextPw = `${pwC}-x`
    const res = await post(path, cur.cookiePair, path === '/change-password' ? changePwBody(pwC, nextPw) : '{}')
    const body = await res.clone().json().catch(() => null)
    if (path === '/change-password' && res.status === 200) pwC = nextPw
    check(`${tag}: 200`, res.status === 200, `${res.status} ${(await res.clone().text()).slice(0, 120)}`)
    const o = await storeExpiry(other.token)
    check(`${tag}: other device's Redis copy gone`, o.redis === null && o.redisTtl === -2, `ttl ${o.redisTtl}`)
    check(`${tag}: other device's auth_sessions row gone`, o.pg === null, String(o.pg))
    const c = await storeExpiry(cur.token)
    if (path === '/revoke-sessions') {
      check(`${tag}: BA's response shape ({ status: true })`, body?.status === true, JSON.stringify(body))
      check(`${tag}: caller's own session gone too in both stores (log out everywhere)`, c.pg === null && c.redis === null, `${c.pg}/${c.redis}`)
    } else if (path === '/revoke-other-sessions') {
      check(`${tag}: BA's response shape ({ status: true })`, body?.status === true, JSON.stringify(body))
      check(`${tag}: caller's current session KEPT in both stores`, c.pg !== null && c.redis !== null, `${c.pg}/${c.redis}`)
      check(`${tag}: caller's cookie still authenticates`, Number((await betterAuthServer.api.getSession({ headers: new Headers({ cookie: cur.cookiePair }), query: { disableRefresh: true } }))?.user?.id) === userC)
    } else {
      check(`${tag}: caller's current session KEPT (not rotated — like web)`, c.pg !== null && c.redis !== null, `${c.pg}/${c.redis}`)
      check(`${tag}: no new session minted (token null, no Set-Cookie)`, body?.token === null && res.headers.get('set-cookie') === null, `${JSON.stringify(body?.token)} / ${res.headers.get('set-cookie')}`)
      check(`${tag}: caller's cookie still authenticates`, Number((await betterAuthServer.api.getSession({ headers: new Headers({ cookie: cur.cookiePair }), query: { disableRefresh: true } }))?.user?.id) === userC)
      check(`${tag}: exactly one session row remains`, (await prisma.authSession.count({ where: { userId: userC } })) === 1)
      check(`${tag}: new password signs in`, !!(await signIn(emailC, pwC)).token)
    }
    await deleteAllNativeSessions(userC)
  }

  console.log('\n§ 7b wrong current password revokes nothing')
  await resetAuthFloors()
  const w1 = await signIn(emailC, pwC)
  const w2 = await signIn(emailC, pwC)
  const wrong = await post('/change-password', w1.cookiePair, changePwBody('definitely-wrong-pw', 'whatever-new-pw-1'))
  check('rejected (400)', wrong.status === 400, String(wrong.status))
  check('both sessions intact in both stores', (await storeExpiry(w2.token)).redis !== null && (await prisma.authSession.count({ where: { userId: userC } })) === 2)
  check('old password still signs in', !!(await signIn(emailC, pwC)).token)
  await deleteAllNativeSessions(userC)

  console.log('\n§ 7c injected failures leave retry targets, never ghosts')
  // (a) the Postgres snapshot throws → NOTHING is mutated, 500, retry works.
  await resetAuthFloors()
  const a1 = await signIn(emailC, pwC)
  const a2 = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  const origFindMany = prisma.authSession.findMany
  prisma.authSession.findMany = async () => { throw new Error('injected: snapshot failure') }
  const resA = await post('/revoke-sessions', a1.cookiePair)
  prisma.authSession.findMany = origFindMany
  check('(a) snapshot failure: 500, not a false success', resA.status === 500, String(resA.status))
  const a1s = await storeExpiry(a1.token); const a2s = await storeExpiry(a2.token)
  check('(a) snapshot failure: nothing deleted — both rows AND both Redis copies intact', a1s.pg !== null && a1s.redis !== null && a2s.pg !== null && a2s.redis !== null, `${a1s.pg}/${a1s.redis} ${a2s.pg}/${a2s.redis}`)
  const resA2 = await post('/revoke-sessions', a1.cookiePair)
  check('(a) retry: 200', resA2.status === 200, String(resA2.status))
  check('(a) retry: both sessions gone in both stores', (await prisma.authSession.count({ where: { userId: userC } })) === 0 && (await redis.get(a1.token)) === null && (await redis.get(a2.token)) === null)

  // (b) one token's Redis delete throws → that token keeps its PG row (durable,
  //     visible retry target), the call reports 500, the retry finishes it.
  await resetAuthFloors()
  const b1c = await signIn(emailC, pwC)
  const b2c = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  const origDel = redis.del.bind(redis)
  redis.del = async (key) => { if (key === b2c.token) throw new Error('injected: redis delete failure'); return origDel(key) }
  const resB = await post('/revoke-other-sessions', b1c.cookiePair)
  redis.del = origDel
  check('(b) per-token failure: 500, not a false success', resB.status === 500, String(resB.status))
  const b2s = await storeExpiry(b2c.token)
  check('(b) per-token failure: the failed token KEEPS its PG row (retry target) and its Redis copy', b2s.pg !== null && b2s.redis !== null, `${b2s.pg}/${b2s.redis}`)
  check('(b) per-token failure: the failed token is still visible to a Postgres snapshot', (await prisma.authSession.count({ where: { userId: userC, token: b2c.token } })) === 1)
  const resB2 = await post('/revoke-other-sessions', b1c.cookiePair)
  check('(b) retry: 200', resB2.status === 200, String(resB2.status))
  check('(b) retry: other gone in both stores, caller kept', (await redis.get(b2c.token)) === null && (await prisma.authSession.count({ where: { userId: userC, token: b2c.token } })) === 0 && (await storeExpiry(b1c.token)).redis !== null)
  await deleteAllNativeSessions(userC)

  // (c) the password change COMMITS, then a later leg throws (here: the web
  //     revoke) → the endpoint 500s, yet the native revoke still ran, because it
  //     lives in the db hook that fires on commit, not in an endpoint after-hook.
  await resetAuthFloors()
  const c1 = await signIn(emailC, pwC)
  const c2 = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  const origUpdateMany = prisma.userSession.updateMany
  prisma.userSession.updateMany = async () => { throw new Error('injected: post-commit failure') }
  const pwAfterC = `${pwC}-y`
  // The db after-hook's throw propagates out of the raw handler as a rejection
  // (runWithAdapter runs the queued hooks, then rethrows); the Next route turns
  // that into a 500. Either shape is "surfaced", a 200 would be the bug.
  const resC = await post('/change-password', c1.cookiePair, changePwBody(pwC, pwAfterC)).catch(() => ({ status: 'rejected' }))
  prisma.userSession.updateMany = origUpdateMany
  check('(c) post-commit failure surfaces (500 / rejection), never 200', resC.status === 500 || resC.status === 'rejected', String(resC.status))
  const committed = !!(await signIn(emailC, pwAfterC).catch(() => ({ token: null }))).token
  check('(c) fixture — the password change DID commit', committed)
  if (committed) pwC = pwAfterC
  const c2s = await storeExpiry(c2.token)
  check('(c) the other device was still revoked in both stores (no ghost)', c2s.pg === null && c2s.redis === null, `${c2s.pg}/${c2s.redis}`)
  check('(c) the caller kept its session', (await storeExpiry(c1.token)).redis !== null)
  await deleteAllNativeSessions(userC)

  console.log('\n§ 7d a concurrent wrong-password attempt from ANOTHER session must not be the one kept')
  // Owner holds `own`, a stolen-cookie holder holds `att`. The owner's change is
  // in flight (bcrypt, ~hundreds of ms) when the attacker submits a WRONG
  // current password. Whatever the interleaving, the owner's commit must keep
  // the OWNER's session and revoke the attacker's — a shared per-user "keep"
  // slot is exactly what this breaks.
  await resetAuthFloors()
  const own = await signIn(emailC, pwC)
  const att = await signIn(emailC, pwC)
  const pwAfterD = `${pwC}-d`
  // Barrier, not a sleep: the OWNER's handler is held at its first credential
  // lookup (past the before-hook, before verify + commit); the attacker's
  // attempt runs to completion in that window; then the owner is released.
  // The lookup is BA-internal: 1.6 read the accounts with findMany
  // (findAccounts), 1.7 reads the credential row with findFirst
  // (findCredentialAccount), so the barrier holds whichever comes first.
  const origAcct = { findMany: prisma.authAccount.findMany, findFirst: prisma.authAccount.findFirst }
  let ownerHeldResolve; const ownerHeld = new Promise((r) => { ownerHeldResolve = r })
  let releaseOwner; const ownerReleased = new Promise((r) => { releaseOwner = r })
  let intercepted = false
  for (const m of ['findMany', 'findFirst']) {
    prisma.authAccount[m] = async (args) => {
      if (!intercepted) { intercepted = true; ownerHeldResolve(); await ownerReleased }
      return origAcct[m].call(prisma.authAccount, args)
    }
  }
  const pOwner = post('/change-password', own.cookiePair, changePwBody(pwC, pwAfterD))
  await ownerHeld
  const rAtt = await post('/change-password', att.cookiePair, changePwBody('wrong-pw-from-stolen-cookie', 'attacker-chosen-pw-1'))
  releaseOwner()
  const rOwner = await pOwner
  Object.assign(prisma.authAccount, origAcct)
  check('(d) owner\'s change: 200', rOwner.status === 200, String(rOwner.status))
  check('(d) attacker\'s attempt: 400', rAtt.status === 400, String(rAtt.status))
  if (rOwner.status === 200) pwC = pwAfterD
  const ownS = await storeExpiry(own.token); const attS = await storeExpiry(att.token)
  check('(d) 🔒 the ATTACKER\'s session is revoked in both stores', attS.pg === null && attS.redis === null, `${attS.pg}/${attS.redis}`)
  check('(d) the OWNER\'s session is the one kept', ownS.pg !== null && ownS.redis !== null, `${ownS.pg}/${ownS.redis}`)
  await deleteAllNativeSessions(userC)

  console.log('\n§ 7e a concurrent credential mirror (hashes already equal) must not skip the native revoke')
  // Simulate backfillNativeCredential winning the race between BA's commit and
  // the hook's users read: the hook sees users.password_hash === the NEW hash.
  await resetAuthFloors()
  const e1 = await signIn(emailC, pwC)
  const e2 = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  const origFindUnique = prisma.user.findUnique
  prisma.user.findUnique = async (args) => {
    const row = await origFindUnique.call(prisma.user, args)
    if (!row || !args?.select?.passwordHash) return row
    const acct = await prisma.authAccount.findFirst({ where: { userId: userC, providerId: 'credential' }, select: { password: true } })
    return { ...row, passwordHash: acct?.password ?? row.passwordHash }
  }
  const pwAfterE = `${pwC}-e`
  const rE = await post('/change-password', e1.cookiePair, changePwBody(pwC, pwAfterE)).catch(() => ({ status: 'rejected' }))
  prisma.user.findUnique = origFindUnique
  check('(e) change-password: 200', rE.status === 200, String(rE.status))
  if (rE.status === 200) pwC = pwAfterE
  const e2s = await storeExpiry(e2.token)
  check('(e) 🔒 the other session is still revoked in both stores', e2s.pg === null && e2s.redis === null, `${e2s.pg}/${e2s.redis}`)
  check('(e) the caller kept its session', (await storeExpiry(e1.token)).redis !== null)
  await deleteAllNativeSessions(userC)

  console.log('\n§ 7f WEB-triggered bulk revoke + account deletion use the same token-driven path')
  await resetAuthFloors()
  const f1 = await signIn(emailC, pwC)
  const f2 = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  // A valid UUID that matches no user_sessions row: the web leg must SUCCEED
  // (0 rows) so the only failure in play is the injected native one — a non-UUID
  // placeholder made Postgres reject the web leg and the "throws" check pass for
  // the wrong reason.
  const noWebSession = randomUUID()
  const origDelF = redis.del.bind(redis)
  redis.del = async (key) => { if (key === f2.token) throw new Error('injected: redis delete failure'); return origDelF(key) }
  const threwF = await revokeAllSessions(userC, noWebSession, 'password_change').then(() => false).catch(() => true)
  redis.del = origDelF
  check('(f) web revokeAllSessions with an evicted list + a failing token THROWS (not swallowed)', threwF)
  check('(f) …and the throw came from the native leg: the OTHER token was still deleted in both stores', (await storeExpiry(f1.token)).pg === null && (await redis.get(f1.token)) === null)
  const f2s = await storeExpiry(f2.token)
  check('(f) the failed token KEEPS its PG row (retry target) and Redis copy', f2s.pg !== null && f2s.redis !== null, `${f2s.pg}/${f2s.redis}`)
  const retried = await revokeAllSessions(userC, noWebSession, 'password_change').then(() => true).catch(() => false)
  check('(f) retry succeeds', retried)
  check('(f) retry: both sessions gone in both stores', (await prisma.authSession.count({ where: { userId: userC } })) === 0 && (await redis.get(f1.token)) === null && (await redis.get(f2.token)) === null)
  const g1 = await signIn(emailC, pwC)
  const g2 = await signIn(emailC, pwC)
  await redis.del(`active-sessions-${userC}`)
  await deleteAllNativeSessions(userC)
  check('(f) account-deletion leg with an evicted list: both sessions gone in both stores', (await prisma.authSession.count({ where: { userId: userC } })) === 0 && (await redis.get(g1.token)) === null && (await redis.get(g2.token)) === null)

  console.log('\n§ 7g an in-flight refresh cannot resurrect a revoked session (missing PG row ⇒ unauthenticated)')
  // BA's refresh: read the Redis copy → (row check) → WRITE it back with a new
  // expiry → update Postgres. Nothing orders that against a concurrent delete.
  // Barrier: hold the heartbeat immediately before its Redis WRITE-BACK — after
  // the row check has already passed — revoke meanwhile, then release. The
  // write-back lands AFTER the revoke: a real orphan (Redis copy, no row) now
  // exists, which is the state the invariant must neutralise. (Holding before
  // the read would let the row check prevent the write and test nothing —
  // Codex pass 5.)
  await resetAuthFloors()
  const r1 = await signIn(emailC, pwC)
  await setExpiry(r1.token, stampAgedBy(DAY_S + EDGE_S))
  const origSetG = redis.set.bind(redis)
  let heldOnce = false
  let reachedResolve; const reachedBarrier = new Promise((r) => { reachedResolve = r })
  let releaseHeartbeat; const heartbeatReleased = new Promise((r) => { releaseHeartbeat = r })
  redis.set = async (key, value, opts) => {
    if (key === r1.token && !heldOnce) { heldOnce = true; reachedResolve(); await heartbeatReleased }
    return origSetG(key, value, opts)
  }
  const pHeartbeat = heartbeat(r1.cookiePair)
  await reachedBarrier
  await revokeAllSessions(userC, randomUUID(), 'revoke_all')
  check('(g) revoke completed while the refresh was paused: both stores empty', (await prisma.authSession.count({ where: { userId: userC } })) === 0 && (await redis.get(r1.token)) === null)
  releaseHeartbeat()
  const hbG = await pHeartbeat.catch(() => ({ status: 'rejected' }))
  redis.set = origSetG
  check('(g) the paused heartbeat did not report success', hbG.status !== 200, String(hbG.status))
  check('(g) fixture — the write-back DID land: a raw Redis orphan exists with no Postgres row', (await redis.get(r1.token)) !== null && (await prisma.authSession.count({ where: { token: r1.token } })) === 0)
  const lookup = await betterAuthServer.api.getSession({ headers: new Headers({ cookie: r1.cookiePair }), query: { disableRefresh: true } })
  check('(g) 🔒 the revoked cookie does NOT authenticate from the orphan', lookup === null, JSON.stringify(lookup?.user?.id ?? null))
  check('(g) the lookup removed the orphan', (await redis.get(r1.token)) === null)
  // BA's get-session answers an unauthenticated cookie with 200 + null (not 401).
  const hbAfter = await heartbeat(r1.cookiePair)
  const hbAfterBody = await hbAfter.json().catch(() => 'unparseable')
  // …and CLEARS the cookie (Max-Age=0) rather than re-issuing one.
  const hbAfterCookie = hbAfter.headers.get('set-cookie') ?? ''
  const reissued = /session_token=[^;]+/.test(hbAfterCookie) && !/max-age=0/i.test(hbAfterCookie)
  check('(g) a later heartbeat with the revoked cookie sees no session and re-issues no cookie', hbAfter.status === 200 && hbAfterBody === null && !reissued, `${hbAfter.status} ${JSON.stringify(hbAfterBody)} ${hbAfterCookie.slice(0, 80)}`)
  check('(g) the session is absent from the Postgres-driven views (devices list / revoke / prune)', (await prisma.authSession.count({ where: { userId: userC } })) === 0)
}

main()
  .catch((e) => { failed++; console.error('\nABORTED — the suite threw before the remaining sections could run:', e) })
  .finally(async () => {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } }).catch(() => [])
    for (const u of users) await deleteAllNativeSessions(u.id).catch(() => {})
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {})
    await resetAuthFloors().catch(() => {})
    await prisma.$disconnect().catch(() => {})
    await redis.quit().catch(() => {})
    console.log(`\n${pass} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
