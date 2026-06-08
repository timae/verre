import type { NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { auth } from '@/auth'

// The single auth seam every API handler resolves its caller through. Returns
// the NextAuth `Session` shape (or null) unchanged, so the trust model
// downstream (`resolveIdentity`, the `u:<userId>` anchor, `Number(session.user.id)`)
// is blind to which credential the caller used. Native-clients design lives in
// docs/dev/proposals/mobile-app/01-identity-and-auth.md.
//
// Two branches, chosen by the precedence rule below:
//   - Logto bearer (native clients) — NOT YET IMPLEMENTED.
//   - NextAuth cookie (web)         — delegate to the existing, unchanged auth().
//
// 🔒 PRECEDENCE: an `Authorization` header present ⇒ the Logto path is
// authoritative and the cookie is ignored ENTIRELY. Claims from the two are
// never merged — without this, a caller carrying both could choose which
// identity to run as.
//
// 🔒 The cookie branch is a deliberate PASS-THROUGH to auth(), never a
// reimplementation. auth() runs the uncached user_sessions.revokedAt revocation
// gate (auth.ts jwt()) and the fresh, uncached pro/role SELECT (auth.ts
// session()). Reimplementing cookie validation here would risk bypassing both —
// the exact holes the invariants forbid. Keeping it a pass-through also makes
// this whole refactor trivially reversible: delete the Logto branch and the seam
// is a one-line wrapper around today's auth().
export async function resolveUser(req: NextRequest): Promise<Session | null> {
  const authorization = req.headers.get('authorization')
  if (authorization) {
    // Logto bearer path, still to come: full access-token validation (jose,
    // aud-pinned to Verre's API resource, issuer exact-match, alg allow-list,
    // JWKS with kid-driven refresh), Logto-subject → Verre users.id mapping,
    // fresh uncached pro/role, and the two-layer (grant-delete + not-before)
    // revocation gate.
    //
    // Until that lands, a bearer token cannot authenticate. We FAIL CLOSED by
    // returning null (→ handlers' existing `!session?.user` → 401), NOT by
    // falling through to the cookie — the precedence rule forbids the cookie the
    // moment an Authorization header is present, so honouring the cookie here
    // would let a caller smuggle a bearer header to pin which path resolves.
    // Returning null rather than throwing keeps the failure a clean 401 instead
    // of an unhandled 500.
    return null
  }
  return auth()
}
