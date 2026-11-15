import { redis, k, scanKeys } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import type { Session } from 'next-auth'
import type { AuthorizedIdentity } from '@/lib/sessionGrant'
import {
  type SessionMeta,
  type WineMeta,
  type WireWine,
  isHostByIdentity,
  wineToWire,
  buildAdderLookup,
} from '@/lib/session'
import { ensureSessionLive, ratingsLost } from '@/lib/sessionRehydrate'
import { redactWine } from '@/lib/wineRedaction'
import { blockPairIds } from '@/lib/userBlock'
import { wireIdentityMap, mapIdentityList } from '@/lib/publicIds'
import { viewableAvatars } from '@/lib/avatarGate'

// The per-viewer session view builders. Extracted from the three session GET
// route bodies (meta / wines / ratings) so the aggregate /state endpoint can
// COMPOSE them instead of re-deriving the security-sensitive transforms
// (block-pair resolution, avatar tier gate, blind/hideLineup redaction).
// The standalone routes call the same builders — one implementation, four
// call sites. See docs/dev/proposals/mobile-app/02-realtime.md §2.
//
// Builders assume the caller already ran the route preamble: code normalized,
// the session opened (openSession — 404 only when absent, 503 while
// restoring), participantOrBanned resolved (removed / invalid handling). `identities` is the session's identities map, fetched
// once by the caller (`redis.hGetAll(k.identities(c))`) and shared across
// builders.
//
// Every response built from these is viewer-dependent — callers MUST set
// `Cache-Control: private, no-store`.

export type SessionParticipant = { id: string; displayName: string; imageUrl: string | null }

// 🔒 The wire shape of SessionMeta: every user id in it is PUBLIC
// (public-user-ids § 4). Built only by metaToWire.
export type WireSessionMeta = Omit<SessionMeta, 'hostUserId'> & { hostUserId: string | null }

// 🔒 metaToWire is an ALLOW-LIST, not a spread: `Record<keyof SessionMeta, …>`
// fails tsc for a new meta field until it is classified here, so a future id
// field can't leak by default (the redactWine `...rest` lesson).
//   'pass'         — no user id in it; emitted as stored
//   'userId'       — the internal integer → the public id (dropped to null on a miss)
//   'identity'     — an identity string → its wire form (a miss → absent)
//   'identityList' — a list of identity strings → wire forms (misses dropped)
const META_WIRE: Record<keyof SessionMeta, 'pass' | 'userId' | 'identity' | 'identityList'> = {
  host: 'pass', name: 'pass', createdAt: 'pass', hostUserId: 'userId',
  hostIdentityId: 'identity', blind: 'pass', blindForEveryone: 'pass',
  lifespan: 'pass', coHostIds: 'identityList', providerIds: 'identityList',
  address: 'pass', dateFrom: 'pass', dateTo: 'pass', timezone: 'pass',
  description: 'pass', link: 'pass', hideLineup: 'pass',
  hideLineupMinutesBefore: 'pass', showProvenance: 'pass',
  coverPhotoUrl: 'pass', category: 'pass', promotedAt: 'pass',
}
export const META_WIRE_KEYS = Object.keys(META_WIRE) as (keyof SessionMeta)[]

export function metaIdentities(meta: SessionMeta): string[] {
  const out: string[] = []
  if (meta.hostUserId != null) out.push(`u:${meta.hostUserId}`)
  if (meta.hostIdentityId) out.push(meta.hostIdentityId)
  for (const id of meta.coHostIds ?? []) out.push(id)
  for (const id of meta.providerIds ?? []) out.push(id)
  return out
}

// `wire` must cover metaIdentities(meta) (wireIdentityMap).
export function metaToWireWith(meta: SessionMeta, wire: Map<string, string>): WireSessionMeta {
  const out: Record<string, unknown> = {}
  for (const key of META_WIRE_KEYS) {
    const v = meta[key]
    if (v === undefined) continue
    switch (META_WIRE[key]) {
      case 'pass': out[key] = v; break
      case 'userId': {
        const w = v == null ? undefined : wire.get(`u:${v}`)
        out[key] = w ? w.slice(2) : null
        break
      }
      case 'identity': { const w = wire.get(v as string); if (w) out[key] = w; break }
      case 'identityList': out[key] = mapIdentityList(v as string[], wire); break
    }
  }
  return out as WireSessionMeta
}

