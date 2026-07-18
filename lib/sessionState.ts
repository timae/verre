import { redis, k, scanKeys } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import type { Session } from 'next-auth'
import type { Identity } from '@/lib/identity'
import {
  type SessionMeta,
  type WireWine,
  isHostByIdentity,
  getWines,
  wineToWire,
  buildKickedUserNameLookup,
} from '@/lib/session'
import { redactWine } from '@/lib/wineRedaction'
import { blockPairIds } from '@/lib/userBlock'
import {
  batchLoadVisibilities,
  resolveProfileViewerBulk,
  viewerFofAuthorSet,
  canViewProfile,
} from '@/lib/profileVisibility'

// The per-viewer session view builders. Extracted from the three session GET
// route bodies (meta / wines / ratings) so the aggregate /state endpoint can
// COMPOSE them instead of re-deriving the security-sensitive transforms
// (block-pair resolution, avatar tier gate, blind/hideLineup redaction).
// The standalone routes call the same builders — one implementation, four
// call sites. See docs/dev/proposals/mobile-app/02-realtime.md §2.
//
// Builders assume the caller already ran the route preamble: code normalized,
// session existence checked (404), participantOrBanned resolved (removed /
// invalid handling). `identities` is the session's identities map, fetched
// once by the caller (`redis.hGetAll(k.identities(c))`) and shared across
// builders.
//
// Every response built from these is viewer-dependent — callers MUST set
// `Cache-Control: private, no-store`.

export type SessionParticipant = { id: string; displayName: string; imageUrl: string | null }

export type SessionMetaView = SessionMeta & {
  code: string
  participants: SessionParticipant[]
  ttlSeconds: number
  viewerBlocksOut: string[]
  viewerBlocksIn: string[]
  banCount: number
}

export type RatingsView = Record<string, { displayName: string; ratings: Record<string, unknown> }>

