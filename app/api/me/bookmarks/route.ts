import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@verre/core'
import { hiddenSql, redactedSql } from '@/lib/outsideView'
import { cravingKey, ownerCravingsSql, ownerWasThereSql } from '@/lib/cravings'
import { viewerCanSeePosts } from '@/lib/profileVisibility'
import { entryKey, loadEntriesSoft, tombstoneMapSql, type CatalogEntry } from '@/lib/catalogEntries'
import { entryYear } from '@/lib/wineDisplay'

// GET /api/me/bookmarks: Saved (catalogue model change § 5). ONE WINE with the
// vintages you saved of it underneath ("this wine, any year" is its own entry,
// `vintage: null`), and your ratings of that wine as context ("where you had
// it", derived, never stored). Grouped by the EFFECTIVE product (merges
// followed, lib/catalogEntries.ts); a craving with no catalogue link (legacy,
// purged) is a wine of its own, shown from its snapshot.
//
// 🔒 Only cravings visible to you (lib/cravings.ts: a craving whose source is
// hidden for you is LEFT OUT until its reveal, not a blind row), and only
// ratings whose bottle the outside rule shows you (a rating of "Wine N" would
// say what Wine N is). Each decided in the statement that reads its content.
// Each saved vintage carries its `key`: DELETE /api/me/bookmarks/<key> removes it.

