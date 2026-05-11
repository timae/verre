// Per-pair soft-hide ("silence"). A mutes B → A no longer sees B's
// content in A's feed; B is unaware. Independent of follow state and
// profile visibility; doesn't gate direct profile reads, search,
// likes, tags, or in-session content.
//
// Distinct from profile_visibility: that's per-USER (B's tier governs
// who can see B); this is per-PAIR (A's choice to hide B). They
// compose multiplicatively in the feed — both filters must pass for
// content to surface.

import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'

export async function isMuted(muterId: number, mutedId: number): Promise<boolean> {
  if (muterId === mutedId) return false
  const row = await prisma.userMute.findUnique({
    where: { muterId_mutedId: { muterId, mutedId } },
    select: { muterId: true },
  })
  return row !== null
}

// Returns the set of user IDs the muter has muted. Used by feed
// filtering to subtract muted authors from the candidate set in one
// query.
export async function mutedUserIds(muterId: number): Promise<Set<number>> {
  const rows = await prisma.userMute.findMany({
    where: { muterId },
    select: { mutedId: true },
  })
  return new Set(rows.map(r => r.mutedId))
}

export type SetMuteResult =
  | { ok: true }
  | { ok: false; reason: 'rate-limited'; retryAfter: number }
  | { ok: false; reason: 'self' }

// Single sanctioned write path. Idempotent in both directions (mute
// an already-muted user → no-op; unmute a not-muted user → no-op).
// Rate-limited 60/hour/user shared across POST and DELETE so a stolen
// cookie can't thrash the table or generate noise. Self-mute rejected
// at the API + DB-CHECK level.
export async function setMute(
  muterId: number,
  mutedId: number,
  mute: boolean,
): Promise<SetMuteResult> {
  if (muterId === mutedId) return { ok: false, reason: 'self' }
  const rl = await checkRate(`rl:mute:u:${muterId}:1h`, 60, 3600)
  if (!rl.allowed) return { ok: false, reason: 'rate-limited', retryAfter: rl.retryAfter }

  if (mute) {
    // Upsert keeps it idempotent — re-muting doesn't bump createdAt
    // (update {} is a no-op).
    await prisma.userMute.upsert({
      where: { muterId_mutedId: { muterId, mutedId } },
      create: { muterId, mutedId },
      update: {},
    })
  } else {
    // deleteMany so a missing row doesn't throw — matches the
    // unfollow shape.
    await prisma.userMute.deleteMany({ where: { muterId, mutedId } })
  }
  return { ok: true }
}
