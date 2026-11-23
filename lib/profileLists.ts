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
import { hiddenSql, redactedSql } from '@/lib/outsideView'
import { cravingKey, ownerCravingsSql, ownerWasThereSql, viewerSeesSql } from '@/lib/cravings'
import { viewerCanSeePosts } from '@/lib/profileVisibility'
import { entryKey, loadEntriesSoft, tombstoneMapSql } from '@/lib/catalogEntries'
import { entryYear } from '@/lib/wineDisplay'
import type { ProfileGateOk } from '@/lib/profileVisibility'
import { encodeKeyCursor, parseKeyCursor, usKeySql } from '@/lib/keyCursor'
import { encodeImpressionsCursor, isScoreSort, parseImpressionsCursor, type ImpressionSort, type ImpressionsCursor } from '@/lib/impressionsCursor'
import { openCravingsCursor, sealCravingsCursor, type CravingsCursor, type CravingsSort } from '@/lib/cravingsCursor'
import { momentFacetWhere, resolveFacets, type MomentFacets, type OpenRowsNaming } from '@/lib/momentFacets'
import { decideMoments, sharedMomentSql } from '@/lib/momentAudience'
import { momentLookInEnabled } from '@/lib/momentGate'
import { coverOutsideSql } from '@/lib/profileTiles'

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
  // The rating's id: the row's key, and what finds the row in its post
  // (`ratingId` there).
  id: number
  postId: number | null
  // 🔒 Absent on a blind row of someone else's list (label identity).
  wineId?: string
  name: string
  vintage: string | null
  producer: string | null
  type: string | null
  // The bottle's kind (its snapshot, like the style): a sparkling rosé is both
  // (step 7, Simon 2026-11-21: the app's list labels it like everywhere else).
  // Kept on a blind row, as the style always was (not identity).
  colour: string | null
  sparkling: boolean
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
  const own = viewerId !== null && viewerId === ownerId
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
    style: string | null; colour: string | null; sparkling: boolean; category: string; image_url: string | null; score: Prisma.Decimal | null; had_at: Date; product_id: string | null; vintage_id: string | null
    had_key: string; score_cents: number | null; redacted: boolean; moment_name: string | null; your_score: Prisma.Decimal | null; in_session: boolean
  }[]>`
    SELECT r.id, ${POST_ID} AS post_id, r.wine_id, w.name, w.vintage, w.producer, w.style, w.colour, w.sparkling, w.category, w.product_id, w.vintage_id,
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
  // A visible bottle shows its catalogue entry (merges followed), else its
  // snapshot; a blind row never reads it.
  const entries = await loadEntriesSoft(page.filter(r => r.redacted === false).map(r => ({ productId: r.product_id, vintageId: r.vintage_id })))
  const items = page.map((r): ImpressionRow => {
    // A NULL flag (never by construction) reads as the closed side.
    const blind = r.redacted !== false
    const e = !blind && r.product_id ? entries.get(entryKey(r.product_id, r.vintage_id)) : undefined
    const momentName = r.in_session && r.moment_name ? r.moment_name : undefined
    return {
      id: r.id,
      postId: r.post_id,
      ...(!blind || own ? { wineId: r.wine_id } : {}),
      name: blind ? '' : e?.name ?? r.name,
      vintage: blind ? null : e ? (entryYear(e) || null) : r.vintage,
      producer: blind ? null : e?.producer ?? r.producer,
      // 🔒 A legacy alcohol-free token is the alcohol-free mark: none on a blind
      // row (ruled 2026-11-20; review r1 of step 7: the feed nulled it, this
      // list didn't).
      type: blind && r.style === 'nonalc' ? null : r.style,
      colour: r.colour,
      sparkling: r.sparkling,
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

// Base: the owner's SHOWN cravings (lib/cravings.ts ownerCravingsSql: their
// real cravings not hidden for them and the blind saves that count as one, one
// row per wine), with the row's bottle `w` and moment `s`; on someone else's
// view also minus what is hidden for the viewer (catalogue model change § 5:
// a craving whose source is hidden is LEFT OUT, never a blind row).
// saved_at in exact epoch microseconds (EXTRACT returns numeric): the sealed
// cursor's key, compared in µs so no float rounds it; `oc.sk` the tiebreak.
const AT_US = Prisma.sql`(EXTRACT(EPOCH FROM oc.saved_at) * 1000000)::bigint`
const cravingsBase = (ownerId: number) => Prisma.sql`FROM (${ownerCravingsSql(ownerId)}) oc
  LEFT JOIN wines w ON w.id = oc.wine_id
  LEFT JOIN sessions s ON s.id = oc.sid`
const cravingsWhere = (ownerId: number, viewerId: number | null) =>
  (viewerId !== null && viewerId === ownerId ? Prisma.sql`TRUE` : viewerSeesSql(viewerId))

export async function cravingsCount(ownerId: number, viewerId: number | null): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${cravingsBase(ownerId)} WHERE ${cravingsWhere(ownerId, viewerId)}`
  return rows[0]?.n ?? 0
}

