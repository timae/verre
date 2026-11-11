import type { NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
// Static on purpose: betterAuth.ts is Node-runtime-only (bcrypt), and so is
// every resolveUser caller (API route handlers). It must never reach proxy.ts /
// auth.config.ts: the proxy runs on Node since Next 16, so that no longer fails
// the build — it would silently put Postgres + bcrypt in front of every /me
// request (the eslint.config.mjs allowlists catch it). A dynamic import would
// only hide the dependency (see app/CLAUDE.md).
import { betterAuthServer } from '@/lib/betterAuth'

// The single auth seam every API handler resolves its caller through. Returns
// the NextAuth `Session` shape (or null) regardless of branch, so the trust
// model downstream (`resolveIdentity`, the `u:<userId>` anchor,
// `Number(session.user.id)`) is blind to which credential the caller used.
// Design: docs/dev/proposals/mobile-app/01-identity-and-auth.md §5a.
//
// Two branches, selected by which session COOKIE authenticates (no cookie-name
// string-matching, no Authorization-header discriminator — each branch's own
// validation decides):
//   - Better Auth cookie (native clients) — betterAuthServer.api.getSession.
//     Returns null without touching any store when no BA cookie is present
//     (verified: routes/session.mjs reads the signed cookie first), so the web
//     hot path pays ~zero for this probe.
//   - NextAuth cookie (web) — delegate to the existing, unchanged auth().
//
// 🔒 PRECEDENCE: BA-first, and claims from the two branches are NEVER merged.
// A caller carrying both cookies resolves as the BA session. Falling through
// when the BA branch returns null is safe — unlike the old bearer-header
// discriminator (an attacker-pinnable side channel), a cookie that fails BA's
// own validation simply doesn't authenticate, and the NextAuth cookie is a
// complete, independently-validated credential.
//
// 🔒 The web branch is a deliberate PASS-THROUGH to auth(), never a
// reimplementation. auth() runs the uncached user_sessions.revokedAt revocation
// gate (auth.ts jwt()) and the fresh, uncached pro/role SELECT (auth.ts
// session()). The BA branch mirrors that posture: getSession validates the
// opaque token against the session store on EVERY call (cookieCache is off —
// CI-pinned), so a session revoked via identityStore dies on the next request,
// and the users SELECT below is fresh and uncached. Never cache either branch.
//
// `userSessionId` is web-only (the per-device user_sessions row): the BA branch
// leaves it undefined — native sessions are revoked through the auth_sessions
// store, not user_sessions. Its native counterpart is `nativeSessionId`, the
// caller's own auth_sessions row id (the `ba:<id>` the devices GET lists; BA
// copies the created row into Redis, so a Redis-served session carries the same
// id). The devices routes use it for This Device, the password-free own-row
// revoke and the revoke-all keep. 🔒 Server-only: no route serializes `session`,
// keep it so, and never add the session TOKEN here.
// `authSource: 'native'` iff the Better Auth cookie validated — the
// UNSPOOFABLE caller-class signal (set by which credential authenticated,
// never by a client-controlled header like X-Verre-Client). Absent on the
// web auth() pass-through. Reserved for native-only policy; never for
// authorization tiers.
export type ResolvedSession = Session & { authSource?: 'native'; nativeSessionId?: number }

export async function resolveUser(req: NextRequest): Promise<ResolvedSession | null> {
  // Availability isolation, NOT an auth decision: a thrown BA branch (Redis
  // down, BA internal error) falls through to auth() so a valid NextAuth
  // cookie keeps working — otherwise a dual-cookie holder 500s on every API
  // route during a Redis outage even though their web credential is fine.
  // Fail-closed semantics are untouched: a revoked/invalid BA session RESOLVES
  // to null (no throw), and the fall-through path still runs auth()'s own full
  // validation — no claim from the failed branch is carried over.
  try {
    // 🔒 disableRefresh — a server-side call must never slide the session; only
    // the HTTP heartbeat may, because its Set-Cookie is the one the device
    // stores. Rationale + pin: lib/betterAuth.ts session config.
    const ba = await betterAuthServer.api.getSession({ headers: req.headers, query: { disableRefresh: true } })
    if (ba?.user) {
      const userId = Number(ba.user.id)
      if (!Number.isInteger(userId) || userId <= 0) return null
      // Same fresh SELECT as auth.ts session(): role/pro changes and account
      // deletion must bite on the next request, not at token mint time.
      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true, pro: true },
      })
      if (!dbUser) return null
      const sid = Number(ba.session.id)
      return {
        user: {
          id: String(dbUser.id),
          name: dbUser.name,
          email: dbUser.email,
          role: dbUser.role,
          pro: dbUser.pro,
        },
        // Date when served from Postgres, ISO string when served from Redis
        // (JSON round-trip) — normalize.
        expires: new Date(ba.session.expiresAt).toISOString(),
        authSource: 'native',
        nativeSessionId: Number.isInteger(sid) && sid > 0 ? sid : undefined,
      }
    }
  } catch (e) {
    console.error('resolveUser: Better Auth branch threw; falling through to web auth()', e)
  }
  return auth()
}
