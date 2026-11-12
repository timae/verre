// Profile visibility — central authorization for who can read profile content.
//
// Four tiers (locked semantics):
//   public-internet  — anyone, no auth required
//   public-users     — any logged-in Verre user
//   public-followers — only people who follow the profile owner (asymmetric)
//   public-mutual    — only mutual follows (both directions of `follows`)
//
// The extended circle (`visibility_fof`, depth 1) FOLLOWS THE TIER (ruled
// 2026-11-11): `public-followers` + it = Followers of Followers (viewer→X→
// profile); `public-mutual` + it = Friends of Friends (viewer↔X↔profile, both
// links mutual). No effect on `public-internet` / `public-users`, which are
// already broader. A block either way between the person in the middle and
// either end breaks the link (ruled 2026-11-11). See
// `viewerCanReachAuthorViaFof` / `viewerFofAuthorSet`.
//
// Posts (Check-Ins Visible To, `users.checkin_visibility`): the stricter of
// the profile tier and the check-in audience wins, see `canViewPosts`. A
// choice whose audience equals the account's reads and saves as Same as
// Profile (`canonicalPostAudience`, @verre/core).
//
// Session compare views are NOT gated by visibility (trust model: session participation > profile tier).
// Tag display follows the post *author's* post gate — being tagged is a
// presentation surface the tagged user consented to via mutual-follow.
//
// The `users.profile_visibility` column is VARCHAR(32) + a CHECK constraint
// added by hand in the migration; this `ProfileVisibility` union is the
// authoritative source of truth and `isProfileVisibility` is the
// belt-and-suspenders write-side validator.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { checkRate, peekRate } from '@/lib/rateLimit'
import {
  type ProfileVisibility,
  type CheckinVisibility,
  type VisibilitySettings,
  isProfileVisibility,
  isCheckinVisibility,
  VISIBILITY_FIELDS,
} from '@/lib/profileVisibilityShared'
import { viewerBlocksAuthor, authorBlocksViewer } from '@/lib/userBlock'
import { applyVisibilityChanges, canonicalPostAudience, extendedCircleApplies, type StrictTier } from '@verre/core'

// Re-export client-safe primitives so server callers keep importing from
// one place. The actual definitions live in `lib/profileVisibilityShared.ts`
// — that file has no Prisma/Redis imports and is safe to pull into client
// bundles (AccountSettings).
export type { ProfileVisibility, CheckinVisibility, VisibilitySettings } from '@/lib/profileVisibilityShared'
export {
  isProfileVisibility,
  isCheckinVisibility,
  DEFAULT_VISIBILITY,
  TIER_LABELS,
  TIER_ORDER,
  VISIBILITY_FIELDS,
} from '@/lib/profileVisibilityShared'

export interface ProfileViewer {
  id: number | null
  followsProfile: boolean       // viewer follows the profile owner
  profileFollowsViewer: boolean // profile owner follows viewer
  isFofOfProfile?: boolean      // viewer in the profile's extended circle (depth 1, by tier)
}

// 🔒 Another user's VisibilitySettings never leave the server: the gate
// result carries them, so it is never serialized (`checkinsAudience` on the
// profile header is the one sanctioned output).
type SettingsRow = {
  profileVisibility: string
  visibilityFof: boolean
  checkinVisibility: string | null
  showCravings: boolean
  showMoments: boolean
  showLocations: boolean
}
const SETTINGS_SELECT = {
  profileVisibility: true, visibilityFof: true, checkinVisibility: true,
  showCravings: true, showMoments: true, showLocations: true,
} as const

// 🔒 Fail closed: a stored check-in audience outside the union (the CHECK
// makes it unreachable) reads as 'only-me' EVERYWHERE — the gate, the bulk
// loader, the owner's GET and the PATCH's compare against the locked row — so
// it hides the posts (an unknown string would otherwise fall into
// canViewProfile's mutual branch) and the owner can still overwrite it (the
// compare sees what the GET showed, else every save would 409).
function normalizeCheckinVisibility(raw: string | null, userId: number): CheckinVisibility | null {
  if (raw === null || isCheckinVisibility(raw)) return raw
  console.error('[profileVisibility] corrupt checkin_visibility value', { userId, value: raw })
  return 'only-me'
}

