// The profile tile lists (lists plan D10): someone's (or your own) Impressions,
// Moments and Cravings. Every loader takes the `ok` gate (REQUIRED: the post
// census gate can't see these `ratings` / `bookmarks` / `session_members`
// reads, scripts/check-post-reads.mjs), and what a bottle shows outside its
// moment is the one SQL rule (lib/outsideView.ts, D4).
//
// 🔒 D7: each tile COUNT is the count of exactly the rows its list shows that
// viewer, over the SAME base WHERE (impressionsCount / cravingsCount below),
// so a tile never shows more than its list.
//
// 🔒 Search, filters and sorts read only fields the row shows: a blind row
// matches its moment name only, and "both had" never counts a blind row. The
// structure + aroma filters read the rating's own perception, which their POST
// shows (never redacted, blind included), so on someone else's list they only
// match rows with a post.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { decimalToNumber, axisNeedsSparkling, type AromaFilterMatch } from '@verre/core'
import { cravingSessionIdSql, hiddenSql, redactedSql } from '@/lib/outsideView'
import type { ProfileGateOk } from '@/lib/profileVisibility'
import { encodeKeyCursor, parseKeyCursor, usKeySql } from '@/lib/keyCursor'
import { encodeImpressionsCursor, isScoreSort, parseImpressionsCursor, type ImpressionSort, type ImpressionsCursor } from '@/lib/impressionsCursor'
import { openCravingsCursor, sealCravingsCursor, type CravingsCursor, type CravingsSort } from '@/lib/cravingsCursor'
import { momentFacetWhere, type MomentFacets } from '@/lib/momentFacets'

const PAGE = 30
const SIMILARITY = 0.3

// The post a rating belongs to, defined ONCE (D10): a session rating's =
// feed_items (user_id, session_id) (unique), a standalone's =
// feed_items.rating_id. `had_at` = the post's created_at (anchored at first
// engagement, so a moment's ratings group together; every in-moment re-rate
// resets rated_at), falling back to rated_at.
const POST_JOINS = Prisma.sql`
  LEFT JOIN feed_items fis ON fis.user_id = r.user_id AND fis.session_id = r.session_id AND fis.kind = 'session'
  LEFT JOIN feed_items fic ON fic.rating_id = r.id`
const POST_ID = Prisma.sql`COALESCE(fis.id, fic.id)`
const HAD_AT = Prisma.sql`COALESCE(fis.created_at, fic.created_at, r.rated_at)`

// Accent-insensitive substring OR typo-tolerant trigram on one column.
function textMatch(col: Prisma.Sql, q: string): Prisma.Sql {
  const qLike = q.replace(/[\\%_]/g, c => `\\${c}`)
  return Prisma.sql`COALESCE(f_unaccent(${col}) ILIKE '%' || f_unaccent(${qLike}) || '%' ESCAPE '\\'
    OR word_similarity(f_unaccent(${q}), f_unaccent(${col})) >= ${SIMILARITY}, false)`
}

// ── Impressions ─────────────────────────────────────────────────────────────

// Base: the owner's ratings minus those hidden from the viewer. Aliases r / w / s.
const impressionsBase = Prisma.sql`
  FROM ratings r
  JOIN wines w ON w.id = r.wine_id
  LEFT JOIN sessions s ON s.id = r.session_id`
const impressionsWhere = (ownerId: number, viewerId: number | null) =>
  Prisma.sql`r.user_id = ${ownerId} AND NOT ${hiddenSql(viewerId, 's')}`

