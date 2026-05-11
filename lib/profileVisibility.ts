// Profile visibility — central authorization for who can read profile content.
//
// Four tiers (locked semantics):
//   public-internet  — anyone, no auth required
//   public-users     — any logged-in Verre user
//   public-followers — only people who follow the profile owner (asymmetric)
//   public-mutual    — only mutual follows (both directions of `follows`)
//
// FoF (`visibility_fof`, depth 1) extends `public-followers` and `public-mutual`
// to also admit a viewer reachable as viewer→intermediary→profile (one hop).
// Has no effect on `public-internet` / `public-users` — those tiers are
// already broader than any FoF set.
//
// HoF leaderboard stays public regardless of tier (decision: deliberately
// public surface, name only, no link). Session compare views are NOT gated
// by visibility (trust model: session participation > profile tier).
// Tag display is governed by the check-in *author's* tier — being tagged
// is a presentation surface the tagged user consented to via mutual-follow.
//
// The `users.profile_visibility` column is VARCHAR(32) + a CHECK constraint
// added by hand in the migration; this `ProfileVisibility` union is the
// authoritative source of truth and `isProfileVisibility` is the
// belt-and-suspenders write-side validator.

import { prisma } from '@/lib/prisma'
import { checkRate, peekRate } from '@/lib/rateLimit'
import {
  type ProfileVisibility,
  isProfileVisibility,
} from '@/lib/profileVisibilityShared'

// Re-export client-safe primitives so server callers keep importing from
// one place. The actual definitions live in `lib/profileVisibilityShared.ts`
// — that file has no Prisma/Redis imports and is safe to pull into client
// bundles (AccountSettings).
export type { ProfileVisibility } from '@/lib/profileVisibilityShared'
export {
  isProfileVisibility,
  DEFAULT_VISIBILITY,
  TIER_LABELS,
  TIER_ORDER,
} from '@/lib/profileVisibilityShared'

export interface ProfileViewer {
  id: number | null
  followsProfile: boolean       // viewer follows the profile owner
  profileFollowsViewer: boolean // profile owner follows viewer
  isFofOfProfile?: boolean      // viewer reachable as viewer→X→profile (depth 1)
}

export interface VisibilitySettings {
  visibility: ProfileVisibility
  fofEnabled: boolean
}

// Pure predicate. Callers must short-circuit on `viewer.id === profileId`
// before calling — same-id check needs the profileId we don't have here.
// resolveProfileViewer / viewerCanSeeAuthor handle the self-check upstream.
export function canViewProfile(
  visibility: ProfileVisibility,
  viewer: ProfileViewer,
  fofEnabled = false,
): boolean {
  if (visibility === 'public-internet') return true
  if (viewer.id === null) return false
  if (visibility === 'public-users') return true
  const direct =
    visibility === 'public-followers'
      ? viewer.followsProfile
      : viewer.followsProfile && viewer.profileFollowsViewer
  if (direct) return true
  if (!fofEnabled) return false
  return viewer.isFofOfProfile === true
}

// Tri-state gate. The display name + the existence of the user are
// always public for any user that exists; everything else (avatar, XP,
// badges, check-ins, social-graph lists) is gated by the owner's tier.
//
//   - 'gone'        → the user doesn't exist; map to 404.
//   - 'shell'       → user exists but the viewer can't see content. Render
//                     a shell page (display name + dummy avatar + follow
//                     button); content endpoints return 404.
//   - 'ok'          → viewer can see everything; render full payload.
//
// Self always resolves to 'ok' regardless of tier — a user must be able
// to see their own profile.
export type ProfileGateResult =
  | { status: 'ok'; viewer: ProfileViewer }
  | { status: 'shell'; name: string }
  | { status: 'gone' }