// `tierOk` false = a corrupt PROFILE tier (unreachable under the CHECK);
// callers decide (the gate shells, the bulk loader drops the author, the
// owner's GET 404s), and `settings` then reads it as the strictest tier.
// The exact collapse only (the same audience, so no gate can change): a
// stored posts choice equal to the account reads as Same as Profile in the
// gate, the bulk loader, the owner's GET and the PATCH's compare alike.
// `canonicalPostAudience` can't clamp: a read never narrows a stored row.
// `storedPosts` = the row's own choice (normalized, before the collapse).
function readSettings(row: SettingsRow, userId: number): { settings: VisibilitySettings; tierOk: boolean; storedPosts: CheckinVisibility | null } {
  const tierOk = isProfileVisibility(row.profileVisibility)
  if (!tierOk) console.error('[profileVisibility] corrupt enum value', { userId, value: row.profileVisibility })
  const storedPosts = normalizeCheckinVisibility(row.checkinVisibility, userId)
  return {
    tierOk,
    storedPosts,
    settings: canonicalPostAudience({
      visibility: tierOk ? row.profileVisibility as ProfileVisibility : 'public-mutual',
      fofEnabled: tierOk && row.visibilityFof,
      checkinVisibility: storedPosts,
      showCravings: row.showCravings,
      showMoments: row.showMoments,
      showLocations: row.showLocations,
    }),
  }
}

// Pure predicate. Callers must short-circuit on `viewer.id === profileId`
// before calling — same-id check needs the profileId we don't have here.
// resolveProfileViewer handles the self-check upstream. `isFofOfProfile`
// already means the circle of THIS tier (followers of followers, or friends
// of friends): the queries below decide it, never this predicate.
export function canViewProfile(
  visibility: ProfileVisibility,
  viewer: ProfileViewer,
  fofEnabled = false,
): boolean {
  if (visibility === 'public-internet') return true
  if (viewer.id === null) return false
  if (visibility === 'public-users') return true
  if (directlyAdmitted(visibility, viewer)) return true
  if (!fofEnabled) return false
  return viewer.isFofOfProfile === true
}

// A strict tier's own edges: a follower (Followers), a mutual follow (Friends).
// The circle lookup is skipped for a viewer this already admits.
const directlyAdmitted = (tier: StrictTier, v: Pick<ProfileViewer, 'followsProfile' | 'profileFollowsViewer'>) =>
  tier === 'public-followers' ? v.followsProfile : v.followsProfile && v.profileFollowsViewer

// The post predicate (Check-Ins Visible To): the profile gate AND the
// check-in audience. The stricter always wins: Same as Profile (null) adds
// nothing, an explicit tier must ALSO pass and never uses FoF (the `false`
// IS the no-FoF rule), Only Me admits nobody. Like canViewProfile, the
// caller short-circuits self first (and blocks before that).
export function canViewPosts(
  settings: Pick<VisibilitySettings, 'visibility' | 'fofEnabled' | 'checkinVisibility'>,
  viewer: ProfileViewer,
): boolean {
  if (!canViewProfile(settings.visibility, viewer, settings.fofEnabled)) return false
  if (settings.checkinVisibility === null) return true
  if (settings.checkinVisibility === 'only-me') return false
  return canViewProfile(settings.checkinVisibility, viewer, false)
}

