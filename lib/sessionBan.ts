import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'

// Bans: `s:<C>:bans` (Set of identity-ids) is the cache; for a Postgres-backed
// session the record is `session_bans` (redis-rehydration § 4.2) and decides for
// `u:` identities (§ 4.7). Anon bans are best-effort: a banned anon can clear
// localStorage and rejoin as a fresh `a:<uuid>`. Documented in docs/kick-ban.md.

export async function listBans(code: string): Promise<
  { identityId: string; displayName: string; imageUrl: string | null }[]
> {
  const ids = await redis.sMembers(k.bans(code))
  if (ids.length === 0) return []
  // Best-effort display-name resolution: logged-in identities hit Postgres
  // for current name + avatar; anon identities fall back to whatever was
  // last in the identities hash before the ban (Redis hash entries get
  // removed during the wipe, so this may be empty — return the id stub).
  const userIds: number[] = []
  for (const id of ids) if (id.startsWith('u:')) userIds.push(Number(id.slice(2)))
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, imageUrl: true },
      })
    : []
  const userById = new Map(users.map(u => [u.id, u]))
  const identities = await redis.hGetAll(k.identities(code))
  return ids.map(id => {
    if (id.startsWith('u:')) {
      const u = userById.get(Number(id.slice(2)))
      return {
        identityId: id,
        displayName: u?.name ?? '[unknown]',
        imageUrl: u?.imageUrl ?? null,
      }
    }
    return {
      identityId: id,
      displayName: identities[id] ?? id,
      imageUrl: null,
    }
  })
}

// The per-session lock that used to live here (`s:{C}:lock:ban`) is replaced by
// the fenced lock:session:{CODE} (lib/sessionLock.ts) taken through the mutation
// contract (lib/sessionMutation.ts) — redis-rehydration § 5.4.