export async function metaToWire(meta: SessionMeta): Promise<WireSessionMeta> {
  return metaToWireWith(meta, await wireIdentityMap(metaIdentities(meta)))
}

export type SessionMetaView = WireSessionMeta & {
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
  caller: AuthorizedIdentity,
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
  // without a dedicated socket. Counted after translation (below): a ban whose
  // `u:<int>` has no users row any more is dropped from the list (listBans), so
  // the count must drop it too, or the panel shows "(1)" over an empty list.
  const isHost = isHostByIdentity(meta, caller)
  const banMembers = isHost ? await redis.sMembers(k.bans(c)) : []

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

  // Brought-by avatar imageUrl resolution: the shared in-moment avatar rule
  // (lib/avatarGate.ts), judged for this viewer.
  const imageUrlByUserId = await viewableAvatars(participantUserIds, viewerUserId, blockPairs)

  // 🔒 Every identity leaves in its wire form; one whose `u:<int>` has no
  // users row (a deleted account before the d: migration) is dropped.
  const wire = await wireIdentityMap([...Object.keys(identities), ...metaIdentities(meta), ...banMembers])
  const banCount = banMembers.filter(m => wire.has(m)).length
  const participants: SessionParticipant[] = []
  for (const [id, displayName] of Object.entries(identities)) {
    const wid = wire.get(id)
    if (!wid) continue
    let imageUrl: string | null = null
    if (id.startsWith('u:')) {
      const n = Number(id.slice(2))
      if (Number.isInteger(n)) {
        const url = imageUrlByUserId.get(n)
        if (url) imageUrl = url
      }
    }
    participants.push({ id: wid, displayName, imageUrl })
  }

  return {
    ...metaToWireWith(meta, wire),
    code: c,
    participants,
    ttlSeconds,
    viewerBlocksOut: mapIdentityList(viewerBlocksOut, wire),
    viewerBlocksIn: mapIdentityList(viewerBlocksIn, wire),
    banCount,
  }
}

// The LIVE Hide Line-up rule: hidden until X minutes before the start, for
// everyone but the moment's hosts (isHostByIdentity: so an anonymous host of a
// Redis-only moment keeps pre-rating). Shared by the wines read below and the
// rate + bookmark POSTs, which decide it inside their contract from `ctx`
// (lists plan D4: a write must not reach a bottle the read hides). Outside a
// moment the SQL rule applies instead (lib/outsideView.ts).
export function lineupHiddenFor(meta: SessionMeta, identity: AuthorizedIdentity, now = Date.now()): boolean {
  if (!meta.hideLineup || !meta.dateFrom || isHostByIdentity(meta, identity)) return false
  const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60 * 1000
  return now < revealAt
}

