import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { decimalToNumber } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k, getLastSeen, getHiddenCarousel } from '@/lib/redis'
import { blockPairIds } from '@/lib/userBlock'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { scrub } from '@/lib/textSafe'

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

// ── Server-side filtering / pagination (moments-server-filtering.md Part B) ──
// The unfiltered home carousel keeps its old contract: NO params → the 50
// most-recently-joined rows, JS-re-sorted by live activity so "just visited"
// floats up (index.tsx depends on this exact shape, a bare array). ANY filter
// param flips to PAGINATED mode: keyset pagination over the caller's WHOLE
// matching history, ordered by a SQL-expressible date key (not Redis activity),
// with nextCursor returned in the `X-Next-Cursor` header so the body stays a
// bare array in both modes. recents.tsx drives the filtered mode.
const DEFAULT_PAGE = 30
const MAX_PAGE = 50
// Max members a multi-select facet accepts per request. `people` is the
// binding one (each becomes a correlated EXISTS — AND semantics); `hosts` OR
// into an ANY() (cheaper) but is capped the same way for symmetry. Bounds
// per-request SQL work the rate limiter can't.
const FACET_MAX = 20
// Cap on a single anon-host name (`n:<name>`) — bounds the free-text bind.
const HOST_NAME_MAX = 64
// Trigram typo tolerance for search — tuned against the prod dump (real typos
// score 0.54–0.67; the stock 0.6 default missed them, 0.3 catches them with no
// false positives). Explicit threshold in the predicate, NOT the %> operator
// (which reads a pooled-connection-leaking session GUC). See the migration.
const SIMILARITY = 0.3

// Roles the caller can filter on. 'taster' means "no host/cohost/provider
// badge" — the sm.role fallback maps host|co_host|provider|taster and anything
// unknown to taster. Mirrors the client RoleKey union.
const ROLE_KEYS = new Set(['host', 'cohost', 'provider', 'taster'])
// Wire role key → the sm.role values it matches (Part A durable mirror stores
// 'co_host'; the wire vocab is 'cohost'). 'taster' is the complement, handled
// specially below (NOT ANY-of a value list).
const ROLE_TO_SM: Record<string, string[]> = {
  host: ['host'],
  cohost: ['co_host'],
  provider: ['provider'],
}

