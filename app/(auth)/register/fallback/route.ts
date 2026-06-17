// No-JS / hydration-failure fallback target for the register form's native submit
// — same rationale as app/(auth)/login/fallback/route.ts. Discards the posted body
// and 303-redirects back to /register so the user sees the form again. Register's
// credential inputs are unnamed today (so a GET fallback wouldn't even serialize
// them), but the form is method="post" as defence-in-depth and this gives that
// fallback an honest, guaranteed landing instead of relying on POST-to-page.
// Relative Location avoids reflecting the server bind host (e.g. 0.0.0.0).
export function POST(): Response {
  return new Response(null, { status: 303, headers: { Location: '/register' } })
}