export async function impressionsCount(ownerId: number, viewerId: number | null): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${impressionsBase} WHERE ${impressionsWhere(ownerId, viewerId)}`
  return rows[0]?.n ?? 0
}

export type ImpressionFilters = {
  q: string
  from: Date | null
  to: Date | null
  category: string | null
  min: number | null
  max: number | null
  /** Their structure ranges: whole 0..5 per axis key, lo ≤ hi. */
  structure: { k: string; lo: number; hi: number }[]
  /** Their aroma picks (core aromaFilterMatch), all or any of them. */
  aromas: AromaFilterMatch[]
  aromaMode: 'all' | 'any'
  common: boolean
  sort: ImpressionSort
  cursor: string | null
}

// A structure range on one axis (Filter Impressions, ruled 2026-11-14): the
// rating must carry the axis (0 = perceived None counts, an absent key does
// not: nobody rated it) with a value inside the range. An axis only a
// sparkling bottle has (Bubbles) also needs the bottle to be sparkling NOW
// (`w.sparkling`, its snapshot; catalogue model change step 4): the post's
// wheel draws the bottle's current axes, and a session wine re-typed from
// sparkling keeps its ratings' bubbles value (Codex review, 2026-11-14).
function structureSql(s: { k: string; lo: number; hi: number }): Prisma.Sql {
  return Prisma.sql`(jsonb_typeof(r.flavors -> ${s.k}::text) = 'number'
    AND (r.flavors ->> ${s.k}::text)::numeric BETWEEN ${s.lo} AND ${s.hi}
    ${axisNeedsSparkling(s.k) ? Prisma.sql`AND w.sparkling` : Prisma.empty})`
}

// One aroma pick: some stored selection satisfies it (core/aroma/filter.ts is
// the rule; aromaPickMatches is this predicate's twin, pinned by units).
function aromaSql(a: AromaFilterMatch): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.aromas) = 'array' THEN r.aromas ELSE '[]'::jsonb END) e
     WHERE (((e ->> 'a') = ANY(${a.ids}::text[]) AND (${a.m}::text IS NULL OR (e ->> 'm') = ${a.m}::text))
            OR (e ->> 'a') = ANY(${a.promotedIds}::text[]))
       AND (NOT ${a.pronounced}::boolean OR (e -> 'p') = 'true'::jsonb))`
}

// The sorts (Simon, 2026-11-14): by when they had it either way, or by their
// score either way (unrated last in both; a tie newest first). The score is on
// every row, blind ones included, so sorting by it shows nothing new.
const SCORE_KEY = Prisma.sql`NULLIF(r.score, 0)`
function impressionsOrder(sort: ImpressionSort): Prisma.Sql {
  if (sort === 'oldest') return Prisma.sql`ORDER BY ${HAD_AT} ASC, r.id ASC`
  if (sort === 'highest') return Prisma.sql`ORDER BY ${SCORE_KEY} DESC NULLS LAST, ${HAD_AT} DESC, r.id DESC`
  if (sort === 'lowest') return Prisma.sql`ORDER BY ${SCORE_KEY} ASC NULLS LAST, ${HAD_AT} DESC, r.id DESC`
  return Prisma.sql`ORDER BY ${HAD_AT} DESC, r.id DESC`
}
// Strictly after the cursor's row in that order. A score sort's unrated rows
// come last, so a scored cursor lets every unrated row through and an unrated
// one pages on the date alone.
function impressionsAfter(sort: ImpressionSort, c: ImpressionsCursor): Prisma.Sql {
  const at = Prisma.sql`(${HAD_AT}, r.id)`
  const key = Prisma.sql`(${c.key}::timestamptz, ${c.id})`
  if (sort === 'oldest') return Prisma.sql`${at} > ${key}`
  if (!isScoreSort(sort)) return Prisma.sql`${at} < ${key}`
  if (c.cents === null) return Prisma.sql`(${SCORE_KEY} IS NULL AND ${at} < ${key})`
  const cents = Prisma.sql`${SCORE_KEY} * 100`
  const beyond = sort === 'highest' ? Prisma.sql`${cents} < ${c.cents}` : Prisma.sql`${cents} > ${c.cents}`
  return Prisma.sql`(${beyond} OR (${cents} = ${c.cents} AND ${at} < ${key}) OR ${SCORE_KEY} IS NULL)`
}

export type ImpressionRow = {
  id: number
  postId: number | null
  wineId: string
  name: string
  vintage: string | null
  producer: string | null
  type: string | null
  category: string
  imageUrl: string | null
  score: number | null
  hadAt: string
  blind?: true
  momentName?: string
  yourScore?: number | null
}

