import { prisma } from '@/lib/prisma'
import { FL_KEYS } from '@/lib/profileFlavor'

// Public community aggregate for one wine_products row — the numbers behind the
// product page (GET /api/wines/[productId]). Aggregates every `ratings` row
// whose wine points at this product, across all sessions and users.
//
// VIEWER-INDEPENDENT by construction: only aggregate scalars + a flavour/aroma
// distribution leave here, never per-taster rows. That is what lets the route
// send `Cache-Control: public` — see the route. When "who tasted it" ships it
// must NOT be added here (it would need profile-visibility + block gating and
// would flip the response to per-viewer).
//
// Blind guard: a wine in a LIVE blind session that hasn't been revealed is
// excluded — its identity is still hidden from that session's tasters, so its
// ratings must not surface on a public page keyed by that identity. Mirrors the
// feed predicate in lib/sessionFeedWines.ts. Revealed or soft-deleted sessions
// count; standalone ratings (no session row) always count (COALESCE(blind,
// false) keeps the LEFT JOIN's NULLs from excluding them).
export type ProductCommunity = {
  avgScore: number | null       // mean over scored rows (score > 0)
  ratingCount: number           // scored rows
  tastingCount: number          // ALL contributing rows (incl. chips/notes-only, score 0/null)
  tasterCount: number           // distinct logged-in tasters (anon rows count toward tastings, not this)
  flavors: Record<string, number | null>
  aromas: { node: string; count: number }[]
}

// The single source of truth for "which ratings contribute" — the blind
// exclusion. Shared between the scalar+flavour query and the aroma query so the
// predicate can't drift. $1 = productId.
const JOINS = `
  FROM ratings r
  JOIN wines w ON w.id = r.wine_id
  LEFT JOIN sessions s ON s.id = r.session_id`
const WHERE = `
  WHERE w.product_id = $1
    AND NOT (COALESCE(s.blind, false) AND w.revealed_at IS NULL AND s.deleted_at IS NULL)`

export async function getProductAggregate(productId: string): Promise<ProductCommunity> {
  // Score-weighted mean per structure axis, identical math to getProfileFlavor
  // (score-weighted, key-PRESENCE not >0 so a rated "None"=0 pulls the mean
  // down) — but restricted to scored rows via `AND r.score > 0` inside the
  // FILTER, since the product query's outer WHERE keeps unscored rows for the
  // tasting count. FL_KEYS is injection-safe (regex-guarded in profileFlavor).
  const weightedAvg = FL_KEYS.map(f =>
    `ROUND((SUM((r.flavors->>'${f}')::numeric * r.score) FILTER (WHERE r.flavors ? '${f}' AND r.score > 0) / NULLIF(SUM(r.score) FILTER (WHERE r.flavors ? '${f}' AND r.score > 0), 0))::numeric, 2) AS ${f}`,
  ).join(', ')

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${weightedAvg},
            ROUND((AVG(r.score) FILTER (WHERE r.score > 0))::numeric, 1) AS avg_score,
            COUNT(*) FILTER (WHERE r.score > 0) AS rating_count,
            COUNT(*) AS tasting_count,
            COUNT(DISTINCT r.user_id) AS taster_count
     ${JOINS}${WHERE}`,
    productId,
  )
  const row = rows[0] || {}
  const flavors: Record<string, number | null> = {}
  for (const k of FL_KEYS) {
    const v = row[k]
    flavors[k] = v == null ? null : Number(v)
  }

  // Aroma distribution: per-node taster frequency (one vote per rating that
  // mentions the node, at whatever taxonomy grain the taster picked). The
  // client rolls up to family via the @verre/core taxonomy at read time — we
  // never store or derive the roll-up here (aroma-layer.md §4). Top 24 nodes.
  // The CASE guards a legacy non-array `aromas` from throwing in the LATERAL
  // (the column is NOT NULL default '[]' and always array-shaped today).
  const aromaRows = await prisma.$queryRawUnsafe<Array<{ node: string; count: bigint | number }>>(
    `SELECT elem->>'a' AS node, COUNT(DISTINCT r.id) AS count
     ${JOINS}
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.aromas) = 'array' THEN r.aromas ELSE '[]'::jsonb END) AS elem
     ${WHERE}
     GROUP BY elem->>'a'
     ORDER BY count DESC, node ASC
     LIMIT 24`,
    productId,
  )

  return {
    avgScore: row.avg_score == null ? null : Number(row.avg_score),
    ratingCount: Number(row.rating_count || 0),
    tastingCount: Number(row.tasting_count || 0),
    tasterCount: Number(row.taster_count || 0),
    flavors,
    aromas: aromaRows.filter(a => a.node).map(a => ({ node: a.node, count: Number(a.count) })),
  }
}
