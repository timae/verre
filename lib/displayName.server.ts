import { redis, k, scanKeys } from '@/lib/redis'
import { withSessionMutation } from '@/lib/sessionMutation'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'

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

// Pure form for a writer that already holds the participant names (the
// rebuild, the per-user heal — both run under the session lock).
export function disambiguateAgainst(name: string, taken: Iterable<string>): string {
  for (const n of taken) if (n === name) return `${name} ${pickEmoji()}`
  return name
}

function pickEmoji(): string {
  return FOOD_EMOJI[Math.floor(Math.random() * FOOD_EMOJI.length)]
}

// A profile rename pushed into every live session that registers the user:
// the roster entry, and for a session they host the meta.host snapshot.
//
// 🔒 Per session under the session lock (G1 — identities and meta are
// shared-state keys), with the decision re-made inside: still registered (a
// kick that landed meanwhile must not be resurrected by this HSET), the
// incarnation unchanged; fenced writes. A Postgres-backed session's meta is
// rewritten FROM THE RECORD (D4) — the caller updates sessions.host_name first.
// Best-effort per session: a busy lock or a failure skips it (the snapshot just
// stays stale until the next rename or rebuild).
export async function propagateDisplayNameToSessions(userId: number, newName: string): Promise<void> {
  const id = `u:${userId}`
  for (const key of await scanKeys('s:*:identities')) {
    const code = key.split(':')[1]
    if (!code || !(await redis.hExists(key, id))) continue
    try {
      await withSessionMutation(code, { label: 'propagate-name', redisLock: { waitMs: 500 } }, async (tx, ctx) => {
        const identities = await redis.hGetAll(k.identities(code))
        if (!(id in identities)) return
        // Collision check against OTHER participants only.
        const resolved = disambiguateAgainst(newName, Object.entries(identities).filter(([pid]) => pid !== id).map(([, n]) => n))
        const meta = ctx.meta!
        const hosts = meta.hostUserId === userId || meta.hostIdentityId === id
        const nextMeta = !hosts ? null
          : ctx.row ? metaFromRecord((await readLiveRow(tx, code))!, await readRecordRoles(tx, code), meta)
          : { ...meta, host: resolved }
        await ctx.fence!.exec(m => {
          m.hSet(k.identities(code), id, resolved)
          if (nextMeta) m.set(k.meta(code), JSON.stringify(nextMeta), { XX: true, KEEPTTL: true })
        })
      })
    } catch (err) {
      console.warn('[rename] propagation skipped a session', { code, err: (err as Error).message })
    }
  }
}