// Show My Locations, applied on READ: the place line (venue, city, VENUE
// country) of a post shows unless the author hides locations and the viewer
// isn't the author. 🔒 Never the wine's origin (`wineRegion` / `wineCountry`),
// and the author's flag comes from the gate / batchLoadVisibilities, never
// from the post's `user` include. `feed_items.location_public` stays unread
// (it only means "has a place").
export type PostPlace = { venueName: string | null; city: string | null; country: string | null }
export function postPlace(post: PostPlace, authorShowsLocations: boolean, viewerIsAuthor: boolean): PostPlace {
  return authorShowsLocations || viewerIsAuthor
    ? { venueName: post.venueName, city: post.city, country: post.country }
    : { venueName: null, city: null, country: null }
}

// What the viewer of an `ok` profile may see beyond the profile itself.
// Self: everything. Cravings / Moments are the owner's Show switches (the
// tile, and later the list); posts are canViewPosts.
export type ProfileSees = { posts: boolean; cravings: boolean; moments: boolean }

// Tri-state gate. The display name + the existence of the user are
// always public for any user that exists; everything else (avatar, XP,
// badges, check-ins, social-graph lists) is gated by the owner's tier.
//
//   - 'gone'        → the user doesn't exist; map to 404.
//   - 'shell'       → user exists but the viewer can't see content. Render
//                     a shell page (display name + dummy avatar + follow
//                     button); content endpoints return 404.
//   - 'ok'          → viewer can see the profile; render full payload.
//                     `sees` says whether the posts / Cravings / Moments
//                     come with it.
//
// Self always resolves to 'ok' regardless of tier — a user must be able
// to see their own profile.
//
// `ok` also carries the owner's `settings` (🔒 never serialized, see
// VisibilitySettings) and `sees`. The profile loaders take this `ok` result
// as a REQUIRED parameter, so a caller can't load posts without the gate.
export type ProfileGateOk = { status: 'ok'; viewer: ProfileViewer; settings: VisibilitySettings; sees: ProfileSees }
export type ProfileGateResult =
  | ProfileGateOk
  | { status: 'shell'; name: string }
  | { status: 'blocked-by-me'; name: string }
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
    select: { name: true, ...SETTINGS_SELECT },
  })
  if (!row) return { status: 'gone' }
  // Every `ok` below is built here. A corrupt profile tier never reaches a
  // non-self `ok` (it shells first); for self it reads as the strictest tier.
  const { settings, tierOk } = readSettings(row, profileId)
  const ok = (viewer: ProfileViewer, self = false): ProfileGateOk => ({
    status: 'ok',
    viewer,
    settings,
    sees: self
      ? { posts: true, cravings: true, moments: true }
      : { posts: canViewPosts(settings, viewer), cravings: settings.showCravings, moments: settings.showMoments },
  })
  if (viewerId !== null && viewerId === profileId) {
    return ok({ id: viewerId, followsProfile: false, profileFollowsViewer: false }, true)
  }
  // Block check runs BEFORE the visibility tier. Block is the strictest
  // primitive — outside-session invisibility supersedes the tier.
  //   - authorBlocksViewer → viewer is the blocked side → collapse to
  //     'gone' (404). They can't tell they're blocked vs the user not
  //     existing.
  //   - viewerBlocksAuthor → viewer is the blocker → 'blocked-by-me'
  //     so the caller can render the stripped "Blocked" view with an
  //     unblock affordance.
  if (viewerId !== null) {
    if (await authorBlocksViewer(viewerId, profileId)) return { status: 'gone' }
    if (await viewerBlocksAuthor(viewerId, profileId)) return { status: 'blocked-by-me', name: row.name }
  }
  if (!tierOk) {
    // CHECK constraint should make this unreachable; if a bad value
    // ever lands, render the shell so the user is still findable but
    // their content stays gated (readSettings logged it).
    return { status: 'shell', name: row.name }
  }
  if (viewerId === null) {
    // Anonymous viewer: no follow edges to resolve. Public-internet tier
    // returns ok with stub follow flags; stricter tiers fall through to
    // the shell.
    if (settings.visibility === 'public-internet') {
      return ok({ id: null, followsProfile: false, profileFollowsViewer: false })
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

  // An explicit check-in tier never uses FoF and needs only the two edges
  // above, so `sees.posts` costs no extra query.
  if (settings.visibility === 'public-internet') {
    return ok({ id: viewerId, followsProfile, profileFollowsViewer })
  }

  // The circle rescue: only worth a query on a strict tier (a stored switch
  // rides along hidden under `public-users`, which admits every viewer here)
  // when the viewer's own edges don't already admit them.
  let isFofOfProfile: boolean | undefined
  const tier = settings.visibility
  if (extendedCircleApplies(tier) && settings.fofEnabled && !directlyAdmitted(tier, { followsProfile, profileFollowsViewer })) {
    isFofOfProfile = await viewerCanReachAuthorViaFof(viewerId, profileId, tier)
  }

  const viewer: ProfileViewer = { id: viewerId, followsProfile, profileFollowsViewer, isFofOfProfile }
  if (!canViewProfile(settings.visibility, viewer, settings.fofEnabled)) {
    return { status: 'shell', name: row.name }
  }
  return ok(viewer)
}

// Per-pair POST gate for one post's author (like POST, "had a sip"): the
// profile gate (blocks first, either direction) + Check-Ins Visible To.
// Up to 5 sequential queries: NOT for loops — batch callers use
// batchLoadVisibilities + resolveProfileViewerBulk + viewerFofAuthorSet +
// canViewPosts. A caller that needs the gate's status (like DELETE's 'gone'
// rule) calls resolveProfileViewer itself.
export async function viewerCanSeePosts(viewerId: number | null, authorId: number): Promise<boolean> {
  const gate = await resolveProfileViewer(authorId, viewerId)
  return gate.status === 'ok' && gate.sees.posts
}

// 🔒 The person in the middle (`x`) links nobody while a block stands either
// way between them and the viewer or the owner (block = bilateral
// invisibility, docs/dev/block.md; the follow rows survive a block). The
// viewer ↔ owner pair itself is the callers' block check.
const bridgeUnblocked = (x: 'a1.following_id' | 'f1.following_id', viewer: Prisma.Sql, owner: Prisma.Sql) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM user_blocks ub
  WHERE (ub.blocker_id = ${Prisma.raw(x)} AND ub.blocked_id IN (${viewer}, ${owner}))
     OR (ub.blocked_id = ${Prisma.raw(x)} AND ub.blocker_id IN (${viewer}, ${owner})))`

// Single-author extended-circle check (depth 1), by the author's tier:
//   public-followers → Followers of Followers: some X with viewer→X→author;
//   public-mutual    → Friends of Friends: some X with viewer↔X AND X↔author;
// X never blocked either way with either end. Every join a PK lookup. Used
// by the per-row gate path; feed / search / session avatars use the bulk
// `viewerFofAuthorSet`.
async function viewerCanReachAuthorViaFof(viewerId: number, authorId: number, tier: StrictTier): Promise<boolean> {
  if (viewerId === authorId) return true
  const [v, a] = [Prisma.sql`${viewerId}`, Prisma.sql`${authorId}`]
  const rows = tier === 'public-mutual'
    ? await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM follows a1
        JOIN follows a2 ON a2.follower_id = a1.following_id AND a2.following_id = a1.follower_id
        JOIN follows b1 ON b1.follower_id = a1.following_id AND b1.following_id = ${authorId}
        JOIN follows b2 ON b2.follower_id = b1.following_id AND b2.following_id = b1.follower_id
        WHERE a1.follower_id = ${viewerId} AND ${bridgeUnblocked('a1.following_id', v, a)}
      ) AS exists`
    : await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.following_id
        WHERE f1.follower_id = ${viewerId} AND f2.following_id = ${authorId}
          AND ${bridgeUnblocked('f1.following_id', v, a)}
      ) AS exists`
  return rows[0]?.exists ?? false
}

// The owner's own settings (GET /api/me/visibility). Null = no such user,
// or a corrupt profile tier (unreachable under the CHECK).
export async function loadVisibility(userId: number): Promise<VisibilitySettings | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: SETTINGS_SELECT })
  if (!row) return null
  const { settings, tierOk } = readSettings(row, userId)
  return tierOk ? settings : null
}

// 🔒 Server-side only (another user's settings): the feed reads
// `showLocations` from here for the place rule, never from a post's `user`
// include (`author: f.user` ships that select verbatim).
export async function batchLoadVisibilities(
  userIds: number[],
): Promise<Map<number, VisibilitySettings>> {
  if (userIds.length === 0) return new Map()
  const rows = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, ...SETTINGS_SELECT },
  })
  const out = new Map<number, VisibilitySettings>()
  for (const r of rows) {
    const { settings, tierOk } = readSettings(r, r.id)
    if (tierOk) out.set(r.id, settings)
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

// Which of `authorIds` have the viewer in their extended circle (depth 1),
// each by its own tier (the rule of `viewerCanReachAuthorViaFof`). Only the
// authors that need it are looked up: the switch on, a strict tier, and a
// viewer their own edges don't already admit (`settings` =
// batchLoadVisibilities, `viewers` = resolveProfileViewerBulk; an author
// missing from `settings` is skipped). One roundtrip: the
// Followers-of-Followers set UNION the Friends-of-Friends set.
//
// Bounded at FOF_AUTHOR_CAP authors in total: the JOIN can fan out to
// (viewer.outdegree × intermediaries.outdegree) and a viewer following
// thousands could otherwise trigger a multi-second query. Callers should
// already be passing at most a page-size of candidates; this is the
// inner DoS-amplifier guard.
const FOF_AUTHOR_CAP = 200
export async function viewerFofAuthorSet(
  viewerId: number,
  authorIds: number[],
  settings: Map<number, VisibilitySettings>,
  viewers: Map<number, ProfileViewer>,
): Promise<Set<number>> {
  const followers: number[] = [], mutual: number[] = []
  for (const id of authorIds) {
    if (followers.length + mutual.length >= FOF_AUTHOR_CAP) break
    const s = settings.get(id), v = viewers.get(id)
    if (!s?.fofEnabled || !extendedCircleApplies(s.visibility) || (v && directlyAdmitted(s.visibility, v))) continue
    ;(s.visibility === 'public-mutual' ? mutual : followers).push(id)
  }
  if (followers.length + mutual.length === 0) return new Set()
  const v = Prisma.sql`${viewerId}`
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT f2.following_id AS id
    FROM follows f1
    JOIN follows f2 ON f2.follower_id = f1.following_id
    WHERE f1.follower_id = ${viewerId} AND f2.following_id = ANY(${followers}::int[])
      AND ${bridgeUnblocked('f1.following_id', v, Prisma.raw('f2.following_id'))}
    UNION
    SELECT b1.following_id AS id
    FROM follows a1
    JOIN follows a2 ON a2.follower_id = a1.following_id AND a2.following_id = a1.follower_id
    JOIN follows b1 ON b1.follower_id = a1.following_id
    JOIN follows b2 ON b2.follower_id = b1.following_id AND b2.following_id = b1.follower_id
    WHERE a1.follower_id = ${viewerId} AND b1.following_id = ANY(${mutual}::int[])
      AND ${bridgeUnblocked('a1.following_id', v, Prisma.raw('b1.following_id'))}
  `
  return new Set(rows.map(r => r.id))
}

