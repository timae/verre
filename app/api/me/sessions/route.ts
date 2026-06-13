import { NextRequest, NextResponse } from 'next/server'
import { decimalToNumber } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k, getLastSeen } from '@/lib/redis'

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
        try {
          ;[taster_count, participant, lastSeen] = await Promise.all([
            redis.hLen(k.identities(r.code)),
            redis.hExists(k.identities(r.code), myIdentityId),
            getLastSeen(r.code, userId),
          ])
        } catch {}
      }
    } catch {}
    // live = session still in Redis AND the caller is still a participant
    // (kicked/banned users drop out of identities — their Moments home must
    // not pin the session) AND it's not clearly over.
    const ttlAlive = ttl_seconds > 0 || ttl_seconds === -1
    const hasDate = r.date_from !== null || r.date_to !== null
    const endsAt =
      r.date_to !== null ? r.date_to.getTime()
      : r.date_from !== null ? r.date_from.getTime() + ASSUMED_DURATION_MS
      : null
    const datePast = endsAt !== null && Date.now() > endsAt
    // Date-less: drop from live once THIS user hasn't touched the moment
    // (visit OR an in-moment action, both bump lastSeen) for the cutoff
    // window. lastSeen 0 (never recorded — pre-feature session) counts as
    // stale so an old date-less session doesn't resurrect as "Just visited".
    const idleMs = lastSeen > 0 ? Date.now() - lastSeen : Infinity
    const datelessStale = !hasDate && idleMs > DATELESS_IDLE_CUTOFF_MS
    const status: 'live' | 'past' =
      ttlAlive && participant && !datePast && !datelessStale ? 'live' : 'past'
    // The "ongoing vs just-visited" label is NOT sent — the client derives
    // it from `status === 'live'` + whether date_from/date_to is present (a
    // pure restatement of fields already on the wire).
    return {
      ...r,
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
    }
  }))

  // Viewer-dependent body (role, own counts) — never shared-cacheable.
  return NextResponse.json(enriched, { headers: { 'Cache-Control': 'private, no-store' } })
}
