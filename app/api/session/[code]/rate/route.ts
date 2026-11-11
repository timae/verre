import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, bumpLastSeen, unhideCarousel, lifespanTTL } from '@/lib/redis'
import { ensurePromoted, mirrorLineup, type WineMeta } from '@/lib/session'
import { ensureMemberRow } from '@/lib/sessionMember'
import { normalizeCode } from '@verre/core'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors } from '@/lib/flavours'
import { gateAromas, type AromaSelection } from '@/lib/aromas'
import { validateScore } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, admitted, refuse, ContractCold, ratingKeyWrite } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'

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
  const { wineId, score, flavors, aromas, notes } = body
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
  // Aromas are present-replaces / omitted-preserves (aroma-layer.md §4): a
  // client that predates the field (web rate pane, stale binary) must not
  // wipe selections another surface saved. `[]` present = deliberate clear.
  const aromasProvided = aromas !== undefined
  const ar = gateAromas(aromas)
  if (ar.error) return NextResponse.json({ error: ar.error }, { status: 400 })
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
  }
  if (typeof notes === 'string' && notes.length > 4000) {
    return NextResponse.json({ error: 'notes too long' }, { status: 400 })
  }

  // Identity comes from the auth cookie or x-vr-anon-token, never the body; the
  // ban/kick gate runs against the record for a `u:` caller of a
  // Postgres-backed session (and is re-made under the locks below).
  const op = await openAsParticipant(c, req, session, 'identity required')
  if (op instanceof NextResponse) return op
  const { identity } = op
  // Early 404 for a wine that isn't in the session (re-checked under the locks):
  // a rate landing after a wine DELETE must not write an orphan rating.
  if (!op.wines.some(w => w.id === wineId)) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const ratingScore = sc.value ?? 0
  const validFlavors = fl.value
  const userId = identity.kind === 'user' ? Number(identity.id.slice(2)) : null
  // Promotion is a logged-in act and runs BEFORE this route's own contract (the
  // locks are not re-entrant). Best-effort: if it fails the rating stays
  // Redis-only, as before; the next logged-in act retries the promotion.
  if (userId !== null) {
    try { await ensurePromoted(c, op.meta) }
    catch (err) { console.error('[rate] promotion failed', { code: c, err }) }
  }

  // The rate, inside the session mutation contract (redis-rehydration § 5.4,
  // plan § 3). Every rate takes the advisory lock (the record is serialized:
  // rate, check-in PATCH, deletes, rebuild) and bumps the publication generation
  // (a rebuild whose backend died cannot publish a stale rating over this one).
  // 🔒 A rate that may REAP its rating (an empty payload — score 0, no chips, no
  // notes, aromas omitted or empty) may DELETE the rating key, so it also takes
  // the Redis lease (r3-3: a key-deleting path must hold it, or a zombie
  // rebuild's NX publish could resurrect the deleted rating).
  //
  // Inside, in order: admission from the caller's FRESH grant (Redis for
  // anonymous callers); the wine read under the locks (an absent lineup is a
  // cold cache → rebuild, never "no such wine"); the server-side flavour
  // normalisation against the wine's CURRENT style; then, for a logged-in
  // rater of a Postgres-backed session, the member row, the wine's FK row
  // (the lineup mirror), the rating upsert (mirror_at = the token, § 4.3), the
  // feed item or the engagement-deletion cascade, and the lifetime counters, all in
  // this one transaction. The rating key is written last,
  // with the committed row's own token: under the advisory lock every writer of
  // the row is serialized, so the last committer also wrote the key last (the
  // old provisional-0 + post-commit re-assert dance existed only because the
  // check-in PATCH was not serialized with the rate).
  const reaps = userId !== null && ratingScore === 0 && Object.keys(validFlavors ?? {}).length === 0
    && !(typeof notes === 'string' && notes.length > 0) && (!aromasProvided || (ar.value ?? []).length === 0)
  let reclaim: string[] = []
  try {
    await withSessionMutation(c, {
      label: 'rate', redisLock: reaps ? { waitMs: 3000 } : false, caller: identity, bumpGen: true, expectedCreatedAt: op.meta.createdAt,
    }, async (tx, ctx) => {
      // Per attempt: a rolled-back attempt's captures must not survive into a
      // re-run (r3 P1 — the cold / lease / superseded retries).
      reclaim = []
      const caller = admitted(ctx)
      const raw = await redis.get(k.wines(c))
      if (raw === null) throw new ContractCold(c)
      const wines = JSON.parse(raw) as WineMeta[]
      const wine = wines.find(w => w.id === wineId)
      if (!wine) throw refuse(404, 'wine not found')
      // §6g gate + §5 zero-fill in one: the stored shape holds for every writer
      // whatever the client sent (an off-style zero key is stripped; a non-zero
      // descriptor key from a stale client → 400).
      const norm = gateAndFillFlavors(validFlavors, 'wine', wine.type)
      if (norm.error) throw refuse(400, norm.error)
      const storedFlavors = norm.value ?? {}
      const key = k.rating(c, caller.id, wineId)
      // Aromas are present-replaces / omitted-preserves (aroma-layer.md §4): an
      // omitted field keeps the prior selection — from the live key, else from
      // the archive (a TTL'd key must not let a stale client wipe them).
      let storedAromas: AromaSelection[] = ar.value ?? []
      if (!aromasProvided) {
        let preserved: AromaSelection[] | null = null
        const priorRaw = await redis.get(key)
        if (priorRaw) {
          try { const a = JSON.parse(priorRaw)?.aromas; if (Array.isArray(a)) preserved = a } catch {}
        }
        if (preserved === null && userId !== null && ctx.row) {
          const rows = await tx.$queryRaw<{ aromas: unknown }[]>`
            SELECT aromas FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${ctx.row.id} LIMIT 1`
          if (Array.isArray(rows[0]?.aromas)) preserved = rows[0].aromas as AromaSelection[]
        }
        if (preserved !== null) storedAromas = preserved
      }
      const pttl = Number(await redis.pTTL(k.meta(c)))
      const ttlMs = pttl > 0 ? pttl : lifespanTTL(ctx.row?.lifespan ?? undefined) * 1000
      const value = (aromas: AromaSelection[], at: number) =>
        JSON.stringify({ score: ratingScore, flavors: storedFlavors, aromas, notes: notes || '', at })

      if (userId === null || !ctx.row) {
        // Anonymous (never archived — Redis is their whole truth), or a
        // logged-in rater of a Redis-only session.
        await ratingKeyWrite(ctx, key, value(storedAromas, Date.now()), { pxMs: ttlMs })
        return
      }
      const sessionId = ctx.row.id
      await ensureMemberRow(tx, ctx.row, userId)
      await mirrorLineup(tx, sessionId, wines)
      // The prior row, for the counter transitions (counters never decrement).
      const priorRows = await tx.$queryRaw<{ score: unknown; notes: string | null }[]>`
        SELECT score, notes FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${sessionId} LIMIT 1`
      const prior = priorRows[0] ?? null
      // The arbiter matches the partial unique (user_id, wine_id, session_id).
      // On conflict an omitted aromas field keeps the row's value; RETURNING
      // aromas is what the row actually committed. mirror_at =
      // clock_timestamp() is the mirror-ordering token, set in the statement
      // that produces it (§ 4.3 — rated_at's transaction-start NOW() is not).
      const upsertRows = await tx.$queryRaw<{ id: number; aromas: unknown; ts: Date }[]>`
        INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at, mirror_at)
        VALUES (${wineId}, ${userId}, ${sessionId}, 'session', ${caller.displayName}, ${ratingScore}::numeric,
                ${JSON.stringify(storedFlavors)}::jsonb, ${JSON.stringify(storedAromas)}::jsonb, ${notes || null}, NOW(), clock_timestamp())
        ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL
        DO UPDATE SET
          rater_name = EXCLUDED.rater_name, score = EXCLUDED.score, flavors = EXCLUDED.flavors,
          aromas = CASE WHEN ${aromasProvided} THEN EXCLUDED.aromas ELSE ratings.aromas END,
          notes = EXCLUDED.notes, rated_at = EXCLUDED.rated_at, mirror_at = clock_timestamp()
        RETURNING id, aromas, mirror_at AS ts`
      const { id: ratingId, ts } = upsertRows[0]
      const committedAromas = Array.isArray(upsertRows[0].aromas) ? upsertRows[0].aromas as AromaSelection[] : storedAromas
      // The session feed item materialises on first engagement (score, chips,
      // aromas or a note); idempotent via the partial unique (user_id,
      // session_id). An emptied rating is reaped instead (engagement-deletion
      // cascade) — and its key goes with it.
      const engaged = ratingScore > 0 || Object.keys(storedFlavors).length > 0 || committedAromas.length > 0 || (notes != null && notes.length > 0)
      if (engaged) {
        await tx.$executeRaw`
          INSERT INTO feed_items (user_id, kind, session_id, created_at, location_public)
          VALUES (${userId}, 'session', ${sessionId}, NOW(), false)
          ON CONFLICT (user_id, session_id) DO NOTHING`
      } else {
        const reaped = await engagementCascadeIn(tx, ratingId, 'empty-only')
        if (reaped) {
          reclaim = reaped
          await ratingKeyWrite(ctx, key, null)
          return
        }
      }
      // Lifetime counters on their transitions (GREATEST / conditional
      // increments, never a decrement). Decimal → Number before equality.
      const noteLen = (notes || '').length
      const isNew = !prior
      const priorScore = prior?.score == null ? null : Number(prior.score)
      const newNote = noteLen > 5 && (!prior || (prior.notes || '').length <= 5)
      let newMonth = false
      if (isNew) {
        const [{ count }] = await tx.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*) AS count FROM ratings WHERE user_id = ${userId} AND DATE_TRUNC('month', rated_at) = DATE_TRUNC('month', NOW())`
        newMonth = Number(count) === 1
      }
      await tx.$executeRaw`
        UPDATE users SET
          lifetime_ratings = lifetime_ratings + ${isNew ? 1 : 0},
          lifetime_five_star = lifetime_five_star + ${ratingScore === 5 && priorScore !== 5 ? 1 : 0},
          lifetime_one_star = lifetime_one_star + ${ratingScore === 1 && priorScore !== 1 ? 1 : 0},
          lifetime_notes_written = lifetime_notes_written + ${newNote ? 1 : 0},
          lifetime_max_note_len = GREATEST(lifetime_max_note_len, ${noteLen}),
          lifetime_photos_added = lifetime_photos_added + ${isNew && !!(wine.imageUrl || wine.image) ? 1 : 0},
          lifetime_consecutive_months = lifetime_consecutive_months + ${newMonth ? 1 : 0},
          first_rated_at = COALESCE(first_rated_at, NOW())
        WHERE id = ${userId}`
      await ratingKeyWrite(ctx, key, value(committedAromas, new Date(ts).getTime()), { pxMs: ttlMs })
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'rate' })
  }
  reclaimImages(reclaim)
  await touchWithMeta(c)

  // Logged-in only: keep a date-less session pinned as "Just visited", un-hide
  // it from the carousel (re-engagement), award badges + XP in the background.
  if (userId !== null) {
    await bumpLastSeen(c, userId)
    await unhideCarousel(userId, c)
    const hasNote = (notes || '').length > 5
    const action = ratingScore === 5 ? (hasNote ? 'rate_5star_note' : 'rate_5star') : (hasNote ? 'rate_with_note' : 'rate')
    import('@/lib/badgeService').then(({ checkAndAwardBadges }) => checkAndAwardBadges(userId, action))
      .catch(err => console.error('[badges] award failed in rate handler:', err))
  }
  return NextResponse.json({ ok: true })
}
