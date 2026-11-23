import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { momentLookInEnabled } from '@/lib/momentGate'
import { grantColumnsSql, grantFromRow, grantMemberJoinSql, grantStatus, type GrantRow } from '@/lib/sessionGrant'
import { batchLoadVisibilities, canViewPosts, resolveProfileViewerBulk, viewerFofAuthorSet } from '@/lib/profileVisibility'
import { viewerBlockedAmong } from '@/lib/userBlock'

// Who may look into a moment, and who in it is NAMED to the viewer
// (docs/dev/proposals/moment-visibility.md § 6 / § 7; step-1 plan § 10 "1b").
// ONE entry point, `decideMoments`, for the look-in, the feed's `momentId` and
// `hostName`, and someone's Moments list (open rows, their filters, the tile).
//
// Two halves, because "named" includes the post gate, which is TypeScript:
// - SQL finds the candidates: the moment's row, the viewer's grant (the
//   record's membership rule, `grantStatus`, the twin of the moment's own),
//   bans, the block pair with the host, the host's and the members' follow
//   edges to the viewer, `only_inside`, kicked.
// - TypeScript runs the EXISTING bulk post gate over the people asked about
//   (`batchLoadVisibilities` + `resolveProfileViewerBulk` + `viewerFofAuthorSet`
//   + `canViewPosts`, plus Show Moments). Never copied into SQL.
//
// NAMED to V = a current member (or the strict host), not kicked, not banned,
// not `only_inside`, no block pair with V either way, Show Moments on, and the
// post gate admits V (their post of the moment would show they were there
// anyway).
//
// ADMITTED (`open`): the flag on, V signed in, not a member (members are
// `member: true`), not banned, no block pair with the host, and the audience:
//   members   → nobody, whatever the guests' switch says
//   friends   → a mutual follow with the host, or (guests' circles on) with a
//               NAMED member (a hidden friend bridges nobody: admission would
//               otherwise tell V that they are in it)
//   followers → V follows the host, or (switch on) a named member
//   verre     → every signed-in user
// "The host" is `sessions.host_user_id`: a hostless moment has no host circle.
// The host's own edge needs no naming: the moment's setting is the host's.
//
// 🔒 Bounded: at most AUDIENCE_PEOPLE_CAP distinct people per call (the FoF
// query's own cap), filled in a FIXED order: the people the caller asks about
// (the profile's owner, the filter's friends; they take their slots whether
// or not they are in any of the moments, so asking about someone never moves
// the cut: review r1), then hosts, then bridge candidates (members whose edge
// to V matches their moment's tier), then the rest, these three by user id.
// Past it a person is not named and admits nobody (fails closed, the same
// answer on every poll). The cap is per CALL: on a feed page or a list a
// moment's bridges compete with the other moments' (named, plan § 12).

export const AUDIENCE_PEOPLE_CAP = 200

export type MomentDecision = {
  sessionId: number
  publicId: string
  hostUserId: number | null
  // The record admits V as a participant (`grantStatus(grant) === 'ok'`).
  member: boolean
  // Banned, or a block pair with the host: refused by the link too.
  refused: boolean
  // May look in through the audience (never true for a member, or while the flag is off).
  open: boolean
  // For a moment V is NOT a member of: the evaluated people named to V (the
  // host, the people asked about, the bridge candidates while admission
  // depends on them; everyone with `everyone`). 🔒 A member gets an empty set
  // and `hostNamed` false (a member sees the moment itself): check `member`
  // first.
  named: ReadonlySet<number>
  hostNamed: boolean
}

type MomentRow = GrantRow & {
  public_id: string; visibility: string | null; include_guest_circles: boolean | null
  host_block: boolean; v_follows_host: boolean; host_follows_v: boolean
}
type PersonRow = { sid: number; user_id: number; only_inside: boolean; v_follows: boolean; follows_v: boolean }

// The tier's own edge between V and a person: a mutual follow (Your Friends),
// V follows them (Your Followers). The SQL below spells the same rule.
const tierEdge = (visibility: string | null, vFollows: boolean, followsV: boolean) =>
  visibility === 'friends' ? vFollows && followsV : visibility === 'followers' && vFollows