// 🔒 `key` (the remove handle: `DELETE /api/me/bookmarks/<key>`) on YOUR OWN
// list only: on someone else's a craving id would be a coarse save time, the
// reason the cursor is sealed (ruled 2026-11-20). `wineId` = the row's bottle,
// while there is one. A row from a moment its owner was not in (saved from
// someone's post) shows that bottle's id and photo only to a viewer who may see
// that post, the owner included (ruled 2026-11-20). Shape agreed with Moment
// Visibility step 3 (.local/moment-visibility/cravings-row-shape-2026-11-20.md).
export type CravingRow = {
  key?: string
  wineId?: string
  postId: number | null
  // The rating its score and post come from (beside a post only).
  ratingId?: number
  name: string
  vintage: string | null
  producer: string | null
  type: string | null
  colour: string | null
  sparkling: boolean
  imageUrl: string | null
  score: number | null
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
  const score = showScores ? Prisma.sql`NULLIF(COALESCE(rv.score, rp.score, rw.score), 0)` : Prisma.sql`NULL::numeric`
  const where: Prisma.Sql[] = [cravingsWhere(ownerId, viewerId)]
  if (opts.q) {
    const named = Prisma.sql`(${textMatch(Prisma.sql`COALESCE(oc.name, w.name)`, opts.q)} OR ${textMatch(Prisma.sql`COALESCE(oc.producer, w.producer)`, opts.q)})`
    // Someone else's rows carry no moment, so search never reads one there.
    where.push(own ? Prisma.sql`(${named} OR (s.deleted_at IS NULL AND ${ownerWasThereSql(ownerId)} AND ${textMatch(Prisma.sql`s.name`, opts.q)}))` : named)
  }
  const viewerKey = viewerId ?? 0
  const scope = { viewerId: viewerKey, ownerId, sort, q: opts.q }
  let after: CravingsCursor | null = null
  if (opts.cursor) {
    after = openCravingsCursor(opts.cursor, scope)
    if (!after) return { items: [], nextCursor: null }
  }
  if (after?.sort === 'recent') {
    where.push(Prisma.sql`(${AT_US}, oc.sk) < (${after.atUs.toString()}::bigint, ${after.id}::bigint)`)
  } else if (after?.sort === 'score') {
    // 🔒 NULL-aware: a tuple compare with a NULL is NULL, so pages would skip
    // or repeat at the scored / unscored boundary.
    where.push(after.quarters === null
      ? Prisma.sql`(${score} IS NULL AND oc.sk < ${after.id}::bigint)`
      : Prisma.sql`(${score} < ${after.quarters}::numeric / 4 OR (${score} = ${after.quarters}::numeric / 4 AND oc.sk < ${after.id}::bigint) OR ${score} IS NULL)`)
  }
  const order = sort === 'score'
    ? Prisma.sql`ORDER BY ${score} DESC NULLS LAST, oc.sk DESC`
    : Prisma.sql`ORDER BY oc.saved_at DESC, oc.sk DESC`
  // The owner's latest rating of THIS WINE at the craving's grain (a vintage's
  // craving: that vintage; "any year": any of them; merges followed), that the
  // outside rule shows the owner AND the viewer (a rating of "Wine N" would say
  // what it is); a legacy unlinked craving: its source bottle's. Its score, its
  // post and its photo. The owner's ratings are read ONCE (`rk`, each with its
  // effective wine through ONE tombstone walk, `pm` / `vm`), reduced to the
  // latest per grain, and hash-joined to the cravings (measured: a per-craving
  // subquery cost ~0.14 ms a row, and a per-row merge walk pushed the plan past
  // Postgres' JIT threshold, ~60 ms of compiling).
  const ratingVisible = (v: number | null) => Prisma.sql`NOT ${hiddenSql(v, 'os')} AND NOT ${redactedSql(v, 'os', 'ow')}`
  const rows = await prisma.$queryRaw<{
    kind: string; id: number; sk: bigint; wine_id: string | null; product_id: string | null; vintage_id: string | null
    name: string | null; vintage: string | null; producer: string | null; style: string | null; colour: string | null; sparkling: boolean | null
    wine_image: string | null; rating_image: string | null; score: Prisma.Decimal | null; post_id: number | null; rating_id: number | null
    at_us: string; moment_name: string | null; was_there: boolean | null; item_author: number | null
  }[]>`
    WITH mine_p AS (
      SELECT DISTINCT ow.product_id AS id FROM ratings o JOIN wines ow ON ow.id = o.wine_id WHERE o.user_id = ${ownerId} AND ow.product_id IS NOT NULL
    ), mine_v AS (
      SELECT DISTINCT ow.vintage_id AS id FROM ratings o JOIN wines ow ON ow.id = o.wine_id WHERE o.user_id = ${ownerId} AND ow.vintage_id IS NOT NULL
    ), pm AS (${tombstoneMapSql('wine_products', Prisma.sql`SELECT id FROM mine_p`)}
    ), vm AS (${tombstoneMapSql('wine_vintages', Prisma.sql`SELECT id FROM mine_v`)}
    ), rk AS MATERIALIZED (
      SELECT o.id, o.score, o.session_id, o.rated_at, o.wine_id,
             COALESCE(rpm.eff, ow.product_id) AS ep, CASE WHEN ow.vintage_id IS NULL THEN NULL ELSE COALESCE(rvm.eff, ow.vintage_id) END AS ev
        FROM ratings o
        JOIN wines ow ON ow.id = o.wine_id
        LEFT JOIN sessions os ON os.id = o.session_id
        LEFT JOIN pm rpm ON rpm.id = ow.product_id
        LEFT JOIN vm rvm ON rvm.id = ow.vintage_id
       WHERE o.user_id = ${ownerId} AND ${ratingVisible(ownerId)}
         ${own ? Prisma.empty : Prisma.sql`AND ${ratingVisible(viewerId)}`}
    ), rv AS (SELECT DISTINCT ON (ep, ev) id, score, session_id, ep, ev FROM rk WHERE ep IS NOT NULL ORDER BY ep, ev, rated_at DESC, id DESC
    ), rp AS (SELECT DISTINCT ON (ep) id, score, session_id, ep FROM rk WHERE ep IS NOT NULL ORDER BY ep, rated_at DESC, id DESC
    ), rw AS (SELECT DISTINCT ON (wine_id) id, score, session_id, wine_id FROM rk ORDER BY wine_id, rated_at DESC, id DESC)
    SELECT oc.kind, oc.id, oc.sk, oc.wine_id, oc.product_id, oc.vintage_id,
           COALESCE(oc.name, w.name) AS name, COALESCE(oc.vintage, w.vintage) AS vintage, COALESCE(oc.producer, w.producer) AS producer,
           w.style, w.colour, w.sparkling, w.image_url AS wine_image,
           (SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = COALESCE(rv.id, rp.id, rw.id) ORDER BY ri.sort_order ASC LIMIT 1) AS rating_image,
           ${score} AS score,
           ${showScores ? Prisma.sql`COALESCE(fps.id, fpc.id)` : Prisma.sql`NULL::integer`} AS post_id,
           ${showScores ? Prisma.sql`COALESCE(rv.id, rp.id, rw.id)` : Prisma.sql`NULL::integer`} AS rating_id,
           ${AT_US}::text AS at_us,
           CASE WHEN s.deleted_at IS NULL THEN s.name END AS moment_name,
           ${ownerWasThereSql(ownerId)} AS was_there,
           (SELECT fis.user_id FROM feed_items fis WHERE fis.id = oc.item_id) AS item_author
    ${cravingsBase(ownerId)}
    -- one of the three matches at most (by the craving's grain)
    LEFT JOIN rv ON oc.vintage_id IS NOT NULL AND rv.ep = oc.ep AND rv.ev = oc.ev
    LEFT JOIN rp ON oc.product_id IS NOT NULL AND oc.vintage_id IS NULL AND rp.ep = oc.ep
    LEFT JOIN rw ON oc.product_id IS NULL AND rw.wine_id = oc.wine_id
    LEFT JOIN feed_items fps ON fps.user_id = ${ownerId} AND fps.session_id = COALESCE(rv.session_id, rp.session_id, rw.session_id) AND fps.kind = 'session'
    LEFT JOIN feed_items fpc ON fpc.rating_id = COALESCE(rv.id, rp.id, rw.id) AND fpc.kind = 'standalone'
    WHERE ${Prisma.join(where, ' AND ')}
    ${order}
    LIMIT ${PAGE + 1}`
  const more = rows.length > PAGE
  const page = more ? rows.slice(0, PAGE) : rows
  // Shown from the catalogue entry (merges followed), else the craving's own
  // snapshot (a purged or legacy craving), else its bottle's.
  const entries = await loadEntriesSoft(page.map(r => ({ productId: r.product_id, vintageId: r.vintage_id })))
  // A row saved from a post (a moment its owner was not in) shows its bottle
  // (id and photo) only to a viewer who may see that post, the owner included
  // (ruled 2026-11-20: a block or a narrowed audience hides it from them too).
  const authors = [...new Set(page.filter(r => r.was_there !== true && r.item_author !== null).map(r => r.item_author!))]
  const seesAuthor = new Map<number, boolean>()
  for (const a of authors) seesAuthor.set(a, await viewerCanSeePosts(viewerId, a))
  const items = page.map((r): CravingRow => {
    const e = r.product_id ? entries.get(entryKey(r.product_id, r.vintage_id)) : undefined
    const showBottle = r.was_there === true || (r.item_author !== null && seesAuthor.get(r.item_author) === true)
    const ratingImage = showScores ? r.rating_image : null
    return {
      ...(own ? { key: cravingKey(r.kind, r.id) } : {}),
      ...(r.wine_id && showBottle ? { wineId: r.wine_id } : {}),
      postId: r.post_id,
      // The rating the row's score and post come from: the post's row to open
      // (step 7 review: since step 5 it can be another bottle of the same wine
      // than the craving's). Only beside its post, so under the same gate.
      ...(r.post_id !== null && r.rating_id !== null ? { ratingId: r.rating_id } : {}),
      name: e?.name ?? r.name ?? '',
      vintage: e ? (entryYear(e) || null) : (r.vintage?.trim() || null),
      producer: e?.producer ?? r.producer,
      // The bottle's own token while it has one (a linked alcohol-free bottle
      // keeps `nonalc`, as on Impressions and the feed), else the entry's pair.
      type: r.style ?? (e ? (e.sparkling ? 'spark' : e.colour) : null),
      colour: e ? e.colour : r.colour,
      sparkling: e ? e.sparkling : !!r.sparkling,
      imageUrl: ratingImage ?? (showBottle ? r.wine_image : null),
      score: decimalToNumber(r.score),
      // The moment of a post-saved bottle follows the same rule (review r3).
      ...(own && showBottle && r.moment_name ? { momentName: r.moment_name } : {}),
    }
  })
  const last = page[page.length - 1]
  let nextCursor: string | null = null
  if (more && last) {
    const scoreN = decimalToNumber(last.score)
    nextCursor = sealCravingsCursor(
      sort === 'recent'
        ? { sort, atUs: BigInt(last.at_us), id: Number(last.sk) }
        : { sort, quarters: scoreN === null ? null : Math.round(scoreN * 4), id: Number(last.sk) },
      scope,
    )
  }
  return { items, nextCursor }
}

