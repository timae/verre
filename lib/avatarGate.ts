import { prisma } from '@/lib/prisma'
import { blockPairIds } from '@/lib/userBlock'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'

// The in-moment avatar rule, shared by the participant list (buildMetaView)
// and the bans list (public-user-ids § 8a b): a photo shows only when the
// VIEWER could see that profile anyway. We deliberately DO NOT extend the
// "session participation > profile tier" exception that applies to display
// names + ratings: avatars are stronger identity than a session-chosen
// display name, and a user's tier choice should hold here. Self always sees
// their own; a block pair (either direction) drops it; otherwise the profile
// tier decides, with the same batch composition as /api/feed. A null viewer
// (anonymous) sees `public-internet` photos only. When the gate denies, the
// photo is absent and the client falls back to initials.
export async function viewableAvatars(
  profileIds: readonly number[],
  viewerUserId: number | null,
  blockPairs?: { blockedByMe: Set<number>; blockingMe: Set<number> } | null,
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = [...new Set(profileIds)]
  if (ids.length === 0) return out
  const pairs = blockPairs !== undefined ? blockPairs : viewerUserId !== null ? await blockPairIds(viewerUserId) : null
  const [visMap, viewerMap, users] = await Promise.all([
    batchLoadVisibilities(ids),
    resolveProfileViewerBulk(ids, viewerUserId),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, imageUrl: true } }),
  ])
  const fofSet = viewerUserId !== null
    ? await viewerFofAuthorSet(viewerUserId, ids, visMap, viewerMap)
    : new Set<number>()
  const urlById = new Map<number, string>()
  for (const u of users) if (u.imageUrl) urlById.set(u.id, u.imageUrl)
  for (const profileId of ids) {
    const url = urlById.get(profileId)
    if (!url) continue
    if (viewerUserId !== null && profileId === viewerUserId) { out.set(profileId, url); continue }
    if (pairs && (pairs.blockedByMe.has(profileId) || pairs.blockingMe.has(profileId))) continue
    const settings = visMap.get(profileId)
    if (!settings) continue
    const base = viewerMap.get(profileId) ?? { id: viewerUserId, followsProfile: false, profileFollowsViewer: false }
    const viewer = {
      id: base.id ?? viewerUserId,
      followsProfile: base.followsProfile,
      profileFollowsViewer: base.profileFollowsViewer,
      isFofOfProfile: settings.fofEnabled ? fofSet.has(profileId) : undefined,
    }
    if (canViewProfile(settings.visibility, viewer, settings.fofEnabled)) out.set(profileId, url)
  }
  return out
}
