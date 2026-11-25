import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { VISIBILITIES, readMomentSettings, writeVisibility, widens, frozen, type MomentSettings, type MomentVisibility, type VisibilityPatch } from '@/lib/momentSettings'
import { withSessionMutation } from '@/lib/sessionMutation'
import { checkRate, checkRateOrThrow, peekRate, refundRate, type RateResult } from '@/lib/rateLimit'
import { momentLookInEnabled, hideFromFeedEnabled } from '@/lib/momentGate'
import { postPrivacyKey } from '@/lib/postPrivacy'

// Moment Defaults (docs/dev/proposals/moment-defaults.md; the build plan
// .local/moment-visibility/moment-defaults-plan.md). A person's own defaults
// for the four host settings, their own two choices in a moment (Incognito,
// Hide from Feed) and a check-in's Hide from Feed.
//
// 🔒 COPIED, NEVER LIVE. Nothing that shows a moment or a post reads this
// table. A default is copied when participation STARTS (seedParticipation,
// called by the three ENTRY writers of `session_members`: the create,
// `ensureMemberRow` on an insert or a cleared kick, promotion's non-kicked
// inserts; CI census scripts/check-member-writes.mjs) and into a check-in at
// its POST. Existing participation is grandfathered: legacy rating authors and
// legacy hosts never get one. Changing a default changes nothing that exists;
// only the deliberate apply does (applyDefault).

type Db = Prisma.TransactionClient | typeof prisma

export type MomentDefaults = {
  visibility: MomentVisibility
  includeGuestCircles: boolean
  showPlace: boolean
  showDetails: boolean
  onlyInside: boolean
  momentHiddenFromFeed: boolean
  checkinHiddenFromFeed: boolean
}
export type DefaultField = keyof MomentDefaults
export type Section = 'host' | 'moments' | 'checkins'

// = the column defaults of `sessions` (visibility, the three switches),
// `moment_privacy` and `feed_items.hidden_from_feed` (pinned by the suite
// against information_schema, so the two can't drift).
export const SYSTEM_DEFAULTS: Readonly<MomentDefaults> = Object.freeze({
  visibility: 'friends', includeGuestCircles: true, showPlace: false, showDetails: false,
  onlyInside: false, momentHiddenFromFeed: false, checkinHiddenFromFeed: false,
})

export const SECTION: Record<DefaultField, Section> = {
  visibility: 'host', includeGuestCircles: 'host', showPlace: 'host', showDetails: 'host',
  onlyInside: 'moments', momentHiddenFromFeed: 'moments', checkinHiddenFromFeed: 'checkins',
}
const FIELDS = Object.keys(SECTION) as DefaultField[]
const COLUMN: Record<DefaultField, Prisma.Sql> = {
  visibility: Prisma.raw('visibility'), includeGuestCircles: Prisma.raw('include_guest_circles'),
  showPlace: Prisma.raw('show_place'), showDetails: Prisma.raw('show_details'), onlyInside: Prisma.raw('only_inside'),
  momentHiddenFromFeed: Prisma.raw('moment_hidden_from_feed'), checkinHiddenFromFeed: Prisma.raw('checkin_hidden_from_feed'),
}
// The own-choice columns of moment_privacy.
const PRIVACY_COLUMN = { onlyInside: Prisma.raw('only_inside'), momentHiddenFromFeed: Prisma.raw('hidden_from_feed') }

const isVisibility = (v: unknown): v is MomentVisibility => (VISIBILITIES as readonly unknown[]).includes(v)

type Row = {
  visibility: string | null; include_guest_circles: boolean | null; show_place: boolean | null; show_details: boolean | null
  only_inside: boolean | null; moment_hidden_from_feed: boolean | null; checkin_hidden_from_feed: boolean | null
}

