import { prisma } from '@/lib/prisma'
import { resolveAxes } from '@/lib/flavours'
import { detectExpiredCodes } from '@/lib/sessionFeedWines'

// Public community aggregate for one wine_products row — the numbers behind the
// product page (GET /api/wines/[productId]). Aggregates every `ratings` row
// whose wine points at this product, across all sessions and users, plus a
// read-time-derived bottle image.
//
// VIEWER-INDEPENDENT by construction: only aggregate scalars + a flavour/aroma
// distribution leave here, never per-taster rows. That is what lets the route
// send `Cache-Control: public`. When "who tasted it" ships it must NOT be added
// here (it would need profile-visibility + block gating and flip to per-viewer).
//
// Blind guard mirrors the feed EXACTLY (lib/sessionFeedWines.ts): a rating is
// excluded only while its session is blind, the wine is unrevealed, the session
// is neither soft-deleted NOR Redis-expired. The feed auto-reveals an expired
// blind session and emits its productId, so the aggregate must count those too
// — otherwise a reachable product page would permanently under-count. Standalone
// ratings (no session) always count.

// Every wine structure axis across ALL styles — the union so a sparkling
// product's `bubbles` judgments (sparkling-only, absent from the red set) are
// aggregated too. Guarded: keys are interpolated raw into SQL (aliases + JSON
// paths); resolveAxes only ever yields lowercase snake keys, but this is a hard
// backstop identical to profileFlavor's FL_KEYS guard.
const WINE_STYLES = ['red', 'white', 'rose', 'spark', 'nonalc']
export const AXIS_KEYS = [...new Set(WINE_STYLES.flatMap(s => resolveAxes('wine', s).map(a => a.k)))]
if (!AXIS_KEYS.every(k => /^[a-z_]+$/.test(k))) {
  throw new Error('AXIS_KEYS contains a value unsafe to interpolate into SQL')
}

export type ProductCommunity = {
  avgScore: number | null       // mean over scored rows (score > 0)
  ratingCount: number           // scored rows
  tastingCount: number          // ALL contributing rows (incl. chips/notes-only, score 0/null)
  tasterCount: number           // distinct logged-in tasters (anon rows count toward tastings, not this)
  flavors: Record<string, number | null>
  aromas: { node: string; count: number }[]
}

export type ProductAggregate = {
  // Bottle shot DERIVED at read time from the freshest non-hidden constituent
  // wine — never a pinned column, so a reclaimed/replaced source image can't
  // leave a permanently broken product image.
  imageUrl: string | null
  community: ProductCommunity
}

// JOINS + the expiry-aware blind exclusion, shared by all sub-queries so the
// predicate can't drift. $1 = productId, $2 = expired session codes (text[]).
const JOINS = `
  FROM ratings r
  JOIN wines w ON w.id = r.wine_id
  LEFT JOIN sessions s ON s.id = r.session_id`
// Exclude iff blind AND unrevealed AND not-deleted AND NOT Redis-expired.
const BLIND_OK = `NOT (COALESCE(s.blind, false) AND w.revealed_at IS NULL AND s.deleted_at IS NULL AND NOT (s.code = ANY($2)))`

export async function getProductAggregate(productId: string): Promise<ProductAggregate> {
  // Which blind-unrevealed-live sessions on this product have expired out of
  // Redis? Those auto-reveal (feed parity), so their ratings must be counted.
  const candidates = await prisma.$queryRawUnsafe<Array<{ code: string }>>(
    `SELECT DISTINCT s.code
       FROM ratings r JOIN wines w ON w.id = r.wine_id JOIN sessions s ON s.id = r.session_id
      WHERE w.product_id = $1 AND s.blind = true AND w.revealed_at IS NULL
        AND s.deleted_at IS NULL AND s.code IS NOT NULL`,
    productId,
  )
  const expired = [...await detectExpiredCodes(candidates.map(c => c.code))]

  // Score-weighted mean per axis, identical math to getProfileFlavor
  // (score-weighted, key-PRESENCE not >0 so a rated "None"=0 pulls the mean
  // down) — restricted to scored rows via `AND r.score > 0` inside the FILTER,
  // since the outer WHERE keeps unscored rows for the tasting count.
  const weightedAvg = AXIS_KEYS.map(f =>
    `ROUND((SUM((r.flavors->>'${f}')::numeric * r.score) FILTER (WHERE r.flavors ? '${f}' AND r.score > 0) / NULLIF(SUM(r.score) FILTER (WHERE r.flavors ? '${f}' AND r.score > 0), 0))::numeric, 2) AS ${f}`,
  ).join(', ')

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${weightedAvg},
            ROUND((AVG(r.score) FILTER (WHERE r.score > 0))::numeric, 1) AS avg_score,
            COUNT(*) FILTER (WHERE r.score > 0) AS rating_count,
            COUNT(*) AS tasting_count,
            COUNT(DISTINCT r.user_id) AS taster_count
     ${JOINS}
     WHERE w.product_id = $1 AND ${BLIND_OK}`,
    productId, expired,
  )
  const row = rows[0] || {}
  const flavors: Record<string, number | null> = {}
  for (const k of AXIS_KEYS) {
    const v = row[k]
    flavors[k] = v == null ? null : Number(v)
  }

  // Aroma distribution: per-node taster frequency (one vote per rating that
  // mentions the node, at the taster's chosen grain). The client rolls up to
  // family via @verre/core at read time (aroma-layer.md §4). Top 24 nodes.
  const aromaRows = await prisma.$queryRawUnsafe<Array<{ node: string; count: bigint | number }>>(
    `SELECT elem->>'a' AS node, COUNT(DISTINCT r.id) AS count
     ${JOINS}
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.aromas) = 'array' THEN r.aromas ELSE '[]'::jsonb END) AS elem
     WHERE w.product_id = $1 AND ${BLIND_OK}
     GROUP BY elem->>'a'
     ORDER BY count DESC, node ASC
     LIMIT 24`,
    productId, expired,
  )

  // Bottle shot: freshest non-hidden constituent wine with a live image. Same
  // blind exclusion so an unrevealed blind wine's shot can't leak. Derived, not
  // stored — a reclaimed source image drops out automatically.
  const imgRows = await prisma.$queryRawUnsafe<Array<{ image_url: string }>>(
    `SELECT w.image_url
       FROM wines w LEFT JOIN sessions s ON s.id = w.session_id
      WHERE w.product_id = $1 AND w.image_url IS NOT NULL AND ${BLIND_OK}
      ORDER BY w.created_at DESC
      LIMIT 1`,
    productId, expired,
  )

  return {
    imageUrl: imgRows[0]?.image_url ?? null,
    community: {
      avgScore: row.avg_score == null ? null : Number(row.avg_score),
      ratingCount: Number(row.rating_count || 0),
      tastingCount: Number(row.tasting_count || 0),
      tasterCount: Number(row.taster_count || 0),
      flavors,
      aromas: aromaRows.filter(a => a.node).map(a => ({ node: a.node, count: Number(a.count) })),
    },
  }
}