export async function resolveProfileViewer(
  profileId: number,
  viewerId: number | null,
): Promise<ProfileGateResult> {
  // Self always passes — the row exists by construction (we have a session
  // cookie), and self-view bypasses every tier. One findUnique to grab
  // the name in case the caller renders a shell anyway, and to verify
  // the user wasn't deleted out from under their own session.
  const row = await prisma.user.findUnique({
    where: { id: profileId },
    select: { name: true, profileVisibility: true, visibilityFof: true },
  })
  if (!row) return { status: 'gone' }
  if (viewerId !== null && viewerId === profileId) {
    return {
      status: 'ok',
      viewer: { id: viewerId, followsProfile: false, profileFollowsViewer: false },
    }
  }
  if (!isProfileVisibility(row.profileVisibility)) {
    // CHECK constraint should make this unreachable; if a bad value
    // ever lands, render the shell so the user is still findable but
    // their content stays gated. Log so prod surfaces the corruption.
    console.error('[profileVisibility] corrupt enum value', { profileId, value: row.profileVisibility })
    return { status: 'shell', name: row.name }
  }
  if (viewerId === null) {
    // Anonymous viewer: no follow edges to resolve. Public-internet tier
    // returns ok with stub follow flags; stricter tiers fall through to
    // the shell.
    if (row.profileVisibility === 'public-internet') {
      return {
        status: 'ok',
        viewer: { id: null, followsProfile: false, profileFollowsViewer: false },
      }
    }
    return { status: 'shell', name: row.name }
  }

  // Logged-in non-self viewer: always resolve the follow edges, even for
  // public-internet tier. Downstream callers use `viewer.followsProfile`
  // to render the FollowButton state correctly. Skipping the lookup
  // for public-internet would short-circuit `isFollowing=false` and
  // cause the button to render "+ follow" for users who already follow.
  const [followsProfile, profileFollowsViewer] = await Promise.all([
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: profileId } },
    }).then(r => !!r),
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: profileId, followingId: viewerId } },
    }).then(r => !!r),
  ])

  if (row.profileVisibility === 'public-internet') {
    return {
      status: 'ok',
      viewer: { id: viewerId, followsProfile, profileFollowsViewer },
    }
  }

  // FoF rescue: only worth a query when the direct edges don't already
  // qualify the viewer under the tier. For `public-followers` direct =
  // followsOut; for `public-mutual` direct = followsOut && followsIn.
  let isFofOfProfile: boolean | undefined
  const directQualifies = row.profileVisibility === 'public-followers'
    ? followsProfile
    : followsProfile && profileFollowsViewer
  if (row.visibilityFof && !directQualifies) {
    isFofOfProfile = await viewerCanReachAuthorViaFof(viewerId, profileId)
  }

  const viewer: ProfileViewer = { id: viewerId, followsProfile, profileFollowsViewer, isFofOfProfile }
  if (!canViewProfile(row.profileVisibility, viewer, row.visibilityFof)) {
    return { status: 'shell', name: row.name }
  }
  return { status: 'ok', viewer }
}