export async function loadImpressions(
  ownerId: number, gate: ProfileGateOk, f: ImpressionFilters,
): Promise<{ items: ImpressionRow[]; nextCursor: string | null; commonCount?: number }> {
  if (!gate.sees.posts) return { items: [], nextCursor: null }
  const viewerId = gate.viewer.id
  const other = viewerId !== null && viewerId !== ownerId ? viewerId : null
  const redacted = redactedSql(viewerId, 's', 'w')
  const where: Prisma.Sql[] = [impressionsWhere(ownerId, viewerId)]
  if (f.from) where.push(Prisma.sql`${HAD_AT} >= ${f.from}`)
  if (f.to) where.push(Prisma.sql`${HAD_AT} <= ${f.to}`)
  if (f.category) where.push(Prisma.sql`w.category = ${f.category}`)
  if (f.min !== null) where.push(Prisma.sql`r.score >= ${f.min}`)
  if (f.max !== null) where.push(Prisma.sql`r.score <= ${f.max}`)
  for (const s of f.structure) where.push(structureSql(s))
  if (f.aromas.length > 0) where.push(Prisma.sql`(${Prisma.join(f.aromas.map(aromaSql), f.aromaMode === 'any' ? ' OR ' : ' AND ')})`)
  // Their structure and aromas show on their POST (blind ones too: the
  // taster's own perception), not on the row: on someone else's list these
  // two filters only match a row that has one.
  if (other !== null && (f.structure.length > 0 || f.aromas.length > 0)) where.push(Prisma.sql`${POST_ID} IS NOT NULL`)
  if (f.q) {
    where.push(Prisma.sql`((NOT ${redacted} AND (${textMatch(Prisma.sql`w.name`, f.q)} OR ${textMatch(Prisma.sql`w.producer`, f.q)}))
      OR (s.deleted_at IS NULL AND ${textMatch(Prisma.sql`s.name`, f.q)}))`)
  }
  const yours = Prisma.sql`EXISTS (SELECT 1 FROM ratings yr WHERE yr.user_id = ${other}::integer AND yr.wine_id = r.wine_id)`
  if (f.common && other !== null) where.push(Prisma.sql`NOT ${redacted} AND ${yours}`)
  const cursor = f.cursor ? parseImpressionsCursor(f.cursor, f.sort) : null
  if (f.cursor && !cursor) return { items: [], nextCursor: null }
  if (cursor) where.push(impressionsAfter(f.sort, cursor))

  const rows = await prisma.$queryRaw<{
    id: number; post_id: number | null; wine_id: string; name: string; vintage: string | null; producer: string | null
    style: string | null; category: string; image_url: string | null; score: Prisma.Decimal | null; had_at: Date
    had_key: string; score_cents: number | null; redacted: boolean; moment_name: string | null; your_score: Prisma.Decimal | null; in_session: boolean
  }[]>`
    SELECT r.id, ${POST_ID} AS post_id, r.wine_id, w.name, w.vintage, w.producer, w.style, w.category,
           COALESCE((SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = r.id ORDER BY ri.sort_order ASC LIMIT 1), w.image_url) AS image_url,
           r.score, ${HAD_AT} AS had_at, ${usKeySql(HAD_AT)} AS had_key, (${SCORE_KEY} * 100)::int AS score_cents, ${redacted} AS redacted,
           CASE WHEN s.deleted_at IS NULL THEN s.name END AS moment_name,
           (r.session_id IS NOT NULL) AS in_session,
           ${other !== null
             ? Prisma.sql`(SELECT yr.score FROM ratings yr WHERE yr.user_id = ${other} AND yr.wine_id = r.wine_id ORDER BY yr.rated_at DESC, yr.id DESC LIMIT 1)`
             : Prisma.sql`NULL::numeric`} AS your_score
    ${impressionsBase}
    ${POST_JOINS}
    WHERE ${Prisma.join(where, ' AND ')}
    ${impressionsOrder(f.sort)}
    LIMIT ${PAGE + 1}`
  const more = rows.length > PAGE
  const page = more ? rows.slice(0, PAGE) : rows
  const items = page.map((r): ImpressionRow => {
    // A NULL flag (never by construction) reads as the closed side.
    const blind = r.redacted !== false
    const momentName = r.in_session && r.moment_name ? r.moment_name : undefined
    return {
      id: r.id,
      postId: r.post_id,
      wineId: r.wine_id,
      name: blind ? '' : r.name,
      vintage: blind ? null : r.vintage,
      producer: blind ? null : r.producer,
      type: r.style,
      category: r.category,
      imageUrl: blind ? null : r.image_url,
      score: positive(r.score),
      hadAt: r.had_at.toISOString(),
      ...(blind ? { blind: true as const } : {}),
      ...(momentName ? { momentName } : {}),
      ...(other !== null ? { yourScore: blind ? null : positive(r.your_score) } : {}),
    }
  })
  const last = page[page.length - 1]
  const nextCursor = more && last ? encodeImpressionsCursor(f.sort, { key: last.had_key, id: last.id, cents: last.score_cents }) : null
  if (other === null || f.cursor) return { items, nextCursor }
  const common = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${impressionsBase}
    WHERE ${impressionsWhere(ownerId, viewerId)} AND NOT ${redacted} AND ${yours}`
  return { items, nextCursor, commonCount: common[0]?.n ?? 0 }
}

// 0 = "not rated" (root CLAUDE.md § Score system).
function positive(v: Prisma.Decimal | null): number | null {
  const n = decimalToNumber(v)
  return n !== null && n > 0 ? n : null
}

// ── Cravings ────────────────────────────────────────────────────────────────

// Base: the owner's bookmarks on the craving's moment (the bottle's own, else
// a session rating's), minus hidden for the viewer; on someone else's list
// also minus blind-for-you and minus no-moment-found (D6). Aliases b / w / s.
// saved_at in exact epoch microseconds (EXTRACT returns numeric): the sealed
// cursor's key, compared in µs so no float rounds it.
const AT_US = Prisma.sql`(EXTRACT(EPOCH FROM b.saved_at) * 1000000)::bigint`
const cravingsBase = Prisma.sql`
  FROM bookmarks b
  JOIN wines w ON w.id = b.wine_id
  LEFT JOIN sessions s ON s.id = ${cravingSessionIdSql('w')}`
function cravingsWhere(ownerId: number, viewerId: number | null): Prisma.Sql {
  const own = viewerId !== null && viewerId === ownerId
  const base = Prisma.sql`b.user_id = ${ownerId} AND NOT ${hiddenSql(viewerId, 's')}`
  return own ? base : Prisma.sql`${base} AND s.id IS NOT NULL AND NOT ${redactedSql(viewerId, 's', 'w')}`
}

export async function cravingsCount(ownerId: number, viewerId: number | null): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${cravingsBase} WHERE ${cravingsWhere(ownerId, viewerId)}`
  return rows[0]?.n ?? 0
}