// Parse a comma-separated multi-select param into a de-duped string[] (empty
// when absent/blank). Values are validated by the caller per facet.
function csv(v: string | null): string[] {
  if (!v) return []
  return [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]
}

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)
  const sp = req.nextUrl.searchParams

  // ── parse + validate the filter contract ──────────────────────────────────
  // Free-text params are scrubbed (strip NUL/control/bidi — a NUL byte would
  // 500 the $queryRaw with P22021) and length-capped before touching Postgres,
  // even though this is a read (root CLAUDE.md's scrub rule is framed for
  // writes, but the NUL-byte 500 hits reads too). 128 chars is ample for a
  // moment/host name search.
  const Q_MAX = 128
  const q = (scrub(sp.get('q')) ?? '').trim().slice(0, Q_MAX)
  const tense = sp.get('tense') // 'upcoming' | 'past' | null (both)
  const roles = csv(sp.get('roles')).filter((r) => ROLE_KEYS.has(r))
  // Same per-facet cap as `people`: hosts OR into the query (each id/name is one
  // ANY() member, cheaper than an EXISTS, but still bound the input). 20 is far
  // beyond any real "moments hosted by one of N people" query.
  const hosts = csv(sp.get('hosts')).slice(0, FACET_MAX) // 'me' | 'u:<id>' | 'n:<name>'
  const people = csv(sp.get('people')).slice(0, FACET_MAX) // 'u:<id>' friend identity ids
  const category = sp.get('category') // 'wine' | null (any); 'any' == null
  // `from`/`to` are full ISO INSTANTS (…Z), not bare YYYY-MM-DD: the client
  // sends the picked LOCAL day's start/end converted to UTC (local-midnight →
  // local-next-midnight-minus-1ms), so the window means "this date in the
  // user's device timezone" — the SAME timezone the moment cards render in
  // (momentFormat.ts uses device-local toLocaleDateString). The server just
  // compares the stored instant against these; no UTC-midnight re-anchoring,
  // so no off-by-a-day for non-UTC users.
  const fromRaw = sp.get('from')
  const toRaw = sp.get('to')
  const cursorRaw = sp.get('cursor')
  const limitRaw = sp.get('limit')

  // Bounds on the EFFECTIVE date (set date, else created) — the same key the
  // client's Recent list sorts on, so the filter and order agree. Parsed
  // lenient: a bad value is ignored rather than 400 (a stale client shouldn't
  // hard-fail the whole list).
  const fromMs = fromRaw ? Date.parse(fromRaw) : NaN
  const toMs = toRaw ? Date.parse(toRaw) : NaN
  const from = Number.isFinite(fromMs) ? new Date(fromMs) : null
  const to = Number.isFinite(toMs) ? new Date(toMs) : null

  const filtered =
    q !== '' || tense !== null || roles.length > 0 || hosts.length > 0 ||
    people.length > 0 || (category !== null && category !== 'any') ||
    from !== null || to !== null || cursorRaw !== null || limitRaw !== null

  // Rate-limit ONLY the genuinely-expensive params — the trigram search (`q`)
  // and the per-friend correlated EXISTS (`people`). The OTHER "filtered" params
  // (tense/roles/hosts/category/date/cursor/limit) are plain indexed WHEREs +
  // keyset paging, no more costly than the unfiltered carousel read — and since
  // the client ALWAYS sends `tense` for Recent/Upcoming, gating the limiter on
  // `filtered` would throttle ordinary browsing (open list → scroll → each page
  // a request) against a "search compute" cap. So the cap keys on `expensive`,
  // not `filtered`. Mirrors app/api/users/search's intent (protect the trigram/
  // EXISTS channel), not ordinary pagination. 30/min/user, caller-keyed.
  const expensive = q !== '' || people.length > 0
  if (expensive) {
    const rl = await checkRate(`rl:moments-search:u:${userId}:1m`, 30, 60)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again ${formatWait(rl.retryAfter)}.` },
        { status: 429, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
  }

  const myIdentityId = `u:${userId}`
  // Block scrub (blocks are global user↔user pairs — one load covers every
  // row): a blocked user must not surface in the people list, and the people
  // FACET must not let the caller probe a block pair's attendance. Loaded up
  // front because both the WHERE (people facet) and the enrichment need it.
  const { blockedByMe, blockingMe } = await blockPairIds(userId)
  const blockedUserIds = new Set([...blockedByMe, ...blockingMe])

  // Friend ids the caller may filter `people` on. The picker only offers
  // friends, but a request is untrusted — intersect the requested `people`
  // ids with the caller's actual mutual-follow set so this can't become an
  // attendance oracle for an arbitrary user. Blocked pairs are excluded too.
  let peopleIds: number[] = []
  if (filtered && people.length > 0) {
    const wanted = people
      .filter((p) => p.startsWith('u:'))
      .map((p) => Number(p.slice(2)))
      .filter((n) => Number.isInteger(n) && n > 0 && !blockedUserIds.has(n))
      // Belt after the block-scrub filter (the raw `people` was already capped
      // at parse). Each accepted friend becomes one correlated EXISTS.
      .slice(0, FACET_MAX)
    if (wanted.length > 0) {
      const mutuals = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT f1."following_id" AS id
        FROM follows f1
        JOIN follows f2 ON f2."follower_id" = f1."following_id" AND f2."following_id" = ${userId}
        WHERE f1."follower_id" = ${userId} AND f1."following_id" = ANY(${wanted})
      `
      peopleIds = mutuals.map((m) => m.id)
    }
  }

  // ── build the row query ────────────────────────────────────────────────────
  // Legacy (no params): the ORIGINAL query verbatim — 50 most-recently-joined,
  // JS activity re-sort below feeds the carousel. Filtered: keyset pagination
  // over the whole matching history, ordered by the effective date.
  let rows: SessionRow[]
  let nextCursor: string | null = null
  // True full-history bucket totals (unfiltered path only) → home nav-row gate.
  let upcomingTotal: number | null = null
  let pastTotal: number | null = null

  if (!filtered) {
    rows = await prisma.$queryRaw<SessionRow[]>`
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
      -- change to the scrub or member-wipe paths. removed_state excludes
      -- kick-keep moments (durable PG mirror of the Redis kicked set).
      WHERE sm.user_id = ${userId} AND s.deleted_at IS NULL
        AND sm.removed_state IS DISTINCT FROM 'kicked'
      GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, sm.role, s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url, s.category
      ORDER BY sm.joined_at DESC
      -- 50 = the recency page for the home carousel. The TRUE full-history
      -- bucket counts come from the cheap tenseCounts query below (not this
      -- capped page) so the home screen's Upcoming/Recent nav rows gate on real
      -- totals — otherwise a user whose only upcoming moment is older than their
      -- 50 most-recently-joined would see no Upcoming row and couldn't reach the
      -- paginated list at all.
      LIMIT 50
    `
    // True (uncapped) bucket counts for the home nav rows — a cheap
    // members⋈sessions scan with NO wine/rating joins, one GROUP BY tense.
    // Returned in headers so the bare-array body is unchanged. `upcoming` =
    // future start (matches the tense facet); everything else is `past`.
    const counts = await prisma.$queryRaw<Array<{ tense: string; n: bigint }>>`
      SELECT CASE WHEN s.date_from IS NOT NULL AND s.date_from > NOW() THEN 'upcoming' ELSE 'past' END AS tense,
             COUNT(*) AS n
      FROM session_members sm
      JOIN sessions s ON s.code = sm.session_code
      WHERE sm.user_id = ${userId} AND s.deleted_at IS NULL
        AND sm.removed_state IS DISTINCT FROM 'kicked'
      GROUP BY 1
    `
    for (const c of counts) {
      if (c.tense === 'upcoming') upcomingTotal = Number(c.n)
      else pastTotal = Number(c.n)
    }
  } else {
    // Effective date the list sorts on: the set date, else the created date.
    // Upcoming sorts SOONEST-first (agenda order); everything else NEWEST-first
    // (the client's per-list sorts, now server-authoritative for paging).
    const asc = tense === 'upcoming'
    const limit = clampLimit(limitRaw)
    const cursor = parseCursor(cursorRaw) // { effKey, id } | null

    // ── facet predicates (composed with AND) ────────────────────────────────
    const where: Prisma.Sql[] = [
      Prisma.sql`sm.user_id = ${userId}`,
      Prisma.sql`s.deleted_at IS NULL`,
      // Kicked moments never appear in the caller's lists — durable PG mirror of
      // the Redis kicked set (kick-ban.md). Exact in SQL, no per-row Redis read.
      Prisma.sql`sm.removed_state IS DISTINCT FROM 'kicked'`,
    ]

    // Tense: split on the effective date vs now. 'upcoming' = starts in the
    // future; 'past' = everything else. Date-less sessions have no future
    // start, so they're 'past'.
    if (tense === 'upcoming') {
      where.push(Prisma.sql`s.date_from IS NOT NULL AND s.date_from > NOW()`)
    } else if (tense === 'past') {
      where.push(Prisma.sql`(s.date_from IS NULL OR s.date_from <= NOW())`)
    }

    // Date window on COALESCE(date_from, created_at), inclusive whole days.
    if (from) where.push(Prisma.sql`COALESCE(s.date_from, s.created_at) >= ${from}`)
    if (to) where.push(Prisma.sql`COALESCE(s.date_from, s.created_at) <= ${to}`)

    // Category: NULL rows predate the column → treat as 'wine' (the only thing
    // they could be), matching the client's fold.
    if (category && category !== 'any') {
      where.push(
        category === 'wine'
          ? Prisma.sql`COALESCE(s.category, 'wine') = 'wine'`
          : Prisma.sql`s.category = ${category}`,
      )
    }

    // Roles: OR within the facet. Non-taster keys match sm.role directly;
    // 'taster' is the COMPLEMENT (no host/cohost/provider badge — role IS NULL
    // is impossible, so it's "not one of the badge values", incl. legacy/
    // unknown). host_user_id === me is the belt for a host whose mirror row
    // predates the role snapshot (same last-resort as the enrichment fallback).
    if (roles.length > 0) {
      const clauses: Prisma.Sql[] = []
      const badgeValues = roles.flatMap((r) => ROLE_TO_SM[r] ?? [])
      if (badgeValues.length > 0) {
        clauses.push(Prisma.sql`sm.role = ANY(${badgeValues})`)
        if (roles.includes('host')) clauses.push(Prisma.sql`s.host_user_id = ${userId}`)
      }
      if (roles.includes('taster')) {
        clauses.push(
          Prisma.sql`(sm.role NOT IN ('host', 'co_host', 'provider') AND s.host_user_id IS DISTINCT FROM ${userId})`,
        )
      }
      where.push(Prisma.sql`(${Prisma.join(clauses, ' OR ')})`)
    }

    // Hosts: OR within the facet. 'me' = the caller's own hosted moments;
    // 'u:<id>' matches host_user_id; 'n:<name>' matches the anon-host name
    // snapshot (accepting rename drift, per the proposal).
    if (hosts.length > 0) {
      const clauses: Prisma.Sql[] = []
      if (hosts.includes('me')) clauses.push(Prisma.sql`s.host_user_id = ${userId}`)
      const uids = hosts.filter((h) => h.startsWith('u:')).map((h) => Number(h.slice(2))).filter((n) => Number.isInteger(n) && n > 0)
      if (uids.length > 0) clauses.push(Prisma.sql`s.host_user_id = ANY(${uids})`)
      // Scrub + length-cap the free-text anon-host names (NUL byte → P22021
      // 500; host_name is VarChar(64) so anything longer can't match anyway).
      const names = hosts
        .filter((h) => h.startsWith('n:'))
        .map((h) => (scrub(h.slice(2)) ?? '').slice(0, HOST_NAME_MAX))
        .filter(Boolean)
      if (names.length > 0) clauses.push(Prisma.sql`s.host_name = ANY(${names})`)
      if (clauses.length > 0) where.push(Prisma.sql`(${Prisma.join(clauses, ' OR ')})`)
    }

    // People: AND semantics — one EXISTS per selected friend ("the moments
    // Anna AND Tim were both at"). peopleIds is already intersected with the
    // caller's mutual-follow set + block scrub, so this can't probe an
    // arbitrary user's attendance. An empty peopleIds after that scrub (a
    // request for non-friends only) matches nothing — intentional.
    if (people.length > 0) {
      if (peopleIds.length === 0) {
        where.push(Prisma.sql`FALSE`)
      } else {
        for (const pid of peopleIds) {
          where.push(
            // `removed_state` excludes a friend who was KICKED from the session
            // — they aren't a participant there, so "moments Anna was at"
            // shouldn't match a moment Anna was kicked from (matches the live
            // identities hash, which strips kicked users, and the caller's own
            // kicked-drop). kick-delete/ban already dropped the sm2 row.
            Prisma.sql`EXISTS (SELECT 1 FROM session_members sm2 WHERE sm2.session_code = s.code AND sm2.user_id = ${pid} AND sm2.removed_state IS DISTINCT FROM 'kicked')`,
          )
        }
      }
    }

    // Search: accent-insensitive substring OR typo-tolerant trigram, over
    // name + host_name. See the migration for f_unaccent + the threshold.
    // `qLike` escapes the LIKE metacharacters (\ % _) so the substring branch
    // treats `q` as LITERAL text — otherwise a `%` in the query would match
    // everything and a `_` (real: session names like `tasting_with_…`) would
    // match any char. The `\` escape char is declared with ESCAPE. The
    // word_similarity branch is unaffected (it doesn't interpret wildcards), so
    // a metachar-containing query still fuzzy-matches on the raw `q`.
    if (q !== '') {
      const qLike = q.replace(/[\\%_]/g, (c) => `\\${c}`)
      where.push(
        Prisma.sql`(
          f_unaccent(s.name) ILIKE '%' || f_unaccent(${qLike}) || '%' ESCAPE '\'
          OR word_similarity(f_unaccent(${q}), f_unaccent(s.name)) >= ${SIMILARITY}
          OR f_unaccent(s.host_name) ILIKE '%' || f_unaccent(${qLike}) || '%' ESCAPE '\'
          OR word_similarity(f_unaccent(${q}), f_unaccent(s.host_name)) >= ${SIMILARITY}
        )`,
      )
    }

    // Keyset cursor: (effective_date, id) strictly beyond the last row, in the
    // sort direction. A tuple comparison keeps it index-friendly and stable
    // across rows sharing an effective date. The date half is bound back as a
    // ::timestamptz from the FULL-PRECISION `eff_key` text the previous page
    // emitted — NOT a JS Date, which is millisecond-only and would drop/dupe a
    // row whose effective date shares a millisecond but differs in microseconds
    // across the boundary. `eff_key` is `to_char(..'US'..)` (below), so the
    // round-trip value is bit-identical to the stored timestamptz.
    if (cursor) {
      where.push(
        asc
          ? Prisma.sql`(COALESCE(s.date_from, s.created_at), s.id) > (${cursor.effKey}::timestamptz, ${cursor.id})`
          : Prisma.sql`(COALESCE(s.date_from, s.created_at), s.id) < (${cursor.effKey}::timestamptz, ${cursor.id})`,
      )
    }

    const order = asc
      ? Prisma.sql`ORDER BY COALESCE(s.date_from, s.created_at) ASC, s.id ASC`
      : Prisma.sql`ORDER BY COALESCE(s.date_from, s.created_at) DESC, s.id DESC`

    // `eff_key` = the effective sort key rendered to microsecond-precision text
    // (Postgres timestamptz stores µs; JS Date / Prisma only ms). It's the
    // cursor's date half — encoded verbatim, compared verbatim. In GROUP BY so
    // the aggregate is legal. `US` = 6-digit fractional seconds; UTC normalized.
    const effKeySql = Prisma.sql`to_char(COALESCE(s.date_from, s.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
    // Fetch one extra to detect a next page without a COUNT.
    // SCALE NOTE: this aggregates (wine/rating joins + GROUP BY) over the full
    // MATCH set before the LIMIT, so each page recomputes counts across all
    // matching rows. Fine at current scale — every query is scoped to one
    // caller's sessions (WHERE sm.user_id = me), and Postgres applies the ORDER
    // BY + LIMIT so it only materialises what it must. If a single user ever has
    // enough sessions that per-page aggregation hurts, the lever is: select the
    // page's session ids first (keyset + LIMIT, no joins), then join+aggregate
    // only those limit+1 rows. Same "don't pre-optimise a caller-scoped set"
    // posture as the deferred trigram GIN index.
    const page = await prisma.$queryRaw<Array<SessionRow & { eff_key: string }>>`
      SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
             s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url, s.category,
             sm.role AS member_role,
             ${effKeySql} AS eff_key,
             COUNT(DISTINCT w.id) AS wine_count,
             COUNT(DISTINCT r.id) AS wines_rated,
             ROUND(AVG(r.score)::numeric, 1) AS avg_score
      FROM session_members sm
      JOIN sessions s ON s.code = sm.session_code
      LEFT JOIN wines w ON w.session_id = s.id
      LEFT JOIN ratings r ON r.wine_id = w.id AND r.user_id = ${userId}
      WHERE ${Prisma.join(where, ' AND ')}
      GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, sm.role, s.date_from, s.date_to, s.address, s.host_user_id, s.cover_photo_url, s.category
      ${order}
      LIMIT ${limit + 1}
    `
    if (page.length > limit) {
      const last = page[limit - 1]
      nextCursor = encodeCursor(last.eff_key, last.id)
      rows = page.slice(0, limit)
    } else {
      rows = page
    }
    // `eff_key` is a cursor-only helper column — strip it before it reaches the
    // enrichment spread (`{ ...r }`), which would otherwise ship it on every
    // filtered-mode row. Not sensitive (it's the row's own effective date), but
    // it isn't part of the wire contract.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rows = rows.map(({ eff_key, ...rest }: SessionRow & { eff_key?: string }) => rest)
  }

  // ── enrichment (Redis TTL/meta/people) — runs on the returned page ONLY ────
  const codes = rows.map((r) => r.code)
  const memberRows = codes.length
    ? await prisma.$queryRaw<Array<{ code: string; uid: number; name: string | null }>>`
        SELECT sm.session_code AS code, u.id AS uid, u.name
        FROM session_members sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.session_code IN (${Prisma.join(codes)})
          -- Drop members KICKED from the session (removed_state) — the "people
          -- there" list must not re-add someone the live identities hash
          -- already stripped. The people list unions this with liveIdentities;
          -- without this the PG branch resurrects a kicked person the Redis
          -- branch correctly omitted.
          AND sm.removed_state IS DISTINCT FROM 'kicked'
      `
    : []
  const membersByCode = new Map<string, Array<{ id: string; name: string }>>()
  for (const m of memberRows) {
    if (m.name === null) continue
    const list = membersByCode.get(m.code) ?? []
    list.push({ id: `u:${m.uid}`, name: m.name })
    membersByCode.set(m.code, list)
  }
  const blockedIdentity = (id: string) =>
    id.startsWith('u:') && blockedUserIds.has(Number(id.slice(2)))
  // Codes the user dismissed from the highlight carousel — forced to 'past'
  // below so they drop from the carousel (still shown in "All moments").
  // One Redis call for the whole list, not per row.
  const hiddenCarousel = await getHiddenCarousel(userId)
  // Redis cost of this loop (PR #65 review): ~2 commands/row + 2 more per
  // LIVE row. node-redis v4 auto-pipelines same-tick commands, so the wave
  // is a handful of round trips, not N — and the page size bounds it.
  const enriched = await Promise.all(rows.map(async (r) => {
    let ttl_seconds = -2
    let lifespan: string | null = null
    let taster_count: number | null = null
    let participant = false
    let lastSeen = 0
    // Whether the caller is currently kicked from this live session (Redis
    // `s:<C>:kicked`). Kicked rows are dropped from the response below.
    let kicked = false
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
          // participant check, the live host name, AND the people list. The
          // kicked-set SISMEMBER rides the same pipelined wave.
          let kickedNow = false
          ;[liveIdentities, lastSeen, kickedNow] = await Promise.all([
            redis.hGetAll(k.identities(r.code)).then((m) => m ?? {}),
            getLastSeen(r.code, userId),
            redis.sIsMember(k.kicked(r.code), myIdentityId),
          ])
          taster_count = Object.keys(liveIdentities).length
          participant = myIdentityId in liveIdentities
          host_name_live = (hostId ? liveIdentities[hostId] : undefined) ?? null
          // Kicked (kick-keep leaves the session_members row, so the SQL still
          // returns it) → drop the moment from the caller's lists entirely
          // (Simon's ruling: a kicked user shouldn't see the moment in their
          // Moments; they can still rejoin by code/link, which re-adds them to
          // identities and clears the kicked flag). Detectable ONLY while the
          // session is live in Redis — the `s:<C>:kicked` set expires with the
          // session, and there's no Postgres mirror of kick state (durable-
          // sessions territory), so after Redis expiry the moment reappears in
          // history. Accepted, same degradation as the role fallback.
          kicked = kickedNow
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
      _kicked: kicked,
    }
  }))

  // Kicked moments are excluded in SQL now (sm.removed_state = 'kicked', the
  // durable PG mirror) — both the row queries AND the bucket-count query — so
  // counts + lists are EXACT and durable past Redis expiry. The Redis `_kicked`
  // enrichment check is kept as the LIVE BELT for the one gap the durable mirror
  // has: in `sessionWipe`, the Redis kicked-SADD runs BEFORE the Postgres txn,
  // so a kick whose PG write failed leaves Redis=kicked, PG=not — same
  // partial-failure discipline as bans. This filter re-drops such a row from the
  // returned page; the matching count fix-up below keeps the badge consistent
  // with it. Common case (PG mirror set): `_kicked` and the SQL exclusion agree,
  // the row was already SQL-excluded, and this is a no-op.
  const visible = enriched.filter((e) => !e._kicked)
  // Partial-failure belt (see above): the SQL counts already exclude durably-
  // kicked rows, so this only corrects the rare Redis-kicked-but-PG-not window,
  // for the kicked rows that surfaced in the enriched page.
  if (upcomingTotal !== null || pastTotal !== null) {
    for (const e of enriched) {
      if (!e._kicked) continue
      const up = e.date_from !== null && new Date(e.date_from).getTime() > Date.now()
      if (up && upcomingTotal !== null) upcomingTotal = Math.max(0, upcomingTotal - 1)
      else if (!up && pastTotal !== null) pastTotal = Math.max(0, pastTotal - 1)
    }
  }
  // Sort: legacy mode re-sorts by live activity (carousel floats "just
  // visited" up — index.tsx depends on this). Filtered mode keeps the SQL
  // date order (already the client's per-list order) so pagination stays
  // stable across pages — a JS re-sort here would only reorder within a page
  // and break the cursor's monotonicity across page boundaries.
  if (!filtered) visible.sort((a, b) => b._lastActiveMs - a._lastActiveMs)
  // Strip the internal keys before sending.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const body = visible.map(({ _lastActiveMs, _kicked, ...rest }) => rest)

  // Viewer-dependent body (role, own counts) — never shared-cacheable. The
  // opaque nextCursor + true bucket totals ride headers so the body stays a
  // bare array in both modes (the home screen consumes the array shape directly).
  const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' }
  if (nextCursor) headers['X-Next-Cursor'] = nextCursor
  // True full-history bucket totals (unfiltered path) — the home nav rows gate
  // on these, not the capped page. Exact for DURABLY-kicked moments: the count
  // query excludes `sm.removed_state = 'kicked'` in SQL regardless of whether
  // the session is in the 50-row page. The only residual is the rare
  // Redis-kicked-but-PG-not partial-failure window (kicked SADD precedes the PG
  // txn in sessionWipe) — the page-scoped correction above patches those rows
  // that surfaced in the page; a same-window session OUTSIDE the page can
  // over-count by one until the PG mirror catches up (self-heals on the next
  // sessionWipe retry). Common case (mirror consistent) the count is exact.
  if (upcomingTotal !== null) headers['X-Upcoming-Total'] = String(upcomingTotal)
  if (pastTotal !== null) headers['X-Recent-Total'] = String(pastTotal)
  return NextResponse.json(body, { headers })
}

// ── row type + cursor helpers ────────────────────────────────────────────────
type SessionRow = {
  id: number; code: string; host_name: string; name: string | null
  created_at: Date; joined_at: Date; wines_rated: bigint; avg_score: number | null
  date_from: Date | null; date_to: Date | null; address: string | null
  host_user_id: number | null; wine_count: bigint
  cover_photo_url: string | null
  category: string | null
  member_role: string
}

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE
  return Math.min(Math.floor(n), MAX_PAGE)
}

// Cursor = "<effKeyIso>.<id>", base64url'd so it's opaque on the wire. Both
// halves are needed: `effKey` is the µs-precision effective-date sort key (an
// ISO-8601 string straight from `to_char`, bound back as ::timestamptz), `id`
// is the stable tiebreak within a shared date. The id is base64'd LAST so a `.`
// can't appear after it — the effKey has a fixed shape with exactly one `.`
// (the fractional-seconds separator), so we split on the LAST dot.
function encodeCursor(effKey: string, id: number): string {
  return Buffer.from(`${effKey}.${id}`).toString('base64url')
}

function parseCursor(raw: string | null): { effKey: string; id: number } | null {
  if (!raw) return null
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const dot = decoded.lastIndexOf('.')
    if (dot < 0) return null
    const effKey = decoded.slice(0, dot)
    const id = Number(decoded.slice(dot + 1))
    // effKey must look like the to_char output — an ISO instant. Validate by
    // shape + parseability so a forged cursor can't inject arbitrary text into
    // the ::timestamptz bind (it's parameterized, but a garbage value would
    // still error; reject early to a clean "no cursor" instead).
    if (!Number.isInteger(id) || id <= 0) return null
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(effKey)) return null
    return { effKey, id }
  } catch {
    return null
  }
}
