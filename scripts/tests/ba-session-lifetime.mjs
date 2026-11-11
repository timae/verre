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
//   § 8  the app's "Sign Out of All Other Devices" helper
//        (revokeAllForNativeCaller keep-by-id): keeps exactly the caller's row,
//        both stores, every web row revoked; legs independent under injected
//        failures; no options = the account-PATCH behaviour (nothing kept);
//        resolveUser names the caller's row (nativeSessionId), Redis- or
//        Postgres-served
//   § 9  the native device label: the app's User-Agent on a BA sign-in →
//        "<model> · Verre App"; anything off-shape falls back to the web parser
//   § 10 the app's last-seen: resolveUser bumps auth_sessions.updatedAt once
//        per 5-minute bucket through Better Auth (both stores, updatedAt only,
//        expiresAt untouched); nothing within a bucket, one write for a
//        parallel burst, none while a heartbeat slide is due or past the
//        per-user budget, no re-created Redis copy; a failing write is logged
//        and not retried within the bucket, a hanging one delays nothing; a
//        revoke racing the bump leaves no copy behind (the bump removes its own
//        write-back), and in the residual window the orphan cannot authenticate
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
import { nativeLastSeenHooks, resolveUser } from '../../lib/resolveUser.ts'
import { deleteAllNativeSessions, pruneExpiredNativeSessions, revokeAllForNativeCaller, revokeAllSessions } from '../../lib/identityStore.ts'
import { parseNativeUserAgent, parseUserAgent } from '../../lib/userAgent.ts'
import { LAST_SEEN_BUCKET_MS, bucketStart } from '../../lib/lastSeen.ts'
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