export type CravingRow = {
  key?: string
  wineId: string
  postId: number | null
  name: string
  vintage: string | null
  producer: string | null
  type: string | null
  imageUrl: string | null
  score: number | null
  blind?: true
  momentName?: string
}

export async function loadCravings(
  ownerId: number, gate: ProfileGateOk, opts: { q: string; sort: CravingsSort; cursor: string | null },
): Promise<{ items: CravingRow[]; nextCursor: string | null }> {
  if (!gate.sees.cravings) return { items: [], nextCursor: null }
  const viewerId = gate.viewer.id
  const own = viewerId !== null && viewerId === ownerId
  // Their scores (and so their posts) only through the post gate; your own always.
  const showScores = own || gate.sees.posts
  // 🔒 Without the post gate a score sort is served as recent: the order would
  // otherwise reveal the hidden scores. The cursor seals the sort APPLIED.
  const sort: CravingsSort = opts.sort === 'score' && showScores ? 'score' : 'recent'
  const redacted = redactedSql(viewerId, 's', 'w')
  const score = showScores ? Prisma.sql`NULLIF(orr.score, 0)` : Prisma.sql`NULL::numeric`
  const where: Prisma.Sql[] = [cravingsWhere(ownerId, viewerId)]
  if (opts.q) {
    const named = Prisma.sql`(${textMatch(Prisma.sql`w.name`, opts.q)} OR ${textMatch(Prisma.sql`w.producer`, opts.q)})`
    // Someone else's rows carry no moment, so search never reads one there.
    where.push(own
      ? Prisma.sql`((NOT ${redacted} AND ${named}) OR (s.deleted_at IS NULL AND ${textMatch(Prisma.sql`s.name`, opts.q)}))`
      : named)
  }
  const viewerKey = viewerId ?? 0
  const scope = { viewerId: viewerKey, ownerId, sort, q: opts.q }
  let after: CravingsCursor | null = null
  if (opts.cursor) {
    after = openCravingsCursor(opts.cursor, scope)
    if (!after) return { items: [], nextCursor: null }
  }
  if (after?.sort === 'recent') {
    where.push(Prisma.sql`(${AT_US}, b.id) < (${after.atUs.toString()}::bigint, ${after.id})`)
  } else if (after?.sort === 'score') {
    // 🔒 NULL-aware: a tuple compare with a NULL is NULL, so pages would skip
    // or repeat at the scored / unscored boundary.
    where.push(after.quarters === null
      ? Prisma.sql`(${score} IS NULL AND b.id < ${after.id})`
      : Prisma.sql`(${score} < ${after.quarters}::numeric / 4 OR (${score} = ${after.quarters}::numeric / 4 AND b.id < ${after.id}) OR ${score} IS NULL)`)
  }
  const order = sort === 'score'
    ? Prisma.sql`ORDER BY ${score} DESC NULLS LAST, b.id DESC`
    : Prisma.sql`ORDER BY b.saved_at DESC, b.id DESC`
  const rows = await prisma.$queryRaw<{
    id: number; wine_id: string; name: string; vintage: string | null; producer: string | null; style: string | null
    wine_image: string | null; rating_image: string | null; score: Prisma.Decimal | null; post_id: number | null
    at_us: string; redacted: boolean; moment_name: string | null
  }[]>`
    SELECT b.id, b.wine_id, w.name, w.vintage, w.producer, w.style, w.image_url AS wine_image,
           (SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = orr.id ORDER BY ri.sort_order ASC LIMIT 1) AS rating_image,
           ${score} AS score,
           ${showScores ? Prisma.sql`fp.id` : Prisma.sql`NULL::integer`} AS post_id,
           ${AT_US}::text AS at_us,
           ${redacted} AS redacted,
           CASE WHEN s.deleted_at IS NULL THEN s.name END AS moment_name
    ${cravingsBase}
    LEFT JOIN LATERAL (
      SELECT o.id, o.score, o.session_id FROM ratings o
       WHERE o.user_id = ${ownerId} AND o.wine_id = b.wine_id
       ORDER BY o.rated_at DESC, o.id DESC LIMIT 1
    ) orr ON true
    LEFT JOIN feed_items fp ON fp.user_id = ${ownerId} AND fp.session_id = orr.session_id AND fp.kind = 'session'
    WHERE ${Prisma.join(where, ' AND ')}
    ${order}
    LIMIT ${PAGE + 1}`
  const more = rows.length > PAGE
  const page = more ? rows.slice(0, PAGE) : rows
  const items = page.map((r): CravingRow => {
    const blind = r.redacted !== false
    const scoreN = decimalToNumber(r.score)
    if (!own) {
      return {
        wineId: r.wine_id, postId: r.post_id, name: r.name, vintage: r.vintage, producer: r.producer,
        type: r.style, imageUrl: r.wine_image, score: scoreN,
      }
    }
    return {
      key: r.wine_id,
      wineId: r.wine_id,
      postId: r.post_id,
      name: blind ? '' : r.name,
      vintage: blind ? null : r.vintage,
      producer: blind ? null : r.producer,
      type: r.style,
      imageUrl: blind ? null : (r.wine_image ?? r.rating_image),
      score: scoreN,
      ...(blind ? { blind: true as const } : {}),
      ...(r.moment_name ? { momentName: r.moment_name } : {}),
    }
  })
  const last = page[page.length - 1]
  let nextCursor: string | null = null
  if (more && last) {
    const scoreN = decimalToNumber(last.score)
    nextCursor = sealCravingsCursor(
      sort === 'recent'
        ? { sort, atUs: BigInt(last.at_us), id: last.id }
        : { sort, quarters: scoreN === null ? null : Math.round(scoreN * 4), id: last.id },
      scope,
    )
  }
  return { items, nextCursor }
}

