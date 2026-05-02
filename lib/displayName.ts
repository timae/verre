import { redis, k } from '@/lib/redis'

// Reserved names — case-insensitive after lowercasing.
// Blocks impersonation of system actors and the deletion placeholder.
const RESERVED = new Set([
  'admin', 'verre', 'support', 'host', 'system',
  '[deleted]', 'deleted', 'moderator', 'mod', 'help', 'api',
  'staff', 'official', 'team', 'root', 'null', 'undefined',
])

// Letters / digits / space / apostrophe / underscore / period / hyphen.
// Excludes Redis key separators (`:`, `*`) and control characters.
const ALLOWED = /^[\p{L}\p{N} '_.\-]+$/u

export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const trimmed = raw.trim().normalize('NFKC')
  if (trimmed.length === 0) throw new Error('name is required')
  if (trimmed.length > 64) throw new Error('name must be at most 64 characters')
  if (!ALLOWED.test(trimmed)) throw new Error('name contains invalid characters')
  if (RESERVED.has(trimmed.toLowerCase())) throw new Error('name is reserved')
  return trimmed
}

// Curated food emoji pool used to disambiguate duplicate display names within
// a session. Excludes anything that reads as suggestive (eggplant, peach) and
// the banana per product preference.
const FOOD_EMOJI = [
  '🍎','🍊','🍋','🍉','🍇','🍓','🫐','🍒','🥭','🍍','🥥','🥝',
  '🍅','🥑','🌽','🥕','🥒','🥬','🥦','🧄','🧅','🥔','🍠',
  '🥨','🥯','🍞','🧀','🍗','🍖','🥓','🍔','🍟','🍕','🌭','🥪',
  '🌮','🌯','🥗','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙',
  '🍚','🍘','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮',
  '🍭','🍬','🍫','🍩','🍪','🥜','🌰','🫖','🍵','☕','🧃','🥤',
]

// If the requested name is already taken in this session's users set, suffix
// it with a random food emoji. The disambiguated name is what gets stored in
// Redis and returned to the client; from there everything (identity record,
// participant list, future requests) sees the suffixed form.
//
// The collision check + write are not atomic, so a tight join-race could in
// theory still produce two identical names. Acceptable for a 4–8 person
// tasting flow; not worth a Lua script.
export async function disambiguateDisplayName(code: string, name: string): Promise<string> {
  const taken = await redis.sIsMember(k.users(code), name)
  if (!taken) return name
  const emoji = FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]
  return `${name} ${emoji}`
}