// Update the owner's visibility settings: a COMPARE-AND-SET (You, step 4).
// `expected` = the six as the client last read them; `changes` = the fields
// to set (partial, at least one). The target is `applyVisibilityChanges`
// (@verre/core, the app's own rule): Same as Profile for a posts choice equal
// to the account, and on an actual tier / circle change a posts choice still
// wider than the account is narrowed to its tier. Inside one transaction the
// users row is locked (`FOR UPDATE`) and compared against THAT row:
//   - stored == that target already → no-op 'ok' (a retry whose first
//     attempt committed, or someone else made the same change);
//   - any expected field ≠ stored → 'conflict' with `current`;
//   - else update + one full before/after audit row → 'ok' with `current`.
// Full-snapshot compare: it covers the coupled FoF ↔ tier, and an A→B→A in
// between is harmless. Under READ COMMITTED a second request's FOR UPDATE
// waits, then reads the committed row, so two racing saves can't both win.
//
// Rate limit: 30/hour/user counts an actual change of ANY field. peekRate
// first (a no-op or a 409 charges nothing), checkRate only after a change
// committed. Race window: two concurrent changes can both peek-pass, briefly
// overshooting by a handful; the route's 60/min/user limiter is the burst
// gate, this counter only caps audit-log growth.
export type VisibilityChanges = Partial<VisibilitySettings>
export type SetVisibilityResult =
  | { ok: true; current: VisibilitySettings }
  | { ok: false; reason: 'conflict'; current: VisibilitySettings }
  | { ok: false; reason: 'rate-limited'; retryAfter: number }
  | { ok: false; reason: 'not-found' }

