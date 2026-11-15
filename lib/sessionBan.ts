import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { viewableAvatars } from '@/lib/avatarGate'
import { wireIdentityMap, userIdOfIdentity } from '@/lib/publicIds'

// Bans: `s:<C>:bans` (Set of identity-ids) is the cache; for a Postgres-backed
// session the record is `session_bans` (redis-rehydration § 4.2) and decides for
// `u:` identities (§ 4.7). Anon bans are best-effort: a banned anon can clear
// localStorage and rejoin as a fresh `a:<uuid>`. Documented in docs/kick-ban.md.

// 🔒 Wire shapes (public-user-ids § 4 + § 8a b): `identityId` is the WIRE
// identity, and a `u:` ban whose users row is gone leaves the list (it can
// never match anyone again: integers are never reused). The photo shows only
// when the CALLER could see it anyway (lib/avatarGate.ts): a ban accepts any
// identity, even someone never in the moment, so returning `users.image_url`
// straight would read anyone's photo whatever their visibility. The viewer is
// the caller (host OR cohost: both read this list), never meta.hostUserId;
// an anonymous caller gets the logged-out rule. The name stays (any profile
// link shows it).
export async function listBans(code: string, viewerUserId: number | null): Promise<
  { identityId: string; displayName: string; imageUrl: string | null }[]
> {
  const ids = await redis.sMembers(k.bans(code))
  if (ids.length === 0) return []
  // Best-effort display-name resolution: logged-in identities hit Postgres
  // for current name; anon identities fall back to whatever was last in the
  // identities hash before the ban (Redis hash entries get removed during the
  // wipe, so this may be empty — return the id stub).
  const userIds: number[] = []
  for (const id of ids) { const n = userIdOfIdentity(id); if (n != null) userIds.push(n) }
  const [users, avatars, wire] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: number; name: string }[]),
    viewableAvatars(userIds, viewerUserId),
    wireIdentityMap(ids),
  ])
  const userById = new Map(users.map(u => [u.id, u]))
  const identities = await redis.hGetAll(k.identities(code))
  const out: { identityId: string; displayName: string; imageUrl: string | null }[] = []
  for (const id of ids) {
    const wid = wire.get(id)
    if (!wid) continue
    const uid = userIdOfIdentity(id)
    if (uid != null) {
      const u = userById.get(uid)
      if (!u) continue
      out.push({ identityId: wid, displayName: u.name, imageUrl: avatars.get(uid) ?? null })
      continue
    }
    out.push({ identityId: wid, displayName: identities[id] ?? id, imageUrl: null })
  }
  return out
}

// The per-session lock that used to live here (`s:{C}:lock:ban`) is replaced by
// the fenced lock:session:{CODE} (lib/sessionLock.ts) taken through the mutation
// contract (lib/sessionMutation.ts) — redis-rehydration § 5.4.
