import { redis, k, scanKeys } from '@/lib/redis'
import { prisma } from '@/lib/prisma'

// Single helper for all flavors of removing a participant from a session,
// invoked by both the host-side ban/kick endpoint and the kicked-user's
// self-service "delete my data" endpoint.
//
// Scope semantics:
//   - 'kick-keep'   → strip from identities + cohost list; reset
//                     session_members.role to 'taster'. Leave the rest
//                     intact so /me/sessions still shows the session.
//   - 'kick-delete' → kick-keep + delete the user's session-scoped data
//                     (ratings, hof, bookmarks-of-wines-in-this-session,
//                     session_members).
//   - 'ban'         → kick-delete + add to bans Set so they can't rejoin.
//                     Wines they added are orphaned (session_id NULL) if
//                     the caller passes deleteAddedWines=true; otherwise
//                     left attached. The wines themselves are never hard-
//                     deleted — that would cascade-delete other tasters'
//                     bookmarks and ratings on that wine.
//
// Order: Postgres transaction first (atomic), then Redis (idempotent
// follow-up). Bans-Set SADD lives in the Postgres txn-equivalent slot in
// Redis — it's the smallest and most-important Redis op, written before
// the identities hash strip so a partial-failure recovery still keeps
// the user out.
//
// Concurrency: callers should hold the per-session ban lock (see
// lib/sessionBan.ts acquireBanLock) when running this helper so the
// wines JSON write-back doesn't race a concurrent host action.

export type WipeScope = 'kick-keep' | 'kick-delete' | 'ban'

export interface WipeOptions {
  code: string
  identityId: string
  scope: WipeScope
  // Only meaningful for scope='ban'. Ignored otherwise.
  deleteAddedWines?: boolean
}

export async function sessionWipe(opts: WipeOptions): Promise<void> {
  const { code, identityId, scope, deleteAddedWines = false } = opts
  const userId = identityId.startsWith('u:') ? Number(identityId.slice(2)) : null

  // ── Redis: bans-Set first (only on scope='ban'). Idempotent; if the
  // Postgres txn below fails the bans entry alone is enough to keep them
  // out, and a retry replays cleanly.
  if (scope === 'ban') await redis.sAdd(k.bans(code), identityId)

  // For kicks (any variant), mark the identity as "kicked" so the bounce
  // page on /join can identify a recently-removed participant whose
  // identity hash entry got stripped. Cleared on rejoin OR on Delete via
  // /leave. Doesn't act as an authorization gate — it's purely a marker
  // for the UI bounce screen.
  if (scope === 'kick-keep' || scope === 'kick-delete') {
    await redis.sAdd(k.kicked(code), identityId)
  }

  // ── Postgres in a single transaction.
  await prisma.$transaction(async tx => {
    if (scope === 'kick-keep') {
      // Reset cohost role so /me/sessions doesn't show a stale "co-host"
      // tag. The user's ratings + bookmarks + session_members row stay
      // — they decide on the bounce screen what to do with them.
      if (userId !== null) {
        await tx.sessionMember.updateMany({
          where: { userId, sessionCode: code },
          data: { role: 'taster' },
        })
      }
    } else {
      // kick-delete and ban share the full per-user wipe.
      if (userId !== null) {
        // Ratings link to wines (not directly to sessions). Walk the
        // relation so we delete only ratings whose wines belong to THIS
        // session.
        await tx.rating.deleteMany({
          where: { userId, wine: { session: { code } } },
        })
        await tx.hallOfFame.deleteMany({ where: { userId, sessionCode: code } })
        // Bookmarks pointing at wines belonging to this session. Other
        // tasters' bookmarks on the same wines stay.
        await tx.bookmark.deleteMany({
          where: { userId, wine: { session: { code } } },
        })
        await tx.sessionMember.deleteMany({ where: { userId, sessionCode: code } })
      }
    }
    // Wine-orphan toggle applies to both kick and ban (host's call,
    // regardless of mode). Orphan (session_id NULL) rather than
    // hard-delete so third-party bookmarks survive.
    if (deleteAddedWines) {
      await tx.wine.updateMany({
        where: { session: { code }, addedByIdentityId: identityId },
        data: { sessionId: null },
      })
    }
  })

  // ── Redis cleanup (post-transaction; each op is idempotent).
  // Per-rating keys via SCAN to avoid blocking Redis on large sessions.
  if (scope !== 'kick-keep') {
    const prefix = `s:${code}:r:${identityId}:`
    const keys = await scanKeys(`${prefix}*`)
    if (keys.length > 0) await redis.del(keys)
  }

  // Drop from identities. Token mapping (`s:<C>:tokens`) is preserved
  // across all wipe scopes — on ban so the next request resolves token
  // → identityId → bans hit → authRemoved bounce; on kick-keep so the
  // kicked anon user can reach `/leave?cleanup=full` to clean up their
  // data; on kick-delete so the same /leave call (which triggers this
  // scope) can resolve the caller in the first place. The token alone
  // doesn't grant access — bans-Set membership and identities-hash
  // absence both gate participation. The token-hash entry becomes a
  // stale pointer but doesn't leak anything since the session expires
  // with its TTL.
  await redis.hDel(k.identities(code), identityId)

  // Strip from cohort + provider lists in meta. Use KEEPTTL so a session
  // with a remaining lifespan (default 48h, or pro 72h/1w/unlimited)
  // doesn't get its TTL clobbered to "no expiration" by the SET.
  // Both lists checked in one read/write to avoid a second meta round-trip.
  const rawMeta = await redis.get(k.meta(code))
  if (rawMeta) {
    const meta = JSON.parse(rawMeta)
    let changed = false
    if (Array.isArray(meta.coHostIds) && meta.coHostIds.includes(identityId)) {
      meta.coHostIds = meta.coHostIds.filter((id: string) => id !== identityId)
      changed = true
    }
    if (Array.isArray(meta.providerIds) && meta.providerIds.includes(identityId)) {
      meta.providerIds = meta.providerIds.filter((id: string) => id !== identityId)
      changed = true
    }
    if (changed) {
      await redis.set(k.meta(code), JSON.stringify(meta), { KEEPTTL: true })
    }
  }

  // Wines JSON write-back if we orphaned any. Mirror the Postgres step
  // — drop the wines from the live Redis array so the live session
  // doesn't keep showing wines that no longer belong to it. The
  // orphaned Postgres rows still hold the wine bytes for /me/saved.
  if (deleteAddedWines) {
    const rawWines = await redis.get(k.wines(code))
    if (rawWines) {
      const wines = JSON.parse(rawWines) as Array<{ addedByIdentityId?: string }>
      const filtered = wines.filter(w => w.addedByIdentityId !== identityId)
      if (filtered.length !== wines.length) {
        await redis.set(k.wines(code), JSON.stringify(filtered), { KEEPTTL: true })
      }
    }
  }
}
