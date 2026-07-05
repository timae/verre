import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { decimalToNumber } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k, getLastSeen, getHiddenCarousel } from '@/lib/redis'
import { blockPairIds } from '@/lib/userBlock'

// Carousel-card label: 'now' (live + started), 'soon' (pinned but not yet
// started), 'visited' (recently opened, started/date-less), or null (not
// pinned). Computed server-side and sent on the wire — see the routing-model
// block in GET. Mirrored by the mobile `CarouselLabel` wire type.
export type CarouselLabel = 'now' | 'soon' | 'visited' | null

// ── Moments-home timing policy (product rulings, NOT tuning knobs) ──────────
// Module-scope constants, not request state. Changing a value is a product
// decision, not a perf dial. They stay here (the sole consumer) rather than in
// @verre/core, whose charter is time-free domain logic — the client reasons
// about none of these windows; it renders the server-computed label/status.
//
// "Time over → recent" (Simon's ruling): a stated end (date_to) flips the
// session to past the moment it passes — no grace. With only a start time we
// assume a duration; 8h keeps an evening tasting pinned through the night and
// nothing more.
const ASSUMED_DURATION_MS = 8 * 3600 * 1000
// A DATE-LESS session can't be claimed "ongoing" — we only know THIS user
// touched it recently. Keep it pinned (as a "Just visited" card) for 1h since
// their last activity (Redis s:{CODE}:lastseen, bumped on visit + rate —
// per-user, NOT session-wide), then drop it to recents. The ephemeral nature
// (dies with the session) is why it lives in Redis, not a Postgres column.
const DATELESS_IDLE_CUTOFF_MS = 3600 * 1000
// A dated, not-yet-started moment enters the carousel once its start is this
// close, regardless of whether the user has opened it ("starting soon").
const SOON_MS = 24 * 3600 * 1000

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)
  const rows = await prisma.$queryRaw<
    Array<{
      id: number; code: string; host_name: string; name: string | null
      created_at: Date; joined_at: Date; wines_rated: bigint; avg_score: number | null
      date_from: Date | null; date_to: Date | null; address: string | null
      host_user_id: number | null; wine_count: bigint
      cover_photo_url: string | null
      category: string | null
      member_role: string
    }>
  >`
    SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
           s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url, s.category,
           sm.role AS member_role,
           COUNT(DISTINCT w.id) AS wine_count,
           COUNT(DISTINCT r.id) AS wines_rated,
           ROUND(AVG(r.score)::numeric, 1) AS avg_score
    FROM session_members sm
    JOIN sessions s ON s.code = sm.session_code
    LEFT JOIN wines w ON w.session_id = s.id
    LEFT JOIN ratings r ON r.wine_id = w.id AND r.user_id = ${userId}
    -- Soft-deleted sessions are scrubbed (code NULL, deleted_at set) and
    -- session_members rows wiped, so the JOIN naturally drops them. The
    -- explicit deleted_at filter documents intent and survives any future
    -- change to the scrub or member-wipe paths.
    WHERE sm.user_id = ${userId} AND s.deleted_at IS NULL
    GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, sm.role, s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url, s.category
    ORDER BY sm.joined_at DESC
    -- 50 = the recency page (Simon's call after the PR #65 review weighed
    -- the Redis enrichment fan-out; a 500 valve was tried and reverted).
    -- KNOWN CONSEQUENCE, accepted until server-side filtering ships: the
    -- mobile filters/search only reach these 50 rows, so older moments are
    -- unfindable past the cap (device repro: the two oldest friend-shared
    -- sessions fell off and the friend vanished from the friends-there
    -- picker). The real fix is pagination + SERVER-side facets — Part B of
    -- docs/dev/proposals/moments-server-filtering.md.
    LIMIT 50
  `

  // Enrich each row with live Redis TTL + lifespan from the meta key, plus
  // live taster count, the caller's role (id-based, never display names),
  // and a live/past status for the Moments-home pinning.
  const myIdentityId = `u:${userId}`
  // Participants per session, for the mobile people filter. Two sources,
  // unioned per row below: PG session_members (durable — survives Redis
  // expiry; registered users only) and the live identities hash (adds anon
  // participants while the session is alive). Batched: one query for all rows.
  const codes = rows.map((r) => r.code)
  const memberRows = codes.length
    ? await prisma.$queryRaw<Array<{ code: string; uid: number; name: string | null }>>`
        SELECT sm.session_code AS code, u.id AS uid, u.name
        FROM session_members sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.session_code IN (${Prisma.join(codes)})
      `
    : []
  const membersByCode = new Map<string, Array<{ id: string; name: string }>>()
  for (const m of memberRows) {
    if (m.name === null) continue
    const list = membersByCode.get(m.code) ?? []
    list.push({ id: `u:${m.uid}`, name: m.name })
    membersByCode.set(m.code, list)
  }
  // Block scrub, server-side (blocks are global user↔user pairs, so one load
  // covers every row): a blocked user must not surface in the people list —
  // same globally-subtracted posture as the in-session surfaces.
  const { blockedByMe, blockingMe } = await blockPairIds(userId)
  const blockedUserIds = new Set([...blockedByMe, ...blockingMe])
  const blockedIdentity = (id: string) =>
    id.startsWith('u:') && blockedUserIds.has(Number(id.slice(2)))
  // Codes the user dismissed from the highlight carousel — forced to 'past'
  // below so they drop from the carousel (still shown in "All moments").
  // One Redis call for the whole list, not per row.
  const hiddenCarousel = await getHiddenCarousel(userId)
  // Redis cost of this loop (PR #65 review): ~2 commands/row + 2 more per
  // LIVE row. node-redis v4 auto-pipelines same-tick commands, so the wave
  // is a handful of round trips, not N — and the 500-row valve bounds it.
  // The real fix at scale is Part B of docs/dev/proposals/
  // moments-server-filtering.md (paginate + enrich per page only).
  const enriched = await Promise.all(rows.map(async (r) => {
    let ttl_seconds = -2
    let lifespan: string | null = null
    let taster_count: number | null = null
    let participant = false
    let lastSeen = 0
    // Durable role from the Postgres session_members mirror — the fallback
    // when Redis meta is gone (expired session). Written at visit time and
    // kept current by the role route's mirror on every transition
    // (moments-server-filtering.md Part A). Live sessions still let the
    // Redis-meta block below OVERRIDE this, so a grant made after the user's
    // last visit is reflected while the session is alive. `taster` (and any
    // legacy/unknown value) maps to null — no badge. `host_user_id === userId`
    // is a last-resort belt for a registered host whose mirror row somehow
    // predates the role snapshot.
    let role: 'host' | 'cohost' | 'provider' | null =
      r.member_role === 'host' ? 'host'
      : r.member_role === 'co_host' ? 'cohost'
      : r.member_role === 'provider' ? 'provider'
      : r.host_user_id === userId ? 'host'
      : null
    // The host's CURRENT display name from the live identities hash — same
    // source the line-up + settings hub resolve from (participants[].displayName
    // ?? meta.host). The card's SQL host_name is a create-time snapshot that
    // goes stale when the host renames (esp. an anon host via the per-session
    // rename, which only writes the identities hash). Falls back to the SQL
    // snapshot when the hash has no entry (archived/expired session — not the
    // carousel case, which is always alive).
    let host_name_live: string | null = null
    let hostId: string | null = null
    let liveIdentities: Record<string, string> = {}
    try {
      const [t, raw] = await Promise.all([
        redis.ttl(k.meta(r.code)),
        redis.get(k.meta(r.code)),
      ])
      ttl_seconds = t
      if (raw) {
        try {
          const meta = JSON.parse(raw)
          lifespan = meta.lifespan ?? null
          hostId = meta.hostIdentityId ?? (meta.hostUserId != null ? `u:${meta.hostUserId}` : null)
          // Redis meta is the LIVE trust anchor: when it's present it FULLY
          // determines the role, overriding the durable PG fallback set above
          // — INCLUDING a reset to null (a demotion after the user's last
          // visit). Assigned unconditionally (not upgrade-only) so a stale PG
          // 'cohost' can't survive a live demotion. On an expired session
          // (no `raw`) this block never runs and the PG mirror stands.
          role =
            meta.hostIdentityId === myIdentityId || meta.hostUserId === userId ? 'host'
            : Array.isArray(meta.coHostIds) && meta.coHostIds.includes(myIdentityId) ? 'cohost'
            : Array.isArray(meta.providerIds) && meta.providerIds.includes(myIdentityId) ? 'provider'
            : null
        } catch {}
        try {
          // One hGetAll serves four consumers: taster count, the caller's
          // participant check, the live host name, AND the people list.
          ;[liveIdentities, lastSeen] = await Promise.all([
            redis.hGetAll(k.identities(r.code)).then((m) => m ?? {}),
            getLastSeen(r.code, userId),
          ])
          taster_count = Object.keys(liveIdentities).length
          participant = myIdentityId in liveIdentities
          host_name_live = (hostId ? liveIdentities[hostId] : undefined) ?? null
        } catch {}
      }
    } catch {}
    // live = session still in Redis AND the caller is still a participant
    // (kicked/banned users drop out of identities — their Moments home must
    // not pin the session) AND it's not clearly over.
    const ttlAlive = ttl_seconds > 0 || ttl_seconds === -1
    const hasDate = r.date_from !== null || r.date_to !== null
    const startsAt = r.date_from !== null ? r.date_from.getTime() : null
    const endsAt =
      r.date_to !== null ? r.date_to.getTime()
      : r.date_from !== null ? r.date_from.getTime() + ASSUMED_DURATION_MS
      : null
    const datePast = endsAt !== null && Date.now() > endsAt
    // Scheduled-but-not-started: a session whose start is in the future is
    // UPCOMING, not live — it must not show as "ongoing" before it begins.
    const dateFuture = startsAt !== null && Date.now() < startsAt
    // Recently-visited: THIS user touched the moment (visit OR an in-moment
    // action, both bump lastSeen) within the 1h window. lastSeen 0 (never
    // recorded — pre-feature session) reads as Infinity → not recent, so an
    // old session doesn't resurrect as "Just visited". This drives two things:
    // (a) a date-less session stays live only while recent, and (b) ANY moment
    // (incl. a not-yet-started upcoming one) gets carousel-pinned while recent.
    const idleMs = lastSeen > 0 ? Date.now() - lastSeen : Infinity
    const recentlyVisited = idleMs <= DATELESS_IDLE_CUTOFF_MS
    const datelessStale = !hasDate && !recentlyVisited
    // Carousel-hidden → never live, never pinned (drops to the list only).
    const hidden = hiddenCarousel.has(r.code)
    // ── Moments-home routing ────────────────────────────────────────────
    // Full model (the two orthogonal axes + the label, the cross-product, and
    // every invariant below): docs/dev/moments-home.md. This is the canonical
    // computation site — keep the doc in sync when changing it. Inline notes
    // are kept only where they guard a specific line.
    //
    // `status` (drives the LISTS) is PURE TENSE — it must NOT depend on
    // `hidden`. Dismissing from the carousel affects ONLY `pinned`, never which
    // LIST a moment lands in (gating the upcoming branch on `!hidden` was a bug:
    // a dismissed future moment fell through to `past` and jumped out of the
    // Upcoming list). Precedence: upcoming (future start) beats live; else live;
    // else past.
    const status: 'live' | 'upcoming' | 'past' =
      ttlAlive && participant && dateFuture ? 'upcoming'
      : ttlAlive && participant && !datePast && !datelessStale ? 'live'
      : 'past'
    // "Starting soon": a dated, not-yet-started moment whose start is within
    // 24h — pinned even if NEVER visited. The dateFuture guard is load-bearing:
    // without it a PAST start also satisfies "<= 24h from now" (negative delta)
    // and would wrongly re-pin a recently-ended dated moment.
    const startsSoon = startsAt !== null && dateFuture && startsAt - Date.now() <= SOON_MS
    // Carousel pin — INDEPENDENT of `status` (a pinned moment still sits in its
    // status's list). `!hidden` lives HERE and ONLY here — dismissing drops the
    // highlight card, full stop, never moves the moment between lists.
    const pinned =
      ttlAlive && participant && !hidden &&
      (status === 'live' || recentlyVisited || startsSoon)
    // Carousel chip — computed HERE, not client-side (the client can't: it
    // depends on per-user Redis lastSeen, never serialized — so the client is a
    // pure renderer and no recency timestamp leaks). null ⟺ !pinned. Precedence
    // (Simon's rulings — see the doc for the why):
    //   1. not-yet-started wins over everything → 'soon'
    //   2. genuinely live (dated + started) wins over recency → 'now'
    //      (`hasDate` gates it: a DATE-LESS live card can't claim "ongoing")
    //   3. else recently-visited → 'visited'
    // The trailing 'now' is unreachable given `pinned`'s definition — a safe
    // least-wrong terminal if the pin invariant ever drifts.
    const carouselLabel: CarouselLabel =
      !pinned ? null
      : dateFuture ? 'soon'
      : status === 'live' && hasDate ? 'now'
      : recentlyVisited ? 'visited'
      : 'now'
    // Activity recency for the "All moments" default sort (most-recently-
    // active on top): the strongest of this user's last touch, the session's
    // scheduled start, and when it was created. Internal — not serialized.
    const lastActiveMs = Math.max(
      lastSeen,
      r.date_from ? r.date_from.getTime() : 0,
      r.created_at ? r.created_at.getTime() : 0,
      r.joined_at ? r.joined_at.getTime() : 0,
    )
    // People who were part of the moment (mobile filter): live identities ∪
    // durable PG members, minus the caller (they're on every row) and minus
    // block pairs. Display names only — presentation, never identity-bearing.
    const peopleById = new Map<string, string>()
    for (const [id, name] of Object.entries(liveIdentities)) {
      if (id !== myIdentityId && !blockedIdentity(id) && name) peopleById.set(id, name)
    }
    for (const m of membersByCode.get(r.code) ?? []) {
      if (m.id !== myIdentityId && !blockedIdentity(m.id) && !peopleById.has(m.id)) peopleById.set(m.id, m.name)
    }
    return {
      ...r,
      people: [...peopleById.entries()].map(([id, name]) => ({ id, name })),
      // Live host name (identities hash) over the create-time SQL snapshot, so
      // a host rename shows on the card like it does in-moment.
      host_name: host_name_live ?? r.host_name,
      wines_rated: Number(r.wines_rated),
      wine_count: Number(r.wine_count),
      // Decimal wire-format trap (root CLAUDE.md): raw numeric serializes as
      // a JSON string without this coercion.
      avg_score: decimalToNumber(r.avg_score),
      date_from: r.date_from ? r.date_from.toISOString() : null,
      date_to: r.date_to ? r.date_to.toISOString() : null,
      ttl_seconds,
      lifespan,
      taster_count,
      role,
      status,
      pinned,
      // The strip card's chip ('now'/'soon'/'visited'/null), server-authoritative
      // (the client can't recompute it — per-user Redis lastSeen isn't on the
      // wire). An enum leaks LESS than a raw timestamp: the 1h cutoff stays
      // server-side and the client can't even infer it.
      carouselLabel,
      _lastActiveMs: lastActiveMs,
    }
  }))

  // "All moments" default sort — most recently active first (live carousel
  // items + just-visited float to the top). The SQL pre-filtered to the 50
  // most-recently-JOINED; this re-sorts that page by true activity. At >50
  // sessions an old-by-join-but-recently-active one could fall off the page
  // — accepted at current scale (lastSeen lives in Redis, not sortable in SQL).
  enriched.sort((a, b) => b._lastActiveMs - a._lastActiveMs)
  // Strip the internal sort key before sending.
  const body = enriched.map(({ _lastActiveMs, ...rest }) => rest)

  // Viewer-dependent body (role, own counts) — never shared-cacheable.
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
}
