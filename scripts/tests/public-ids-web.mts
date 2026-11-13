// Public user ids, the web half (docs/dev/proposals/public-user-ids.md § 9):
//   § 1 the proxy, called directly: the version floor on every /api call, the
//       old-tab bounce (decoded token, both cookie names, chunked forms, the
//       NEXTAUTH_SECRET-only deploy, no secret = nobody signed in), the exact
//       path rule, no Set-Cookie on /api, /me still redirects
//   § 2 the NextAuth session route wrapper: GET and POST /api/auth/session with
//       a minted JWT cookie answer the PUBLIC id, no userSessionId
// The you-profile suite stubs @/auth, so NextAuth gets its own suite.
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/public-ids-web.mts
import { NextRequest } from 'next/server'
import type { NextFetchEvent } from 'next/server'

const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required')
const SECRET = process.env.AUTH_SECRET

const { proxy } = await import('../../proxy.ts')
const { encode } = await import('next-auth/jwt')
const { prisma } = await import('../../lib/prisma.ts')
const { redis } = await import('../../lib/redis.ts')
const sessionRoute = await import('../../app/api/auth/[...nextauth]/route.ts')
const { WEB_WIRE_GENERATION, CODE_FLOOR_IOS } = await import('../../lib/clientVersion.ts')

let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const BASE = 'http://localhost:3000'
const ev = {} as NextFetchEvent
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new NextRequest(`${BASE}${path}`, { method, headers })
const mint = (token: Record<string, unknown>, salt: string, secret = SECRET) => encode({ token, secret, salt })
const STATE = '/api/session/ABCD1234/state'
const bounced = (r: Response | undefined) => !!r && r.status === 401 && r.headers.get('x-vr-auth') === 'invalid' && r.headers.get('cache-control') === 'private, no-store'