// ── Someone's Moments (D5) ──────────────────────────────────────────────────

// 🔒 Join safety: a SHARED row is a moment you are in (lib/momentAudience.ts
// `sharedMomentSql`: your member row, not kicked, no ban of yours), and only it
// carries the code. With Moment Visibility on, an OPEN row is one of their
// moments you may look into (step-1 plan § 4.5): no code, its public id, and
// only where the profile's OWNER is named to you there (Show Moments alone is
// weaker: a host the look-in hides would still be listed one tap away). Every
// other moment is only counted in `otherCount`. Aliases s / sm (theirs).
const theirMemberships = (ownerId: number) => Prisma.sql`
  FROM session_members sm
  JOIN sessions s ON s.code = sm.session_code
  WHERE sm.user_id = ${ownerId} AND s.deleted_at IS NULL AND sm.removed_state IS DISTINCT FROM 'kicked'`
// The candidates for open rows: their most recent memberships you're not in
// (the list's own order). Past it a moment is counted, never an open row.
const OPEN_CANDIDATES = 100

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
// `address` only with the moment's Show Place; the cover never a code-bearing one.
export type OpenMomentRow = {
  momentId: string
  name: string | null
  dateFrom: string | null
  dateTo: string | null
  createdAt: string | null
  address?: string | null
  coverPhotoUrl: string | null
  category: string | null
  role: MomentRole
}

