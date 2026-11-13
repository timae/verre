// Public user ids: the ONLY user id a client ever sees, sends, scans or links
// (docs/dev/proposals/public-user-ids.md). 12 characters of the Crockford
// alphabet, the first a LETTER, so a public id never looks like an integer
// (the legacy `/u/<digits>` scan rule and the internal `u:<digits>` identity
// can't confuse the two). Minted by the database (`gen_public_user_id()`), never
// by a client. Canonical uppercase, no hyphen, on the wire and in the database;
// input is case-insensitive and otherwise strict. Links are LOWERCASE
// (`profilePath`): easier to read, and the alphabet has no i, l, o or u to
// confuse with a digit.

export const PUBLIC_USER_ID_LENGTH = 12
const PUBLIC_USER_ID_RE = /^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$/

export function isPublicUserId(v: unknown): v is string {
  return typeof v === 'string' && PUBLIC_USER_ID_RE.test(v)
}

// ASCII letters and digits only BEFORE uppercasing: full Unicode case mapping
// turns 'ß' into 'SS' and 'ſ' into 'S', so an 11-character spelling would
// alias a real id.
const ASCII_12 = /^[0-9A-Za-z]{12}$/

export function normalizePublicUserId(input: unknown): string | null {
  if (typeof input !== 'string' || !ASCII_12.test(input)) return null
  const s = input.toUpperCase()
  return PUBLIC_USER_ID_RE.test(s) ? s : null
}

// The profile page's path, for every link, redirect and shared URL (web and
// app). Readers normalise (`normalizePublicUserId`), so an uppercase link works too.
export function profilePath(publicId: string): string {
  return `/u/${publicId.toLowerCase()}`
}
