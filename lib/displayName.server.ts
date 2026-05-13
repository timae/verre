import { redis, k } from '@/lib/redis'

// Server-only display-name helper. Lives in a separate file from the
// rest of `lib/displayName.ts` so client components (e.g.
// SessionAnonMenu) can import the pure pieces (validateDisplayName,
// stripDisambiguationEmoji) without dragging in the `lib/redis.ts`
// Node-only module (which trips the Next.js client bundler with
// `Module not found: Can't resolve 'net'`).

// Curated food emoji pool used to disambiguate duplicate display names
// within a session. Excludes anything that reads as suggestive
// (eggplant, peach) and the banana per product preference.
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
// The collision check + write are not atomic, so a tight join-race could
// in theory still produce two identical names; acceptable since the data
// layer doesn't depend on uniqueness.
export async function disambiguateDisplayName(code: string, name: string): Promise<string> {
  const identities = await redis.hGetAll(k.identities(code))
  const taken = Object.values(identities).some(n => n === name)
  if (!taken) return name
  const emoji = FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]
  return `${name} ${emoji}`
}
