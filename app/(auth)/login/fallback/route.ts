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
// A RELATIVE Location ("/login") is deliberate: building an absolute URL from the
// request origin reflects the server's bind host (e.g. 0.0.0.0 behind a proxy),
// which is unresolvable to the browser. A relative path sidesteps host-resolution
// entirely — the browser resolves it against the page origin it's already on.
export function POST(): Response {
  return new Response(null, { status: 303, headers: { Location: '/login' } })
}