const NO_OPEN = { ids: [] as number[], naming: { hostNamed: [], namedFor: () => [] } as OpenRowsNaming }

// Which of their moments you may look into AND they are named to you in,
// decided once per request (lib/momentAudience.ts), with who else is named
// there for the filters (the host, the filter's friends).
async function openMoments(ownerId: number, viewerId: number, peopleIds: number[]): Promise<typeof NO_OPEN> {
  if (!momentLookInEnabled()) return NO_OPEN
  const cand = await prisma.$queryRaw<{ id: number }[]>`
    SELECT s.id ${theirMemberships(ownerId)} AND NOT ${sharedMomentSql(viewerId)}
     ORDER BY COALESCE(s.date_from, s.created_at) DESC, s.id DESC LIMIT ${OPEN_CANDIDATES}`
  const decided = await decideMoments(viewerId, cand.map(r => r.id), { also: [ownerId, ...peopleIds] })
  const open = [...decided.values()].filter(d => d.open && d.named.has(ownerId))
  return {
    ids: open.map(d => d.sessionId),
    naming: {
      hostNamed: open.filter(d => d.hostNamed).map(d => d.sessionId),
      namedFor: (userId: number) => open.filter(d => d.named.has(userId)).map(d => d.sessionId),
    },
  }
}