// Single-author existence check for FoF (depth 1): does any X exist where
// viewer→X→author? One indexed query, used by the per-row gate path. Feed
// uses the bulk variant `viewerFofAuthorSet`.
async function viewerCanReachAuthorViaFof(viewerId: number, authorId: number): Promise<boolean> {
  if (viewerId === authorId) return true
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM follows f1
      JOIN follows f2 ON f2.follower_id = f1.following_id
      WHERE f1.follower_id = ${viewerId} AND f2.following_id = ${authorId}
    ) AS exists
  `
  return rows[0]?.exists ?? false
}

export async function loadVisibility(userId: number): Promise<VisibilitySettings | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { profileVisibility: true, visibilityFof: true },
  })
  if (!row) return null
  if (!isProfileVisibility(row.profileVisibility)) {
    console.error('[profileVisibility] corrupt enum value', { userId, value: row.profileVisibility })
    return null
  }
  return { visibility: row.profileVisibility, fofEnabled: row.visibilityFof }
}

export async function batchLoadVisibilities(
  userIds: number[],
): Promise<Map<number, VisibilitySettings>> {
  if (userIds.length === 0) return new Map()
  const rows = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, profileVisibility: true, visibilityFof: true },
  })
  const out = new Map<number, VisibilitySettings>()
  for (const r of rows) {
    if (isProfileVisibility(r.profileVisibility)) {
      out.set(r.id, { visibility: r.profileVisibility, fofEnabled: r.visibilityFof })
    } else {
      console.error('[profileVisibility] corrupt enum value', { userId: r.id, value: r.profileVisibility })
    }
  }
  return out
}

// Resolve the viewer's relationship to a batch of profile owners, in a
// constant number of queries regardless of batch size. Used by feed.
export async function resolveProfileViewerBulk(
  profileIds: number[],
  viewerId: number | null,
): Promise<Map<number, ProfileViewer>> {
  const out = new Map<number, ProfileViewer>()
  if (viewerId === null) {
    for (const id of profileIds) {
      out.set(id, { id: null, followsProfile: false, profileFollowsViewer: false })
    }
    return out
  }
  const [followsOut, followsIn] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: profileIds } },
      select: { followingId: true },
    }),
    prisma.follow.findMany({
      where: { followingId: viewerId, followerId: { in: profileIds } },
      select: { followerId: true },
    }),
  ])
  const followsOutSet = new Set(followsOut.map(r => r.followingId))
  const followsInSet = new Set(followsIn.map(r => r.followerId))
  for (const id of profileIds) {
    out.set(id, {
      id: viewerId,
      followsProfile: followsOutSet.has(id),
      profileFollowsViewer: followsInSet.has(id),
    })
  }
  return out
}

// Resolve which authors in `authorIds` are reachable from `viewerId` as
// viewer→X→author (depth 1). Single SQL roundtrip; used by the feed when
// any author has fof enabled and the viewer doesn't already qualify by
// direct follow.
//
// Bounded at FOF_AUTHOR_CAP authorIds: the JOIN can fan out to
// (viewer.outdegree × intermediaries.outdegree) and a viewer following
// thousands could otherwise trigger a multi-second query. Callers should
// already be passing at most a page-size of candidates; this is the
// inner DoS-amplifier guard.
const FOF_AUTHOR_CAP = 200
export async function viewerFofAuthorSet(
  viewerId: number,
  authorIds: number[],
): Promise<Set<number>> {
  if (authorIds.length === 0) return new Set()
  const capped = authorIds.length > FOF_AUTHOR_CAP ? authorIds.slice(0, FOF_AUTHOR_CAP) : authorIds
  const rows = await prisma.$queryRaw<{ following_id: number }[]>`
    SELECT DISTINCT f2.following_id
    FROM follows f1
    JOIN follows f2 ON f2.follower_id = f1.following_id
    WHERE f1.follower_id = ${viewerId}
      AND f2.following_id = ANY(${capped}::int[])
  `
  return new Set(rows.map(r => r.following_id))
}

// Per-pair gate used by non-feed call sites (single check-in detail, like
// endpoint, etc.). Self always passes; otherwise resolves the relationship
// and applies the tier check. Returns true when viewer can see author's
// content.
//
// NOT SAFE in a loop — issues 1-3 sequential queries per call. For batch
// gating (feed pages, search results), use resolveProfileViewerBulk +
// viewerFofAuthorSet + canViewProfile in the caller.
export async function viewerCanSeeAuthor(
  viewerId: number | null,
  authorId: number,
): Promise<boolean> {
  if (viewerId !== null && viewerId === authorId) return true
  const settings = await loadVisibility(authorId)
  if (!settings) return false
  if (settings.visibility === 'public-internet') return true
  if (viewerId === null) return false
  if (settings.visibility === 'public-users') return true
  const [followsOut, followsIn] = await Promise.all([
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: authorId } },
    }).then(r => !!r),
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: authorId, followingId: viewerId } },
    }).then(r => !!r),
  ])
  let isFof: boolean | undefined
  const direct =
    settings.visibility === 'public-followers'
      ? followsOut
      : followsOut && followsIn
  if (!direct && settings.fofEnabled) {
    isFof = await viewerCanReachAuthorViaFof(viewerId, authorId)
  }
  return canViewProfile(
    settings.visibility,
    { id: viewerId, followsProfile: followsOut, profileFollowsViewer: followsIn, isFofOfProfile: isFof },
    settings.fofEnabled,
  )
}

// Update a user's visibility settings. Validates the union, enforces a
// rate limit (30/hour/user — defends against a stolen cookie thrashing
// the audit log), writes the user row + audit log atomically.
//
// peekRate is used for the precheck so a no-op submit (same value) doesn't
// burn the limiter slot; only an actual change increments the counter.
// Without that, tapping the same tier twice would consume two of 30 for
// nothing.
//
// Race window: two concurrent requests can both peek-pass then both
// commit-and-increment, briefly overshooting the 30/hour ceiling by a
// handful. Acceptable since the route-level 60/min/user limiter in
// `/api/me/visibility` is the real burst gate; this counter only caps
// audit-log growth.
export type SetVisibilityResult =
  | { ok: true }
  | { ok: false; reason: 'rate-limited'; retryAfter: number }
  | { ok: false; reason: 'invalid-tier' }
  | { ok: false; reason: 'not-found' }

export async function setProfileVisibility(
  userId: number,
  newTier: string,
  newFof: boolean,
): Promise<SetVisibilityResult> {
  if (!isProfileVisibility(newTier)) return { ok: false, reason: 'invalid-tier' }
  const peek = await peekRate(`rl:visibility:u:${userId}:1h`, 30)
  if (!peek.allowed) return { ok: false, reason: 'rate-limited', retryAfter: peek.retryAfter }

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { profileVisibility: true, visibilityFof: true },
    })
    if (!current) return 'not-found' as const
    if (current.profileVisibility === newTier && current.visibilityFof === newFof) {
      return 'noop' as const
    }
    await tx.user.update({
      where: { id: userId },
      data: { profileVisibility: newTier, visibilityFof: newFof },
    })
    await tx.profileVisibilityLog.create({
      data: {
        userId,
        fromTier: current.profileVisibility,
        toTier: newTier,
        fromFof: current.visibilityFof,
        toFof: newFof,
      },
    })
    return 'ok' as const
  })

  if (result === 'not-found') return { ok: false, reason: 'not-found' }
  if (result === 'ok') {
    // Only an actual change increments the counter. The peek above already
    // bounded reads; this caps writes at 30/hour.
    await checkRate(`rl:visibility:u:${userId}:1h`, 30, 3600)
  }
  return { ok: true }
}
