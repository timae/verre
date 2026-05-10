// Defense-in-depth Origin check for state-changing endpoints.
//
// NextAuth defaults to `SameSite=Lax` for the session cookie, which
// means a real browser will not send the cookie on a cross-origin
// fetch/XHR — so the user is already protected from a typical CSRF
// page. This check is a second layer for cases where SameSite is
// bypassed: SameSite=None deployments, browser bugs, embedded webviews
// with relaxed cookie behavior, or future cookie-policy changes.
//
// We allow:
//  - Same-origin requests (Origin matches Host).
//  - Requests with no Origin/Referer (server-to-server, curl) — the
//    cookie itself is the trust anchor; CSRF concerns only apply when
//    a browser is the user-agent and is being tricked.
//
// We reject any browser-style cross-origin request even if the cookie
// happened to leak through.

import type { NextRequest } from 'next/server'

// Pre-lowercase at module load so the per-request comparison is a
// straight string match instead of mapping the array on every call.
const EXTRA_ORIGINS = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  // Genuinely-missing Origin → non-browser caller (curl, server-to-
  // server). Cookie remains the trust anchor.
  if (origin === null) return true
  // Explicit empty string or "null" → synthetic origin sent by a
  // browser (sandboxed iframe, file:// page, opaque origin). Reject
  // because there's no way to verify same-site context.
  if (origin === '' || origin === 'null') return false

  const host = req.headers.get('host')
  if (!host) return false

  try {
    const u = new URL(origin)
    // Match host (with or without port). Localhost and the deployed
    // hostname both flow through here.
    if (u.host === host) return true
    if (u.hostname === host) return true
    // Allow any explicitly-listed origin from the deploy config — same
    // list Server Actions consults.
    if (EXTRA_ORIGINS.includes(u.host.toLowerCase())) return true
    return false
  } catch {
    return false
  }
}