try {
  console.log('\n§ 1 the proxy')
  let r = await proxy(req(STATE, { 'x-verre-client': 'ios/0.1.1/embedded' }), ev)
  check('an old app (0.1.1) on /state → 426, even with no env floor (the floor is in code)', r?.status === 426 && !process.env.NATIVE_MIN_VERSION_IOS, r?.status)
  const body426 = r ? await r.json() : null
  check('…the 426 names the code floor', body426?.minVersion === CODE_FLOOR_IOS, body426)
  r = await proxy(req('/api/me/sessions', { 'x-verre-client': 'ios/0.1.4/embedded' }), ev)
  check('…on every /api call, not only native auth', r?.status === 426)
  r = await proxy(req(STATE, { 'x-verre-client': `ios/${CODE_FLOOR_IOS}/embedded` }), ev)
  check('0.1.5 passes', r === undefined, r?.status)

  const signedIn = await mint({ id: '900000123', userSessionId: 'x' }, 'authjs.session-token')
  const signedInSecure = await mint({ id: '900000123', userSessionId: 'x' }, '__Secure-authjs.session-token')
  const empty = await mint({}, 'authjs.session-token')
  r = await proxy(req(STATE, { cookie: `authjs.session-token=${signedIn}`, 'x-verre-web': WEB_WIRE_GENERATION }), ev)
  check('the new web (X-Verre-Web) passes, and the proxy adds no Set-Cookie on /api', r === undefined)
  r = await proxy(req(STATE, { cookie: `authjs.session-token=${signedIn}` }), ev)
  check('🔒 a signed-in web call without X-Verre-Web → 401 + X-Vr-Auth: invalid + no-store', bounced(r), r?.status)
  const bounceBody = r ? await r.json() : null
  check('…the body says to reload, no em dash', bounceBody?.error === 'Verre was updated. Reload the page.' && !/—/.test(JSON.stringify(bounceBody)), bounceBody)
  r = await proxy(req(STATE, { cookie: `__Secure-authjs.session-token=${signedInSecure}` }), ev)
  check('🔒 …under the __Secure- cookie name too', bounced(r))
  const half = Math.ceil(signedIn.length / 2)
  r = await proxy(req(STATE, { cookie: `authjs.session-token.0=${signedIn.slice(0, half)}; authjs.session-token.1=${signedIn.slice(half)}` }), ev)
  check('🔒 …a chunked .0/.1 cookie', bounced(r))
  const halfS = Math.ceil(signedInSecure.length / 2)
  r = await proxy(req(STATE, { cookie: `__Secure-authjs.session-token.0=${signedInSecure.slice(0, halfS)}; __Secure-authjs.session-token.1=${signedInSecure.slice(halfS)}` }), ev)
  check('🔒 …a chunked __Secure- cookie', bounced(r))
  r = await proxy(req(`/api/session/ABCD1234/wines/x/reveal`, { cookie: `authjs.session-token=${signedIn}` }, 'POST'), ev)
  check('…anything below /api/session/<code>', bounced(r))
  r = await proxy(req(STATE, { cookie: `authjs.session-token=${empty}`, 'x-vr-anon-token': 'tok' }), ev)
  check('🔒 a revoked / legacy token re-encoded to {} (anonymous to the server) passes, its anon token kept', r === undefined)
  r = await proxy(req(STATE, { cookie: 'authjs.session-token=garbage' }), ev)
  check('a tampered cookie passes (getToken → null: not signed in)', r === undefined)
  r = await proxy(req(STATE, { 'x-vr-anon-token': 'tok' }), ev)
  check('an anonymous call passes', r === undefined)
  r = await proxy(req(STATE, { cookie: `authjs.session-token=${signedIn}`, 'x-verre-client': `ios/${CODE_FLOOR_IOS}/embedded` }), ev)
  check('the app (X-Verre-Client) is never decoded or bounced', r === undefined)
  r = await proxy(req('/api/session/ABCD1234/leave?cleanup=full', { cookie: `authjs.session-token=${signedIn}` }, 'POST'), ev)
  check('a removed tab\'s leave (Keep / Delete) passes: no user id in it, and the old page ignores the answer', r === undefined)
  r = await proxy(req('/api/session/ABCD1234/removed-state', { cookie: `authjs.session-token=${signedIn}` }), ev)
  check('…and its removed-state read passes', r === undefined)
  r = await proxy(req('/api/session/ABCD1234/leave/x', { cookie: `authjs.session-token=${signedIn}` }, 'POST'), ev)
  check('…exactly those two paths (anything below them still bounces)', bounced(r))
  r = await proxy(req('/api/session', { cookie: `authjs.session-token=${signedIn}` }, 'POST'), ev)
  check('create (/api/session) without the marker passes', r === undefined)
  r = await proxy(req('/api/session/join', { cookie: `authjs.session-token=${signedIn}` }, 'POST'), ev)
  check('/api/session/join without the marker passes', r === undefined)
  r = await proxy(req('/api/me/sessions', { cookie: `authjs.session-token=${signedIn}` }), ev)
  check('other /api routes without the marker pass (only moment routes bounce)', r === undefined)
  // A NEXTAUTH_SECRET-only deploy: NextAuth signs with AUTH_SECRET ?? NEXTAUTH_SECRET.
  delete process.env.AUTH_SECRET
  process.env.NEXTAUTH_SECRET = 'nextauth-only-secret-0123456789abcdef'
  const viaNext = await mint({ id: '900000124', userSessionId: 'y' }, 'authjs.session-token', process.env.NEXTAUTH_SECRET)
  r = await proxy(req(STATE, { cookie: `authjs.session-token=${viaNext}` }), ev)
  check('🔒 the bounce still fires with ONLY NEXTAUTH_SECRET set', bounced(r))
  delete process.env.NEXTAUTH_SECRET
  let threw = false
  try { r = await proxy(req(STATE, { cookie: `authjs.session-token=${signedIn}` }), ev) } catch { threw = true }
  check('🔒 no secret at all: a cookie call passes (nobody can be signed in), never a throw', !threw && r === undefined)
  process.env.AUTH_SECRET = SECRET
  const me = await proxy(req('/me'), ev)
  check('/me still redirects when logged out (NextAuth runs off /api)', !!me && me.status >= 300 && me.status < 400 && /\/login/.test(me.headers.get('location') ?? ''), { status: me?.status, loc: me?.headers.get('location') })

  console.log('\n§ 2 the NextAuth session route')
  const email = `pubids-web-${Date.now()}@example.test`
  const user = await prisma.user.create({ data: { name: 'Web Wren', email }, select: { id: true, publicId: true } })
  const us = await prisma.userSession.create({ data: { userId: user.id, deviceLabel: 'test' }, select: { id: true } })
  const tok = await mint({ id: String(user.id), userSessionId: us.id, sub: String(user.id) }, 'authjs.session-token')
  // `update()` POSTs carry NextAuth's CSRF double-submit (cookie + body token).
  const csrfRes = await sessionRoute.GET(new NextRequest(`${BASE}/api/auth/csrf`))
  const { csrfToken } = await csrfRes.json() as { csrfToken: string }
  const csrfCookie = (csrfRes.headers.getSetCookie().find(c => c.startsWith('authjs.csrf-token=')) ?? '').split(';')[0]
  for (const method of ['GET', 'POST'] as const) {
    const h = method === 'GET' ? sessionRoute.GET : sessionRoute.POST
    const cookie = method === 'POST' ? `authjs.session-token=${tok}; ${csrfCookie}` : `authjs.session-token=${tok}`
    const res = await h(new NextRequest(`${BASE}/api/auth/session`, { method, headers: { cookie, 'content-type': 'application/json', ...(method === 'POST' ? { origin: BASE } : {}) }, body: method === 'POST' ? JSON.stringify({ csrfToken }) : undefined }))
    const text = await res.text()
    let body: { user?: Record<string, unknown> } | null = null
    try { body = JSON.parse(text) } catch {}
    check(`${method} /api/auth/session: user.id is the PUBLIC id, no userSessionId, no integer anywhere`, res.status === 200 && body?.user?.id === user.publicId && !('userSessionId' in (body?.user ?? {})) && !('publicId' in (body?.user ?? {})) && !text.includes(String(user.id)), { status: res.status, text: text.slice(0, 200) })
  }
  const anon = await sessionRoute.GET(new NextRequest(`${BASE}/api/auth/session`))
  const anonText = await anon.text()
  check('signed out: the body passes through (no user)', anon.status === 200 && !/"user"/.test(anonText), anonText)
  await prisma.user.delete({ where: { id: user.id } })
} catch (err) {
  failed++
  console.log(`  ❌ the suite crashed: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  console.log(`\n${pass} passed, ${failed} failed`)
  await prisma.$disconnect().catch(() => {})
  await redis.quit().catch(() => {})
  process.exit(failed > 0 ? 1 : 0)
}
