import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, TTL, touchWithMeta, bumpLastSeen, unhideCarousel } from '@/lib/redis'
import { getSessionMeta, getWines, pgUpsertSession, pgUpsertWine } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { participantOrBanned, authInvalid, authRemoved } from '@/lib/identity'
import { validateFlavors } from '@/lib/checkinValidation'
import { validateScore } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { engagementDeletionCascade } from '@/lib/engagementCascade'

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  // Reject malformed bodies up front so a stray empty/garbage POST
  // doesn't produce a 500. The validators below also reject negatives,
  // floats, strings, arrays and objects masquerading as numbers — the
  // previous `score || 0` fallback let any truthy value land in Redis.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineId, score, flavors, notes } = body
  // wineId is a string id minted in lib/session.ts — today nanoid(21)
  // for new rows; older rows are 13-char numeric timestamps. Strict
  // allow-list: digits, letters, underscore, dash — never colons, glob
  // chars, newlines, or quotes that could collide with Redis key
  // separators or confuse downstream tooling. Cap at 32 chars to leave
  // headroom while bounding key size (schema is VarChar(21)).
  if (!wineId || typeof wineId !== 'string' || wineId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(wineId)) {
    return NextResponse.json({ error: 'wineId required' }, { status: 400 })
  }
  const sc = validateScore(score)
  if (sc.error) return NextResponse.json({ error: sc.error }, { status: 400 })
  const fl = validateFlavors(flavors)
  if (fl.error) return NextResponse.json({ error: fl.error }, { status: 400 })
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
  }
  if (typeof notes === 'string' && notes.length > 4000) {
    return NextResponse.json({ error: 'notes too long' }, { status: 400 })
  }

  // Identity comes from auth() or x-vr-anon-token. Never from the request
  // body. Also gates against ban/kick — a banned cookie can't keep
  // writing ratings until the host notices.
  const p = await participantOrBanned(c, req, session)
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid()
  const identity = p.identity

  const ratingScore = sc.value ?? 0
  const validFlavors = fl.value
  // Rating is keyed by identity id, never by display name. Two participants
  // sharing a display name (legitimately via collision, or accidentally via
  // a client-side race) cannot overwrite each other's ratings.
  await redis.set(
    k.rating(c, identity.id, wineId),
    JSON.stringify({ score: ratingScore, flavors: validFlavors, notes: notes || '', at: Date.now() }),
    { EX: TTL },
  )

  const wines = await getWines(c)
  const wine = wines.find(w => w.id === wineId)

  if (identity.kind === 'user' && wine) {
    const userId = Number(identity.id.slice(2))  // strip "u:" prefix
    try {
      const meta = await getSessionMeta(c)
      if (meta) {
        // pgUpsertSession returns the sessions.id directly (one DB roundtrip
        // instead of upsert + findUnique). The integer id is what the new
        // partial unique on ratings (user_id, wine_id, session_id) needs
        // for its FK write.
        const sessionId = await pgUpsertSession(c, meta)
        await pgUpsertWine(c, wine)

        // Snapshot the prior rating so the lifetime_* counters bump
        // only on the relevant transitions (new rating, first 5★, longer
        // note, new month). Counters NEVER decrement. Raw SELECT instead
        // of prisma.rating.findUnique({wineId_userId:…}) because the
        // compound-key accessor disappears once this PR's migration
        // drops @@unique([wineId, userId]).
        //
        // Scoped to (wine_id, user_id, session_id) so the prior we read
        // matches the row the upsert below will target. Without the
        // session_id clause, once phase 2 ships standalone ratings
        // (session_id IS NULL) for the same (wine, user) pair, this
        // SELECT could pick up the standalone row and mis-attribute
        // counter deltas for the session row.
        //
        // Race note: a brand-new (wine, user, session) triple under two
        // concurrent tabs has both SELECTs returning null and both
        // INSERTs racing on the partial unique. The row itself collapses
        // to one (ON CONFLICT DO UPDATE — no 23505), but both branches
        // compute isNew=true and double-bump lifetime_ratings by 1. This
        // is unchanged from the old upsert and accepted at current scale;
        // see future-work-rewire.md if it ever becomes user-visible.
        const priorRows = await prisma.$queryRaw<{ score: unknown; notes: string | null }[]>`
          SELECT score, notes FROM ratings
           WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${sessionId}
           LIMIT 1`
        const prior = priorRows[0] ?? null
        const noteLen = (notes || '').length
        const wroteNote = noteLen > 5

        // `origin` shipped in rewire phase 1 (additive). Every rating
        // from this endpoint is by definition session-origin. The raw
        // INSERT…ON CONFLICT shape mirrors the SQL phase 2 needs — race-
        // safe under the new partial unique (concurrent same-(user,wine,
        // session) POSTs collapse to a single UPDATE instead of a 23505).
        // Conflict target columns must match the partial-unique index
        // declaration exactly so Postgres picks it as the arbiter.
        //
        // Caveat documented in rewire.md §6 phase 1.5: raw SQL bypasses
        // Prisma's typecheck — a future column rename won't be caught
        // at compile time. Same trade-off the lifetime-counter UPDATE
        // below already accepts.
        // RETURNING id is captured so the engagement-deletion cascade
        // below (when the upsert lands an empty payload) can target the
        // exact row. ON CONFLICT DO UPDATE … RETURNING returns the
        // pre-existing id on conflict — the canonical row, not the
        // client's stale local id.
        const upsertRows = await prisma.$queryRaw<{ id: number }[]>`
          INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, notes, rated_at)
          VALUES (
            ${wineId},
            ${userId},
            ${sessionId},
            'session',
            ${identity.displayName},
            ${ratingScore}::numeric,
            ${JSON.stringify(validFlavors)}::jsonb,
            ${notes || null},
            NOW()
          )
          ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL
          DO UPDATE SET
            rater_name = EXCLUDED.rater_name,
            score = EXCLUDED.score,
            flavors = EXCLUDED.flavors,
            notes = EXCLUDED.notes,
            rated_at = EXCLUDED.rated_at
          RETURNING id`
        const ratingId = upsertRows[0]?.id

        // Materialise the session feed_item on first engagement. The engagement
        // trigger from §3 of the rewire: any rating with score > 0, flavour
        // chips, or a note counts as engagement. A rate POST with all three
        // empty (e.g. a misbehaving or hostile client) lands the rating row
        // — that's the user's interaction with the wine — but does NOT create
        // a social post. Phase 3's engagement-deletion auto-cascade reaps any
        // emptied rating; this guard avoids materialising the post in the
        // first place so the user doesn't accumulate empty session posts.
        //
        // Idempotent via the partial unique (user_id, session_id). Subsequent
        // rates in the same session collapse to ON CONFLICT DO NOTHING — the
        // feed_item's createdAt is never updated, so post chronology stays
        // anchored on first engagement.
        //
        // Anon ratings never reach this branch (the outer `identity.kind ===
        // 'user'` gate at the top of the handler skips them). feed_items.user_id
        // NOT NULL enforces this at the schema level.
        const hasEngagement = ratingScore > 0
          || Object.keys(validFlavors ?? {}).length > 0
          || (notes != null && notes.length > 0)
        let cascadeReaped = false
        if (hasEngagement) {
          await prisma.$executeRaw`
            INSERT INTO feed_items (user_id, kind, session_id, created_at, location_public)
            VALUES (${userId}, 'session', ${sessionId}, NOW(), false)
            ON CONFLICT (user_id, session_id) DO NOTHING`
        } else if (ratingId != null) {
          // Engagement-deletion cascade — the user just cleared score +
          // chips + notes on a previously-engaged rating. Reap the
          // empty row and drop the session feed_item if this was their
          // only rating in the session. The empty-payload predicate on
          // the cascade is a safety net: if a concurrent engaged POST
          // (from another tab) lands between this handler's upsert and
          // the cascade's SELECT, the row no longer matches the empty
          // predicate, cascade no-ops, and we MUST leave Redis alone —
          // wiping it would clobber the other tab's just-written state.
          // The cascade returns true only when it actually reaped; gate
          // the Redis cleanup AND the lifetime-counter bump on it.
          cascadeReaped = await engagementDeletionCascade(ratingId)
          if (cascadeReaped) await redis.del(k.rating(c, identity.id, wineId))
        }

        // Lifetime counter updates. Done as a single SQL UPDATE with
        // GREATEST() / conditional increments so we never double-count
        // (e.g. re-rating to 5★ after rating to 5★ doesn't bump again).
        // Prisma surfaces Decimal columns as runtime Decimal objects;
        // coerce via Number() (or toNumber()) before strict equality.
        //
        // Skip entirely when the cascade just reaped the row — incrementing
        // lifetime_ratings for a row that no longer exists would leave
        // permanent drift (counters never decrement). first_rated_at
        // similarly should anchor on a real engagement, not on a no-op
        // empty rate from a misbehaving client.
        const isNew = !prior
        const priorScore = prior?.score == null ? null : Number(prior.score)
        const newFiveStar = ratingScore === 5 && priorScore !== 5
        const newOneStar  = ratingScore === 1 && priorScore !== 1
        const newNote     = wroteNote && (!prior || (prior.notes || '').length <= 5)
        const newPhoto    = isNew && !!(wine.imageUrl || wine.image)

        // Did this rating add a brand-new month bucket to the user's set?
        // Only checked on NEW ratings (re-rating same wine doesn't add a
        // month). We just inserted, so the current month is guaranteed
        // present; bump only if THIS rating is the only one in the bucket.
        let newMonth = false
        if (isNew && !cascadeReaped) {
          const [{ count }] = await prisma.$queryRaw<[{count:bigint}]>`
            SELECT COUNT(*) AS count FROM ratings
            WHERE user_id=${userId}
              AND DATE_TRUNC('month', rated_at) = DATE_TRUNC('month', NOW())`
          newMonth = Number(count) === 1
        }

        if (!cascadeReaped) {
          await prisma.$executeRaw`
            UPDATE users SET
              lifetime_ratings = lifetime_ratings + ${isNew ? 1 : 0},
              lifetime_five_star = lifetime_five_star + ${newFiveStar ? 1 : 0},
              lifetime_one_star = lifetime_one_star + ${newOneStar ? 1 : 0},
              lifetime_notes_written = lifetime_notes_written + ${newNote ? 1 : 0},
              lifetime_max_note_len = GREATEST(lifetime_max_note_len, ${noteLen}),
              lifetime_photos_added = lifetime_photos_added + ${newPhoto ? 1 : 0},
              lifetime_consecutive_months = lifetime_consecutive_months + ${newMonth ? 1 : 0},
              first_rated_at = COALESCE(first_rated_at, NOW())
            WHERE id = ${userId}`
        }
      }
    } catch (err) {
      console.error('rate counter update error:', err)
    }

    if (ratingScore === 5) {
      try {
        await prisma.hallOfFame.upsert({
          where: { wineName_userId: { wineName: wine.name, userId } },
          create: {
            wineName: wine.name, producer: wine.producer || null, vintage: wine.vintage || null,
            style: wine.type || null, score: 5, raterName: identity.displayName,
            userId, sessionCode: c, ratedAt: new Date(),
          },
          update: { raterName: identity.displayName, score: 5, ratedAt: new Date() },
        })
      } catch {}
    }
  }

  await touchWithMeta(c)

  // Award badges + XP directly (no HTTP round-trip). Logged-in users only.
  if (identity.kind === 'user') {
    const userId = Number(identity.id.slice(2))
    // In-moment activity → keep a date-less session pinned as "Just visited"
    // and un-hide it from the carousel if dismissed (re-engagement = un-hide).
    // bumpLastSeen sets the hash's TTL itself (it can be the first write, with
    // no prior /visit, after touchWithMeta's scan above already ran).
    await bumpLastSeen(c, userId)
    await unhideCarousel(userId, c)
    const hasNote = (notes || '').length > 5
    const action = ratingScore === 5
      ? (hasNote ? 'rate_5star_note' : 'rate_5star')
      : (hasNote ? 'rate_with_note' : 'rate')
    // Fire-and-forget: badge awards run in the background after the rate
    // POST has already responded. Log unexpected errors so genuine bugs
    // (DB drops, schema drift) stay visible — checkAndAwardBadges itself
    // already swallows the two known-safe Prisma codes (P2002/P2003).
    import('@/lib/badgeService').then(({ checkAndAwardBadges }) =>
      checkAndAwardBadges(userId, action)
    ).catch(err => console.error('[badges] award failed in rate handler:', err))
  }

  return NextResponse.json({ ok: true })
}
