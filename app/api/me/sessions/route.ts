import { NextRequest, NextResponse } from 'next/server'
import { decimalToNumber } from '@verre/core'
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
      host_user_id: number | null; wine_count: bigint
    }>
  >`
    SELECT s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at,
           s.date_from, s.address, s.host_user_id,
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
    GROUP BY s.id, s.code, s.host_name, s.name, s.created_at, sm.joined_at, s.date_from, s.address, s.host_user_id
    ORDER BY sm.joined_at DESC
    LIMIT 50
  `

  // Enrich each row with live Redis TTL + lifespan from the meta key, plus
  // live taster count and the caller's role (id-based, never display names).
  const myIdentityId = `u:${userId}`
  const enriched = await Promise.all(rows.map(async (r) => {
    let ttl_seconds = -2
    let lifespan: string | null = null
    let taster_count: number | null = null
    let role: 'host' | 'cohost' | 'provider' | null =
      r.host_user_id === userId ? 'host' : null
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
          if (meta.hostIdentityId === myIdentityId || meta.hostUserId === userId) role = 'host'
          else if (Array.isArray(meta.coHostIds) && meta.coHostIds.includes(myIdentityId)) role = 'cohost'
          else if (Array.isArray(meta.providerIds) && meta.providerIds.includes(myIdentityId)) role = 'provider'
        } catch {}
        try { taster_count = await redis.hLen(k.identities(r.code)) } catch {}
      }
    } catch {}
    return {
      ...r,
      wines_rated: Number(r.wines_rated),
      wine_count: Number(r.wine_count),
      // Decimal wire-format trap (root CLAUDE.md): raw numeric serializes as
      // a JSON string without this coercion.
      avg_score: decimalToNumber(r.avg_score),
      date_from: r.date_from ? r.date_from.toISOString() : null,
      ttl_seconds,
      lifespan,
      taster_count,
      role,
    }
  }))

  // Viewer-dependent body (role, own counts) — never shared-cacheable.
  return NextResponse.json(enriched, { headers: { 'Cache-Control': 'private, no-store' } })
}