// ── Someone's Moments (D5) ──────────────────────────────────────────────────

// 🔒 Join safety: ONLY moments you share (both member rows, neither kicked,
// the moment live, upcoming included) and, as a belt, no ban of yours. A
// moment you're not in (or were kicked from) is never a row, a name or a code;
// it is only counted in `otherCount`. Aliases s / sm (theirs) / mine.
const sharedSql = (viewerId: number) => Prisma.sql`(
  EXISTS (SELECT 1 FROM session_members mine
           WHERE mine.session_code = s.code AND mine.user_id = ${viewerId} AND mine.removed_state IS DISTINCT FROM 'kicked')
  AND NOT EXISTS (SELECT 1 FROM session_bans vb WHERE vb.session_code = s.code AND vb.identity_id = ${`u:${viewerId}`}))`
const theirMemberships = (ownerId: number) => Prisma.sql`
  FROM session_members sm
  JOIN sessions s ON s.code = sm.session_code
  WHERE sm.user_id = ${ownerId} AND s.deleted_at IS NULL AND sm.removed_state IS DISTINCT FROM 'kicked'`

// The app's SessionRole (RoleChip), mapped exactly as /api/me/sessions does.
export type MomentRole = 'host' | 'cohost' | 'provider' | null
export type SharedMomentRow = {
  code: string
  name: string | null
  dateFrom: string | null
  dateTo: string | null
  createdAt: string | null
  address: string | null
  coverPhotoUrl: string | null
  category: string | null
  role: MomentRole
}

