import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, bumpLastSeen, unhideCarousel, lifespanTTL } from '@/lib/redis'
import { ensurePromoted, type WineMeta } from '@/lib/session'
import { reconcileLineup, lockOccurrence, readOccurrence } from '@/lib/occurrences'
import { ensureMemberRow } from '@/lib/sessionMember'
import { normalizeCode } from '@verre/core'
import { validateFlavors } from '@/lib/checkinValidation'
import { gateAndFillFlavors } from '@/lib/flavours'
import { gateAromas, type AromaSelection } from '@/lib/aromas'
import { validateScore, kindOfStyle } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { scrub } from '@/lib/textSafe'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { XP_REWARDS } from '@/lib/badges'
import { engagementCascadeIn, reclaimImages } from '@/lib/engagementCascade'
import { withSessionMutation, admitted, refuse, ContractCold, ContractRefused, ratingKeyWrite } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'
import { lineupHiddenFor } from '@/lib/sessionState'
import { afterCommit } from '@/lib/afterCommit'
import { parseWireIdentity, wireIdentity } from '@/lib/publicIds'
import {
  isOpId, isBaseVersion, readRatingVersion, bumpRatingVersion, canonicalRating, readCanonicalRating,
} from '@/lib/ratingVersions'

// The save limit (tasting feedback § 3, ruled 2026-11-25): per signed-in user,
// one budget across moments, a backstop against an auto-save loop bug or a
// stolen login. Guests are not limited (web only; auto-save is app only).
const RATE_SAVE_LIMIT = { max: 600, windowSeconds: 600 }
const noStore = { 'Cache-Control': 'private, no-store' }

