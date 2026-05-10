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