// Resolved: a NULL column (or no row) is the system default.
export async function readDefaults(db: Db, userId: number): Promise<MomentDefaults> {
  const r = (await db.$queryRaw<Row[]>`
    SELECT visibility, include_guest_circles, show_place, show_details, only_inside, moment_hidden_from_feed, checkin_hidden_from_feed
      FROM moment_defaults WHERE user_id = ${userId}`)[0]
  const d = SYSTEM_DEFAULTS
  if (!r) return { ...d }
  return {
    visibility: isVisibility(r.visibility) ? r.visibility : d.visibility,
    includeGuestCircles: r.include_guest_circles ?? d.includeGuestCircles,
    showPlace: r.show_place ?? d.showPlace,
    showDetails: r.show_details ?? d.showDetails,
    onlyInside: r.only_inside ?? d.onlyInside,
    momentHiddenFromFeed: r.moment_hidden_from_feed ?? d.momentHiddenFromFeed,
    checkinHiddenFromFeed: r.checkin_hidden_from_feed ?? d.checkinHiddenFromFeed,
  }
}

// The PATCH body: exactly one known field with a value of its type, else null.
export function parseDefaultPatch(body: unknown): { field: DefaultField; value: MomentVisibility | boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || !(FIELDS as string[]).includes(keys[0])) return null
  const field = keys[0] as DefaultField
  const value = (body as Record<string, unknown>)[field]
  if (field === 'visibility' ? !isVisibility(value) : typeof value !== 'boolean') return null
  return { field, value: value as MomentVisibility | boolean }
}

export async function writeDefault(userId: number, field: DefaultField, value: MomentVisibility | boolean): Promise<void> {
  const col = COLUMN[field]
  await prisma.$executeRaw`
    INSERT INTO moment_defaults (user_id, ${col}, updated_at) VALUES (${userId}, ${value}, now())
    ON CONFLICT (user_id) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_at = now()`
}

// ── Copying (K1, K3) ─────────────────────────────────────────────────────────

// The create body's own choices for this moment (the host only), winning over
// the defaults field by field; absent = the default.
export type ParticipationOverride = { onlyInside?: boolean; hiddenFromFeed?: boolean }

// 🔒 ONE set-based statement, sourced from the PEOPLE (a create override for
// someone with no defaults row must still write: review r1 P1), each person's
// OWN defaults (promotion: never the promoter's). A row only when a resolved
// value is ON (no row and an all-false row read the same everywhere), never
// over an existing row, never for someone who already rated in this moment (a
// rating author's participation is old: K1). The caller decides the rest of
// K1: participation STARTS in this transaction (its member insert, or `/join`
// clearing a kick) and the person is not the strict host (the create seeds the
// host itself). A seed only ever HIDES.
export async function seedParticipation(
  tx: Prisma.TransactionClient, row: { id: number }, userIds: number[], override: ParticipationOverride = {},
): Promise<number> {
  if (!userIds.length) return 0
  const oi = override.onlyInside ?? null
  const hf = override.hiddenFromFeed ?? null
  return tx.$executeRaw`
    INSERT INTO moment_privacy (session_id, user_id, only_inside, hidden_from_feed)
    SELECT ${row.id}, u.id, v.oi, v.hf
      FROM unnest(${userIds}::int[]) AS u(id)
      LEFT JOIN moment_defaults d ON d.user_id = u.id
      CROSS JOIN LATERAL (SELECT COALESCE(${oi}::boolean, d.only_inside, false) AS oi,
                                 COALESCE(${hf}::boolean, d.moment_hidden_from_feed, false) AS hf) v
     WHERE (v.oi OR v.hf)
       AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.session_id = ${row.id} AND r.user_id = u.id)
    ON CONFLICT (session_id, user_id) DO NOTHING`
}

