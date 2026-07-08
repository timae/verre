import { COUNTRY_CODES } from '@verre/core'

// Strip control & visual-spoofing characters from user-supplied
// strings. Three classes targeted:
//
//  1. C0 controls + DEL (\x00..\x08, \x0b, \x0c, \x0e..\x1f, \x7f).
//     Tab/LF/CR are whitelisted (normal in notes). NULL byte is the
//     highest-impact: Postgres TEXT rejects it with P22021 -> 500, so
//     dropping it converts to a clean save.
//  2. Bidirectional control characters (U+202A..U+202E, U+2066..U+2069).
//     RTL override etc. let a user spoof visual order in feed/HoF
//     rendering.
//  3. Zero-width characters and invisible separators (U+200B,
//     U+200E, U+200F, U+2028, U+2029, U+FEFF). Invisible at render
//     time and a known phishing tool: two visually-identical names can
//     be byte-different.
//
//     ZWNJ (U+200C) and ZWJ (U+200D) are deliberately left through:
//     they are required for correct ligature rendering in Persian,
//     Arabic, Hindi, and other scripts that use them. Stripping them
//     would silently mangle words.
//
// Trim runs after the strip so a string that's now leading/trailing
// whitespace doesn't masquerade as a real value. An input that
// reduces to '' returns null so DB writes default to NULL rather than
// storing an empty string.
//
// All escape sequences are ASCII-safe so the source itself doesn't
// contain the very bytes it's filtering: earlier versions included
// U+2028 in the regex literal, which Node's parser treats as a line
// terminator and silently broke the regex.
// eslint-disable-next-line no-control-regex
const SCRUB_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu

export function scrub(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const cleaned = input.replace(SCRUB_RE, '').trim()
  return cleaned.length === 0 ? null : cleaned
}

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