type Row = {
  kind: string; id: number; product_id: string | null; vintage_id: string | null; saved_at: Date
  name: string | null; producer: string | null; vintage: string | null; wine_id: string | null
  w_name: string | null; w_producer: string | null; w_vintage: string | null; grape: string | null
  style: string | null; colour: string | null; sparkling: boolean | null; abv: Prisma.Decimal | null; category: string | null
  image_url: string | null; purchase_url: string | null
  session_id: number | null; session_code: string | null; session_deleted_at: Date | null; was_there: boolean | null; item_author: number | null
}
type RatingRow = {
  id: number; score: Prisma.Decimal | null; flavors: unknown; notes: string | null; rated_at: Date; vintage: string | null
  ep: string | null; wine_id: string; image_url: string | null; session_id: number | null; session_code: string | null; session_deleted_at: Date | null
}

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  // Your SHOWN cravings (lib/cravings.ts: real cravings not hidden for you and
  // the blind saves that count as one, one per wine).
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT oc.kind, oc.id, oc.product_id, oc.vintage_id, oc.saved_at, oc.name, oc.producer, oc.vintage, oc.wine_id,
           w.name AS w_name, w.producer AS w_producer, w.vintage AS w_vintage, w.grape, w.style, w.colour, w.sparkling, w.abv,
           w.category, w.image_url, w.purchase_url,
           s.id AS session_id, s.code AS session_code, s.deleted_at AS session_deleted_at, ${ownerWasThereSql(userId)} AS was_there,
           (SELECT fi.user_id FROM feed_items fi WHERE fi.id = oc.item_id) AS item_author
      FROM (${ownerCravingsSql(userId)}) oc
      LEFT JOIN wines w ON w.id = oc.wine_id
      LEFT JOIN sessions s ON s.id = oc.sid
     ORDER BY oc.saved_at DESC, oc.sk DESC`
  const entries = await loadEntriesSoft(rows.map(r => ({ productId: r.product_id, vintageId: r.vintage_id })))
  // A bottle saved from someone's post (a moment you were not in) shows its
  // photo and purchase link only while you may still see that post (ruled
  // 2026-11-20: a block or a narrowed audience hides them).
  const seesAuthor = new Map<number, boolean>()
  for (const a of new Set(rows.filter(r => r.was_there !== true && r.item_author !== null).map(r => r.item_author!))) seesAuthor.set(a, await viewerCanSeePosts(userId, a))
  const showBottle = (r: Row) => r.was_there === true || (r.item_author !== null && seesAuthor.get(r.item_author) === true)
  const entryOf = (r: Row): CatalogEntry | undefined => (r.product_id ? entries.get(entryKey(r.product_id, r.vintage_id)) : undefined)

  type Group = { key: string; entry?: CatalogEntry; rows: Row[] }
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const e = entryOf(r)
    const key = e ? e.productId : `u:${cravingKey(r.kind, r.id)}`
    const g = groups.get(key) ?? { key, entry: e, rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }

  // Your ratings of these wines, newest first: by the bottle's effective
  // product (merges followed by ONE tombstone walk over your rated wines, never
  // a walk per row: lib/catalogEntries.ts tombstoneMapSql), and for a craving
  // with no catalogue link, of its own bottle.
  const products = [...groups.values()].flatMap(g => (g.entry ? [g.entry.productId] : []))
  const bottles = [...groups.values()].flatMap(g => (g.entry ? [] : g.rows.flatMap(r => (r.wine_id ? [r.wine_id] : []))))
  const ratings = products.length === 0 && bottles.length === 0 ? [] : await prisma.$queryRaw<RatingRow[]>`
    WITH mine AS (SELECT DISTINCT w0.product_id AS id FROM ratings r0 JOIN wines w0 ON w0.id = r0.wine_id WHERE r0.user_id = ${userId} AND w0.product_id IS NOT NULL),
         pm AS (${tombstoneMapSql('wine_products', Prisma.sql`SELECT id FROM mine`)})
    SELECT r.id, r.score, r.flavors, r.notes, r.rated_at, w.vintage, r.wine_id, COALESCE(pm.eff, w.product_id) AS ep,
           (SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = r.id ORDER BY ri.sort_order ASC LIMIT 1) AS image_url,
           s.id AS session_id, s.code AS session_code, s.deleted_at AS session_deleted_at
      FROM ratings r
      JOIN wines w ON w.id = r.wine_id
      LEFT JOIN sessions s ON s.id = r.session_id
      LEFT JOIN pm ON pm.id = w.product_id
     WHERE r.user_id = ${userId}
       AND (COALESCE(pm.eff, w.product_id) = ANY(${products}::text[]) OR r.wine_id = ANY(${bottles}::text[]))
       AND NOT ${hiddenSql(userId, 's')} AND NOT ${redactedSql(userId, 's', 'w')}
     ORDER BY r.rated_at DESC, r.id DESC`
  const ratingsOf = new Map<string, RatingRow[]>()
  const ratingsOfBottle = new Map<string, RatingRow[]>()
  for (const r of ratings) {
    if (r.ep) ratingsOf.set(r.ep, [...(ratingsOf.get(r.ep) ?? []), r])
    ratingsOfBottle.set(r.wine_id, [...(ratingsOfBottle.get(r.wine_id) ?? []), r])
  }

  // 🔒 A moment's code is a join credential: only for a moment you were in (a
  // craving saved from someone's post names no code; review r1). A deleted
  // moment's code is scrubbed: "[deleted session]", no link.
  const moment = (x: { session_id: number | null; session_code: string | null; session_deleted_at: Date | null }, wasThere = true) => ({
    session_id: wasThere ? x.session_id : null,
    session_code: x.session_deleted_at || !wasThere ? null : x.session_code,
    session_deleted: wasThere && !!x.session_deleted_at,
  })
  return NextResponse.json([...groups.values()].map(g => {
    const top = g.rows[0]
    const e = g.entry
    const context = e ? ratingsOf.get(e.productId) ?? [] : g.rows.flatMap(r => (r.wine_id ? ratingsOfBottle.get(r.wine_id) ?? [] : []))
    return {
      key: g.key,
      name: e?.name ?? top.name ?? top.w_name ?? '',
      producer: e?.producer ?? top.producer ?? top.w_producer ?? null,
      grape: e ? (e.grapes.join(', ') || null) : top.grape,
      // The kind for the icon and the axes: the entry's, else the source
      // bottle's snapshot.
      style: top.style ?? (e ? (e.sparkling ? 'spark' : e.colour) : null),
      colour: e ? e.colour : top.colour,
      sparkling: e ? e.sparkling : !!top.sparkling,
      abv: e ? e.abv : decimalToNumber(top.abv),
      category: e?.category ?? top.category ?? 'wine',
      image_url: g.rows.find(r => r.image_url && showBottle(r))?.image_url ?? context.find(r => r.image_url)?.image_url ?? null,
      purchase_url: g.rows.find(r => r.purchase_url && showBottle(r))?.purchase_url ?? null,
      saved_at: top.saved_at,
      // A wine with no catalogue link says nothing about its years.
      linked: !!e,
      vintages: g.rows.map(r => {
        const re = entryOf(r)
        const year = re ? entryYear(re) : (r.vintage ?? r.w_vintage ?? '').trim()
        return { key: cravingKey(r.kind, r.id), vintage: year || null, saved_at: r.saved_at, ...moment(r, r.was_there === true) }
      }),
      ratings: context.map(r => ({
        id: r.id,
        score: decimalToNumber(r.score),
        flavors: r.flavors ?? {},
        notes: r.notes,
        rated_at: r.rated_at,
        vintage: r.vintage?.trim() || null,
        ...moment(r),
      })),
    }
  }), {
    // Viewer-private content: Cache-Control private, no-store (app/api/CLAUDE.md).
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
