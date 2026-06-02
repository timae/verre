import { headers, cookies } from 'next/headers'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'

// Decides which (if any) informational banner the login page shows, based on
// the session cookie the browser is carrying. Three outcomes:
//
//   'password_change' — the session was REVOKED because the user changed their
//       password (from another device). The JWT signature is still valid when a
//       session is revoked (revocation is DB state, not a signature change), so
//       getToken decodes userSessionId and we look up the row's reason.
//   'session_expired' — a session cookie is physically present but getToken
//       can't decode it (expired JWT). We deliberately DON'T persist any
//       identity to recover here — the browser's own password manager prefills
//       email+password on the form; we only explain the bounce. (Designed this
//       way after review: a separate email-hint cookie would reinvent native
//       autofill and store PII at rest against this codebase's minimisation
//       posture.)
//   null — no cookie (fresh visitor), an active session, or a revoke reason we
//       don't surface ('manual' / 'revoke_all' / 'logout').
//
// SHARED-COMPUTER TRADEOFF (deliberate): the notice is keyed off whoever HOLDS
// the cookie, not whoever proves account ownership. On a shared machine, a
// stranger opening /login with a stale revoked cookie would see "your password
// was changed". Accepted as a tradeoff for clarity to the legitimate user; the
// bare cookie already implies "someone was logged in here".
//
// Decoding the cookie here resurrects NO auth: it only reads userSessionId for
// a lookup and returns a UI string. The real gate is auth.ts's jwt() callback.
// Best-effort: any failure resolves to null so the login page always renders.
export type LoginNotice = 'password_change' | 'session_expired'

// Mirror NextAuth's secureCookie precedence: an explicit AUTH_URL/NEXTAUTH_URL
// protocol wins (that's what issuance keys off when set), else fall back to the
// forwarded proto. Keying only off x-forwarded-proto would silently break the
// notice if AUTH_URL is later set to https behind a proxy that strips the
// header — issuance would use the __Secure- cookie name while we'd read the
// unprefixed one (name+salt mismatch → silent decode failure).
function isSecureCookie(reqHeaders: Headers): boolean {
  const authUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL
  if (authUrl) {
    try { return new URL(authUrl).protocol === 'https:' } catch { /* fall through */ }
  }
  return reqHeaders.get('x-forwarded-proto') === 'https'
}

export async function getLoginNotice(): Promise<LoginNotice | null> {
  try {
    const secret = process.env.AUTH_SECRET
    if (!secret) return null
    const reqHeaders = await headers()
    const secureCookie = isSecureCookie(reqHeaders)
    const cookieName = secureCookie ? '__Secure-authjs.session-token' : 'authjs.session-token'

    const token = await getToken({ req: { headers: reqHeaders }, secret, secureCookie })
    if (token) {
      const userSessionId = token.userSessionId
      if (typeof userSessionId !== 'string') return null
      const sess = await prisma.userSession.findUnique({
        where: { id: userSessionId },
        select: { revokedAt: true, revocationReason: true },
      })
      if (!sess || !sess.revokedAt) return null
      if (sess.revocationReason === 'password_change') return 'password_change'
      return null
    }

    // No decodable token. If a session cookie is nonetheless PRESENT, it's an
    // expired/undecodable session (not a fresh visitor) → explain the bounce.
    const cookieStore = await cookies()
    if (cookieStore.get(cookieName)) return 'session_expired'
    return null
  } catch {
    return null
  }
}