export async function loadSharedMoments(
  ownerId: number, gate: ProfileGateOk, viewerId: number,
  opts: { facets: MomentFacets; blockedUserIds: Set<number>; cursor: string | null; limit: number },
): Promise<{ items: SharedMomentRow[]; nextCursor: string | null; otherCount?: number }> {
  if (!gate.sees.moments) return { items: [], nextCursor: null }
  const where: Prisma.Sql[] = [sharedSql(viewerId)]
  where.push(...await momentFacetWhere(opts.facets, { subjectId: ownerId, viewerId, blockedUserIds: opts.blockedUserIds }))
  const cursor = parseKeyCursor(opts.cursor)
  if (opts.cursor && !cursor) return { items: [], nextCursor: null }
  const eff = Prisma.sql`COALESCE(s.date_from, s.created_at)`
  if (cursor) where.push(Prisma.sql`(${eff}, s.id) < (${cursor.key}::timestamptz, ${cursor.id})`)
  const rows = await prisma.$queryRaw<{
    id: number; code: string; name: string | null; date_from: Date | null; date_to: Date | null; created_at: Date | null
    address: string | null; cover_photo_url: string | null; category: string | null; member_role: string
    host_user_id: number | null; eff_key: string
  }[]>`
    SELECT s.id, s.code,
           -- A nameless moment (before the required-name rule) reads as its
           -- host's name, as your own list does (r.name || r.host_name).
           COALESCE(NULLIF(s.name, ''), s.host_name) AS name,
           s.date_from, s.date_to, s.created_at, s.address, s.cover_photo_url, s.category,
           sm.role AS member_role, s.host_user_id, ${usKeySql(eff)} AS eff_key
    ${theirMemberships(ownerId)} AND ${Prisma.join(where, ' AND ')}
    ORDER BY ${eff} DESC, s.id DESC
    LIMIT ${opts.limit + 1}`
  const more = rows.length > opts.limit
  const page = more ? rows.slice(0, opts.limit) : rows
  const items = page.map((r): SharedMomentRow => ({
    code: r.code,
    name: r.name,
    dateFrom: r.date_from?.toISOString() ?? null,
    dateTo: r.date_to?.toISOString() ?? null,
    createdAt: r.created_at?.toISOString() ?? null,
    address: r.address,
    coverPhotoUrl: r.cover_photo_url,
    category: r.category,
    role: r.member_role === 'host' ? 'host'
      : r.member_role === 'co_host' ? 'cohost'
      : r.member_role === 'provider' ? 'provider'
      : r.host_user_id === ownerId ? 'host'
      : null,
  }))
  const last = page[page.length - 1]
  const nextCursor = more && last ? encodeKeyCursor(last.eff_key, last.id) : null
  if (opts.cursor) return { items, nextCursor }
  // Their memberships minus the shared ones, unfiltered (the closing line).
  const other = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${theirMemberships(ownerId)} AND NOT ${sharedSql(viewerId)}`
  return { items, nextCursor, otherCount: other[0]?.n ?? 0 }
}