async function signIn(email, password, userAgent) {
  const { headers, response } = await betterAuthServer.api.signInEmail({
    body: { email, password },
    ...(userAgent ? { headers: new Headers({ 'user-agent': userAgent }) } : {}),
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
  const aRow = await prisma.authSession.findFirst({ where: { token: a.token }, select: { id: true } })
  check('resolveUser names the caller\'s own auth_sessions row (nativeSessionId, Redis-served)', aRow !== null && resolved?.nativeSessionId === aRow.id, `${resolved?.nativeSessionId} vs ${aRow?.id}`)
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

  console.log('\n§ 8 revokeAllForNativeCaller keeps the caller by id (the app\'s "Sign Out of All Other Devices")')
  const rowId = async (token) => (await prisma.authSession.findFirst({ where: { token }, select: { id: true } }))?.id ?? null
  const gone = async (token) => (await storeExpiry(token)).pg === null && (await redis.get(token)) === null
  const alive = async (token) => { const st = await storeExpiry(token); return st.pg !== null && st.redis !== null }
  const webRows = async (n) => {
    const ids = []
    for (let i = 0; i < n; i++) ids.push((await prisma.userSession.create({ data: { userId: userC, deviceLabel: 'MacBook · Safari' }, select: { id: true } })).id)
    return ids
  }
  const webState = async (ids) => prisma.userSession.findMany({ where: { id: { in: ids } }, select: { revokedAt: true, revocationReason: true } })
  await resetAuthFloors()
  const k1 = await signIn(emailC, pwC); const k2 = await signIn(emailC, pwC); const k3 = await signIn(emailC, pwC)
  const kWeb = await webRows(2)
  await redis.del(`active-sessions-${userC}`)
  const kId = await rowId(k1.token)
  // Postgres-served resolve: drop the caller's Redis copy (BA reads the row and
  // does not re-populate Redis).
  await redis.del(k1.token)
  const kResolved = await resolveUser(new NextRequest(`${origin}/api/me/devices`, { headers: { cookie: k1.cookiePair } }))
  check('(a) resolveUser names the row when Postgres-served too', kId !== null && kResolved?.nativeSessionId === kId, `${kResolved?.nativeSessionId} vs ${kId}`)
  const kCount = await revokeAllForNativeCaller(userC, { keepNativeSessionId: kId, reason: 'revoke_all' })
  check('(a) the caller\'s row is kept', (await storeExpiry(k1.token)).pg !== null)
  check('(a) every OTHER native session is gone in both stores (list evicted)', (await gone(k2.token)) && (await gone(k3.token)))
  const kw = await webState(kWeb)
  check('(a) every web session revoked, reason revoke_all, count returned', kCount === 2 && kw.length === 2 && kw.every(r => r.revokedAt && r.revocationReason === 'revoke_all'), JSON.stringify({ kCount, kw }))
  await deleteAllNativeSessions(userC)

  // (b) no options = the account PATCH behaviour, unchanged: nothing kept.
  await resetAuthFloors()
  const p1 = await signIn(emailC, pwC); const p2 = await signIn(emailC, pwC)
  const pWeb = await webRows(1)
  await revokeAllForNativeCaller(userC)
  const pw = await webState(pWeb)
  check('(b) no options: EVERY native session dies, the caller\'s included', (await gone(p1.token)) && (await gone(p2.token)))
  check('(b) no options: web rows revoked with reason password_change', pw[0]?.revokedAt && pw[0]?.revocationReason === 'password_change', JSON.stringify(pw))

  // (c) legs independent: the web leg throws → the native leg still ran.
  await resetAuthFloors()
  const c1n = await signIn(emailC, pwC); const c2n = await signIn(emailC, pwC)
  const c1Id = await rowId(c1n.token)
  const origUM = prisma.userSession.updateMany
  prisma.userSession.updateMany = async () => { throw new Error('injected: web leg failure') }
  const threwWeb = await revokeAllForNativeCaller(userC, { keepNativeSessionId: c1Id, reason: 'revoke_all' }).then(() => false, () => true)
  prisma.userSession.updateMany = origUM
  check('(c) web-leg failure THROWS (not swallowed)', threwWeb)
  check('(c) …and the native leg still ran: other gone, caller kept', (await gone(c2n.token)) && (await alive(c1n.token)))
  await deleteAllNativeSessions(userC)

  // (d) …and the other way: one native token fails → web leg still ran, the
  //     failed token keeps its row (retry target), the retry finishes it.
  await resetAuthFloors()
  const d1n = await signIn(emailC, pwC); const d2n = await signIn(emailC, pwC); const d3n = await signIn(emailC, pwC)
  const d1Id = await rowId(d1n.token)
  const dWeb = await webRows(1)
  await redis.del(`active-sessions-${userC}`)
  const origDelD = redis.del.bind(redis)
  redis.del = async (key) => { if (key === d3n.token) throw new Error('injected: redis delete failure'); return origDelD(key) }
  const threwNative = await revokeAllForNativeCaller(userC, { keepNativeSessionId: d1Id, reason: 'revoke_all' }).then(() => false, () => true)
  redis.del = origDelD
  const dw = await webState(dWeb)
  check('(d) native per-token failure THROWS', threwNative)
  check('(d) …the web leg still ran', !!dw[0]?.revokedAt, JSON.stringify(dw))
  check('(d) …the other token is gone, the failed one keeps its row + copy, the caller is kept', (await gone(d2n.token)) && (await alive(d3n.token)) && (await alive(d1n.token)))
  const dRetry = await revokeAllForNativeCaller(userC, { keepNativeSessionId: d1Id, reason: 'revoke_all' }).then(() => true, () => false)
  check('(d) retry: succeeds, the failed token gone, the caller still kept', dRetry && (await gone(d3n.token)) && (await alive(d1n.token)))
  await deleteAllNativeSessions(userC)
  await prisma.userSession.deleteMany({ where: { userId: userC } })

  console.log('\n§ 9 the native device label (session.create.before)')
  const APP_UA = 'Verre/1.0.0 (iPhone 15 Pro; iOS 26.1)'
  const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  check('parser: the app shape → "<model> · Verre App"', parseNativeUserAgent(APP_UA) === 'iPhone 15 Pro · Verre App', String(parseNativeUserAgent(APP_UA)))
  check('parser: a model with parentheses', parseNativeUserAgent('Verre/1.2.3 (iPhone SE (3rd generation); iOS 26.0.1)') === 'iPhone SE (3rd generation) · Verre App')
  check('parser: a browser UA is not the app', parseNativeUserAgent(SAFARI_UA) === null)
  check('parser: a 41-character model is rejected (falls back)', parseNativeUserAgent(`Verre/1.0.0 (${'i'.repeat(41)}; iOS 26.1)`) === null)
  check('parser: a control / bidi character in the model is rejected', parseNativeUserAgent('Verre/1.0.0 (iPhone\u202e 15; iOS 26.1)') === null && parseNativeUserAgent('Verre/1.0.0 (iPhone\n15; iOS 26.1)') === null)
  check('🔒 the WEB parser never says "Verre App" for the app UA (a browser can\'t claim it)', !parseUserAgent(APP_UA).includes('Verre App'), parseUserAgent(APP_UA))
  await resetAuthFloors()
  const labelOf = async (ua) => {
    const t = (await signIn(emailC, pwC, ua)).token
    return (await prisma.authSession.findFirst({ where: { token: t }, select: { userAgent: true } }))?.userAgent
  }
  check('sign-in with the app UA stores "iPhone 15 Pro · Verre App"', (await labelOf(APP_UA)) === 'iPhone 15 Pro · Verre App')
  check('sign-in with a browser UA keeps the web label', (await labelOf(SAFARI_UA)) === 'iPhone · Safari')
  check('sign-in with a too-long app model falls back to the web parser', (await labelOf(`Verre/1.0.0 (iPhone ${'X'.repeat(40)}; iOS 26.1)`)) === 'iPhone')
  await deleteAllNativeSessions(userC)

  await lastSeenSection(origin, password)
}

// § 10 the app's last-seen bump (lib/resolveUser.ts). It is fire-and-forget:
// nativeLastSeenHooks hands the suite each bump promise to await, and Better
// Auth's updateSession is wrapped to count the writes, hold them at a barrier
// or fail them; fixture writes use the unwrapped original. The bump makes ONE
// attempt per session per 5-minute bucket, so every sub-case signs in its own
// session.
async function lastSeenSection(origin, password) {
  console.log('\n§ 10 resolveUser bumps the app\'s last-seen once per 5-minute bucket (updatedAt only, through Better Auth)')
  const ctx = await betterAuthServer.$context
  const origUpdate = ctx.internalAdapter.updateSession
  let bumps = []
  let bumpImpl = origUpdate
  ctx.internalAdapter.updateSession = (token, data) => {
    const p = Promise.resolve().then(() => bumpImpl(token, data))
    bumps.push({ token, data, p })
    return p
  }
  let started = []
  nativeLastSeenHooks.started = (p) => { started.push(p) }
  // Bounded waits: a regression that awaits the bump, or never reaches a
  // barrier, must fail the check, not hang CI.
  const TIMED_OUT = Symbol('timed out')
  const within = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r(TIMED_OUT), ms))])
  const settle = () => within(Promise.allSettled(started.splice(0)), 5000)
  const gate = () => { let open; const p = new Promise((r) => { open = r }); return { p, open } }
  // Each same-bucket claim must not straddle a 5-minute edge.
  const inOneBucket = async () => {
    const left = LAST_SEEN_BUCKET_MS - (Date.now() % LAST_SEEN_BUCKET_MS)
    if (left < 15_000) await new Promise((r) => setTimeout(r, left + 100))
  }
  const seen = async (token) => {
    const row = await prisma.authSession.findFirst({ where: { token }, select: { updatedAt: true, expiresAt: true } })
    const raw = await redis.get(token)
    const copy = raw ? JSON.parse(raw).session : null
    return {
      pg: row ? row.updatedAt.getTime() : null,
      redis: copy ? new Date(copy.updatedAt).getTime() : null,
      pgExp: row ? row.expiresAt.getTime() : null,
      redisExp: copy ? new Date(copy.expiresAt).getTime() : null,
      ttl: await redis.ttl(token),
    }
  }
  const backdate = (token) => origUpdate(token, { updatedAt: new Date(Date.now() - 2 * LAST_SEEN_BUCKET_MS) })
  // An expiresAt-only fixture write: Better Auth's adapter then stamps the ROW's
  // updatedAt itself (onUpdate, unfloored), so always backdate AFTER it.
  const stampAt = (token, expiresAt) => origUpdate(token, { expiresAt })
  const resolveAs = (cookiePair) => resolveUser(new NextRequest(`${origin}/api/me/devices`, { headers: { cookie: cookiePair } }))
  const fresh = async () => { const s = await signIn(emailD, password); await backdate(s.token); return s }
  await resetAuthFloors()
  const emailD = `${TAG}-d@example.test`
  const userD = Number((await betterAuthServer.api.signUpEmail({ body: { name: 'Lifetime D', email: emailD, password } }))?.user?.id)
  const budgetKey = `rl:native-lastseen:user:${userD}:5m`
  check('fixture: user D signed up', Number.isInteger(userD))
  try {
    // (a) a stale bucket → one write, both stores, updatedAt only. The stamp is
    //     12 h old (not due for a slide), so a bump that slid it would show.
    await inOneBucket()
    const sA = await signIn(emailD, password)
    bumps = []
    await resolveAs(sA.cookiePair)
    await settle()
    check('(a) a session already on the current bucket (a fresh sign-in) → no write', bumps.length === 0, String(bumps.length))
    await stampAt(sA.token, stampAgedBy(DAY_S / 2))
    await backdate(sA.token)
    const a0 = await seen(sA.token)
    check('(a) fixture: updatedAt sits in an older bucket in both stores', a0.pg !== null && a0.pg === a0.redis && a0.pg < bucketStart(Date.now()), `${a0.pg}/${a0.redis}`)
    bumps = []
    const tA = Date.now()
    const aRes = await resolveAs(sA.cookiePair)
    await settle()
    const a1 = await seen(sA.token)
    check('(a) resolveUser still resolves the caller', Number(aRes?.user?.id) === userD)
    check('(a) exactly one write, through Better Auth\'s updateSession', bumps.length === 1 && bumps[0].token === sA.token, String(bumps.length))
    check('(a) 🔒 the write sends updatedAt ONLY (never expiresAt)', bumps.length === 1 && JSON.stringify(Object.keys(bumps[0].data)) === '["updatedAt"]', JSON.stringify(bumps[0]?.data))
    check('(a) Postgres updatedAt = the bucket START (the update hook floors the exact time the bump sends)', a1.pg === bucketStart(tA), `${a1.pg} vs ${bucketStart(tA)}`)
    check('(a) the Redis copy agrees', a1.redis === a1.pg, `${a1.redis} vs ${a1.pg}`)
    check('(a) 🔒 expiresAt unchanged in both stores', a1.pgExp === a0.pgExp && a1.redisExp === a0.redisExp, `${a1.pgExp}/${a1.redisExp} vs ${a0.pgExp}/${a0.redisExp}`)
    check('(a) the Redis TTL still follows the unchanged expiresAt', near(a1.ttl, (a0.redisExp - Date.now()) / 1000, 5), `${a1.ttl} vs ${(a0.redisExp - Date.now()) / 1000}`)
    bumps = []
    await resolveAs(sA.cookiePair)
    await settle()
    const a2 = await seen(sA.token)
    check('(a) a second resolve in the same bucket writes nothing', bumps.length === 0 && a2.pg === a1.pg && a2.redis === a1.redis, `${bumps.length} ${a2.pg}`)

    // (b) five parallel requests while the first write is held → one write,
    //     and none of the requests waits for it.
    await inOneBucket()
    const sB = await fresh()
    bumps = []
    const atB = gate(), heldB = gate()
    bumpImpl = async (token, data) => { atB.open(); await heldB.p; return origUpdate(token, data) }
    const burst = await Promise.all(Array.from({ length: 5 }, () => within(resolveAs(sB.cookiePair))))
    const reachedB = (await within(atB.p)) !== TIMED_OUT
    const heldCalls = bumps.length
    heldB.open()
    await settle()
    bumpImpl = origUpdate
    check('(b) five parallel requests → one write, none waits for it', burst.every((r) => r !== TIMED_OUT && Number(r?.user?.id) === userD) && reachedB && heldCalls === 1 && bumps.length === 1, `${burst.filter((r) => r === TIMED_OUT).length} timed out, reached ${reachedB}, ${heldCalls}/${bumps.length}`)
    check('(b) …and that write landed', (await seen(sB.token)).pg === bucketStart(Date.now()))

    // (c) due for the heartbeat slide → no write (the heartbeat writes updatedAt).
    await inOneBucket()
    const sC = await signIn(emailD, password)
    await stampAt(sC.token, stampAgedBy(DAY_S + EDGE_S))
    await backdate(sC.token)
    const c0 = await seen(sC.token)
    check('(c) fixture: due, both stores on the same older bucket', c0.pg !== null && c0.pg === c0.redis && c0.pg < bucketStart(Date.now()), `${c0.pg}/${c0.redis}`)
    bumps = []
    check('(c) a due session still resolves', Number((await resolveAs(sC.cookiePair))?.user?.id) === userD)
    await settle()
    const c1 = await seen(sC.token)
    check('(c) due for the slide → no write', bumps.length === 0 && c1.pg === c0.pg && c1.redis === c0.redis, `${bumps.length} ${c1.pg} vs ${c0.pg}`)
    // 30 s short of due: a bump started now could still be in flight when the
    // heartbeat slides, so the margin skips it too ((a)'s 12 h stamp writes).
    const sC2 = await signIn(emailD, password)
    await stampAt(sC2.token, stampAgedBy(DAY_S - 30))
    await backdate(sC2.token)
    const c20 = await seen(sC2.token)
    bumps = []
    await resolveAs(sC2.cookiePair)
    await settle()
    check('(c) 30 s short of due (inside the margin) → no write', bumps.length === 0 && (await seen(sC2.token)).pg === c20.pg, String(bumps.length))

    // (d) Redis copy evicted → Postgres-served; the write updates the row and
    //     does NOT re-create the copy.
    await inOneBucket()
    const sD = await signIn(emailD, password)
    await redis.del(sD.token)
    await backdate(sD.token)
    bumps = []
    const tD = Date.now()
    check('(d) a Postgres-served session resolves', Number((await resolveAs(sD.cookiePair))?.user?.id) === userD)
    await settle()
    const d1 = await seen(sD.token)
    check('(d) Postgres updatedAt bumped to the current bucket', bumps.length === 1 && d1.pg === bucketStart(tD), `${bumps.length} ${d1.pg} vs ${bucketStart(tD)}`)
    check('(d) the evicted Redis copy is not re-created', d1.redis === null && (await redis.get(sD.token)) === null)

    // (e) a failing write never fails the request, is logged, and is not
    //     retried within the bucket; a hanging one never delays the request.
    await inOneBucket()
    const sE = await fresh()
    const origErr = console.error
    const logged = []
    console.error = (...args) => { logged.push(String(args[0])) }
    bumpImpl = () => { throw new Error('injected: bump failure') }
    bumps = []
    const eRes = await resolveAs(sE.cookiePair).catch(() => 'threw')
    await settle()
    console.error = origErr
    bumpImpl = origUpdate
    check('(e) an injected updateSession failure does not fail the resolve', Number(eRes?.user?.id) === userD, String(eRes))
    check('(e) …the failure is logged, not swallowed', logged.some((m) => m.includes('native last-seen bump failed')), JSON.stringify(logged))
    bumps = []
    await resolveAs(sE.cookiePair)
    await settle()
    check('(e) …and not retried in the same bucket (one attempt per session per bucket)', bumps.length === 0, String(bumps.length))
    const sE2 = await fresh()
    const atHang = gate(), hang = gate()
    bumpImpl = async (token, data) => { atHang.open(); await hang.p; return origUpdate(token, data) }
    bumps = []
    const hRes = await within(resolveAs(sE2.cookiePair))
    const reachedHang = (await within(atHang.p)) !== TIMED_OUT
    check('(e) a hanging write does not delay the resolve', hRes !== TIMED_OUT && Number(hRes?.user?.id) === userD && reachedHang, `${String(hRes?.user?.id ?? 'timed out')} reached ${reachedHang}`)
    hang.open()
    await settle()
    bumpImpl = origUpdate
    check('(e) …and it lands once released', (await seen(sE2.token)).pg === bucketStart(Date.now()))

    // (f) a revoke between the bump's read and its Redis write-back: hold the
    //     write-back, revoke, release. The row update then finds no row, so the
    //     bump deletes the copy it put back: nothing is left.
    await resetAuthFloors()
    await inOneBucket()
    const sF = await fresh()
    const origSet = redis.set.bind(redis)
    const atF = gate(), releaseF = gate()
    let heldF = false, landedF = false
    redis.set = async (key, value, opts) => {
      if (key !== sF.token || heldF) return origSet(key, value, opts)
      heldF = true; atF.open(); await releaseF.p
      const r = await origSet(key, value, opts); landedF = true; return r
    }
    try {
      const fRes = await within(resolveAs(sF.cookiePair))
      check('(f) fixture: the bump reached its Redis write-back (held there)', (await within(atF.p)) !== TIMED_OUT)
      await revokeAllSessions(userD, randomUUID(), 'revoke_all')
      check('(f) revoke completed while the bump was held: both stores empty', (await prisma.authSession.count({ where: { userId: userD } })) === 0 && (await redis.get(sF.token)) === null)
      releaseF.open()
      await settle()
      check('(f) the request itself resolved, before the revoke', Number(fRes?.user?.id) === userD)
      check('(f) fixture: the write-back DID land after the revoke', landedF)
      check('(f) 🔒 …and the bump removed it: no copy, no row', (await redis.get(sF.token)) === null && (await prisma.authSession.count({ where: { token: sF.token } })) === 0)
      check('(f) 🔒 the revoked session stays dead', (await betterAuthServer.api.getSession({ headers: new Headers({ cookie: sF.cookiePair }), query: { disableRefresh: true } })) === null)
    } finally { redis.set = origSet }

    // (g) the narrower window: the bump's write-back AND row update both land
    //     between the revoke's Redis delete and its row delete. The copy then
    //     outlives the row; secondaryStorage.get must keep it unauthenticated.
    await inOneBucket()
    const sG = await fresh()
    const origDeleteMany = prisma.authSession.deleteMany
    const atWriteG = gate(), releaseWriteG = gate(), atRowDeleteG = gate(), releaseRowDeleteG = gate()
    let heldWriteG = false, heldRowDeleteG = false
    redis.set = async (key, value, opts) => {
      if (key === sG.token && !heldWriteG) { heldWriteG = true; atWriteG.open(); await releaseWriteG.p }
      return origSet(key, value, opts)
    }
    prisma.authSession.deleteMany = async (args) => {
      if (JSON.stringify(args ?? {}).includes(sG.token) && !heldRowDeleteG) { heldRowDeleteG = true; atRowDeleteG.open(); await releaseRowDeleteG.p }
      return origDeleteMany.call(prisma.authSession, args)
    }
    try {
      await within(resolveAs(sG.cookiePair))
      const gAtWrite = (await within(atWriteG.p)) !== TIMED_OUT
      const pRevoke = revokeAllSessions(userD, randomUUID(), 'revoke_all')
      const gAtRowDelete = (await within(atRowDeleteG.p)) !== TIMED_OUT
      check('(g) fixture: bump held at its write-back, revoke held between its Redis and row deletes', gAtWrite && gAtRowDelete && (await redis.get(sG.token)) === null)
      releaseWriteG.open()
      await settle()
      releaseRowDeleteG.open()
      await within(pRevoke)
      check('(g) fixture: the copy outlived the row (the residual window)', (await redis.get(sG.token)) !== null && (await prisma.authSession.count({ where: { token: sG.token } })) === 0)
      const gLookup = await betterAuthServer.api.getSession({ headers: new Headers({ cookie: sG.cookiePair }), query: { disableRefresh: true } })
      check('(g) 🔒 the revoked session stays dead (no resurrection)', gLookup === null, JSON.stringify(gLookup?.user?.id ?? null))
      check('(g) the lookup removed the orphan', (await redis.get(sG.token)) === null)
    } finally { redis.set = origSet; prisma.authSession.deleteMany = origDeleteMany }

    // (h) the per-user budget: once spent, a stale session is not written, and
    //     the request still resolves.
    await inOneBucket()
    const sH = await fresh()
    await redis.set(budgetKey, '30', { EX: 300 })
    const h0 = await seen(sH.token)
    bumps = []
    check('(h) over the budget, the request still resolves', Number((await resolveAs(sH.cookiePair))?.user?.id) === userD)
    await settle()
    check('(h) 🔒 over the per-user budget → no write', bumps.length === 0 && (await seen(sH.token)).pg === h0.pg, String(bumps.length))
  } finally {
    ctx.internalAdapter.updateSession = origUpdate
    nativeLastSeenHooks.started = () => {}
    await redis.del(budgetKey)
    await deleteAllNativeSessions(userD)
  }
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
