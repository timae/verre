// Per-pair block. A blocks B → bidirectional invisibility OUTSIDE shared
// sessions; render-style dormancy INSIDE shared sessions.
//
// Non-destructive: follows / mutes / likes / tags between the pair stay
// in DB. Unblock restores visibility everywhere.
//
// Composition with other primitives:
//   - Visibility tier (per-USER, B's tier): viewer-side gate. Block runs
//     BEFORE the tier — block is the strictest primitive.
//   - Mute (per-PAIR, A's intent): A's feed-only soft-hide. Survives a
//     block/unblock cycle. After unblock, B's content stays hidden by
//     the still-active mute.
//
// Separate from Kick/Ban (per-session moderation primitive, shipping
// after this branch).
//
// FUTURE: when notifications ship, the recipient set must filter
// block-pairs on every notification surface.

import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'

// Viewer blocked author. The blocker direction — viewer chose to hide
// the author. Used to decide between the "blocked-by-me" stripped
// view (clickable to unblock) and the underlying tier gate.
export async function viewerBlocksAuthor(viewerId: number, authorId: number): Promise<boolean> {
  if (viewerId === authorId) return false
  const row = await prisma.userBlock.findUnique({
    where: { blockerId_blockedId: { blockerId: viewerId, blockedId: authorId } },
    select: { blockerId: true },
  })
  return row !== null
}

// Author blocked viewer. The blocked direction — author chose to hide
// the viewer. Maps to 404 on profile reads (viewer can't tell they're
// blocked vs the user not existing).
export async function authorBlocksViewer(viewerId: number, authorId: number): Promise<boolean> {
  if (viewerId === authorId) return false
  const row = await prisma.userBlock.findUnique({
    where: { blockerId_blockedId: { blockerId: authorId, blockedId: viewerId } },
    select: { blockerId: true },
  })
  return row !== null
}

// Either direction. The fast-path primitive used by viewerCanSeeAuthor
// to short-circuit visibility resolution. The function name suggests
// order-independence — the implementation MUST OR both directions; a
// refactor that "optimises" to a single composite-PK lookup silently
// drops one direction.
export async function anyBlockBetween(a: number, b: number): Promise<boolean> {
  if (a === b) return false
  const row = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true },
  })
  return row !== null
}

// Block-pair sets for the viewer, both directions. Used by feed,
// search, profile list filters to drop pair-edges in one pass.
// `blockedByMe`: users the viewer has blocked (viewer is blocker).
// `blockingMe`: users who have blocked the viewer (viewer is blocked).
// The union is what we filter on; the split is kept so callers that
// render the "blocked-by-me" badge can distinguish.
//
// Bounded at BLOCK_PAIR_CAP per direction. Power users with thousands
// of blocks see only the most recent within the cap; the rest still
// exist in the table but don't participate in the in-memory filter.
// Acceptable trade — block-pair counts at this magnitude are abuse
// scenarios, not normal use.
const BLOCK_PAIR_CAP = 1000
export async function blockPairIds(userId: number): Promise<{ blockedByMe: Set<number>; blockingMe: Set<number> }> {
  const [out, inn] = await Promise.all([
    prisma.userBlock.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
      orderBy: { createdAt: 'desc' },
      take: BLOCK_PAIR_CAP,
    }),
    prisma.userBlock.findMany({
      where: { blockedId: userId },
      select: { blockerId: true },
      orderBy: { createdAt: 'desc' },
      take: BLOCK_PAIR_CAP,
    }),
  ])
  return {
    blockedByMe: new Set(out.map(r => r.blockedId)),
    blockingMe: new Set(inn.map(r => r.blockerId)),
  }
}

export type SetBlockResult =
  | { ok: true }
  | { ok: false; reason: 'rate-limited'; retryAfter: number }
  | { ok: false; reason: 'self' }

// Single sanctioned write path. Idempotent in both directions. POST
// is rate-limited (30/h/user); DELETE is uncapped — unblock is the
// recovery path and must never be locked out by stolen-cookie POST
// burst.
//
// Self-block rejected at API + DB-CHECK level.
export async function setBlock(
  blockerId: number,
  blockedId: number,
  block: boolean,
): Promise<SetBlockResult> {
  if (blockerId === blockedId) return { ok: false, reason: 'self' }

  if (block) {
    const rl = await checkRate(`rl:block:u:${blockerId}:1h`, 30, 3600)
    if (!rl.allowed) return { ok: false, reason: 'rate-limited', retryAfter: rl.retryAfter }
    try {
      await prisma.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      })
    } catch (err: unknown) {
      // FK violation = target user doesn't exist. Swallow and return
      // uniform success so the endpoint can't be used to enumerate the
      // user-id space ("does user N exist?"). Mirrors the follow POST
      // pattern. Any other error rethrows.
      if ((err as { code?: string }).code !== 'P2003') throw err
    }
  } else {
    // DELETE intentionally uncapped — see header comment.
    await prisma.userBlock.deleteMany({ where: { blockerId, blockedId } })
  }
  return { ok: true }
}

// List of users the calling user has blocked, newest first. Used by
// the settings UI to render the BlockedUsersList.
//
// Returns `imageUrl` unconditionally — even if the blocked user
// tightened their profile_visibility tier after being blocked, the
// blocker still sees the avatar in their own settings list. Intent:
// the blocker is being reminded who they blocked; the imageUrl was
// visible at block-time. If product later wants to tighten this
// (e.g. always show dummy avatar in settings), it's a one-line
// change here.
export async function listBlockedUsers(blockerId: number): Promise<Array<{ id: number; name: string; imageUrl: string | null; createdAt: Date }>> {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId },
    select: {
      createdAt: true,
      blocked: { select: { id: true, name: true, imageUrl: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: BLOCK_PAIR_CAP,
  })
  return rows.map(r => ({
    id: r.blocked.id,
    name: r.blocked.name,
    imageUrl: r.blocked.imageUrl,
    createdAt: r.createdAt,
  }))
}