export async function loadSharedMoments(
  ownerId: number, gate: ProfileGateOk, viewerId: number,
  opts: { facets: MomentFacets; blockedUserIds: Set<number>; cursor: string | null; limit: number },
): Promise<{ items: (SharedMomentRow | OpenMomentRow)[]; nextCursor: string | null; otherCount?: number }> {
  if (!gate.sees.moments) return { items: [], nextCursor: null }
  const cursor = parseKeyCursor(opts.cursor)
  if (opts.cursor && !cursor) return { items: [], nextCursor: null }
  const resolved = await resolveFacets(opts.facets, viewerId, opts.blockedUserIds)
  const open = await openMoments(ownerId, viewerId, resolved.people)
  const ctx = { subjectId: ownerId, viewerId, blockedUserIds: opts.blockedUserIds, resolved }
  const shared = [sharedMomentSql(viewerId), ...await momentFacetWhere(opts.facets, ctx)]
  const which = open.ids.length === 0
    ? Prisma.join(shared, ' AND ')
    : Prisma.sql`((${Prisma.join(shared, ' AND ')}) OR (${Prisma.join([
        Prisma.sql`s.id = ANY(${open.ids}::int[])`, ...await momentFacetWhere(opts.facets, { ...ctx, open: open.naming }),
      ], ' AND ')}))`
  const where: Prisma.Sql[] = [which]
  const eff = Prisma.sql`COALESCE(s.date_from, s.created_at)`
  if (cursor) where.push(Prisma.sql`(${eff}, s.id) < (${cursor.key}::timestamptz, ${cursor.id})`)
  // An open row whose host is not named to you: no fallback to the host's name.
  const hostHidden = open.ids.filter(id => !open.naming.hostNamed.includes(id))
  const rows = await prisma.$queryRaw<{
    id: number; code: string; public_id: string; open: boolean; name: string | null; date_from: Date | null; date_to: Date | null
    created_at: Date | null; address: string | null; show_place: boolean | null; cover_photo_url: string | null; outside_cover: string | null
    category: string | null; member_role: string; host_user_id: number | null; eff_key: string
  }[]>`
    SELECT s.id, s.code, s.public_id, (s.id = ANY(${open.ids}::int[])) AS open,
           -- A nameless moment (before the required-name rule) reads as its
           -- host's name, as your own list does (r.name || r.host_name), except
           -- on an open row whose host is hidden from you.
           CASE WHEN s.id = ANY(${hostHidden}::int[]) THEN NULLIF(s.name, '') ELSE COALESCE(NULLIF(s.name, ''), s.host_name) END AS name,
           s.date_from, s.date_to, s.created_at, s.address, s.show_place, s.cover_photo_url, ${coverOutsideSql('s')} AS outside_cover, s.category,
           sm.role AS member_role, s.host_user_id, ${usKeySql(eff)} AS eff_key
    ${theirMemberships(ownerId)} AND ${Prisma.join(where, ' AND ')}
    ORDER BY ${eff} DESC, s.id DESC
    LIMIT ${opts.limit + 1}`
  const more = rows.length > opts.limit
  const page = more ? rows.slice(0, opts.limit) : rows
  const items = page.map((r): SharedMomentRow | OpenMomentRow => {
    const role: MomentRole = r.member_role === 'host' ? 'host'
      : r.member_role === 'co_host' ? 'cohost'
      : r.member_role === 'provider' ? 'provider'
      : r.host_user_id === ownerId ? 'host'
      : null
    const common = {
      name: r.name,
      dateFrom: r.date_from?.toISOString() ?? null,
      dateTo: r.date_to?.toISOString() ?? null,
      createdAt: r.created_at?.toISOString() ?? null,
    }
    if (r.open) {
      return { momentId: r.public_id, ...common, ...(r.show_place === true ? { address: r.address } : {}), coverPhotoUrl: r.outside_cover, category: r.category, role }
    }
    return { code: r.code, ...common, address: r.address, coverPhotoUrl: r.cover_photo_url, category: r.category, role }
  })
  const last = page[page.length - 1]
  const nextCursor = more && last ? encodeKeyCursor(last.eff_key, last.id) : null
  if (opts.cursor) return { items, nextCursor }
  // Their memberships minus the shared and the open ones, unfiltered (the closing line).
  const other = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${theirMemberships(ownerId)} AND NOT ${sharedMomentSql(viewerId)}`
  return { items, nextCursor, otherCount: Math.max(0, (other[0]?.n ?? 0) - open.ids.length) }
}
