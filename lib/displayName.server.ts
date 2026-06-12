import { redis, k, scanKeys } from '@/lib/redis'

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
  return `${name} ${pickEmoji()}`
}

function pickEmoji(): string {
  return FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]
}

// Propagate a profile rename into every LIVE session the user participates
// in: the identities-hash value (the roster name) and `meta.host` where they
// are the host. This implements the documented "changing it once in profile
// settings propagates to every session" behavior — without it the Redis
// snapshots written at join/visit time stay frozen until the session expires.
// The caller also mirrors the Postgres `sessions.host_name` snapshot (feed /
// profile session cards read it). Frozen-by-policy snapshots
// (ratings.rater_name, checkins) are deliberately NOT touched.
//
// Best-effort by design: a Redis hiccup must not fail the rename (the
// snapshot just stays stale), so each session is wrapped individually.
// ⚠️ The meta write is a non-WATCHed read-modify-write of the whole JSON —
// same pattern as the settings PATCH. If this races a concurrent settings
// save, the last writer wins the whole blob, and a rename landing on a stale
// read could drop a just-made settings change (incl. authz-relevant fields
// like coHostIds). The window is one round-trip and requires a same-instant
// settings save; the proper fix is a WATCH'd mutateMeta helper mirroring
// mutateWines — deferred until a second meta-mutating background path
// appears. KEEPTTL+XX on the meta write is load-bearing (lib/CLAUDE.md):
// KEEPTTL preserves pro lifespans, XX refuses to resurrect a meta key that
// expired between the read and the write.
export async function propagateDisplayNameToSessions(userId: number, newName: string): Promise<void> {
  const id = `u:${userId}`
  const keys = await scanKeys('s:*:identities')
  for (const key of keys) {
    try {
      const identities = await redis.hGetAll(key)
      if (!(id in identities)) continue
      // Per-session collision check against OTHER participants — the user's
      // own old entry must not trigger the emoji suffix.
      const taken = Object.entries(identities).some(([pid, n]) => pid !== id && n === newName)
      const resolved = taken ? `${newName} ${pickEmoji()}` : newName
      // Recheck membership right before the write: a kick landing between
      // the hGetAll and here must not be resurrected by this hSet.
      if (!(await redis.hExists(key, id))) continue
      await redis.hSet(key, id, resolved)

      const code = key.split(':')[1]
      const raw = await redis.get(k.meta(code))
      if (raw) {
        const meta = JSON.parse(raw)
        if (meta.hostUserId === userId || meta.hostIdentityId === id) {
          meta.host = resolved
          await redis.set(k.meta(code), JSON.stringify(meta), { KEEPTTL: true, XX: true })
        }
      }
    } catch {
      // Per-session best-effort — skip and continue.
    }
  }
}
