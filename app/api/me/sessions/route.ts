import { NextRequest, NextResponse } from 'next/server'
import { decimalToNumber } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k, getLastSeen, getHiddenCarousel } from '@/lib/redis'

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
    }>
  >`
    SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
           s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url,
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
    GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url
    ORDER BY sm.joined_at DESC
    LIMIT 50
  `

  // Enrich each row with live Redis TTL + lifespan from the meta key, plus
  // live taster count, the caller's role (id-based, never display names),
  // and a live/past status for the Moments-home pinning.
  const myIdentityId = `u:${userId}`
  // Codes the user dismissed from the highlight carousel — forced to 'past'
  // below so they drop from the carousel (still shown in "All moments").
  // One Redis call for the whole list, not per row.
  const hiddenCarousel = await getHiddenCarousel(userId)
  // "Time over → recent" (Simon's ruling): a stated end (date_to) flips the
  // session to past the moment it passes — no grace. With only a start time
  // we have to assume a duration; 8h keeps an evening tasting pinned through
  // the night and nothing more.
  const ASSUMED_DURATION_MS = 8 * 3600 * 1000
  // A DATE-LESS session can't be claimed "ongoing" — we only know THIS user
  // touched it recently. Keep it pinned (as a "Just visited" card) for 1h
  // since their last activity (Redis s:{CODE}:lastseen, bumped on visit +
  // rate — per-user, NOT session-wide), then drop it to recents. The
  // ephemeral nature (dies with the session) is why it lives in Redis, not
  // a Postgres column.
  const DATELESS_IDLE_CUTOFF_MS = 3600 * 1000
  const enriched = await Promise.all(rows.map(async (r) => {
    let ttl_seconds = -2
    let lifespan: string | null = null
    let taster_count: number | null = null
    let participant = false
    let lastSeen = 0
    let role: 'host' | 'cohost' | 'provider' | null =
      r.host_user_id === userId ? 'host' : null
    // The host's CURRENT display name from the live identities hash — same
    // source the line-up + settings hub resolve from (participants[].displayName
    // ?? meta.host). The card's SQL host_name is a create-time snapshot that
    // goes stale when the host renames (esp. an anon host via the per-session
    // rename, which only writes the identities hash). Falls back to the SQL
    // snapshot when the hash has no entry (archived/expired session — not the
    // carousel case, which is always alive).
    let host_name_live: string | null = null
    let hostId: string | null = null
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
          if (meta.hostIdentityId === myIdentityId || meta.hostUserId === userId) role = 'host'
          else if (Array.isArray(meta.coHostIds) && meta.coHostIds.includes(myIdentityId)) role = 'cohost'
          else if (Array.isArray(meta.providerIds) && meta.providerIds.includes(myIdentityId)) role = 'provider'
        } catch {}
        try {
          ;[taster_count, participant, lastSeen, host_name_live] = await Promise.all([
            redis.hLen(k.identities(r.code)),
            redis.hExists(k.identities(r.code), myIdentityId),
            getLastSeen(r.code, userId),
            hostId ? redis.hGet(k.identities(r.code), hostId).then((v) => v ?? null) : Promise.resolve(null),
          ])
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
    // ── Moments-home routing (source of truth) ──────────────────────────
    // The home screen + "All moments" list consume TWO orthogonal signals to
    // place a moment. Read this before changing the buckets, `pinned`, or
    // either client filter (apps/mobile .../moments/index.tsx + recents.tsx).
    //
    // 1. `status` ('live' | 'upcoming' | 'past') — a 3-way bucket that drives
    //    the LISTS. The had-list shows every `!== 'upcoming'` row; the Upcoming
    //    row shows `=== 'upcoming'`. Mutually exclusive: a moment is in exactly
    //    one list. Precedence: upcoming (future start) beats live; else live;
    //    else past.
    // 2. `pinned` (boolean) — INDEPENDENT of `status`; drives the CAROUSEL
    //    highlight strip alone. The carousel is a promotion layered on top of
    //    the lists, NOT a fourth bucket, so a pinned moment ALSO sits in
    //    whichever list its `status` puts it in.
    //
    // The cross-product the client must handle:
    //   live + pinned        → carousel + had-list. Label: dated→"Happening
    //                          now", date-less→"Just visited".
    //   upcoming + pinned    → carousel + Upcoming row, AT ONCE (you visited a
    //                          not-yet-started moment <1h ago). Label is
    //                          "Just visited" (it hasn't begun, so never
    //                          "Happening now"). THIS is the overlap that makes
    //                          `pinned` a separate signal — one enum can't say
    //                          "carousel AND Upcoming".
    //   past / not-pinned    → list only, no carousel.
    //
    // INVARIANT: `status` is PURE TENSE — it must NOT depend on `hidden`.
    // Dismissing from the carousel affects ONLY `pinned` (below), never which
    // LIST a moment lands in. An earlier version gated the upcoming branch on
    // `!hidden`; dismissing a future moment then fell through to `past` and the
    // moment jumped out of Upcoming into "Recent moments" — a bug, because an
    // upcoming moment's list is the Upcoming row, not the had-list (whereas a
    // live moment's list IS the had-list, so demoting it there was invisible
    // and masked the issue). Keep `hidden` out of this ternary.
    const status: 'live' | 'upcoming' | 'past' =
      ttlAlive && participant && dateFuture ? 'upcoming'
      : ttlAlive && participant && !datePast && !datelessStale ? 'live'
      : 'past'
    // Carousel pin: anything live is pinned; additionally an upcoming moment is
    // pinned while recently visited (the future-start overlap). `!hidden` lives
    // HERE and ONLY here — dismissing drops the highlight card, full stop, and
    // never moves the moment between lists.
    const pinned =
      ttlAlive && participant && !hidden &&
      (status === 'live' || (status === 'upcoming' && recentlyVisited))
    // The "happening-now vs just-visited" carousel label is NOT sent — the
    // client derives it from fields already on the wire: "Happening now" only
    // when the moment is dated AND has actually started; otherwise "Just
    // visited" (a
    // date-less live one, or an upcoming+pinned one that hasn't begun).
    // Activity recency for the "All moments" default sort (most-recently-
    // active on top): the strongest of this user's last touch, the session's
    // scheduled start, and when it was created. Internal — not serialized.
    const lastActiveMs = Math.max(
      lastSeen,
      r.date_from ? r.date_from.getTime() : 0,
      r.created_at ? r.created_at.getTime() : 0,
      r.joined_at ? r.joined_at.getTime() : 0,
    )
    return {
      ...r,
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
