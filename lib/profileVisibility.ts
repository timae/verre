// Profile visibility — central authorization for who can read profile content.
//
// Today every profile is `public-internet`. The 4-tier setting (`public-internet`
// / `public-users` / `public-followers` / `public-mutual`) is planned; when the
// `users.profile_visibility` column ships, callers pass the actual value here
// and the existing call sites stop letting unauthorized viewers through. See
// project_future_work.md "Privacy-focused branch" for the rollout plan.

import { prisma } from '@/lib/prisma'

export type ProfileVisibility =
  | 'public-internet'
  | 'public-users'
  | 'public-followers'
  | 'public-mutual'

export interface ProfileViewer {
  id: number | null
  followsProfile: boolean
  profileFollowsViewer: boolean
}

export function canViewProfile(visibility: ProfileVisibility, viewer: ProfileViewer): boolean {
  if (visibility === 'public-internet') return true
  if (viewer.id === null) return false
  if (visibility === 'public-users') return true
  if (visibility === 'public-followers') return viewer.followsProfile
  if (visibility === 'public-mutual') return viewer.followsProfile && viewer.profileFollowsViewer
  return false
}

export const DEFAULT_VISIBILITY: ProfileVisibility = 'public-internet'

// Resolves the viewer's relationship to a profile and applies the visibility
// gate. Returns 'ok' with the resolved viewer, 'gone' when the profile
// shouldn't be observable (404 — covers both "no such user" and "exists but
// gated under a non-public-internet tier"; the indistinguishability prevents
// existence enumeration when the future per-user tier ships), or 'gated'
// for the special case where visibility is `public-internet` but a future
// caller's pre-check (eg. a feed scope) already excluded the viewer.
//
// Today every profile uses DEFAULT_VISIBILITY=public-internet so the only
// way to land 'gone' is a real missing user; when the column ships, a
// stricter tier with an unauthorized viewer also resolves 'gone'.
export type ProfileGateResult =
  | { status: 'ok'; viewer: ProfileViewer }
  | { status: 'gone' }

export async function resolveProfileViewer(
  profileId: number,
  viewerId: number | null,
  visibility: ProfileVisibility = DEFAULT_VISIBILITY,
): Promise<ProfileGateResult> {
  const profile = await prisma.user.findUnique({ where: { id: profileId }, select: { id: true } })
  if (!profile) return { status: 'gone' }

  const [followsProfile, profileFollowsViewer] = viewerId
    ? await Promise.all([
        prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: profileId } } }).then(r => !!r),
        prisma.follow.findUnique({ where: { followerId_followingId: { followerId: profileId, followingId: viewerId } } }).then(r => !!r),
      ])
    : [false, false]

  const viewer: ProfileViewer = { id: viewerId, followsProfile, profileFollowsViewer }
  if (!canViewProfile(visibility, viewer)) return { status: 'gone' }
  return { status: 'ok', viewer }
}
