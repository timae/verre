import { COUNTRY_CODES, scrub } from '@verre/core'

// `scrub` (control / bidi / zero-width strip + trim, '' → null) lives in
// @verre/core so the native editors share the exact character set; the full
// rationale is on its definition (packages/core/src/textScrub.ts).
export { scrub }

// scrub with a ''-fallback — internal convenience for the sanitizers below
// (they compose string ops that want '' rather than null).
function clean(v: unknown): string {
  return scrub(v) ?? ''
}

// Defang URL inputs at the write boundary: only allow http(s) schemes
// through with no embedded whitespace (\n, \t, etc. that `scrub` permits
// elsewhere). Everything else — `javascript:`, `data:`, `vbscript:`,
// URLs with embedded newlines — collapses to `''`. Empty input stays
// empty. This protects any future render path (or third-party consumer
// like /api/me/bookmarks which already surfaces purchase_url) from
// being tricked into clickable scheme-injection links.
//
// Lives HERE (not lib/session.ts, its original home) so pure write-boundary
// callers like /api/checkins don't pull in lib/redis just to sanitize a
// string — lib/session re-exports for its existing importers.
export function cleanUrl(v: unknown): string {
  const s = clean(v)
  if (!s) return ''
  // Auto-prepend https:// when the user typed a bare domain ("example.com").
  // Avoids the silent-drop trap where a paste without scheme would appear
  // saved but never render. URL-validate the result — without this,
  // `javascript:alert(1)` would prepend to `https://javascript:alert(1)`,
  // a non-navigable string that browsers reject on click but pollutes
  // the DB.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(candidate)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return ''
    return u.toString()
  } catch {
    return ''
  }
}

// ISO 3166-1 alpha-2 allow-list. Normalize and validate at the write
// boundary so garbage codes (`XX`, `12`, single chars from typos) never
// reach Postgres. Invalid input collapses to `''`. The dropdown picker
// in the UI only offers valid codes, so this is defense-in-depth.
//
// Requires the cleaned input to be exactly 2 chars before lookup, so a
// 3-char typo like `'usa'` doesn't silently truncate to `'US'` and pass.
export function cleanCountry(v: unknown): string {
  const s = clean(v).toUpperCase()
  if (s.length !== 2) return ''
  return COUNTRY_CODES.has(s) ? s : ''
}
