import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const VALID_TYPES = ['all', 'red', 'white', 'spark', 'rose', 'nonalc']

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') ?? 'all'
  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 })
  }

  // Aggregate by normalised name across all sessions.
  // Qualification: ≥3 ratings AND ≥2 distinct sessions.
  const typeClause = type === 'all' ? '' : `AND w.style = '${type}'`

  const rows = await prisma.$queryRawUnsafe<Array<{
    wine_key: string
    display_name: string
    producer: string | null
    vintage: string | null
    style: string | null
    image_url: string | null
    avg_score: number
    rating_count: bigint
    session_count: bigint
    user_count: bigint
  }>>(`
    WITH grouped AS (
      SELECT
        LOWER(TRIM(w.name)) AS wine_key,
        (SELECT w2.name FROM wines w2
         WHERE LOWER(TRIM(w2.name)) = LOWER(TRIM(w.name))
         GROUP BY w2.name ORDER BY COUNT(*) DESC LIMIT 1) AS display_name,
        (SELECT w2.producer FROM wines w2
         WHERE LOWER(TRIM(w2.name)) = LOWER(TRIM(w.name)) AND w2.producer IS NOT NULL
         GROUP BY w2.producer ORDER BY COUNT(*) DESC LIMIT 1) AS producer,
        (SELECT w2.vintage FROM wines w2
         WHERE LOWER(TRIM(w2.name)) = LOWER(TRIM(w.name)) AND w2.vintage IS NOT NULL
         GROUP BY w2.vintage ORDER BY COUNT(*) DESC LIMIT 1) AS vintage,
        (SELECT w2.style FROM wines w2
         WHERE LOWER(TRIM(w2.name)) = LOWER(TRIM(w.name)) AND w2.style IS NOT NULL
         GROUP BY w2.style ORDER BY COUNT(*) DESC LIMIT 1) AS style,
        (SELECT w2.image_url FROM wines w2
         WHERE LOWER(TRIM(w2.name)) = LOWER(TRIM(w.name)) AND w2.image_url IS NOT NULL
         ORDER BY w2.created_at DESC LIMIT 1) AS image_url,
        ROUND(AVG(r.score)::numeric, 2)              AS avg_score,
        COUNT(r.id)                                  AS rating_count,
        COUNT(DISTINCT w.session_id)                 AS session_count,
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.user_id IS NOT NULL) AS user_count
      FROM wines w
      JOIN ratings r ON r.wine_id = w.id
      WHERE r.score > 0 ${typeClause}
      GROUP BY LOWER(TRIM(w.name))
      HAVING COUNT(r.id) >= 3
         AND COUNT(DISTINCT w.session_id) >= 2
    )
    SELECT * FROM grouped
    ORDER BY avg_score DESC, rating_count DESC
    LIMIT 50
  `)

  return NextResponse.json(
    rows.map((r, i) => ({
      rank: i + 1,
      wineKey: r.wine_key,
      name: r.display_name,
      producer: r.producer,
      vintage: r.vintage,
      style: r.style,
      imageUrl: r.image_url,
      avgScore: Number(r.avg_score),
      ratingCount: Number(r.rating_count),
      sessionCount: Number(r.session_count),
      userCount: Number(r.user_count),
    }))
  )
}