export async function decideMoments(
  viewerId: number | null,
  sessionIds: number[],
  opts: { everyone?: boolean; also?: number[] } = {},
): Promise<Map<number, MomentDecision>> {
  const out = new Map<number, MomentDecision>()
  const ids = [...new Set(sessionIds)]
  if (ids.length === 0) return out
  const v = viewerId
  const admission = momentLookInEnabled() && v !== null
  const also = [...new Set(opts.also ?? [])]
  const moments = await prisma.$queryRaw<MomentRow[]>`
    SELECT ${grantColumnsSql(v)}, s.public_id, s.visibility, s.include_guest_circles,
           EXISTS (SELECT 1 FROM user_blocks ub
                    WHERE (ub.blocker_id = ${v}::int AND ub.blocked_id = s.host_user_id)
                       OR (ub.blocked_id = ${v}::int AND ub.blocker_id = s.host_user_id)) AS host_block,
           EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v}::int AND f.following_id = s.host_user_id) AS v_follows_host,
           EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = s.host_user_id AND f.following_id = ${v}::int) AS host_follows_v
      FROM sessions s ${grantMemberJoinSql(v)}
     WHERE s.id = ANY(${ids}::int[]) AND s.deleted_at IS NULL`
  if (moments.length === 0) return out
  const pre = new Map(moments.map(m => {
    const grant = grantFromRow(m, v)
    const host = m.host_user_id === null ? null : Number(m.host_user_id)
    const member = v !== null && grantStatus(grant) === 'ok'
    const refused = grant.banned || m.host_block
    const direct = host !== null && tierEdge(m.visibility, m.v_follows_host, m.host_follows_v)
    return [m.id, { host, member, refused, direct }]
  }))
  // The people of the moments V is not in (current members, not kicked, and
  // the strict host, minus bans) the answer can depend on: the host, the
  // people asked about, everyone with `everyone`, and bridge candidates only
  // where admission is possible and the host's own edge doesn't already admit
  // (measured: .local/moment-visibility/step1-plan.md § 12).
  const outsider = moments.filter(m => !pre.get(m.id)!.member).map(m => m.id)
  const bridging = moments.filter(m => {
    const p = pre.get(m.id)!
    return admission && !p.member && !p.refused && !p.direct && m.include_guest_circles === true && (m.visibility === 'friends' || m.visibility === 'followers')
  }).map(m => m.id)
  const people = outsider.length === 0 ? [] : await prisma.$queryRaw<PersonRow[]>`
    WITH mo AS (
      SELECT s.id AS sid, s.code, s.host_user_id, s.visibility, s.include_guest_circles
        FROM sessions s WHERE s.id = ANY(${outsider}::int[]) AND s.deleted_at IS NULL
    ), p AS (
      SELECT mo.sid, sm.user_id FROM mo JOIN session_members sm ON sm.session_code = mo.code
       WHERE (sm.removed_state IS DISTINCT FROM 'kicked' OR sm.user_id = mo.host_user_id)
         AND (${opts.everyone === true} OR mo.sid = ANY(${bridging}::int[]) OR sm.user_id = ANY(${also}::int[]) OR sm.user_id = mo.host_user_id)
      UNION
      SELECT mo.sid, mo.host_user_id FROM mo WHERE mo.host_user_id IS NOT NULL
    ), e AS (
      SELECT p.sid, p.user_id, mo.code, mo.host_user_id, mo.visibility, mo.include_guest_circles,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v}::int AND f.following_id = p.user_id) AS v_follows,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = p.user_id AND f.following_id = ${v}::int) AS follows_v
        FROM p JOIN mo ON mo.sid = p.sid
    )
    SELECT e.sid, e.user_id, COALESCE(mp.only_inside, false) AS only_inside, e.v_follows, e.follows_v
      FROM e
      LEFT JOIN moment_privacy mp ON mp.session_id = e.sid AND mp.user_id = e.user_id
     WHERE NOT EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = e.code AND b.identity_id = 'u:' || e.user_id)
       AND (${opts.everyone === true} OR e.user_id = e.host_user_id OR e.user_id = ANY(${also}::int[])
            OR (e.sid = ANY(${bridging}::int[])
                AND ((e.visibility = 'friends' AND e.v_follows AND e.follows_v) OR (e.visibility = 'followers' AND e.v_follows))))`

  const byMoment = new Map<number, PersonRow[]>()
  for (const p of people) {
    const list = byMoment.get(p.sid)
    if (list) list.push(p)
    else byMoment.set(p.sid, [p])
  }
  const visibilityOf = new Map(moments.map(m => [m.id, m.visibility]))
  const bridgingSet = new Set(bridging)
  const isBridgeEdge = (p: PersonRow) => bridgingSet.has(p.sid) && tierEdge(visibilityOf.get(p.sid)!, p.v_follows, p.follows_v)
  // The fixed fill order, capped; the people asked about always cost their slots.
  const present = new Set(people.map(p => p.user_id))
  const hosts = new Set(moments.flatMap(m => (m.host_user_id === null ? [] : [Number(m.host_user_id)])))
  const bridges = new Set(people.filter(isBridgeEdge).map(p => p.user_id))
  const asc = (s: Iterable<number>) => [...s].sort((a, b) => a - b)
  const considered = new Set(also.filter(id => present.has(id)))
  let room = AUDIENCE_PEOPLE_CAP - also.length
  for (const id of [...asc(hosts), ...asc(bridges), ...asc(present)]) {
    if (room <= 0) break
    if (!present.has(id) || considered.has(id)) continue
    considered.add(id)
    room--
  }
  const visible = await visiblePeople(v, [...considered])

  for (const m of moments) {
    const { host, member, refused, direct } = pre.get(m.id)!
    const rows = byMoment.get(m.id) ?? []
    const named = new Set(rows.filter(p => considered.has(p.user_id) && !p.only_inside && visible.has(p.user_id)).map(p => p.user_id))
    const bridged = m.include_guest_circles === true && rows.some(p => named.has(p.user_id) && tierEdge(m.visibility, p.v_follows, p.follows_v))
    const admits = m.visibility === 'verre' || ((m.visibility === 'friends' || m.visibility === 'followers') && (direct || bridged))
    out.set(m.id, {
      sessionId: m.id,
      publicId: m.public_id,
      hostUserId: host,
      member,
      refused,
      open: admission && !member && !refused && admits,
      named,
      hostNamed: host !== null && named.has(host),
    })
  }
  return out
}

