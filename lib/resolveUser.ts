import type { NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
// Static on purpose: betterAuth.ts is Node-runtime-only (bcrypt), and so is
// every resolveUser caller (API route handlers). If this seam ever leaks into
// the Edge graph (middleware/auth.config), the build fails loud — a dynamic
// import would be bundled for Edge all the same (see app/CLAUDE.md) while
// hiding the dependency.
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
// store, not user_sessions. Routes that operate on the CALLER'S OWN device row
// (devices revoke-all, per-device logout) already 401/skip on a missing
// userSessionId.
export async function resolveUser(req: NextRequest): Promise<Session | null> {
  // Availability isolation, NOT an auth decision: a thrown BA branch (Redis
  // down, BA internal error) falls through to auth() so a valid NextAuth
  // cookie keeps working — otherwise a dual-cookie holder 500s on every API
  // route during a Redis outage even though their web credential is fine.
  // Fail-closed semantics are untouched: a revoked/invalid BA session RESOLVES
  // to null (no throw), and the fall-through path still runs auth()'s own full
  // validation — no claim from the failed branch is carried over.
  try {
    const ba = await betterAuthServer.api.getSession({ headers: req.headers })
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
      }
    }
  } catch (e) {
    console.error('resolveUser: Better Auth branch threw; falling through to web auth()', e)
  }
  return auth()
}
