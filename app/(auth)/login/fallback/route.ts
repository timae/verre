import { safeRedirect } from '@/lib/safeRedirect'

// No-JS / hydration-failure fallback target for the login form's native submit.
//
// LoginForm submits via JS (signIn). But if the handler never runs — a hydration
// race or a ChunkLoadError, both observed in the wild — the browser does a NATIVE
// form submit. method="post" keeps the credentials out of the URL (body, not query
// string); this route is where that body lands. We DISCARD it (never read/log the
// posted password) and 303-redirect back to /login so the user simply sees the
// form again and can retry once JS has loaded.
//
// Why a real route handler instead of action="/login": POSTing to an App Router
// PAGE route has no defined contract — it incidentally renders the page (a 200)
// today, but that's version-dependent framework behavior, not a guarantee. A
// route handler makes the graceful re-render OURS, not Next's whim. 303 (See Other)
// forces the redirected request to GET, so the browser lands on a clean /login.
//
// The form carries the original ?redirect= through (e.g. /join/<code>) so the
// retry returns to where the user started, not a bare /login. We re-validate it
// with safeRedirect — it's attacker-supplied, so an unvalidated reflection would
// be an open redirect — and put the cleaned value back on /login?redirect=.
//
// A RELATIVE Location is deliberate: building an absolute URL from the request
// origin reflects the server's bind host (e.g. 0.0.0.0 behind a proxy), which is
// unresolvable to the browser. A relative path sidesteps host-resolution entirely.
export function POST(req: Request): Response {
  const redirect = new URL(req.url).searchParams.get('redirect')
  const safe = safeRedirect(redirect, '')
  const location = safe ? `/login?redirect=${encodeURIComponent(safe)}` : '/login'
  return new Response(null, { status: 303, headers: { Location: location } })
}