// The create body's `privacy` (a signed-in create; a guest's is ignored by the
// caller): every field optional, `false` a choice like `true`. Returns the
// parsed choices, or a string error (400).
export type CreatePrivacy = Partial<Pick<MomentDefaults, 'visibility' | 'includeGuestCircles' | 'showPlace' | 'showDetails' | 'onlyInside'>> & { hiddenFromFeed?: boolean }
export function parseCreatePrivacy(raw: unknown): CreatePrivacy | string {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid privacy'
  const b = raw as Record<string, unknown>
  const out: CreatePrivacy = {}
  if (b.visibility !== undefined) {
    if (!isVisibility(b.visibility)) return 'invalid privacy.visibility'
    out.visibility = b.visibility
  }
  for (const key of ['includeGuestCircles', 'showPlace', 'showDetails', 'onlyInside', 'hiddenFromFeed'] as const) {
    if (b[key] === undefined) continue
    if (typeof b[key] !== 'boolean') return `invalid privacy.${key}`
    out[key] = b[key] as boolean
  }
  return out
}

// The four host settings a signed-in create writes: the body's, else the
// host's defaults (read in the create's transaction).
export function createHostSettings(privacy: CreatePrivacy, d: MomentDefaults): Pick<MomentDefaults, 'visibility' | 'includeGuestCircles' | 'showPlace' | 'showDetails'> {
  return {
    visibility: privacy.visibility ?? d.visibility,
    includeGuestCircles: privacy.includeGuestCircles ?? d.includeGuestCircles,
    showPlace: privacy.showPlace ?? d.showPlace,
    showDetails: privacy.showDetails ?? d.showDetails,
  }
}

// ── Direction (D2) ───────────────────────────────────────────────────────────

// A host switch going ON opens wider; an own choice going ON hides (narrower).
const HIDES: Record<DefaultField, boolean> = {
  visibility: false, includeGuestCircles: false, showPlace: false, showDetails: false,
  onlyInside: true, momentHiddenFromFeed: true, checkinHiddenFromFeed: true,
}
// Applying `value` can only open wider / only narrow (Visible To mixes, except
// at either end).
export function onlyWidens(field: DefaultField, value: MomentVisibility | boolean): boolean {
  if (field === 'visibility') return value === VISIBILITIES[VISIBILITIES.length - 1]
  return HIDES[field] ? value === false : value === true
}
// Does changing the default from `from` to `to` make it MORE private? (Visible
// To to a narrower audience, a host switch off, an own choice on.) The PATCH
// never charges or refuses that (R10: hiding is never refused), so a Cancel
// that undoes a widening always goes through (Codex build r9).
export function narrowsDefault(field: DefaultField, from: MomentVisibility | boolean, to: MomentVisibility | boolean): boolean {
  if (field === 'visibility') return VISIBILITIES.indexOf(to as MomentVisibility) < VISIBILITIES.indexOf(from as MomentVisibility)
  return HIDES[field] ? to === true && from === false : to === false && from === true
}

// 🔒 A WIDENING apply respects the matching write fence (§ 2.5); copying and
// narrowing never check a flag.
export function widenFlagOn(field: DefaultField): boolean {
  return SECTION[field] === 'checkins' || field === 'momentHiddenFromFeed' ? hideFromFeedEnabled() : momentLookInEnabled()
}

// ── The preview (`existing` on the PATCH's answer) ───────────────────────────

export type Preview = { field: DefaultField; value: MomentVisibility | boolean; count: number; wider: number; narrower: number }

const rankSql = Prisma.sql`CASE s.visibility WHEN 'friends' THEN 1 WHEN 'followers' THEN 2 WHEN 'verre' THEN 3 ELSE 0 END`

