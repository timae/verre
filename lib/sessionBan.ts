import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'

// Bans live in Redis only (`s:<C>:bans`, Set of identity-ids). TTL matches
// the session lifespan — when the session expires, the ban list dies with
// it. Anon bans are best-effort: a banned anon can clear localStorage and
// rejoin as a fresh `a:<uuid>`. Documented in docs/kick-ban.md.

export async function addBan(code: string, identityId: string): Promise<void> {
  await redis.sAdd(k.bans(code), identityId)
}

export async function removeBan(code: string, identityId: string): Promise<void> {
  await redis.sRem(k.bans(code), identityId)
}

export async function isBanned(code: string, identityId: string): Promise<boolean> {
  return (await redis.sIsMember(k.bans(code), identityId)) === true
}

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

// Acquire the per-session meta-mutation lock. Returns true on success.
// Short TTL so a crashed handler doesn't block forever. Callers should
// SET NX + EX, then release on success/failure.
//
// Originally introduced for kick/ban to serialize the wines JSON write-back
// (hence the `lock:ban` key name kept for continuity), it now also guards
// the `set-role` read-modify-write on `s:<C>:meta` in
// `app/api/session/[code]/route.ts`. Two concurrent strict-host actions
// without the lock could each read the same starting meta, build divergent
// coHostIds/providerIds sets, and silently drop one of the writes.
const BAN_LOCK_TTL_SECONDS = 10

export async function acquireBanLock(code: string): Promise<boolean> {
  const res = await redis.set(k.banLock(code), '1', {
    NX: true,
    EX: BAN_LOCK_TTL_SECONDS,
  })
  return res === 'OK'
}

export async function releaseBanLock(code: string): Promise<void> {
  await redis.del(k.banLock(code))
}
