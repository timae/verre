import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'

export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)
  const rows = await prisma.$queryRaw<
    Array<{
      id: number; code: string; host_name: string; name: string | null
      created_at: Date; joined_at: Date; wines_rated: bigint; avg_score: number | null
      date_from: Date | null; address: string | null
    }>
  >`
    SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
           s.date_from, s.address,
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
    GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, s.date_from, s.address
    ORDER BY sm.joined_at DESC
    LIMIT 50
  `

  // Enrich each row with live Redis TTL + lifespan from the meta key.
  const enriched = await Promise.all(rows.map(async (r) => {
    let ttl_seconds = -2
    let lifespan: string | null = null
    try {
      const [t, raw] = await Promise.all([
        redis.ttl(k.meta(r.code)),
        redis.get(k.meta(r.code)),
      ])
      ttl_seconds = t
      if (raw) {
        try { lifespan = JSON.parse(raw).lifespan ?? null } catch {}
      }
    } catch {}
    return {
      ...r,
      wines_rated: Number(r.wines_rated),
      date_from: r.date_from ? r.date_from.toISOString() : null,
      ttl_seconds,
      lifespan,
    }
  }))

  return NextResponse.json(enriched)
}