// Numeric user id of the logged-in viewer, or null for anon. Derived from the
// resolved auth session (NOT from a request body / URL param — see the trust
// model in root CLAUDE.md).
export function viewerUserIdFrom(session: Session | null): number | null {
  if (!session?.user) return null
  const n = Number(session.user.id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function buildMetaView(
  c: string,
  meta: SessionMeta,
  caller: Identity,
  viewerUserId: number | null,
  identities: Record<string, string>,
): Promise<SessionMetaView> {
  // Participants come from the identities map (id-keyed, the authoritative
  // source). Logged-in participants' numeric userIds drive both block
  // resolution (below) and the brought-by-avatar gate.
  const participantUserIds: number[] = []
  for (const id of Object.keys(identities)) {
    if (id.startsWith('u:')) {
      const n = Number(id.slice(2))
      if (Number.isInteger(n) && n > 0) participantUserIds.push(n)
    }
  }
  const ttlSeconds = await redis.ttl(k.meta(c))

  // Ban count: only sent to host/cohost callers (others have no UI for it).
  // Drives the conditional render of the BannedUsersSection on the client —
  // polled via the 5s session refetch, so cross-host ban events propagate
  // without a dedicated socket.
  const isHost = isHostByIdentity(meta, caller)
  const banCount = isHost ? await redis.sCard(k.bans(c)) : 0

  // Viewer's block-pair set, scoped to identity-ids of participants in this
  // session. Sent to the client so the participants list and Compare screen
  // can apply the block render rules. Only logged-in viewers have a
  // block-pair set — anon viewers never appear in user_blocks.
  //
  // SECURITY: these arrays carry the viewer's block-pair list (scoped to
  // this session). They MUST NOT be logged, mirrored to analytics, or stored
  // in any shared cache. Callers force `private, no-store` for this reason.
  const blockPairs = viewerUserId !== null ? await blockPairIds(viewerUserId) : null

  const viewerBlocksOut: string[] = []
  const viewerBlocksIn: string[] = []
  if (blockPairs) {
    // Translate user-ids to identity-ids; only logged-in participants
    // (u:<id>) participate in blocks. Filter to participants actually in
    // this session so the client's render filter doesn't have to.
    const participantUserIdSet = new Set(participantUserIds)
    for (const uid of blockPairs.blockedByMe) {
      if (participantUserIdSet.has(uid)) viewerBlocksOut.push(`u:${uid}`)
    }
    for (const uid of blockPairs.blockingMe) {
      if (participantUserIdSet.has(uid)) viewerBlocksIn.push(`u:${uid}`)
    }
  }

  // Brought-by avatar imageUrl resolution. We deliberately DO NOT extend the
  // "session participation > profile tier" exception that already applies to
  // display names + ratings: avatars are stronger identity than a
  // session-chosen display name, and a user's tier choice should hold here.
  // Block beats tier (handled first via blockPairs); tier gates via the same
  // batch composition used by /api/feed. Anon viewer (viewerUserId === null)
  // only sees `public-internet` avatars. Self always sees their own. When
  // the gate denies, imageUrl stays null and the client falls back to the
  // initial letter.
  const imageUrlByUserId = new Map<number, string>()
  if (participantUserIds.length > 0) {
    const [visMap, viewerMap, users] = await Promise.all([
      batchLoadVisibilities(participantUserIds),
      resolveProfileViewerBulk(participantUserIds, viewerUserId),
      prisma.user.findMany({
        where: { id: { in: participantUserIds } },
        select: { id: true, imageUrl: true },
      }),
    ])
    const fofCandidates = participantUserIds.filter(id => visMap.get(id)?.fofEnabled === true)
    const fofSet = fofCandidates.length > 0 && viewerUserId !== null
      ? await viewerFofAuthorSet(viewerUserId, fofCandidates)
      : new Set<number>()
    const urlById = new Map<number, string>()
    for (const u of users) {
      if (u.imageUrl) urlById.set(u.id, u.imageUrl)
    }
    for (const profileId of participantUserIds) {
      const url = urlById.get(profileId)
      if (!url) continue
      // Self: always visible.
      if (viewerUserId !== null && profileId === viewerUserId) {
        imageUrlByUserId.set(profileId, url)
        continue
      }
      // Block beats tier — block-pair (either direction) drops the avatar.
      if (blockPairs && (blockPairs.blockedByMe.has(profileId) || blockPairs.blockingMe.has(profileId))) continue
      const settings = visMap.get(profileId)
      if (!settings) continue
      const base = viewerMap.get(profileId) ?? { id: viewerUserId, followsProfile: false, profileFollowsViewer: false }
      const viewer = {
        id: base.id ?? viewerUserId,
        followsProfile: base.followsProfile,
        profileFollowsViewer: base.profileFollowsViewer,
        isFofOfProfile: settings.fofEnabled ? fofSet.has(profileId) : undefined,
      }
      if (canViewProfile(settings.visibility, viewer, settings.fofEnabled)) {
        imageUrlByUserId.set(profileId, url)
      }
    }
  }

  const participants = Object.entries(identities).map(([id, displayName]) => {
    let imageUrl: string | null = null
    if (id.startsWith('u:')) {
      const n = Number(id.slice(2))
      if (Number.isInteger(n)) {
        const url = imageUrlByUserId.get(n)
        if (url) imageUrl = url
      }
    }
    return { id, displayName, imageUrl }
  })

  return {
    ...meta,
    code: c,
    participants,
    ttlSeconds,
    viewerBlocksOut,
    viewerBlocksIn,
    banCount,
  }
}

export async function buildWinesView(
  c: string,
  meta: SessionMeta,
  identity: Identity,
  identities: Record<string, string>,
): Promise<WireWine[]> {
  const wines = await getWines(c)
  const isUserHost = isHostByIdentity(meta, identity)

  // Lineup hidden until X minutes before start
  if (meta.hideLineup && meta.dateFrom && !isUserHost) {
    const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60 * 1000
    if (Date.now() < revealAt) return []
  }

  // Hybrid resolution for `addedByDisplayName`: live identities map →
  // users.name fallback for kicked logged-in adders → snapshot on the wine
  // itself → null.
  const userNameLookup = await buildKickedUserNameLookup(wines, identities)

  // Enter the redaction branch when:
  //   - session is blind AND the caller isn't host (the default rule), OR
  //   - session is blind AND meta.blindForEveryone is on (then redact even
  //     hosts — the helper itself decides per-wine whether to short-circuit
  //     on `revealed`).
  if (meta.blind && (!isUserHost || meta.blindForEveryone)) {
    // Per-wine redaction: see lib/wineRedaction.ts for the full rule.
    // Pre-feature wines have NULL `addedByIdentityId` and never match the
    // provider exception — they redact like any other wine the caller
    // didn't add.
    return wines.map((w, i) => {
      const redacted = redactWine(w, {
        revealed: !!w.revealedAt,
        isHost: isUserHost,
        ownsWine: !!w.addedByIdentityId && w.addedByIdentityId === identity.id,
        index: i,
        blindForEveryone: !!meta.blindForEveryone,
      })
      return redacted ?? wineToWire(w, identity.id, identities, userNameLookup)
    })
  }

  return wines.map(w => wineToWire(w, identity.id, identities, userNameLookup))
}

// Ratings for this session, id-keyed:
//   { "u:42": { displayName: "Sam 🍅", ratings: { "<wineId>": {...} } }, ... }
//
// Block filter is COSMETIC (client-side only) for ratings. The locked design
// treats in-session participation like participant-list rendering: the data
// is shared session-context, the block filter is render-style. The raw wire
// payload still contains block-pair raters (visible in DevTools) — Verre's
// block primitive is a UI filter, not a secrecy mechanism inside a shared
// tasting.
//
// Live ratings come straight from Redis as already-numeric JSON — the
// Decimal→string coercion trap lives on the Postgres-backed read paths only.
export async function buildRatingsView(
  c: string,
  identities: Record<string, string>,
): Promise<RatingsView> {
  const prefix = `s:${c}:r:`
  const keys = await scanKeys(`${prefix}*`)
  const result: RatingsView = {}
  if (keys.length === 0) return result
  const values = await redis.mGet(keys)

  // Each rating key is `s:{C}:r:{identityId}:{wineId}` where identityId is
  // either `u:<n>` (one colon) or `a:<uuid>` (one colon). Strip the known
  // prefix, then split off the trailing `:<wineId>` from the right so the
  // identity id retains its embedded colon.
  keys.forEach((key, i) => {
    const val = values[i]
    if (!val) return
    const rest = key.slice(prefix.length)               // "<identityId>:<wineId>"
    const lastColon = rest.lastIndexOf(':')
    if (lastColon === -1) return                         // malformed — skip
    const identityId = rest.slice(0, lastColon)
    const wineId = rest.slice(lastColon + 1)
    // Roster guard (Simon's ruling, 2026-07-18): kick-keep preserves a user's
    // rating keys but removes their identities entry — those ratings must not
    // render in compare or count into its math (averages, charts, aroma
    // consensus: every surface derives from this view). Rejoin re-adds the
    // entry and the ratings reappear (keys are never deleted). Every
    // legitimate rater has an entry (join writes it; only kick/ban removes
    // it), so a missing entry is always "removed", never a false positive.
    if (!identities[identityId]) return
    if (!result[identityId]) {
      result[identityId] = {
        displayName: identities[identityId] || identityId,
        ratings: {},
      }
    }
    result[identityId].ratings[wineId] = JSON.parse(val)
  })

  return result
}
