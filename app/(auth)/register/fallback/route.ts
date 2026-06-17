import { safeRedirect } from '@/lib/safeRedirect'

// No-JS / hydration-failure fallback target for the register form's native submit
// — same rationale as app/(auth)/login/fallback/route.ts. Discards the posted body
// and 303-redirects back to /register so the user sees the form again. Register's
// credential inputs are unnamed today (so a GET fallback wouldn't even serialize
// them), but the form is method="post" as defence-in-depth and this gives that
// fallback an honest, guaranteed landing instead of relying on POST-to-page.
//
// Carries the original ?redirect= through (re-validated with safeRedirect — it's
// attacker-supplied, so an unvalidated reflection would be an open redirect) so a
// retry returns to where the user started, e.g. /join/<code>.
// Relative Location avoids reflecting the server bind host (e.g. 0.0.0.0).
export function POST(req: Request): Response {
  const redirect = new URL(req.url).searchParams.get('redirect')
  const safe = safeRedirect(redirect, '')
  const location = safe ? `/register?redirect=${encodeURIComponent(safe)}` : '/register'
  return new Response(null, { status: 303, headers: { Location: location } })
}