// `wines` is the lineup the route loaded absent-aware (openSession /
// loadLiveWines) — never a `[]` standing in for an evicted key.
export async function buildWinesView(
  c: string,
  meta: SessionMeta,
  identity: AuthorizedIdentity,
  identities: Record<string, string>,
  wines: WineMeta[],
  { echo = false }: { echo?: boolean } = {},
): Promise<WireWine[]> {
  const isUserHost = isHostByIdentity(meta, identity)

  // Lineup hidden until X minutes before start (not for a write's own echo:
  // the writer just wrote that bottle; blind redaction still applies below)
  if (!echo && lineupHiddenFor(meta, identity)) return []

  // Hybrid resolution for `addedByDisplayName`: live identities map →
  // users.name fallback for kicked logged-in adders → snapshot on the wine
  // itself → null.
  const adderLookup = await buildAdderLookup(wines, identities)

  // Provenance strip (Moment Setup → "Show Who Brought Each Impression").
  // When the host turned attribution OFF, wineToWire nulls the adder name +
  // userId structurally (5th arg) so it can never render "Brought by". Passed
  // through here AND in the four wine-mutation routes so every wire surface
  // inherits it — the strip lives in the one sanctioned transform, not post-hoc
  // in this reader alone (a review fix; the reader-only version leaked through
  // the add/edit/reorder/reveal echo responses). Default ON: absent/true leaves
  // provenance intact. Composes with blind (redaction already nulls a masked
  // wine's fields; this bites only on wines the caller can otherwise see).
  const showProvenance = meta.showProvenance !== false

  // Enter the redaction branch when:
  //   - session is blind AND the caller isn't host (the default rule), OR
  //   - session is blind AND meta.blindForEveryone is on (then redact even
  //     hosts — the helper itself decides per-wine whether to short-circuit
  //     on `revealed`).
  if (meta.blind && (!isUserHost || meta.blindForEveryone)) {
    // 🔒 The own-wine bypass is a privilege: for a `u:` caller with a grant,
    // ownership comes from the RECORD (wines.added_by_identity_id), never the
    // cached provenance — a refused reassign projection would otherwise leave
    // the former owner seeing the wine un-redacted (plan § 2, r1-5).
    const owned = identity.grant
      ? new Set((await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM wines WHERE session_id = ${identity.grant.sessionId} AND added_by_identity_id = ${identity.id}`).map(r => r.id))
      : null
    // Per-wine redaction: see lib/wineRedaction.ts for the full rule.
    // Pre-feature wines have NULL `addedByIdentityId` and never match the
    // provider exception — they redact like any other wine the caller
    // didn't add.
    return wines.map((w, i) => {
      const redacted = redactWine(w, {
        revealed: !!w.revealedAt,
        isHost: isUserHost,
        ownsWine: owned ? owned.has(w.id) : !!w.addedByIdentityId && w.addedByIdentityId === identity.id,
        index: i,
        blindForEveryone: !!meta.blindForEveryone,
      })
      return redacted ?? wineToWire(w, identity.id, identities, adderLookup, showProvenance)
    })
  }

  return wines.map(w => wineToWire(w, identity.id, identities, adderLookup, showProvenance))
}

// The reply of a line-up write (reorder, reveal / hide, a wine edit, the
// brought-by reassign; leak-fixes F6): the SAME per-viewer view the line-up
// read builds, so Blind for All masks the host's own echo too (a no-op edit
// must not unmask a bottle on demand). Same shape as before: a masked bottle is
// the "Wine N" stub. (The wine POST's echo stays a plain wineToWire: the adder
// just typed the bottle.)
export async function buildWinesEcho(c: string, meta: SessionMeta, identity: AuthorizedIdentity, wines: WineMeta[]): Promise<WireWine[]> {
  return buildWinesView(c, meta, identity, await redis.hGetAll(k.identities(c)), wines)
}

// A single bottle's echo, picked out of the view. The hide-line-up gate is
// skipped for it alone (`echo`): its writer (a host, or a provider editing
// their own bottle) just wrote it; blind redaction still applies.
export async function buildWineEcho(c: string, meta: SessionMeta, identity: AuthorizedIdentity, wines: WineMeta[], wineId: string): Promise<WireWine | null> {
  const view = await buildWinesView(c, meta, identity, await redis.hGetAll(k.identities(c)), wines, { echo: true })
  return view.find(w => w.id === wineId) ?? null
}

// Ratings for this session, keyed by WIRE identity:
//   { "u:<publicId>": { displayName: "Sam 🍅", ratings: { "<wineId>": {...} } }, ... }
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
//
// Ratings-scan trigger (redis-rehydration § 5.1, ruling 5 — single-key
// eviction): an empty SCAN for a Postgres-backed session that has committed
// ratings means the rating keys were lost — a reconciling `force` rebuild, then
// one rescan (with the identities map it reconciled).
export async function buildRatingsView(
  c: string,
  identities: Record<string, string>,
): Promise<RatingsView> {
  const prefix = `s:${c}:r:`
  let keys = await scanKeys(`${prefix}*`)
  const result: RatingsView = {}
  if (keys.length === 0 && await ratingsLost(c)) {
    if ((await ensureSessionLive(c, { force: true })) === 'live') {
      keys = await scanKeys(`${prefix}*`)
      identities = await redis.hGetAll(k.identities(c))
    }
  }
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
        displayName: identities[identityId] || '',
        ratings: {},
      }
    }
    result[identityId].ratings[wineId] = JSON.parse(val)
  })

  // 🔒 Keyed by WIRE identity; a rater whose `u:<int>` has no users row is dropped.
  const wire = await wireIdentityMap(Object.keys(result))
  const out: RatingsView = {}
  for (const [id, v] of Object.entries(result)) {
    const wid = wire.get(id)
    if (wid) out[wid] = v
  }
  return out
}