// Host fields over the moments you host yourself, live (cohosted and frozen
// moments are excluded by construction, D9): what would open wider, what
// would narrow, as SQL over `sessions s` (NULL reads closed / off, as
// lib/momentSettings.ts fromRow). K6: the circles switch widens only where
// Visible To is Friends / Followers, and narrows everywhere it is on.
function hostDiffSql(field: DefaultField, value: MomentVisibility | boolean): { wider: Prisma.Sql; narrower: Prisma.Sql } {
  const FALSE = Prisma.sql`false`
  if (field === 'visibility') {
    const target = VISIBILITIES.indexOf(value as MomentVisibility)
    return { wider: Prisma.sql`${rankSql} < ${target}`, narrower: Prisma.sql`${rankSql} > ${target}` }
  }
  const col = COLUMN[field]
  if (field === 'includeGuestCircles') {
    return value
      ? { wider: Prisma.sql`s.include_guest_circles IS NOT TRUE AND s.visibility IN ('friends', 'followers')`, narrower: FALSE }
      : { wider: FALSE, narrower: Prisma.sql`s.include_guest_circles IS TRUE` }
  }
  return value ? { wider: Prisma.sql`s.${col} IS NOT TRUE`, narrower: FALSE } : { wider: FALSE, narrower: Prisma.sql`s.${col} IS TRUE` }
}

// Your choices' scope S (§ 2.4): live or deleted moments where you have a
// member row NOT kicked (a kicked row may be a placeholder kick-keep wrote for
// anyone), or a kicked one WITH a privacy row of yours (it proves you took
// part), are the strict host of a live moment (a legacy host may have no member
// row), have a rating, or have a moment post.
function scopeSql(userId: number): Prisma.Sql {
  return Prisma.sql`
    SELECT s.id FROM session_members sm JOIN sessions s ON s.code = sm.session_code AND s.deleted_at IS NULL
     WHERE sm.user_id = ${userId}
       AND (sm.removed_state IS DISTINCT FROM 'kicked'
            OR EXISTS (SELECT 1 FROM moment_privacy p WHERE p.session_id = s.id AND p.user_id = ${userId}))
    UNION SELECT id FROM sessions WHERE host_user_id = ${userId} AND deleted_at IS NULL
    UNION SELECT session_id FROM ratings WHERE user_id = ${userId} AND session_id IS NOT NULL
    UNION SELECT session_id FROM feed_items WHERE user_id = ${userId} AND kind = 'session' AND session_id IS NOT NULL`
}

export async function previewDefault(db: Db, userId: number, field: DefaultField, value: MomentVisibility | boolean): Promise<Preview | null> {
  let wider = 0, narrower = 0
  const section = SECTION[field]
  if (section === 'host') {
    const d = hostDiffSql(field, value)
    const r = (await db.$queryRaw<{ wider: number; narrower: number }[]>`
      SELECT COUNT(*) FILTER (WHERE ${d.wider})::int AS wider, COUNT(*) FILTER (WHERE ${d.narrower})::int AS narrower
        FROM sessions s WHERE s.host_user_id = ${userId} AND s.deleted_at IS NULL`)[0]
    wider = r.wider; narrower = r.narrower
  } else {
    const n = section === 'moments'
      ? (await db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM (${scopeSql(userId)}) x(id)
            LEFT JOIN moment_privacy mp ON mp.session_id = x.id AND mp.user_id = ${userId}
           WHERE COALESCE(mp.${PRIVACY_COLUMN[field as keyof typeof PRIVACY_COLUMN]}, false) <> ${value}`)[0].n
      : (await db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM feed_items WHERE user_id = ${userId} AND kind = 'standalone' AND hidden_from_feed <> ${value}`)[0].n
    if (value) narrower = n; else wider = n
  }
  const count = wider + narrower
  return count ? { field, value, count, wider, narrower } : null
}

// ── The apply (K5, K6, K7, § 2.4) ────────────────────────────────────────────

// Test seams (scripts/tests/moment-defaults-section.mts): `redis(step)` runs
// inside each of the apply's bounded Redis calls (a stall injected there must
// hit the deadline); `afterParentLocks` between the own-choices hide's parent
// locks and its upsert.
export const momentDefaultsSeams: {
  redis: (step: 'peek' | 'reserve' | 'charge' | 'refund') => Promise<void>
  afterParentLocks: (userId: number) => Promise<void>
} = { redis: async () => {}, afterParentLocks: async () => {} }

