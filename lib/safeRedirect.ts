// Validate a user-supplied post-auth redirect target. The `?redirect=` param on
// /login and /register (seeded by JoinClient as /join/<code>) is attacker-supplied
// — anyone can craft /login?redirect=//evil.com or ?redirect=https://evil.com. If
// the auth flow then navigates there (window.location.assign / a 303 Location),
// that's an OPEN REDIRECT (credential-phishing handoff). So every redirect target
// — on the JS success path AND the no-JS fallback — passes through here first.
//
// Allowed: a SAME-ORIGIN relative path only — starts with a single "/", not "//"
// or "/\" (protocol-relative / backslash tricks that browsers treat as a host),
// no scheme, no control chars/whitespace. Anything else → the caller's default.
//
// Pure + framework-neutral (no next/node imports) so it's usable in route
// handlers, client components, and tests alike.
export function safeRedirect(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback
  // Must be a path: exactly one leading slash, and the next char must NOT be
  // another slash or a backslash (//host and /\host both navigate off-origin).
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return fallback
  // Reject any backslash (browsers treat \ as / in URLs, so /\evil or /a\b can
  // smuggle a host) and any control char / whitespace (newline header-smuggling).
  if (/[\\\x00-\x1f\x7f]/.test(raw)) return fallback
  return raw
}
