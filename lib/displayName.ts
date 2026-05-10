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

// Mixed-script detection: a name that mixes letters from unrelated
// writing systems (Cyrillic `і` next to Latin `victm`, Greek `α` next
// to Latin) is rejected. This blocks the homoglyph impersonation class.
// Single-script names in any one system pass.
//
// Compound-script exceptions (Unicode TR39's "highly restrictive"
// posture): Japanese routinely mixes Han + Hiragana + Katakana, Korean
// mixes Hangul + Han. We treat those clusters as a single logical
// script so legitimate East-Asian names aren't rejected.
//
// Numbers, spaces, and the punctuation in ALLOWED are script-neutral
// and don't count toward the script set.
const SCRIPT_GROUPS: { name: string; re: RegExp }[] = [
  { name: 'Latin',    re: /\p{Script=Latin}/u },
  { name: 'Cyrillic', re: /\p{Script=Cyrillic}/u },
  { name: 'Greek',    re: /\p{Script=Greek}/u },
  { name: 'CJK',      re: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { name: 'Korean',   re: /[\p{Script=Hangul}\p{Script=Han}]/u },
  { name: 'Arabic',   re: /\p{Script=Arabic}/u },
  { name: 'Hebrew',   re: /\p{Script=Hebrew}/u },
  { name: 'Thai',     re: /\p{Script=Thai}/u },
  { name: 'Devanagari', re: /\p{Script=Devanagari}/u },
]

// Han is in both the CJK and Korean groups (intentional — Han +
// Hiragana/Katakana = Japanese, Han + Hangul = Korean). Either match
// firing alone is fine; if both fire we need to disambiguate to avoid
// rejecting legitimate single-language names:
//   - Hiragana/Katakana present  → Japanese; drop Korean (no Hangul)
//   - Hangul present              → Korean;   drop CJK
//   - Han only (Chinese)          → either tag is the "single logical
//                                    script", drop one of them
function detectScripts(s: string): string[] {
  const hits = SCRIPT_GROUPS.filter(g => g.re.test(s)).map(g => g.name)
  if (hits.length <= 1) return hits
  if (hits.includes('CJK') && hits.includes('Korean')) {
    const hasJa = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)
    const hasKo = /\p{Script=Hangul}/u.test(s)
    if (hasJa && !hasKo) return hits.filter(h => h !== 'Korean')
    if (hasKo && !hasJa) return hits.filter(h => h !== 'CJK')
    if (!hasJa && !hasKo) return hits.filter(h => h !== 'Korean')  // Han-only
    // Both Hiragana AND Hangul present → real script mix. Fall through.
  }
  return hits
}

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
  // Mixed-script reject. NFKC above already collapses Roman-numeral
  // Ⅴ → Latin V, ﬁ → fi etc. (compatibility decompositions), so
  // confusable single-script names still get caught here on the next
  // step of the pipeline. The remaining attack class — Cyrillic `і`
  // beside Latin `victm` — is exactly what mixed-script blocks.
  const scripts = detectScripts(trimmed)
  if (scripts.length > 1) {
    throw new Error('name must use a single writing system')
  }
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