export const REDIS_DEADLINE_MS = 500
export const LOCK_TIMEOUT_MS = 2000
const OPEN: RateResult = { allowed: true, retryAfter: 0 }

// 🔒 Every Redis call of the apply has a deadline: the shared client QUEUES
// commands while disconnected, so a plain await can hang (Codex r5 P2). The
// caller picks what a timeout means: the request limiter fails OPEN (a hide
// must reach Postgres), the widening reservation fails CLOSED.
async function bounded<T>(step: 'peek' | 'reserve' | 'charge' | 'refund', call: () => Promise<T>, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>(resolve => { timer = setTimeout(() => resolve(onTimeout), REDIS_DEADLINE_MS) })
  try {
    return await Promise.race([momentDefaultsSeams.redis(step).then(call), deadline])
  } finally {
    clearTimeout(timer)
  }
}

export const applyRequestKey = (userId: number) => ({ key: `rl:moment-defaults-apply-req:u:${userId}:1m`, max: 60, window: 60 })
export const applySectionKey = (userId: number, section: Section) => ({ key: `rl:moment-defaults-apply:${section}:u:${userId}:1h`, max: 10, window: 3600 })
// The single-item change budget a widening action also draws one change from.
export const applyItemKey = (userId: number, section: Section) => section === 'host'
  ? { key: `rl:moment-visibility:u:${userId}:1h`, max: 30, window: 3600 }
  : { ...postPrivacyKey.user(userId), window: 3600 }

type Reservation = { refund: () => Promise<void> }

// ONE slot on the section's bulk key AND one change on the single-item key,
// never under a Postgres lock. 🔒 Granted only when Redis CONFIRMED both
// charges: a timeout or a Redis error is a refusal (fails closed; Codex build
// r1: `checkRate` allows on an error, so a failover could have widened
// uncharged). 🔒 A refusal on EITHER refunds BOTH (`checkRate` increments
// before it compares), but only keys that were charged: an answered one now,
// a timed-out one once its increment confirms; an errored one was not, and a
// refund there would erase an earlier charge.
type Charge = { r: RateResult } | { timedOut: true } | { failed: true }
// `done` settles with whether Redis actually charged the key (also after the
// deadline: a timed-out increment may still land).
function charge(k: { key: string; max: number; window: number }): { got: Promise<Charge>; done: Promise<boolean> } {
  const inner = momentDefaultsSeams.redis('reserve').then(() => checkRateOrThrow(k.key, k.max, k.window))
  const done = inner.then(() => true, () => false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Charge>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), REDIS_DEADLINE_MS) })
  const got = Promise.race([inner.then((r): Charge => ({ r }), (): Charge => ({ failed: true })), deadline]).finally(() => clearTimeout(timer))
  return { got, done }
}
async function reserveWidening(userId: number, section: Section): Promise<{ granted: Reservation } | { refused: RateResult }> {
  const keys = [applySectionKey(userId, section), applyItemKey(userId, section)]
  const charges = keys.map(charge)
  const results = await Promise.all(charges.map(c => c.got))
  // An answered key is refunded now (bounded); a timed-out one only once its
  // increment CONFIRMS (Codex build r2: a connection lost before Redis ran it
  // would otherwise refund a slot it never took), not awaited; an errored one
  // never (it was not charged).
  const refund = async () => {
    await Promise.all(keys.map((k, i) => {
      const c = results[i]
      if ('r' in c) return bounded('refund', () => refundRate(k.key), undefined)
      if ('timedOut' in c) void charges[i].done.then(ok => (ok ? refundRate(k.key) : undefined))
      return undefined
    }))
  }
  if (results.every(c => 'r' in c && c.r.allowed)) return { granted: { refund } }
  await refund()
  // The wait: a refused counter's own, 60 s for a timeout or an error, nothing
  // for an allowed one (Codex build r2 P3).
  const waits = results.map(c => ('r' in c ? (c.r.allowed ? 0 : c.r.retryAfter) : 60))
  return { refused: { allowed: false, retryAfter: Math.max(...waits, 1) } }
}

