// Usernames (docs/dev/proposals/usernames.md § 4): a unique lookup and display
// name, `@simon`. Carries NO trust: never an identity, never authorises, never
// inside a moment. Lowercase `a-z 0-9 . _`, 3 to 30 characters, no two dots in
// a row, no dot at either end, at least one letter or digit. The FORMAT half here is byte-for-byte the
// database CHECK `users_username_format_chk` (pinned both ways by the
// you-profile suite); the RESERVED half is policy, for writes only.
//
// 🔒 Reads (links, the scanner, lookups, the share link) test the FORMAT only:
// an account the operator gave a reserved name must open like any other.

import { RESERVED_DISPLAY_NAMES } from './displayName'
import { profilePath } from './publicUserId'

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30

const FORMAT_RE = /^[a-z0-9._]{3,30}$/
// ASCII only BEFORE lowercasing: full Unicode case mapping turns 'ß' into 'SS'
// and 'K' (Kelvin) into 'k', so a non-ASCII spelling would alias a real name.
const ASCII_RE = /^[A-Za-z0-9._]*$/

export function isUsernameFormat(s: string): boolean {
  return FORMAT_RE.test(s) && !s.includes('..') && !s.startsWith('.') && !s.endsWith('.') && /[a-z0-9]/.test(s)
}

function canonical(input: string): string | null {
  const t = input.trim()
  const s = t.startsWith('@') ? t.slice(1) : t
  return ASCII_RE.test(s) ? s.toLowerCase() : null
}

// For READS. The canonical name, or null. `/@Simon` opens `@simon`.
export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = canonical(input)
  return s !== null && isUsernameFormat(s) ? s : null
}

// A URL path segment (`/@<segment>`, the by-username API route, a scanned
// link): like `normalizeUsername`, but nothing is trimmed and no `@` dropped,
// so `/@@simon` and `/@%20simon` are not second spellings of a profile.
export function usernameFromPath(segment: unknown): string | null {
  if (typeof segment !== 'string' || !ASCII_RE.test(segment)) return null
  const s = segment.toLowerCase()
  return isUsernameFormat(s) ? s : null
}

// The search side's lenient form: a partial or 2-character query is fine, a
// character no username can hold is not (null: the caller drops the username
// clause). One leading `@` dropped, ASCII lowercased.
export function usernameQuery(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = canonical(input)
  return s ? s : null
}

// Staff words (D3): each is reserved alone, and so is any name made ONLY of
// them and the brand (`STAFF_ONLY_RE`).
export const USERNAME_STAFF_WORDS = ['official', 'team', 'support', 'staff', 'admin', 'app', 'help', 'mod', 'hq'] as const
// The whole name is `verre` and / or staff words, nothing else, in any order.
const STAFF_ONLY_RE = new RegExp(`^(?:verre|${USERNAME_STAFF_WORDS.join('|')})+$`)

const ROUTE_WORDS = [
  // web
  'api', 'join', 'legal', 'login', 'register', 'me', 'session', 'u',
  // app
  'about', 'attributions', 'feed', 'moments', 'you', 'soon', 'signin', 'signup', 'updaterequired',
  // future
  'place', 'places', 'producer', 'producers', 'wine', 'wines', 'catalog', 'moment', 'impression', 'impressions',
  'craving', 'cravings', 'settings', 'search', 'explore', 'home', 'profile', 'user', 'users', 'account', 'privacy',
  'terms', 'contact', 'press', 'blog', 'jobs', 'security', 'logout',
]
// Only matter if `/name` URLs ever exist.
const FILE_NAMES = ['robots.txt', 'sitemap.xml', 'favicon.ico', 'favicon.png', 'index.html', 'manifest.json']
const BRAND_AND_STAFF = [
  'verre', 'verreapp', 'gastro', 'app', 'admins', 'administrator', 'administrators', 'moderators', 'mods', 'curator', 'verified', 'anonymous', 'guest', 'everyone', 'all',
  'here', 'nobody', 'unknown',
]

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  ...RESERVED_DISPLAY_NAMES, ...ROUTE_WORDS, ...FILE_NAMES, ...BRAND_AND_STAFF,
])

const strip = (s: string) => s.replace(/[._]/g, '')
const RESERVED_STRIPPED: ReadonlySet<string> = new Set([...RESERVED_USERNAMES].map(strip))

// A WRITE rule. Takes a canonical name. Reserved: a reserved word, a lookalike
// (equal to one once dots and underscores are removed: `v.e.r.r.e`, `_admin_`),
// or the staff rule: with dots and underscores removed the name is made ONLY
// of `verre` and staff words (`verre_official`, `teamverre`, `official_support`,
// `admin.team`). Ruled 2026-11-14: first "contains verre and a staff word",
// which caught ordinary words (`happyverre`, `verremodern`: the short staff
// words match inside them, and verre is French for glass); then widened to
// staff words without the brand. Any other word lets a name through
// (`verre_official_ch`, `support_simon`): accepted, impersonators are watched
// and blocked by hand (scripts/set-username.mts --block-old).
export function isReservedUsername(name: string): boolean {
  if (RESERVED_USERNAMES.has(name)) return true
  const bare = strip(name)
  return RESERVED_STRIPPED.has(bare) || STAFF_ONLY_RE.test(bare)
}

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: 'invalid' | 'reserved'; message: string }

// For WRITES, without the throw (the availability check names the reason).
export function checkUsername(raw: unknown): UsernameCheck {
  const invalid = (message: string): UsernameCheck => ({ ok: false, reason: 'invalid', message })
  if (raw === undefined || raw === null) return invalid('username is required')
  if (typeof raw !== 'string') return invalid('username must be a string')
  const t = raw.trim()
  const typed = t.startsWith('@') ? t.slice(1) : t
  if (typed.length === 0) return invalid('username is required')
  if (!ASCII_RE.test(typed)) return invalid('username can only use letters a to z, numbers, dots and underscores')
  const s = typed.toLowerCase()
  if (s.length < USERNAME_MIN) return invalid(`username must be at least ${USERNAME_MIN} characters`)
  if (s.length > USERNAME_MAX) return invalid(`username must be at most ${USERNAME_MAX} characters`)
  if (s.includes('..')) return invalid('username cannot have two dots in a row')
  if (s.startsWith('.') || s.endsWith('.')) return invalid('username cannot start or end with a dot')
  if (!/[a-z0-9]/.test(s)) return invalid('username must contain a letter or a number')
  if (!isUsernameFormat(s)) return invalid('username is invalid')
  if (isReservedUsername(s)) return { ok: false, reason: 'reserved', message: 'username is reserved' }
  return { ok: true, username: s }
}

// For WRITES. The canonical name (a typed `Simon` is stored as `simon`), or a
// throw with a user-facing message, like `validateDisplayName`.
export function validateUsername(raw: unknown): string {
  const r = checkUsername(raw)
  if (!r.ok) throw new Error(r.message)
  return r.username
}

// The link people SHARE: `/@name`, or the public-id path while someone has no
// username. The QR keeps `profilePath` (it survives a rename).
export function profileSharePath(person: { id: string; username?: string | null }): string {
  return person.username ? `/@${person.username}` : profilePath(person.id)
}