// The person half: who of `ids` the viewer may see as having been in a moment
// (self always; a block pair either way out; Show Moments on; the post gate).
async function visiblePeople(viewerId: number | null, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>(viewerId !== null && ids.includes(viewerId) ? [viewerId] : [])
  const others = ids.filter(id => id !== viewerId)
  if (others.length === 0) return out
  const [blocked, settings, viewers] = await Promise.all([
    viewerBlockedAmong(viewerId, others),
    batchLoadVisibilities(others),
    resolveProfileViewerBulk(others, viewerId),
  ])
  const unblocked = others.filter(id => !blocked.has(id))
  const fof = viewerId === null ? new Set<number>() : await viewerFofAuthorSet(viewerId, unblocked, settings, viewers)
  for (const id of unblocked) {
    const s = settings.get(id), rel = viewers.get(id)
    if (!s || !rel || !s.showMoments) continue
    if (canViewPosts(s, { ...rel, isFofOfProfile: s.fofEnabled ? fof.has(id) : undefined })) out.add(id)
  }
  return out
}

// 🔒 Join safety for someone's Moments (lists plan D5), shared by the list and
// the automatic Moments tile cover (T12): a moment YOU are in (a member row,
// not kicked; upcoming included) and, as a belt, no ban of yours. Aliases `s`
// = sessions (live, joined by the caller); `mine` / `vb` are internal.
export const sharedMomentSql = (viewerId: number) => Prisma.sql`(
  EXISTS (SELECT 1 FROM session_members mine
           WHERE mine.session_code = s.code AND mine.user_id = ${viewerId} AND mine.removed_state IS DISTINCT FROM 'kicked')
  AND NOT EXISTS (SELECT 1 FROM session_bans vb WHERE vb.session_code = s.code AND vb.identity_id = ${`u:${viewerId}`}))`