export type ApplyOutcome =
  | { status: 'ok'; changed: number }
  | { status: 'not-found' }
  | { status: 'limited'; changed: number; retryAfter: number }

type Step = 'narrowed' | 'widened' | 'would-widen' | 'none'

// One hosted moment under its own contract, PG only (no Redis lock, no meta:
// never opened, never rebuilt), the lock wait bounded by `lockTimeoutMs`.
// 🔒 Decided under the locks: the row is still the one the scan read (codes
// recycle: bind the id) and you are its strict host by the FRESH grant
// (`ctx.meta` is null: never isStrictHost(meta, …)); the direction and K6 are
// decided again from the LOCKED row (a cohost can change it after the scan).
// Timed out, gone, or any throw → left as it is (not reported: K7).
async function hostStep(userId: number, cand: { id: number; code: string }, field: DefaultField, value: MomentVisibility | boolean, mayWiden: boolean): Promise<Step> {
  try {
    return await withSessionMutation(cand.code, {
      label: 'moment-defaults-apply', redisLock: false, readMeta: false, lockTimeoutMs: LOCK_TIMEOUT_MS,
      caller: { id: `u:${userId}`, displayName: '', kind: 'user' },
    }, async (tx, ctx): Promise<Step> => {
      if (!ctx.row || ctx.row.id !== cand.id || ctx.callerStatus !== 'ok' || !ctx.caller?.grant?.strictHost) return 'none'
      const current = await readMomentSettings(tx, ctx.row.id)
      if (!current || frozen(current)) return 'none'
      const patch = hostPatch(field, value, current)
      if (!patch) return 'none'
      const wider = widens(current, patch)
      if (wider && !mayWiden) return 'would-widen'
      await writeVisibility(tx, current, patch)
      return wider ? 'widened' : 'narrowed'
    })
  } catch (err) {
    if (isLockTimeout(err)) console.warn('[moment-defaults] apply: lock timeout, moment left as it is', { sessionId: cand.id })
    else console.error('[moment-defaults] apply: moment left as it is', { sessionId: cand.id, err })
    return 'none'
  }
}

// What applying the default changes on this (locked) moment, or null. K6: the
// circles switch is turned ON only where Visible To is Friends / Followers.
function hostPatch(field: DefaultField, value: MomentVisibility | boolean, s: MomentSettings): VisibilityPatch | null {
  if (field === 'visibility') return value !== s.visibility ? { visibility: value as MomentVisibility } : null
  if (field === 'includeGuestCircles') {
    if (value === true) return !s.includeGuestCircles && (s.visibility === 'friends' || s.visibility === 'followers') ? { includeGuestCircles: true } : null
    return s.includeGuestCircles ? { includeGuestCircles: false } : null
  }
  if (field === 'showPlace' || field === 'showDetails') return s[field] !== value ? { [field]: value as boolean } : null
  return null
}

// SQLSTATE 55P03; a raw statement's arrives wrapped in P2010 (the
// isUsernameConflict pattern).
export function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; cause?: { code?: string } } | null
  if (!e || typeof e !== 'object') return false
  return e.code === '55P03' || e.cause?.code === '55P03'
    || (e.code === 'P2010' && (e.meta?.code === '55P03' || e.meta?.driverAdapterError?.cause?.originalCode === '55P03'))
}

