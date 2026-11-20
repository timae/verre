import NextAuth from 'next-auth'
import { getToken } from 'next-auth/jwt'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { authConfig } from '@/auth.config'
import { clientVersionGate, WEB_WIRE_GENERATION } from '@/lib/clientVersion'

// The lightweight instance from auth.config.ts (JWT signature only), NOT the
// full auth.ts: its jwt() callback hits Postgres for the revocation gate, and
// the proxy runs on the Node runtime, so importing it here would succeed and
// silently move DB work in front of every /me request. next-auth's types lack
// the (NextRequest, NextFetchEvent) overload, hence the cast.
const nextAuthProxy = NextAuth(authConfig).auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>

// 🔒 `proxy` DISPATCHES BY PATH. `/api/*` runs only the gates below and NEVER
// touches NextAuth: NextAuth(authConfig).auth matched on /api would append a
// re-issued session cookie (from the lightweight config, which has no
// revocation step) to every API response, racing sign-out, and its callback
// form would drop /me's `authorized` redirect. Returning undefined passes the
// request through (Next 16: `mod.proxy || mod.default`).
export async function proxy(req: NextRequest, ev: NextFetchEvent): Promise<Response | undefined> {
  const path = req.nextUrl.pathname
  if (path === '/api' || path.startsWith('/api/')) return apiGates(req, path)
  return nextAuthProxy(req, ev)
}

// /api/session/<code> and everything below it: not the create (/api/session)
// and not /api/session/join (create has no code yet; join is where a bounced
// tab lands).
const MOMENT_PATH = /^\/api\/session\/(?!join(?:\/|$))[^/]+(?:\/.*)?$/
// …and not the two calls of a REMOVED tab's Keep / Delete prompt: they take no
// user id and answer nothing keyed by one, and the old RemovedView ignores
// their answer, so a bounce there would silently drop a "Delete my ratings".
const REMOVED_PATH = /^\/api\/session\/[^/]+\/(?:leave|removed-state)\/?$/

async function apiGates(req: NextRequest, path: string): Promise<Response | undefined> {
  // 🔒 The version floor on EVERY API call, not only native auth: an old app
  // left in the foreground polls /state every 5 s without re-running
  // get-session, and its own id would be `u:<int>` against `u:<publicId>`
  // payloads. apiFetch sends any 426 to the update screen.
  const gate = clientVersionGate(req)
  if (gate) return gate
  if (!MOMENT_PATH.test(path) || REMOVED_PATH.test(path)) return undefined
  // 🔒 The web twin: a moment tab left open across the deploy keeps
  // `myId = u:<int>`, so its own ratings look missing and a re-rate replaces
  // the stored notes. The new web code sends X-Verre-Web; a SIGNED-IN caller
  // with neither marker is bounced with the auth-invalid header, which the old
  // sessionFetch turns into a full reload into /join/<code> (one 5 s poll).
  // The markers are checked BEFORE any decode (zero cost for the app and the
  // new web).
  if (req.headers.get('x-verre-client')) return undefined
  if (req.headers.get('x-verre-web') === WEB_WIRE_GENERATION) return undefined
  if (!(await signedInWebCaller(req))) {
    // 🔒 A GUEST tab open across the deploy (catalogue model change spec § 7,
    // review r1 M3): bouncing it with X-Vr-Auth: invalid would make the old
    // sessionFetch drop its guest token, so it is not bounced; its moment
    // WRITES (no client id, the photo in the body) get one 409 with no
    // X-Vr-Auth (not 403 / 429, which the old tab maps to other messages). The
    // old tab shows its own generic error until it reloads: accepted residual.
    // Its reads keep working.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return Response.json(
        { error: 'Verre was updated. Reload the page.' },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return undefined
  }
  return Response.json(
    { error: 'Verre was updated. Reload the page.' },
    { status: 401, headers: { 'X-Vr-Auth': 'invalid', 'Cache-Control': 'private, no-store' } },
  )
}

// 🔒 "Signed in" is the DECODED token carrying an `id`, never the cookie's
// presence: a revoked or legacy token is re-encoded to `{}` (auth.ts) and its
// cookie lives on, and that browser is anonymous to the server; bouncing it
// would make the old sessionFetch delete its anon token. getToken decodes
// without a database and sets no cookie; expired or tampered → null; chunked
// `.N` cookies are reassembled (each cookie name is its own salt). The secret
// is exactly what NextAuth signs with (`AUTH_SECRET ?? NEXTAUTH_SECRET`,
// next-auth/lib/env.js); none set → nobody can be signed in, never a throw.
// An x-vr-anon-token is NOT an exemption: a signed-in tab that joined
// anonymously earlier keeps its token and is exactly the case to bounce.
async function signedInWebCaller(req: NextRequest): Promise<boolean> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!secret) return false
  for (const secureCookie of [false, true]) {
    try {
      const token = await getToken({ req, secret, secureCookie })
      if (token && typeof token === 'object' && token.id) return true
    } catch {
      // getToken throws only on a missing req / secret, both excluded above.
    }
  }
  return false
}

// /me needs NextAuth's `authorized` redirect; /api/* needs the gates above.
// Matched /api request bodies are buffered up to 10 MB by Next; the largest
// Verre body is the 3 MB image cap (lib/s3.ts).
export const config = {
  matcher: ['/me/:path*', '/api/:path*'],
}
