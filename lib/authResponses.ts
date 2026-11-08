import { NextResponse } from 'next/server'

// Standardized rejection for "you have no valid identity for this session"
// (resolver returned null, or you're not a participant). The X-Vr-Auth header
// signals the client to drop its stored token and bounce to /join, which is
// distinct from a permission-denied 403 (e.g. "only the host can do this") —
// those should NOT clear the token.
export function authInvalid(error = 'identity required', status = 401): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { 'X-Vr-Auth': 'invalid', 'Cache-Control': 'private, no-store' },
  })
}

// Variant for callers who were a participant but got removed (kicked or
// banned). The 'removed' sentinel tells the client to PRESERVE the local
// token + name + id keys (vs 'invalid' which wipes them), bounce to
// /join/<code>, and let that page identify them via the preserved token
// and render the right "You were removed" copy.
export function authRemoved(error = 'removed from session', status = 401): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { 'X-Vr-Auth': 'removed', 'Cache-Control': 'private, no-store' },
  })
}