// Host: TWO passes (K5, Codex r2 / r3): pass 1 visits every candidate under its
// lock, writes each one that narrows NOW and collects each one that would
// widen; then ONE reservation outside any transaction; pass 2 revisits the
// collected ones under their locks: granted → written if they still differ,
// refused → only those that narrow now. The 429 is decided from pass 2.
async function applyHost(userId: number, field: DefaultField, value: MomentVisibility | boolean, widenAllowed: boolean, limit: RateResult | null): Promise<ApplyOutcome> {
  const d = hostDiffSql(field, value)
  const cands = await prisma.$queryRaw<{ id: number; code: string }[]>`
    SELECT s.id, s.code FROM sessions s
     WHERE s.host_user_id = ${userId} AND s.deleted_at IS NULL AND ((${d.wider}) OR (${d.narrower}))
     ORDER BY CASE WHEN ${d.narrower} THEN 0 ELSE 1 END, s.id`
  let changed = 0
  const collected: { id: number; code: string }[] = []
  for (const c of cands) {
    const out = await hostStep(userId, c, field, value, false)
    if (out === 'narrowed') changed++
    else if (out === 'would-widen') collected.push(c)
  }
  if (!collected.length) return { status: 'ok', changed }
  const res = widenAllowed ? await reserveWidening(userId, 'host') : null
  const granted = res && 'granted' in res ? res.granted : null
  let widened = 0, remained = 0
  for (const c of collected) {
    const out = await hostStep(userId, c, field, value, !!granted)
    if (out === 'widened') { widened++; changed++ } else if (out === 'narrowed') changed++
    else if (out === 'would-widen') remained++
  }
  // 🔒 Settled by COMMITTED widenings: none → both refunded.
  if (granted && widened === 0) await granted.refund()
  if (remained > 0) {
    const refusal = res && 'refused' in res ? res.refused : limit
    if (refusal) return { status: 'limited', changed, retryAfter: refusal.retryAfter }
    // Neither a budget nor the limiter: the flag is off (§ 2.5). An action that
    // was widening only answers like a missing route (review r1 P3: a middle
    // Visible To can be widening only too, which `onlyWidens` can't see).
    if (changed === 0) return { status: 'not-found' }
  }
  return { status: 'ok', changed }
}

// Your choices in moments: ONE statement per action, no contract (the post
// route's model: by participation, deleted moments and kicked members too).
async function applyMoments(userId: number, field: 'onlyInside' | 'momentHiddenFromFeed', value: boolean, widenAllowed: boolean, limit: RateResult | null): Promise<ApplyOutcome> {
  const col = PRIVACY_COLUMN[field]
  if (value) {
    // A hide: the DIFFERING ids first, without locks (locking all of S would
    // make a no-op hide block every ordinary writer of those moments), then
    // only their parents in account deletion's order (the sessions by code,
    // then your users row, FOR KEY SHARE: the upsert's foreign-key checks
    // would otherwise deadlock with your own account deletion), then the
    // upsert driven by those SAME ids (never S again: a moment joined since
    // would re-open the lock-order inversion; it got its own seed anyway).
    const ids = (await prisma.$queryRaw<{ id: number }[]>`
      SELECT x.id FROM (${scopeSql(userId)}) x(id)
        LEFT JOIN moment_privacy mp ON mp.session_id = x.id AND mp.user_id = ${userId}
       WHERE NOT COALESCE(mp.${col}, false)`).map(r => Number(r.id))
    if (!ids.length) return { status: 'ok', changed: 0 }
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ANY(${ids}::int[]) ORDER BY code NULLS LAST, id FOR KEY SHARE`
      const me = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${userId} FOR KEY SHARE`
      if (!me[0]) return 0
      await momentDefaultsSeams.afterParentLocks(userId)
      return tx.$executeRaw`
        INSERT INTO moment_privacy (session_id, user_id, ${col})
        SELECT sid, ${userId}, true FROM unnest(${ids}::int[]) AS t(sid)
        ON CONFLICT (session_id, user_id) DO UPDATE SET ${col} = true WHERE NOT moment_privacy.${col}`
    })
    return { status: 'ok', changed }
  }
  return applyShow(userId, 'moments', widenAllowed, limit, () => asUser(userId, tx => tx.$executeRaw`
    UPDATE moment_privacy SET ${col} = false WHERE user_id = ${userId} AND ${col} AND session_id IN (${scopeSql(userId)})`))
}

