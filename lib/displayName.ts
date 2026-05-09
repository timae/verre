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

// Min 2 chars matches the search/typeahead minimum so every user remains
// discoverable by prefix; existing 1-char names from before this rule landed
// are grandfathered (validation only fires on register / name change).
export const DISPLAY_NAME_MIN = 2

export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const trimmed = raw.trim().normalize('NFKC')
  if (trimmed.length === 0) throw new Error('name is required')
  if (trimmed.length < DISPLAY_NAME_MIN) throw new Error(`name must be at least ${DISPLAY_NAME_MIN} characters`)
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

// If the requested name is already used by another participant in this
// session, suffix it with a random food emoji so humans can tell two
// participants apart in the UI. Disambiguation is purely cosmetic now —
// since data is identity-id keyed, two identical display names no longer
// cause data collisions. The check looks at the identities map (the
// authoritative participant list).
//
// The collision check + write are not atomic, so a tight join-race could in
// theory still produce two identical names; acceptable since the data layer
// doesn't depend on uniqueness.
export async function disambiguateDisplayName(code: string, name: string): Promise<string> {
  const identities = await redis.hGetAll(k.identities(code))
  const taken = Object.values(identities).some(n => n === name)
  if (!taken) return name
  const emoji = FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]
  return `${name} ${emoji}`
}