// Same as Profile in the audit log: NULL there means only "a row from before
// these columns" (or a signup row's from_*).
export const AUDIT_SAME_AS_PROFILE = 'profile'
const auditTier = (v: CheckinVisibility | null) => v ?? AUDIT_SAME_AS_PROFILE

const sameSettings = (a: VisibilitySettings, b: VisibilitySettings) =>
  VISIBILITY_FIELDS.every(f => a[f] === b[f])

export async function setProfileVisibility(
  userId: number,
  { expected, changes }: { expected: VisibilitySettings; changes: VisibilityChanges },
): Promise<SetVisibilityResult> {
  const peek = await peekRate(`rl:visibility:u:${userId}:1h`, 30)
  if (!peek.allowed) return { ok: false, reason: 'rate-limited', retryAfter: peek.retryAfter }

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<SettingsRow[]>`
      SELECT profile_visibility AS "profileVisibility", visibility_fof AS "visibilityFof",
             checkin_visibility AS "checkinVisibility", show_cravings AS "showCravings",
             show_moments AS "showMoments", show_locations AS "showLocations"
      FROM users WHERE id = ${userId} FOR UPDATE`
    if (!rows[0]) return { kind: 'not-found' as const }
    // The same reading as the owner's GET (normalized), so the owner can
    // always overwrite a bad stored value.
    // The audit's `from` is what the row held (`storedPosts`), not its collapsed reading.
    const { settings: stored, storedPosts } = readSettings(rows[0], userId)
    const target = applyVisibilityChanges(expected, changes)
    if (sameSettings(stored, target)) return { kind: 'ok' as const, current: stored, changed: false }
    if (!sameSettings(stored, expected)) return { kind: 'conflict' as const, current: stored }
    await tx.user.update({
      where: { id: userId },
      data: {
        profileVisibility: target.visibility,
        visibilityFof: target.fofEnabled,
        checkinVisibility: target.checkinVisibility,
        showCravings: target.showCravings,
        showMoments: target.showMoments,
        showLocations: target.showLocations,
      },
    })
    await tx.profileVisibilityLog.create({
      data: {
        userId,
        fromTier: stored.visibility, toTier: target.visibility,
        fromFof: stored.fofEnabled, toFof: target.fofEnabled,
        fromCheckinTier: auditTier(storedPosts), toCheckinTier: auditTier(target.checkinVisibility),
        fromShowCravings: stored.showCravings, toShowCravings: target.showCravings,
        fromShowMoments: stored.showMoments, toShowMoments: target.showMoments,
        fromShowLocations: stored.showLocations, toShowLocations: target.showLocations,
      },
    })
    return { kind: 'ok' as const, current: target, changed: true }
  })

  if (result.kind === 'not-found') return { ok: false, reason: 'not-found' }
  if (result.kind === 'conflict') return { ok: false, reason: 'conflict', current: result.current }
  if (result.changed) await checkRate(`rl:visibility:u:${userId}:1h`, 30, 3600)
  return { ok: true, current: result.current }
}