// POST /api/session/<code>/rate — save the caller's rating of one bottle.
// Merge saves, the version check, counters and XP once per rating, the 503 for
// a signed-in save into a moment with no record: docs/dev/rating-saves.md.
//
// Two body forms:
// - FULL (the web Rate pane, old app binaries, the app's Clear): `score`,
//   `flavors`, `notes` are replaced (omitted = 0 / {} / none), `aromas`
//   present-replaces / omitted-preserves (aroma-layer.md §4); an empty result
//   REAPS the rating (the engagement cascade).
// - MERGE (`merge: true`, the app's auto-save; signed in only): each of
//   `score`, `flavors`, `notes`, `aromas` is optional (at least one) and an
//   omitted one keeps the stored value (a new rating: the defaults; a rating key
//   without a row is never imported). A merge NEVER reaps: a merged empty result
//   writes nothing and answers `{ ok: true, unchanged: true }`; a committed one
//   answers `{ ok: true, rating }` (the canonical RatingMeta incl. `at` and `v`).
//   Requires `opId` (a UUID) and `baseVersion`.
// 🔒 `baseVersion` (any form, signed in): under the locks, before anything else,
// the current version (`rating_versions`, 0 without a row) must equal it, else
// NOTHING is written and the answer is 409 `{ stale: true, rating, version,
// lastOpId }`. A request without it (the web) is not checked but still bumps.
// 🔒 `viewer` (any form, optional): the wire identity the app queued the change
// under; present and not the caller → 409 `{ wrongViewer: true }`, before
// anything else.
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  // The entrance gate first (leak-fixes F2). Identity comes from the auth
  // cookie or x-vr-anon-token, never the body; the ban/kick gate runs against
  // the record for a `u:` caller of a Postgres-backed session (and is re-made
  // under the locks below).
  const op = await openAsParticipant(c, req, session, 'identity required')
  if (op instanceof NextResponse) return op
  const { identity } = op
  const userId = identity.kind === 'user' ? Number(identity.id.slice(2)) : null
  // The save limit: after the entrance gate, before the body (every attempt counts).
  if (userId !== null) {
    const rl = await checkRate(`rl:rate:u:${userId}:10m`, RATE_SAVE_LIMIT.max, RATE_SAVE_LIMIT.windowSeconds)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many saves. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
        { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
      )
    }
  }
  // Reject malformed bodies so a stray empty/garbage POST
  // doesn't produce a 500. The validators below also reject negatives,
  // floats, strings, arrays and objects masquerading as numbers — the
  // previous `score || 0` fallback let any truthy value land in Redis.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { wineId, score, flavors, aromas, notes, merge, opId, baseVersion, viewer } = body
  // 🔒 The wrong-account guard (docs/dev/rating-saves.md § The wrong-account
  // guard): the app sends the account it queued the change under (`viewer`, the
  // WIRE identity: `u:<publicId>`). A save queued under one account must never
  // land as another's (a sign-out and sign-in between queue and send): present
  // and not the caller → 409 `{ wrongViewer: true }`, nothing written. Absent
  // (the web, old binaries): no check. Before the 503, the version check and
  // any write; the caller is translated, the integer id never leaves the server.
  if (viewer !== undefined) {
    const sent = parseWireIdentity(viewer)
    if (!sent) return NextResponse.json({ error: 'viewer must be a wire identity' }, { status: 400 })
    const own = await wireIdentity(identity.id)
    const same = own !== null && (sent.kind === 'user' ? `u:${sent.publicId}` === own : sent.id.toLowerCase() === own.toLowerCase())
    if (!same) return NextResponse.json({ wrongViewer: true }, { status: 409, headers: noStore })
  }
  // wineId is a string id minted in lib/session.ts — today nanoid(21)
  // for new rows; older rows are 13-char numeric timestamps. Strict
  // allow-list: digits, letters, underscore, dash — never colons, glob
  // chars, newlines, or quotes that could collide with Redis key
  // separators or confuse downstream tooling. Cap at 32 chars to leave
  // headroom while bounding key size (schema is VarChar(21)).
  if (!wineId || typeof wineId !== 'string' || wineId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(wineId)) {
    return NextResponse.json({ error: 'wineId required' }, { status: 400 })
  }
  if (merge !== undefined && typeof merge !== 'boolean') return NextResponse.json({ error: 'merge must be a boolean' }, { status: 400 })
  const isMerge = merge === true
  if (opId !== undefined && !isOpId(opId)) return NextResponse.json({ error: 'opId must be a UUID' }, { status: 400 })
  if (baseVersion !== undefined && !isBaseVersion(baseVersion)) return NextResponse.json({ error: 'baseVersion must be a non-negative integer' }, { status: 400 })
  if (isMerge && (opId === undefined || baseVersion === undefined)) return NextResponse.json({ error: 'a merge save needs opId and baseVersion' }, { status: 400 })
  if (isMerge && userId === null) return NextResponse.json({ error: 'a merge save needs a signed-in rater' }, { status: 400 })
  // Which fields this request sets: all three (+ aromas when present) for a
  // full save, only the present ones for a merge.
  const scoreGiven = !isMerge || score !== undefined
  const flavorsGiven = !isMerge || flavors !== undefined
  const notesGiven = !isMerge || notes !== undefined
  // Aromas are present-replaces / omitted-preserves (aroma-layer.md §4) in both
  // forms: a client that predates the field (web rate pane, stale binary) must
  // not wipe selections another surface saved. `[]` present = deliberate clear.
  const aromasProvided = aromas !== undefined
  if (isMerge && !scoreGiven && !flavorsGiven && !notesGiven && !aromasProvided) {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 })
  }
  const sc = validateScore(score)
  if (sc.error) return NextResponse.json({ error: sc.error }, { status: 400 })
  const fl = validateFlavors(flavors)
  if (fl.error) return NextResponse.json({ error: fl.error }, { status: 400 })
  const ar = gateAromas(aromas)
  if (ar.error) return NextResponse.json({ error: ar.error }, { status: 400 })
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
  }
  if (typeof notes === 'string' && notes.length > 4000) {
    return NextResponse.json({ error: 'notes too long' }, { status: 400 })
  }
  // The note as it is stored and compared. A MERGE (the app's auto-save) is
  // scrubbed (control / bidi / zero-width strip + trim, '' → none): the app
  // compares against the same `scrub`. A FULL save keeps today's `notes || null`
  // (scrubbing it too would make a whitespace-only full save reap: parked).
  const cleanNotes: string | null = isMerge ? scrub(notes) : (typeof notes === 'string' && notes.length > 0 ? notes : null)

  // Early 404 for a wine that isn't in the session (re-checked under the locks):
  // a rate landing after a wine DELETE must not write an orphan rating.
  // …and the same 404 for a line-up hidden from the caller (an early reject:
  // the decision is re-made under the locks below).
  // (A cache behind the record must not 404 a bottle the record has.)
  if (lineupHiddenFor(op.meta, identity) || (!op.wines.some(w => w.id === wineId) && !(await readOccurrence(c, wineId)))) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  const ratingScore = sc.value ?? 0
  const validFlavors = fl.value
  // Promotion is a logged-in act and runs BEFORE this route's own contract (the
  // locks are not re-entrant). Best-effort: if it fails, the contract below
  // finds no record and answers 503 (a signed-in rating is never written to
  // Redis only any more); the next attempt retries the promotion.
  if (userId !== null) {
    try { await ensurePromoted(c, op.meta) }
    catch (err) { console.error('[rate] promotion failed', { code: c, err }) }
  }

  // The rate, inside the session mutation contract (redis-rehydration § 5.4,
  // plan § 3). Every rate takes the advisory lock (the record is serialized:
  // rate, check-in PATCH, deletes, rebuild) and bumps the publication generation
  // (a rebuild whose backend died cannot publish a stale rating over this one).
  // 🔒 A FULL rate that may REAP its rating (an empty payload — score 0, no
  // chips, no notes, aromas omitted or empty) may DELETE the rating key, so it
  // also takes the Redis lease (r3-3: a key-deleting path must hold it, or a
  // zombie rebuild's NX publish could resurrect the deleted rating). A merge
  // never reaps.
  //
  // Inside, in order: admission from the caller's FRESH grant (Redis for
  // anonymous callers); a signed-in caller without a record → 503; the wine
  // read under the locks (an absent lineup is a cold cache → rebuild, never "no
  // such wine"); for a signed-in rater: the version check, the server-side
  // flavour normalisation against the wine's CURRENT style, the merge (a merged
  // empty result: `unchanged`, before anything is written), the member row, the
  // rating upsert (mirror_at = the token, § 4.3) with the once-per-rating flags,
  // the feed item or the engagement-deletion cascade (+ the take-back of the
  // action XP), the lifetime counters and the action XP, the version bump, all
  // in this one transaction. The rating key is written last, with the committed
  // row's own token and version: under the advisory lock every writer of the row
  // is serialized, so the last committer also wrote the key last.
  const reaps = !isMerge && userId !== null && ratingScore === 0 && Object.keys(validFlavors ?? {}).length === 0
    && !cleanNotes && (!aromasProvided || (ar.value ?? []).length === 0)
  type Outcome = { kind: 'saved'; rating: ReturnType<typeof canonicalRating> | null } | { kind: 'unchanged' } | { kind: 'cleared' }
  let reclaim: string[] = []
  let outcome = { kind: 'saved', rating: null } as Outcome
  try {
    await withSessionMutation(c, {
      label: 'rate', redisLock: reaps ? { waitMs: 3000 } : false, caller: identity, bumpGen: true, expectedCreatedAt: op.meta.createdAt,
    }, async (tx, ctx) => {
      // Per attempt: a rolled-back attempt's captures must not survive into a
      // re-run (r3 P1 — the cold / lease / superseded retries).
      reclaim = []
      outcome = { kind: 'saved', rating: null }
      const caller = admitted(ctx)
      // 🔒 No signed-in rating is written to Redis only (Simon, 2026-11-25):
      // without a record (its promotion failed) a version beside the write
      // could not commit with it. Nothing written; the client retries.
      if (userId !== null && !ctx.row) throw refuse(503, 'This moment isn’t ready to save yet. Try again in a moment.', { 'Retry-After': '5' })
      // The bottle from its authority: the RECORD in a Postgres-backed moment
      // (model change § 8a; a NULL revision reconciled first, so a cache-only
      // bottle of an old failed mirror gets its row), the cached line-up in a
      // Redis-only one. The rate no longer mirrors the line-up: the row exists.
      let wine: WineMeta | null
      if (ctx.row) {
        await reconcileLineup(tx, ctx)
        wine = await lockOccurrence(tx, ctx.row.id, wineId)
      } else {
        const raw = await redis.get(k.wines(c))
        if (raw === null) throw new ContractCold(c)
        wine = (JSON.parse(raw) as WineMeta[]).find(w => w.id === wineId) ?? null
      }
      // 🔒 A hidden line-up (the live rule, decided here from the fresh grant +
      // meta) is the same 404: the read hides the bottle, so must the write.
      if (!wine || !ctx.meta || lineupHiddenFor(ctx.meta, caller)) throw refuse(404, 'wine not found')
      // rating-write: EXEMPT
      const key = k.rating(c, caller.id, wineId)
      const pttl = Number(await redis.pTTL(k.meta(c)))
      const ttlMs = pttl > 0 ? pttl : lifespanTTL(ctx.row?.lifespan ?? undefined) * 1000
      // §6g gate + §5 zero-fill in one: the stored shape holds for every writer
      // whatever the client sent (an off-style zero key is stripped; a non-zero
      // descriptor key from a stale client → 400).
      // Bubbles from the bottle's kind (its snapshot: the cached `type` is the
      // token a link derived from the entry's pair; catalogue model change step 4).
      const normFlavors = () => {
        const norm = gateAndFillFlavors(validFlavors, 'wine', kindOfStyle(wine!.type))
        if (norm.error) throw refuse(400, norm.error)
        return norm.value ?? {}
      }

      if (userId === null || !ctx.row) {
        // A guest (never archived — Redis is their whole truth): today's full
        // save, no version. Aromas omitted keep the key's.
        const storedFlavors = normFlavors()
        let storedAromas: AromaSelection[] = ar.value ?? []
        if (!aromasProvided) {
          const priorRaw = await redis.get(key)
          if (priorRaw) {
            try { const a = JSON.parse(priorRaw)?.aromas; if (Array.isArray(a)) storedAromas = a } catch {}
          }
        }
        // rating-write: EXEMPT
        await ratingKeyWrite(ctx, key, JSON.stringify({ score: ratingScore, flavors: storedFlavors, aromas: storedAromas, notes: cleanNotes ?? '', at: Date.now() }), { pxMs: ttlMs })
        return
      }
      const sessionId = ctx.row.id
      // 🔒 The version check, before anything is written.
      const current = await readRatingVersion(tx, userId, wineId)
      if (baseVersion !== undefined && baseVersion !== current.version) {
        const rating = await readCanonicalRating(tx, userId, sessionId, wineId, current.version)
        throw new ContractRefused(NextResponse.json(
          { stale: true, rating, version: current.version, lastOpId: current.lastOpId }, { status: 409, headers: noStore }))
      }
      const storedFlavors = flavorsGiven ? normFlavors() : null
      // The prior row: the merge's base, the flags and the counter transitions.
      // (A rating key without a row is NEVER imported: it can be a post-edit
      // clear whose Redis delete failed, or a rebuild's kept key of a live
      // user with no row; importing it would resurrect a deleted rating.)
      const priorRows = await tx.$queryRaw<{ score: unknown; flavors: unknown; aromas: unknown; notes: string | null; five_star_counted: boolean; one_star_counted: boolean; note_counted: boolean }[]>`
        SELECT score, flavors, aromas, notes, five_star_counted, one_star_counted, note_counted
          FROM ratings WHERE wine_id = ${wineId} AND user_id = ${userId} AND session_id = ${sessionId} LIMIT 1 FOR UPDATE`
      const prior = priorRows[0] ?? null
      // Aromas omitted keep the ROW's (the upsert's CASE), in both forms; a new
      // row starts from none (the row is the authority: the key is not read).
      const mAromas: AromaSelection[] = aromasProvided ? (ar.value ?? [])
        : Array.isArray(prior?.aromas) ? prior.aromas as AromaSelection[] : []
      // The MERGED result (prior ⊕ the validated, normalised supplied fields).
      const mScore = scoreGiven ? ratingScore : (prior?.score == null ? 0 : Number(prior.score))
      const mFlavors = storedFlavors ?? ((prior?.flavors && typeof prior.flavors === 'object' && !Array.isArray(prior.flavors) ? prior.flavors : {}) as Record<string, number>)
      const mNotes = notesGiven ? cleanNotes : (prior?.notes || null)
      // 🔒 A merge NEVER reaps: a merged empty result writes nothing (no member
      // row, no counters, no key), before every side effect.
      if (isMerge && mScore === 0 && Object.keys(mFlavors).length === 0 && mAromas.length === 0 && !mNotes) {
        outcome = { kind: 'unchanged' }
        return
      }
      await ensureMemberRow(tx, ctx.row, userId)
      // The arbiter matches the partial unique (user_id, wine_id, session_id).
      // VALUES carry the merged result, and every field follows the aromas
      // pattern on conflict (an omitted field keeps the row's value: a belt, the
      // merged values were computed from the locked row). The three flags are
      // set once and never cleared (count ONCE per rating); the note rule is
      // `char_length` (code points), the backfill's own. mirror_at =
      // clock_timestamp() is the mirror-ordering token, set in the statement
      // that produces it (§ 4.3 — rated_at's transaction-start NOW() is not).
      // rating-write: BUMPS
      const upsertRows = await tx.$queryRaw<{ id: number; score: unknown; flavors: unknown; aromas: unknown; notes: string | null; ts: Date; five_star_counted: boolean; one_star_counted: boolean; note_counted: boolean }[]>`
        INSERT INTO ratings (wine_id, user_id, session_id, origin, rater_name, score, flavors, aromas, notes, rated_at, mirror_at,
                             five_star_counted, one_star_counted, note_counted)
        VALUES (${wineId}, ${userId}, ${sessionId}, 'session', ${caller.displayName}, ${mScore}::numeric,
                ${JSON.stringify(mFlavors)}::jsonb, ${JSON.stringify(mAromas)}::jsonb, ${mNotes}, NOW(), clock_timestamp(),
                ${mScore}::numeric = 5, ${mScore}::numeric = 1, COALESCE(char_length(${mNotes}::text) > 5, false))
        ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL
        DO UPDATE SET
          rater_name = EXCLUDED.rater_name,
          score = CASE WHEN ${scoreGiven} THEN EXCLUDED.score ELSE ratings.score END,
          flavors = CASE WHEN ${flavorsGiven} THEN EXCLUDED.flavors ELSE ratings.flavors END,
          aromas = CASE WHEN ${aromasProvided} THEN EXCLUDED.aromas ELSE ratings.aromas END,
          notes = CASE WHEN ${notesGiven} THEN EXCLUDED.notes ELSE ratings.notes END,
          rated_at = EXCLUDED.rated_at, mirror_at = clock_timestamp(),
          five_star_counted = ratings.five_star_counted OR EXCLUDED.five_star_counted,
          one_star_counted = ratings.one_star_counted OR EXCLUDED.one_star_counted,
          note_counted = ratings.note_counted OR EXCLUDED.note_counted
        RETURNING id, score, flavors, aromas, notes, mirror_at AS ts, five_star_counted, one_star_counted, note_counted`
      const row = upsertRows[0]
      const ratingId = row.id
      const committed = canonicalRating(row, new Date(row.ts).getTime(), 0)
      // The session feed item materialises on first engagement (score, chips,
      // aromas or a note); idempotent via the partial unique (user_id,
      // session_id). An emptied rating (a FULL save) is reaped instead
      // (engagement-deletion cascade, the owner's own clear: its action XP is
      // taken back) — and its key goes with it.
      const engaged = committed.score > 0 || Object.keys(committed.flavors).length > 0 || (committed.aromas ?? []).length > 0 || committed.notes.length > 0
      if (engaged) {
        await tx.$executeRaw`
          INSERT INTO feed_items (user_id, kind, session_id, created_at, location_public)
          VALUES (${userId}, 'session', ${sessionId}, NOW(), false)
          ON CONFLICT (user_id, session_id) DO NOTHING`
      } else {
        // rating-write: BUMPS
        const reaped = await engagementCascadeIn(tx, ratingId, 'empty-only', { ownClear: true })
        if (reaped) {
          reclaim = reaped
          await bumpRatingVersion(tx, userId, wineId, opId ?? null)
          // rating-write: BUMPS
          await ratingKeyWrite(ctx, key, null)
          outcome = { kind: 'cleared' }
          return
        }
      }
      // Lifetime counters and the rating-action XP ONCE per rating (tasting
      // feedback § 2): `lifetime_ratings` and +10 only for a new rating, the
      // five-star / one-star / note counters (+5 five-star, +5 note) only on
      // their flag's flip. Counters never decrement. The XP goes into this
      // transactional UPDATE (after COMMIT the flags are set, so a lost
      // background award would lose it for good) and onto the row
      // (`rating_action_xp`, what the owner's own clear takes back).
      const isNew = !prior
      const fiveFlip = row.five_star_counted && !prior?.five_star_counted
      const oneFlip = row.one_star_counted && !prior?.one_star_counted
      const noteFlip = row.note_counted && !prior?.note_counted
      const actionXp = (isNew ? XP_REWARDS.RATE_WINE : 0) + (fiveFlip ? XP_REWARDS.GIVE_5_STAR : 0) + (noteFlip ? XP_REWARDS.WRITE_NOTE : 0)
      const noteLen = committed.notes.length
      let newMonth = false
      if (isNew) {
        const [{ count }] = await tx.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*) AS count FROM ratings WHERE user_id = ${userId} AND DATE_TRUNC('month', rated_at) = DATE_TRUNC('month', NOW())`
        newMonth = Number(count) === 1
      }
      if (actionXp > 0) {
        // rating-write: BUMPS
        await tx.$executeRaw`UPDATE ratings SET rating_action_xp = rating_action_xp + ${actionXp} WHERE id = ${ratingId}`
      }
      await tx.$executeRaw`
        UPDATE users SET
          lifetime_ratings = lifetime_ratings + ${isNew ? 1 : 0},
          lifetime_five_star = lifetime_five_star + ${fiveFlip ? 1 : 0},
          lifetime_one_star = lifetime_one_star + ${oneFlip ? 1 : 0},
          lifetime_notes_written = lifetime_notes_written + ${noteFlip ? 1 : 0},
          lifetime_max_note_len = GREATEST(lifetime_max_note_len, ${noteLen}),
          lifetime_photos_added = lifetime_photos_added + ${isNew && !!(wine.imageUrl || wine.image) ? 1 : 0},
          lifetime_consecutive_months = lifetime_consecutive_months + ${newMonth ? 1 : 0},
          first_rated_at = COALESCE(first_rated_at, NOW()),
          xp = xp + ${actionXp}
        WHERE id = ${userId}`
      const v = await bumpRatingVersion(tx, userId, wineId, opId ?? null)
      const rating = { ...committed, v }
      // rating-write: BUMPS
      await ratingKeyWrite(ctx, key, JSON.stringify(rating), { pxMs: ttlMs })
      outcome = { kind: 'saved', rating }
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'rate' })
  }
  // A merged empty result: nothing was written, so nothing else runs (no
  // refresh, no last-seen bump, no carousel unhide, no badge evaluation).
  if (outcome.kind === 'unchanged') return NextResponse.json({ ok: true, unchanged: true }, { headers: noStore })
  reclaimImages(reclaim)
  // 🔒 The committed outcome is answered AT ONCE: the best-effort steps after
  // COMMIT run in the background, each caught and logged on its own. They can
  // throw (lib/redis.ts) or stall (the shared client queues commands while
  // disconnected); awaited, a committed save would report failure and the app
  // would keep its old cache (or a committed Clear its old draft). Coalesced
  // per key (one run + one trailing per moment or rater, lib/afterCommit.ts).
  // Logged-in only: keep a date-less session pinned as "Just visited", un-hide
  // it from the carousel (re-engagement), evaluate badges (only NEW badges'
  // own XP: the action XP was credited in the transaction).
  afterCommit('rate', 'touch', c, () => touchWithMeta(c))
  if (userId !== null) {
    afterCommit('rate', 'last-seen', `${userId}:${c}`, () => bumpLastSeen(c, userId))
    afterCommit('rate', 'carousel', `${userId}:${c}`, () => unhideCarousel(userId, c))
    afterCommit('rate', 'badges', userId, () => import('@/lib/badgeService').then(({ checkAndAwardBadges }) => checkAndAwardBadges(userId)))
  }
  if (isMerge && outcome.kind === 'saved' && outcome.rating) return NextResponse.json({ ok: true, rating: outcome.rating }, { headers: noStore })
  return NextResponse.json({ ok: true }, { headers: noStore })
}