// 🔒 The statements that lock several of your rows (your moment_privacy rows,
// your check-ins) take your users row FOR KEY SHARE FIRST, in the same
// transaction (Codex build r1): account deletion holds that row FOR UPDATE
// before its cascade deletes those rows, so the two serialize instead of
// locking the rows in different orders (a deadlock). Gone → nothing to do.
async function asUser(userId: number, write: (tx: Prisma.TransactionClient) => Promise<number>): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const me = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${userId} FOR KEY SHARE`
    if (!me[0]) return 0
    await momentDefaultsSeams.afterParentLocks(userId)
    return write(tx)
  })
}

async function applyCheckins(userId: number, value: boolean, widenAllowed: boolean, limit: RateResult | null): Promise<ApplyOutcome> {
  if (value) {
    const changed = await asUser(userId, tx => tx.$executeRaw`
      UPDATE feed_items SET hidden_from_feed = true WHERE user_id = ${userId} AND kind = 'standalone' AND NOT hidden_from_feed`)
    return { status: 'ok', changed }
  }
  return applyShow(userId, 'checkins', widenAllowed, limit, () => asUser(userId, tx => tx.$executeRaw`
    UPDATE feed_items SET hidden_from_feed = false WHERE user_id = ${userId} AND kind = 'standalone' AND hidden_from_feed`))
}

// A SHOW of your choices or check-ins: all one widening statement, so the
// reservation comes first (no lock is held yet), refunded when it changed
// nothing or threw.
async function applyShow(userId: number, section: Section, widenAllowed: boolean, limit: RateResult | null, write: () => Promise<number>): Promise<ApplyOutcome> {
  if (!widenAllowed) return { status: 'limited', changed: 0, retryAfter: limit?.retryAfter ?? 60 }
  const res = await reserveWidening(userId, section)
  if ('refused' in res) return { status: 'limited', changed: 0, retryAfter: res.refused.retryAfter }
  let changed = 0
  try { changed = await write() } catch (err) { await res.granted.refund(); throw err }
  if (changed === 0) await res.granted.refund()
  return { status: 'ok', changed }
}

// POST /api/me/moment-defaults/apply { field }: the STORED default applied to
// what differs NOW (K7: not bound to the preview, ruled).
// Budget (D6, R10): narrowing is never charged or refused. A widening action
// reserves one slot on the section's bulk key + one change on the single-item
// key; refused (on either, or the request limiter spent) → the widening part
// is left and the answer is 429 AFTER the narrowing part applied.
// The request limiter (60/min): peeked first (fails open); spent + the default
// can only widen → 429 before the scan; charged only when nothing changed.
export async function applyDefault(userId: number, field: DefaultField): Promise<ApplyOutcome> {
  const value = (await readDefaults(prisma, userId))[field]
  const showOnly = onlyWidens(field, value)
  const flag = widenFlagOn(field)
  if (showOnly && !flag) return { status: 'not-found' }
  const req = applyRequestKey(userId)
  const peek = await bounded('peek', () => peekRate(req.key, req.max), OPEN)
  if (!peek.allowed && showOnly) return { status: 'limited', changed: 0, retryAfter: peek.retryAfter }
  const widenAllowed = peek.allowed && flag
  const limit = peek.allowed ? null : peek
  const section = SECTION[field]
  const out = section === 'host' ? await applyHost(userId, field, value, widenAllowed, limit)
    : section === 'moments' ? await applyMoments(userId, field as 'onlyInside' | 'momentHiddenFromFeed', value as boolean, widenAllowed, limit)
    : await applyCheckins(userId, value as boolean, widenAllowed, limit)
  if (out.status === 'not-found' || out.changed === 0) await bounded('charge', () => checkRate(req.key, req.max, req.window), OPEN)
  return out
}
